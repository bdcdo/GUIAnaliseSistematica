"""Best-effort wakeups for the durable auto-review reconciliation outbox."""

import asyncio
import logging
from datetime import UTC, datetime

import httpx

from config import settings
from services.supabase_client import get_supabase

logger = logging.getLogger(__name__)

_RECONCILIATION_PATH = "/api/internal/auto-review/reconcile"
_WAKEUP_INTERVAL_SECONDS = 30.0
_WAKEUP_TIMEOUT_SECONDS = 10.0


def _reconciliation_url() -> str | None:
    base_url = settings.frontend_internal_url.strip().rstrip("/")
    if not base_url or not settings.auto_review_reconciliation_secret:
        return None
    return f"{base_url}{_RECONCILIATION_PATH}"


def assert_auto_review_reconciliation_capability() -> None:
    """Refuse the new backend until the canonical database contract exists."""
    if not settings.supabase_url or not settings.supabase_service_key:
        raise RuntimeError(
            "Auto-review reconciliation requires SUPABASE_URL and SUPABASE_SERVICE_KEY."
        )

    try:
        result = get_supabase().rpc("auto_review_reconciliation_capability").execute()
    except Exception as error:
        raise RuntimeError(
            "Database migration for auto-review reconciliation is not available."
        ) from error

    if result.data is not True:
        raise RuntimeError(
            "Database migration returned an invalid auto-review capability."
        )


async def has_due_auto_review_reconciliation_request(
    *, now: datetime | None = None
) -> bool:
    """Return whether the durable outbox has work eligible for this tick."""
    due_before = (now or datetime.now(UTC)).isoformat()

    def query_due_request() -> bool:
        result = (
            get_supabase()
            .table("auto_review_reconciliation_requests")
            .select("document_id")
            .lte("next_attempt_at", due_before)
            .limit(1)
            .execute()
        )
        if not isinstance(result.data, list):
            raise RuntimeError(
                "Auto-review reconciliation outbox returned invalid data."
            )
        return bool(result.data)

    # supabase-py is synchronous. Keep its network wait outside FastAPI's event
    # loop so health checks and requests are not stalled by the periodic probe.
    return await asyncio.to_thread(query_due_request)


async def wake_auto_review_reconciliation(
    client: httpx.AsyncClient | None = None,
) -> bool:
    """Ask the frontend to drain the durable outbox, without owning its state."""
    url = _reconciliation_url()
    if url is None:
        logger.warning(
            "Auto-review reconciliation wakeup disabled: configure "
            "FRONTEND_INTERNAL_URL and AUTO_REVIEW_RECONCILIATION_SECRET."
        )
        return False

    owns_client = client is None
    if client is None:
        client = httpx.AsyncClient(timeout=_WAKEUP_TIMEOUT_SECONDS)

    try:
        response = await client.post(
            url,
            headers={
                "Authorization": (
                    f"Bearer {settings.auto_review_reconciliation_secret}"
                )
            },
        )
        response.raise_for_status()
        return True
    except Exception:
        # A RPC que publicou a resposta também gravou a outbox. Portanto, a
        # falha deste sinal não perde trabalho: o próximo tick tenta o dreno.
        logger.warning("Failed to wake auto-review reconciliation", exc_info=True)
        return False
    finally:
        if owns_client:
            await client.aclose()


async def run_auto_review_reconciliation_wakeup_loop(
    *, interval_seconds: float = _WAKEUP_INTERVAL_SECONDS
) -> None:
    """Wake the frontend only while the durable outbox has due work."""
    async with httpx.AsyncClient(timeout=_WAKEUP_TIMEOUT_SECONDS) as client:
        while True:
            try:
                has_due_request = await has_due_auto_review_reconciliation_request()
            except asyncio.CancelledError:
                raise
            except Exception:
                # A falha da sonda não prova que a outbox está vazia. Acordar o
                # consumidor preserva o contrato durável em vez de atrasar jobs.
                logger.warning(
                    "Failed to inspect auto-review reconciliation outbox; "
                    "waking frontend conservatively",
                    exc_info=True,
                )
                has_due_request = True

            if has_due_request:
                await wake_auto_review_reconciliation(client)
            await asyncio.sleep(interval_seconds)
