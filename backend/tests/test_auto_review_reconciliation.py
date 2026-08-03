import asyncio
from datetime import UTC, datetime
from types import SimpleNamespace

import httpx
import pytest

import main
from services import auto_review_reconciliation as reconciliation


def _configure_wakeup(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        reconciliation.settings,
        "frontend_internal_url",
        "https://frontend.example.com/",
    )
    monkeypatch.setattr(
        reconciliation.settings,
        "auto_review_reconciliation_secret",
        "reconciliation-secret",
    )


def test_wakeup_posts_to_internal_route_with_dedicated_bearer(monkeypatch) -> None:
    _configure_wakeup(monkeypatch)
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(204)

    async def scenario() -> bool:
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            return await reconciliation.wake_auto_review_reconciliation(client)

    assert asyncio.run(scenario()) is True
    assert len(requests) == 1
    assert (
        str(requests[0].url)
        == "https://frontend.example.com/api/internal/auto-review/reconcile"
    )
    assert requests[0].headers["Authorization"] == "Bearer reconciliation-secret"


def test_wakeup_failure_is_best_effort(monkeypatch, caplog) -> None:
    _configure_wakeup(monkeypatch)

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("frontend unavailable", request=request)

    async def scenario() -> bool:
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            return await reconciliation.wake_auto_review_reconciliation(client)

    assert asyncio.run(scenario()) is False
    assert "Failed to wake auto-review reconciliation" in caplog.text


def test_wakeup_is_disabled_without_internal_url(monkeypatch) -> None:
    monkeypatch.setattr(reconciliation.settings, "frontend_internal_url", "")
    monkeypatch.setattr(
        reconciliation.settings,
        "auto_review_reconciliation_secret",
        "reconciliation-secret",
    )

    assert asyncio.run(reconciliation.wake_auto_review_reconciliation()) is False


class _DueRequestQuery:
    def __init__(self, data: list[dict[str, str]]) -> None:
        self.data = data
        self.calls: list[tuple[object, ...]] = []

    def select(self, columns: str):
        self.calls.append(("select", columns))
        return self

    def lte(self, column: str, value: str):
        self.calls.append(("lte", column, value))
        return self

    def limit(self, count: int):
        self.calls.append(("limit", count))
        return self

    def execute(self):
        self.calls.append(("execute",))
        return SimpleNamespace(data=self.data)


@pytest.mark.parametrize(
    ("rows", "expected"),
    [([], False), ([{"document_id": "document-1"}], True)],
)
def test_due_request_query_is_bounded_and_uses_database_deadline(
    monkeypatch,
    rows: list[dict[str, str]],
    expected: bool,
) -> None:
    query = _DueRequestQuery(rows)

    class Supabase:
        def table(self, name: str):
            assert name == "auto_review_reconciliation_requests"
            return query

    monkeypatch.setattr(reconciliation, "get_supabase", lambda: Supabase())
    now = datetime(2026, 8, 3, 15, 30, tzinfo=UTC)

    assert (
        asyncio.run(reconciliation.has_due_auto_review_reconciliation_request(now=now))
        is expected
    )
    assert query.calls == [
        ("select", "document_id"),
        ("lte", "next_attempt_at", "2026-08-03T15:30:00+00:00"),
        ("limit", 1),
        ("execute",),
    ]


class _StopLoop(Exception):
    pass


def _run_single_periodic_tick(
    monkeypatch: pytest.MonkeyPatch,
    *,
    due: bool | Exception,
) -> list[object]:
    wakeup_calls: list[object] = []

    async def fake_has_due_request() -> bool:
        if isinstance(due, Exception):
            raise due
        return due

    async def fake_wakeup(client=None) -> bool:
        wakeup_calls.append(client)
        return True

    async def stop_after_tick(_interval_seconds: float) -> None:
        raise _StopLoop

    monkeypatch.setattr(
        reconciliation,
        "has_due_auto_review_reconciliation_request",
        fake_has_due_request,
    )
    monkeypatch.setattr(reconciliation, "wake_auto_review_reconciliation", fake_wakeup)
    monkeypatch.setattr(reconciliation.asyncio, "sleep", stop_after_tick)

    with pytest.raises(_StopLoop):
        asyncio.run(
            reconciliation.run_auto_review_reconciliation_wakeup_loop(
                interval_seconds=0
            )
        )

    return wakeup_calls


