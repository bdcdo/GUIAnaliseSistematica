// Invariante "viewAs é somente leitura": o ?viewAsUser= da URL só troca a
// identidade EXIBIDA pela fila (resolveProjectQueueIdentity, testada aqui na
// forma pura) e nunca chega às Server Actions de escrita — elas nem aceitam um
// parâmetro de identidade: resolvem o ator canônico via
// resolveProjectMemberActor a partir da sessão autenticada. O segundo bloco
// exercita uma action de escrita real (saveResponse) e prova que o valor
// persistido é o membro canônico mesmo quando o chamador tenta injetar um
// viewAsUser como argumento extra.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedProjectAccessContext } from "@/lib/auth";
import { createProjectIdentityActionHarness } from "@/actions/__tests__/project-identity-harness";

const resolveMemberUserId = vi.hoisted(() =>
  vi.fn(async () => "canonical-member"),
);
const harness = createProjectIdentityActionHarness(resolveMemberUserId);

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));
// Clerk e supabase/admin são dependências transitivas do módulo real de auth
// (importado via importOriginal abaixo para manter resolveProjectQueueIdentity
// REAL); nunca devem ser alcançados pelos cenários deste arquivo.
vi.mock("@clerk/nextjs/server", () => ({ currentUser: async () => null }));
vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdmin: () => ({ from: () => ({}) }),
}));
vi.mock("@/lib/supabase/server", () => harness.supabaseServerModule);
// Mantém a implementação real (resolveProjectQueueIdentity) e sobrepõe apenas
// o ator autenticado das actions, como nos demais testes de Server Actions.
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, ...harness.authModule };
});

const access: ResolvedProjectAccessContext = {
  status: "resolved",
  accountUserId: "master-1",
  memberUserId: "master-member",
  project: { id: "p1", name: "Projeto", created_by: "owner" },
  membershipRole: null,
  isMaster: true,
  isCoordinator: true,
};

describe("resolveProjectQueueIdentity — viewAs é somente leitura", () => {
  it("troca a fila sem substituir a conta autenticada ou seu membro próprio", async () => {
    const { resolveProjectQueueIdentity } = await import("@/lib/auth");

    const result = resolveProjectQueueIdentity(access, "member-viewed");

    expect(result).toEqual({
      ownMemberUserId: "master-member",
      queueUserId: "member-viewed",
      isImpersonating: true,
    });
    expect(result.queueUserId).not.toBe(access.accountUserId);
  });

  it("não-master não pode trocar a fila pela URL", async () => {
    const { resolveProjectQueueIdentity } = await import("@/lib/auth");

    expect(
      resolveProjectQueueIdentity(
        { ...access, isMaster: false, isCoordinator: false },
        "member-viewed",
      ),
    ).toEqual({
      ownMemberUserId: "master-member",
      queueUserId: "master-member",
      isImpersonating: false,
    });
  });
});

describe("saveResponse — escrita persiste o ator real, nunca o viewAs", () => {
  beforeEach(() => {
    harness.reset({
      profiles: { data: { first_name: "Ana", last_name: "Souza" } },
      responses: { data: null },
      projects: {
        data: {
          pydantic_hash: null,
          pydantic_fields: [],
          schema_version_major: 1,
          schema_version_minor: 0,
          schema_version_patch: 0,
          round_strategy: null,
          current_round_id: "round-1",
          automation_mode: null,
        },
      },
      documents: { data: null },
    });
    resolveMemberUserId.mockReset();
    resolveMemberUserId.mockResolvedValue("canonical-member");
  });

  it("persiste respondent_id canônico mesmo com viewAsUser injetado como argumento extra", async () => {
    const { saveResponse } = await import("@/actions/responses");

    // A assinatura não tem parâmetro de identidade — o cast simula um caller
    // malicioso empurrando um viewAsUser além dos parâmetros declarados.
    const saveWithInjectedViewAs = saveResponse as unknown as (
      ...args: unknown[]
    ) => ReturnType<typeof saveResponse>;

    const result = await saveWithInjectedViewAs(
      "project-1",
      "doc-1",
      {},
      {},
      "member-viewed",
    );

    // `missingRequiredFields` acompanha todo save bem-sucedido: são os nomes das
    // obrigatórias em aberto no conjunto GRAVADO (vazio = codificação completa).
    expect(result).toEqual({ success: true, missingRequiredFields: [] });
    // A identidade veio do ator autenticado (por projectId), não de input do caller.
    expect(resolveMemberUserId).toHaveBeenCalledWith("project-1");

    const insert = harness.supabase.writeCalls.find(
      (w) => w.table === "responses" && w.op === "insert",
    );
    expect(insert).toBeDefined();
    const payload = insert!.payload as { respondent_id: string };
    expect(payload.respondent_id).toBe("canonical-member");
    expect(payload.respondent_id).not.toBe("member-viewed");
  });

  it("não grava quando a identidade canônica está indisponível", async () => {
    resolveMemberUserId.mockRejectedValueOnce(
      new Error("identity unavailable"),
    );
    const { saveResponse } = await import("@/actions/responses");

    const result = await saveResponse("project-1", "doc-1", {});

    expect(result).toEqual({
      success: false,
      error: "Não foi possível verificar sua identidade no projeto.",
    });
    expect(harness.supabase.writeCalls).toEqual([]);
  });
});
