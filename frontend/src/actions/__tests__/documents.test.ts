import { describe, it, expect, beforeEach, vi } from "vitest";

// Testa o filtro de conflito com o indice unico parcial
// documents_project_external_id_active_uniq (migration 20260623130000):
// uploadDocuments nao pode mais inserir external_id ja ATIVO no projeto nem
// repetido no proprio lote, senao o INSERT em lote falharia inteiro. O mock de
// documents e uma FILA: 1a query = SELECT dos external_ids ativos existentes,
// 2a = o INSERT. Quando o lote nao tem external_id, o SELECT e pulado e o INSERT
// consome o 1o item.
import {
  makeSupabaseMock,
  type TableResult,
  type TableResults,
  type WriteCall,
  type RpcCall,
} from "./supabase-mock";

let writeCalls: WriteCall[];
let rpcCalls: RpcCall[];
let serverTableResults: TableResults | undefined;
let serverRpcResults: Record<string, TableResult> | undefined;

// vi.fn() (não arrow fixa) para permitir override por teste nos guards de
// exclude/restore/hardDelete — mesmo padrão de comparisons-retry.test.ts.
const hoisted = vi.hoisted(() => ({
  getUser: vi.fn<() => Promise<{ id: string } | null>>(async () => ({
    id: "userCoord",
  })),
  isCoord: vi.fn<() => Promise<boolean>>(async () => true),
  resolveMemberUserId: vi.fn<(projectId: string) => Promise<string>>(
    async () => "canonical-member",
  ),
  // Espiões, e não no-ops: QUAIS rotas são revalidadas é contrato observável —
  // a fila de Atribuições depende do path para não servir do Router Cache um
  // documento já excluído (#664).
  revalidatePath: vi.fn<(path: string) => void>(),
  revalidateTag: vi.fn<(tag: string, profile?: unknown) => void>(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: (path: string) => hoisted.revalidatePath(path),
  revalidateTag: (tag: string, profile?: unknown) =>
    hoisted.revalidateTag(tag, profile),
}));
vi.mock("@/lib/auth", () => ({
  getAuthUser: () => hoisted.getUser(),
  resolveProjectMemberActor: async (projectId: string) => {
    const user = await hoisted.getUser();
    if (!user) {
      return { ok: false, code: "unauthenticated", error: "Não autenticado" };
    }
    try {
      return {
        ok: true,
        user,
        memberUserId: await hoisted.resolveMemberUserId(projectId),
      };
    } catch {
      return {
        ok: false,
        code: "identity_unavailable",
        error: "Não foi possível verificar sua identidade no projeto.",
      };
    }
  },
  // Reimplementa a lógica real de requireCoordinator sobre os mesmos mocks
  // hoisted, para excludeDocuments/restoreDocuments/hardDeleteDocuments
  // e mantém os mesmos estados discriminados do helper real.
  requireCoordinator: async (_projectId: string, deniedMessage: string) => {
    const user = await hoisted.getUser();
    if (!user) {
      return { ok: false, code: "unauthenticated", error: "Não autenticado" };
    }
    if (!(await hoisted.isCoord())) {
      return { ok: false, code: "forbidden", error: deniedMessage };
    }
    return { ok: true, user };
  },
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServer: async () =>
    makeSupabaseMock({
      tableResults: serverTableResults,
      writeCalls,
      rpcCalls,
      rpcResults: serverRpcResults,
    }),
}));

beforeEach(() => {
  writeCalls = [];
  rpcCalls = [];
  serverTableResults = undefined;
  serverRpcResults = undefined;
  hoisted.getUser.mockResolvedValue({ id: "userCoord" });
  hoisted.isCoord.mockResolvedValue(true);
  hoisted.resolveMemberUserId.mockReset();
  hoisted.resolveMemberUserId.mockResolvedValue("canonical-member");
  hoisted.revalidatePath.mockClear();
  hoisted.revalidateTag.mockClear();
});

async function loadUpload() {
  return (await import("@/actions/documents")).uploadDocuments;
}

async function loadGetDocumentText() {
  return (await import("@/actions/documents")).getDocumentText;
}

async function loadCheck() {
  return (await import("@/actions/documents")).checkDuplicates;
}

async function loadExclude() {
  return (await import("@/actions/documents")).excludeDocuments;
}

async function loadRestore() {
  return (await import("@/actions/documents")).restoreDocuments;
}

async function loadHardDelete() {
  return (await import("@/actions/documents")).hardDeleteDocuments;
}

async function loadBrowse() {
  return (await import("@/actions/documents")).getDocumentsForBrowse;
}

async function loadRevalidateCache() {
  return (await import("@/actions/documents")).revalidateProjectDocumentsCache;
}

function insertedExternalIds(): (string | null)[] {
  const call = writeCalls.find(
    (c) => c.table === "documents" && c.op === "insert",
  );
  return ((call?.payload as { external_id: string | null }[]) ?? []).map(
    (r) => r.external_id,
  );
}

describe("getDocumentsForBrowse — identidade canônica", () => {
  it("reconhece como própria a resposta do membro canônico da conta-alias", async () => {
    serverTableResults = {
      documents: {
        data: [
          {
            id: "doc-1",
            external_id: "EXT-1",
            title: "Documento",
            created_at: "2026-07-15T00:00:00Z",
            exclusion_pending_at: null,
          },
        ],
      },
      responses: {
        data: [{ document_id: "doc-1", respondent_id: "canonical-member" }],
      },
      project_comments: { data: [] },
    };
    const browse = await loadBrowse();

    const result = await browse("project-1");

    expect(result[0]?.userAlreadyResponded).toBe(true);
    expect(hoisted.resolveMemberUserId).toHaveBeenCalledWith("project-1");
  });
});

function insertedRows(): { metadata: unknown; external_id: string | null }[] {
  const call = writeCalls.find(
    (c) => c.table === "documents" && c.op === "insert",
  );
  return (
    (call?.payload as { metadata: unknown; external_id: string | null }[]) ?? []
  );
}

describe("uploadDocuments — filtro do indice unico (add_all)", () => {
  it("pula external_id ja ATIVO no projeto e insere os demais", async () => {
    // SELECT devolve DOC-1 como ja existente ativo; depois o INSERT (sem erro).
    serverTableResults = {
      documents: [{ data: [{ external_id: "DOC-1" }] }, { error: null }],
    };
    const uploadDocuments = await loadUpload();

    const r = await uploadDocuments(
      "proj-1",
      [
        { external_id: "DOC-1", text: "ja existe" },
        { external_id: "DOC-2", text: "novo a" },
        { external_id: "DOC-3", text: "novo b" },
      ],
      false,
    );

    expect(r.error).toBeUndefined();
    expect(r.count).toBe(2);
    expect(r.skipped).toBe(1);
    expect(insertedExternalIds()).toEqual(["DOC-2", "DOC-3"]);
  });

  it("pula repeticao do mesmo external_id dentro do lote (mantem a 1a)", async () => {
    serverTableResults = {
      documents: [{ data: [] }, { error: null }],
    };
    const uploadDocuments = await loadUpload();

    const r = await uploadDocuments(
      "proj-1",
      [
        { external_id: "DOC-A", text: "primeira" },
        { external_id: "DOC-A", text: "duplicata no arquivo" },
        { external_id: "DOC-B", text: "outra" },
      ],
      false,
    );

    expect(r.count).toBe(2);
    expect(r.skipped).toBe(1);
    expect(insertedExternalIds()).toEqual(["DOC-A", "DOC-B"]);
  });

  it("nunca filtra documentos sem external_id", async () => {
    // Sem external_ids no lote -> SELECT e pulado; INSERT consome o 1o item.
    serverTableResults = { documents: [{ error: null }] };
    const uploadDocuments = await loadUpload();

    const r = await uploadDocuments(
      "proj-1",
      [
        { text: "sem id 1" },
        { text: "sem id 2" },
      ],
      false,
    );

    expect(r.count).toBe(2);
    expect(r.skipped).toBe(0);
    expect(insertedExternalIds()).toEqual([null, null]);
  });
});

describe("uploadDocuments — contagem em add_new_only", () => {
  it("conta os duplicados do duplicateMap em skipped (count + skipped == total)", async () => {
    // SELECT do filtro nao acha nada ativo; INSERT do DOC-2 ok.
    serverTableResults = {
      documents: [{ data: [] }, { error: null }],
    };
    const uploadDocuments = await loadUpload();

    const r = await uploadDocuments(
      "proj-1",
      [
        { external_id: "DOC-1", text: "ja existe no projeto" },
        { external_id: "DOC-2", text: "novo" },
      ],
      false,
      {
        mode: "add_new_only",
        duplicateMap: [
          { csvIndex: 0, existingDocId: "id-1", matchType: "external_id" },
        ],
      },
    );

    expect(r.error).toBeUndefined();
    expect(r.count).toBe(1);
    expect(r.skipped).toBe(1);
    expect(insertedExternalIds()).toEqual(["DOC-2"]);
  });

  it("todos duplicados -> 0 importados e skipped == total", async () => {
    // Early return: nenhuma query e disparada.
    const uploadDocuments = await loadUpload();

    const r = await uploadDocuments(
      "proj-1",
      [
        { external_id: "DOC-1", text: "x" },
        { external_id: "DOC-2", text: "y" },
      ],
      false,
      {
        mode: "add_new_only",
        duplicateMap: [
          { csvIndex: 0, existingDocId: "id-1", matchType: "external_id" },
          { csvIndex: 1, existingDocId: "id-2", matchType: "external_id" },
        ],
      },
    );

    expect(r.count).toBe(0);
    expect(r.skipped).toBe(2);
  });
});

describe("uploadDocuments — replace_and_add delega à RPC transacional", () => {
  // O caminho replace_and_add deixou de fazer 5 chamadas PostgREST separadas
  // (delete reviews/responses + reset assignments + update duplicados + insert)
  // e passou a chamar a RPC replace_and_add_documents, que roda os 5 passos numa
  // transação (issue #284 — falha parcial não apaga respostas/revisões). O
  // pré-filtro read-only de external_id (SELECT em documents) continua no TS.
  function rpcArgs(): Record<string, unknown> {
    const call = rpcCalls.find((c) => c.fn === "replace_and_add_documents");
    return (call?.args as Record<string, unknown>) ?? {};
  }

  it("chama a RPC com dup + novo e não emite writes diretos", async () => {
    // O filtro do novo doc consulta documents (SELECT, sem conflito ativo).
    serverTableResults = { documents: [{ data: [] }] };
    const uploadDocuments = await loadUpload();

    const r = await uploadDocuments(
      "proj-1",
      [
        { external_id: "DOC-1", text: "casa por hash com doc existente" },
        { external_id: "DOC-2", text: "novo" },
      ],
      false,
      {
        mode: "replace_and_add",
        deleteResponses: true,
        duplicateMap: [
          { csvIndex: 0, existingDocId: "id-1", matchType: "text_hash" },
        ],
      },
    );

    expect(r.error).toBeUndefined();
    expect(r.count).toBe(2);
    expect(r.skipped).toBe(0);

    // Uma única RPC com o payload transacional; nenhum delete/update/insert solto.
    expect(rpcCalls).toHaveLength(1);
    expect(writeCalls).toHaveLength(0);

    const args = rpcArgs();
    expect(args.p_existing_doc_ids).toEqual(["id-1"]);
    expect(args.p_delete_responses).toBe(true);
    expect(args.p_duplicate_updates).toHaveLength(1);
    expect((args.p_duplicate_updates as { id: string }[])[0].id).toBe("id-1");
    expect((args.p_duplicate_updates as { text_hash: string }[])[0].text_hash)
      .toBeTruthy();
    expect(args.p_new_documents).toHaveLength(1);
    expect((args.p_new_documents as { external_id: string }[])[0].external_id)
      .toBe("DOC-2");
  });

  it("propaga o erro da RPC (ex.: 23505) sem fallout parcial", async () => {
    // newDocs vazio (o único doc é duplicado) -> sem SELECT de filtro; só a RPC.
    serverRpcResults = {
      replace_and_add_documents: {
        error: {
          message: "duplicate key value violates unique constraint",
          code: "23505",
        },
      },
    };
    const uploadDocuments = await loadUpload();

    const r = await uploadDocuments(
      "proj-1",
      [{ external_id: "DOC-1", text: "casa por hash com outro doc" }],
      false,
      {
        mode: "replace_and_add",
        deleteResponses: true,
        duplicateMap: [
          { csvIndex: 0, existingDocId: "id-1", matchType: "text_hash" },
        ],
      },
    );

    expect(r.error).toContain("duplicate key");
    // Nenhuma escrita direta — a atomicidade (rollback) é responsabilidade da RPC.
    expect(writeCalls).toHaveLength(0);
    expect(rpcCalls).toHaveLength(1);
  });
});

describe("uploadDocuments — persiste a linha original (metadata)", () => {
  const meta = {
    original_row: { texto: "conteúdo", tribunal: "TJSP", classe: "" },
    original_columns: ["texto", "tribunal", "classe"],
  };

  it("add_all: grava metadata no INSERT; doc sem metadata vira null", async () => {
    serverTableResults = { documents: [{ error: null }] };
    const uploadDocuments = await loadUpload();

    await uploadDocuments(
      "proj-1",
      [
        { text: "conteúdo", metadata: meta },
        { text: "sem meta" },
      ],
      false,
    );

    const rows = insertedRows();
    expect(rows[0].metadata).toEqual(meta);
    expect(rows[1].metadata).toBeNull();
  });

  it("add_new_only: grava metadata nas linhas novas inseridas", async () => {
    serverTableResults = { documents: [{ data: [] }, { error: null }] };
    const uploadDocuments = await loadUpload();

    await uploadDocuments(
      "proj-1",
      [{ external_id: "DOC-1", text: "novo", metadata: meta }],
      false,
      { mode: "add_new_only" },
    );

    expect(insertedRows()[0].metadata).toEqual(meta);
  });

  it("replace_and_add: metadata flui no p_new_documents e no p_duplicate_updates da RPC", async () => {
    // Pré-filtro do doc novo consulta documents (SELECT sem conflito).
    serverTableResults = { documents: [{ data: [] }] };
    const uploadDocuments = await loadUpload();

    await uploadDocuments(
      "proj-1",
      [
        { external_id: "DOC-1", text: "dup por hash", metadata: meta },
        { external_id: "DOC-2", text: "novo", metadata: meta },
      ],
      false,
      {
        mode: "replace_and_add",
        deleteResponses: true,
        duplicateMap: [
          { csvIndex: 0, existingDocId: "id-1", matchType: "text_hash" },
        ],
      },
    );

    const call = rpcCalls.find((c) => c.fn === "replace_and_add_documents");
    const args = (call?.args ?? {}) as Record<string, unknown>;
    expect((args.p_new_documents as { metadata: unknown }[])[0].metadata).toEqual(
      meta,
    );
    expect(
      (args.p_duplicate_updates as { metadata: unknown }[])[0].metadata,
    ).toEqual(meta);
  });
});

// Nota (merge da main / #287): o describe "replace_and_add fail-loud nos
// deletes" testava o caminho antigo de DELETEs PostgREST separados, abortando
// passo a passo. Esse caminho foi substituído pela RPC transacional
// (replace_and_add_documents): uma falha em qualquer passo faz ROLLBACK de tudo.
// A intenção — falha não deixa estado parcial — está coberta por "propaga o erro
// da RPC (ex.: 23505) sem fallout parcial" acima e pelo teste SQL de rollback
// (supabase/tests/atomic_replace_rpcs.test.sql).

describe("checkDuplicates — propaga erro de query (não engole silenciosamente)", () => {
  it("lança quando a query por external_id falha", async () => {
    serverTableResults = {
      documents: [{ error: { message: "db down" } }],
    };
    const checkDuplicates = await loadCheck();

    await expect(
      checkDuplicates("proj-1", [
        { external_id: "X", text_hash: "h1", csvIndex: 0 },
      ]),
    ).rejects.toThrow(/ID externo/);
  });

  it("lança quando a query por text_hash falha (docs sem external_id)", async () => {
    // Sem external_id, o bloco 1 é pulado e a query de hash é a 1ª em documents.
    serverTableResults = {
      documents: [{ error: { message: "hash fail" } }],
    };
    const checkDuplicates = await loadCheck();

    await expect(
      checkDuplicates("proj-1", [{ text_hash: "h1", csvIndex: 0 }]),
    ).rejects.toThrow(/hash de conteúdo/);
  });

  it("lança quando a query de responses falha", async () => {
    // extId acha 1 duplicata → dispara a query de responses, que falha.
    serverTableResults = {
      documents: [{ data: [{ id: "d1", external_id: "X" }] }],
      responses: [{ error: { message: "resp fail" } }],
    };
    const checkDuplicates = await loadCheck();

    await expect(
      checkDuplicates("proj-1", [
        { external_id: "X", text_hash: "h1", csvIndex: 0 },
      ]),
    ).rejects.toThrow(/respostas das duplicatas/);
  });

  it("caminho feliz: retorna duplicatas sem lançar quando não há erro", async () => {
    serverTableResults = {
      documents: [{ data: [{ id: "d1", external_id: "X" }] }],
      responses: [{ data: [] }],
    };
    const checkDuplicates = await loadCheck();

    const r = await checkDuplicates("proj-1", [
      { external_id: "X", text_hash: "h1", csvIndex: 0 },
    ]);

    expect(r.duplicates).toHaveLength(1);
    expect(r.duplicatesWithResponses).toBe(0);
  });
});

describe("getDocumentText", () => {
  it("retorna texto e titulo quando o doc existe", async () => {
    serverTableResults = {
      documents: [{ data: { title: "Titulo", text: "conteudo" } }],
    };
    const getDocumentText = await loadGetDocumentText();

    const r = await getDocumentText("proj-1", "doc-1");

    expect(r).toEqual({ text: "conteudo", title: "Titulo" });
  });

  it("retorna null (sem lancar) quando o doc nao existe", async () => {
    // maybeSingle devolve data:null em 0 linhas; nao pode lancar (era .single()).
    serverTableResults = { documents: [{ data: null }] };
    const getDocumentText = await loadGetDocumentText();

    await expect(getDocumentText("proj-1", "missing")).resolves.toBeNull();
  });

  it("lanca quando a query retorna erro, em vez de silenciar como nao-encontrado", async () => {
    serverTableResults = {
      documents: [{ error: { message: "rls denied", code: "42501" } }],
    };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const getDocumentText = await loadGetDocumentText();

    await expect(getDocumentText("proj-1", "doc-1")).rejects.toMatchObject({
      message: "rls denied",
    });
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
  });
});

// Caracterização de excludeDocuments/restoreDocuments/hardDeleteDocuments —
// não tinham nenhum teste antes do #385. Cobrem o guard (auth+coordenador) e o
// caminho feliz que passou a compartilhar finishDocumentsMutation.
describe("excludeDocuments", () => {
  it("não-autenticado → error, sem UPDATE", async () => {
    hoisted.getUser.mockResolvedValueOnce(null);
    const excludeDocuments = await loadExclude();

    const r = await excludeDocuments("proj-1", ["doc1"], "motivo");

    expect(r).toEqual({ error: "Não autenticado" });
    expect(writeCalls).toHaveLength(0);
  });

  it("motivo vazio (coordenador) → error de motivo, sem UPDATE", async () => {
    const excludeDocuments = await loadExclude();

    const r = await excludeDocuments("proj-1", ["doc1"], "   ");

    expect(r).toEqual({ error: "Motivo da exclusão é obrigatório" });
    expect(writeCalls).toHaveLength(0);
  });

  it("não-coordenador → error de coordenador, sem UPDATE", async () => {
    hoisted.isCoord.mockResolvedValueOnce(false);
    const excludeDocuments = await loadExclude();

    const r = await excludeDocuments("proj-1", ["doc1"], "motivo");

    expect(r).toEqual({ error: "Apenas coordenador pode excluir documentos" });
    expect(writeCalls).toHaveLength(0);
  });

  it("não-coordenador COM motivo vazio → error de coordenador (gate roda antes da validação de motivo)", async () => {
    hoisted.isCoord.mockResolvedValueOnce(false);
    const excludeDocuments = await loadExclude();

    const r = await excludeDocuments("proj-1", ["doc1"], "   ");

    expect(r).toEqual({ error: "Apenas coordenador pode excluir documentos" });
    expect(writeCalls).toHaveLength(0);
  });

  it("caminho feliz: marca excluded_at/reason/by e retorna count", async () => {
    const excludeDocuments = await loadExclude();

    const r = await excludeDocuments("proj-1", ["doc1", "doc2"], "  motivo  ");

    expect(r).toEqual({ count: 2 });
    expect(writeCalls).toHaveLength(1);
    expect(writeCalls[0]).toMatchObject({
      table: "documents",
      op: "update",
      payload: {
        excluded_reason: "motivo",
        excluded_by: "userCoord",
      },
    });
  });

  it("erro do Supabase → error, sem revalidar", async () => {
    serverTableResults = {
      documents: [{ error: { message: "db down" } }],
    };
    const excludeDocuments = await loadExclude();

    const r = await excludeDocuments("proj-1", ["doc1"], "motivo");

    expect(r).toEqual({ error: "db down" });
  });
});

describe("restoreDocuments", () => {
  it("não-coordenador → error, sem UPDATE", async () => {
    hoisted.isCoord.mockResolvedValueOnce(false);
    const restoreDocuments = await loadRestore();

    const r = await restoreDocuments("proj-1", ["doc1"]);

    expect(r).toEqual({ error: "Apenas coordenador pode restaurar documentos" });
    expect(writeCalls).toHaveLength(0);
  });

  it("caminho feliz: limpa excluded_at/reason/by e retorna count", async () => {
    const restoreDocuments = await loadRestore();

    const r = await restoreDocuments("proj-1", ["doc1", "doc2", "doc3"]);

    expect(r).toEqual({ count: 3 });
    expect(writeCalls[0]).toMatchObject({
      table: "documents",
      op: "update",
      payload: { excluded_at: null, excluded_reason: null, excluded_by: null },
    });
  });
});

describe("hardDeleteDocuments", () => {
  it("não-coordenador → error, sem DELETE", async () => {
    hoisted.isCoord.mockResolvedValueOnce(false);
    const hardDeleteDocuments = await loadHardDelete();

    const r = await hardDeleteDocuments("proj-1", ["doc1"]);

    expect(r).toEqual({
      error: "Apenas coordenador pode apagar documentos permanentemente",
    });
    expect(writeCalls).toHaveLength(0);
  });

  it("caminho feliz: DELETE e retorna count", async () => {
    const hardDeleteDocuments = await loadHardDelete();

    const r = await hardDeleteDocuments("proj-1", ["doc1"]);

    expect(r).toEqual({ count: 1 });
    expect(writeCalls[0]).toMatchObject({ table: "documents", op: "delete" });
  });
});

// A fila de Atribuições deixou de ter unstable_cache (#664) e passou a ser lida
// direto do banco, mas o Router Cache do cliente ainda pode servir a
// renderização anterior — sem revalidar o path, um documento recém-excluído
// seguiria aparecendo como atribuível para o coordenador. Asserir a rota aqui,
// e não só confiar no efeito colateral de qualquer revalidatePath invalidar o
// Router Cache inteiro, é o que dá vermelho se a chamada for removida ou
// trocada por uma revalidação de escopo mais estreito.
describe("revalidateProjectDocumentsCache — rotas invalidadas", () => {
  it("revalida config, Atribuições e a tag de progresso", async () => {
    const revalidateProjectDocumentsCache = await loadRevalidateCache();

    await revalidateProjectDocumentsCache("proj-1");

    expect(hoisted.revalidatePath.mock.calls.map(([p]) => p)).toEqual([
      "/projects/proj-1/config/documents",
      "/projects/proj-1/analyze/assignments",
    ]);
    expect(hoisted.revalidateTag).toHaveBeenCalledWith(
      "project-proj-1-progress",
      { expire: 60 },
    );
  });

  it("não revalida a tag `-documents`, que perdeu o produtor com o unstable_cache", async () => {
    const revalidateProjectDocumentsCache = await loadRevalidateCache();

    await revalidateProjectDocumentsCache("proj-1");

    expect(hoisted.revalidateTag.mock.calls.map(([t]) => t)).not.toContain(
      "project-proj-1-documents",
    );
  });
});