def test_periodic_loop_does_not_wake_frontend_without_due_work(monkeypatch) -> None:
    assert _run_single_periodic_tick(monkeypatch, due=False) == []


def test_periodic_loop_wakes_frontend_for_due_work(monkeypatch) -> None:
    calls = _run_single_periodic_tick(monkeypatch, due=True)

    assert len(calls) == 1


def test_periodic_loop_wakes_conservatively_when_outbox_query_fails(
    monkeypatch, caplog
) -> None:
    calls = _run_single_periodic_tick(
        monkeypatch,
        due=RuntimeError("database unavailable"),
    )

    assert len(calls) == 1
    assert "Failed to inspect auto-review reconciliation outbox" in caplog.text


def test_lifespan_starts_and_stops_periodic_wakeup(monkeypatch) -> None:
    monkeypatch.setattr(main.settings, "frontend_internal_url", "https://frontend")
    monkeypatch.setattr(
        main.settings,
        "auto_review_reconciliation_secret",
        "reconciliation-secret",
    )
    capability_checks: list[None] = []
    started = asyncio.Event()
    stopped = asyncio.Event()

    async def fake_loop() -> None:
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            stopped.set()

    monkeypatch.setattr(main, "run_auto_review_reconciliation_wakeup_loop", fake_loop)
    monkeypatch.setattr(
        main,
        "assert_auto_review_reconciliation_capability",
        lambda: capability_checks.append(None),
    )

    async def scenario() -> None:
        async with main.lifespan(main.app):
            await asyncio.wait_for(started.wait(), timeout=1)
        assert stopped.is_set()

    asyncio.run(scenario())
    assert capability_checks == [None]


def test_lifespan_refuses_internal_url_without_dedicated_secret(monkeypatch) -> None:
    monkeypatch.setattr(main.settings, "frontend_internal_url", "https://frontend")
    monkeypatch.setattr(main.settings, "auto_review_reconciliation_secret", "")

    async def scenario() -> None:
        with pytest.raises(
            RuntimeError,
            match="AUTO_REVIEW_RECONCILIATION_SECRET",
        ):
            async with main.lifespan(main.app):
                pass

    asyncio.run(scenario())


def test_capability_gate_requires_canonical_database_rpc(monkeypatch) -> None:
    class Rpc:
        def execute(self):
            raise RuntimeError("function does not exist")

    class Supabase:
        def rpc(self, name: str):
            assert name == "auto_review_reconciliation_capability"
            return Rpc()

    monkeypatch.setattr(reconciliation.settings, "supabase_url", "https://db")
    monkeypatch.setattr(reconciliation.settings, "supabase_service_key", "service-key")
    monkeypatch.setattr(reconciliation, "get_supabase", lambda: Supabase())

    with pytest.raises(RuntimeError, match="migration"):
        reconciliation.assert_auto_review_reconciliation_capability()


def test_capability_gate_accepts_migrated_database(monkeypatch) -> None:
    class Rpc:
        data = True

        def execute(self):
            return self

    class Supabase:
        def rpc(self, name: str):
            assert name == "auto_review_reconciliation_capability"
            return Rpc()

    monkeypatch.setattr(reconciliation.settings, "supabase_url", "https://db")
    monkeypatch.setattr(reconciliation.settings, "supabase_service_key", "service-key")
    monkeypatch.setattr(reconciliation, "get_supabase", lambda: Supabase())

    reconciliation.assert_auto_review_reconciliation_capability()
