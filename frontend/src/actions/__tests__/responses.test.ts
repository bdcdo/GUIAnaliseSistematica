import { describe, it, expect, vi, beforeEach } from "vitest";
import { revalidatePath, revalidateTag } from "next/cache";
import { isCodingComplete } from "@/lib/coding-completeness";
import { responseQualifiesForVersion } from "@/lib/compare-version";
import type { VersionedResponse } from "@/lib/compare-version";
import type { AnswerFieldHashes, PydanticField } from "@/lib/types";
import type { SaveResponseOpts } from "@/actions/responses";

const drainAutoReviewReconciliationRequests = vi.hoisted(() => vi.fn(async () => ({
  processed: 1,
  stale: 0,
  failed: 0,
  remaining: 0,
})));

// Mocks precisam ser declarados antes do import dinamico do modulo sob teste.
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  resolveProjectMemberActor: vi.fn(async () => ({
    ok: true,
    user: { id: "user-1", email: "u@test.com" },
    memberUserId: "user-1",
  })),
}));
vi.mock("@/lib/auto-review-reconciler", () => ({
  drainAutoReviewReconciliationRequests,
}));

interface State {
  responseInsertPayload: Record<string, unknown> | null;
  responseUpdatePayload: Record<string, unknown> | null;
  assignmentUpdatePayload: Record<string, unknown> | null;
  existingResponse: {
    id: string;
    is_partial: boolean;
    answers?: Record<string, unknown>;
    answer_field_hashes?: Record<string, string | null> | null;
  } | null;
  existingResponseError: { message: string; code?: string } | null;
  // Respostas sucessivas do lookup de `existing`, na ordem das leituras.
  // Vazia = todas as leituras devolvem `existingResponse`.
  existingResponseQueue: Array<State["existingResponse"]>;
  existingReadCount: number;
  responseUpdateFilters: Array<{ column: string; value: unknown }>;
  // Quantas linhas o UPDATE por chave lógica afeta. Default: 1 quando há
  // resposta corrente, 0 quando não há — o que o banco faria.
  responseUpdateMatchedRows: () => boolean;
  // Erros devolvidos pelo INSERT, na ordem das tentativas.
  responseInsertErrorQueue: Array<{ message: string; code?: string }>;
  currentAssignmentStatus: string | null;
  pydanticFields: Array<{
    name: string;
    type: string;
    required?: boolean;
    options?: string[];
    target?: string;
    hash?: string;
  }>;
  schemaVersion: { major: number; minor: number; patch: number };
  documentExcludedAt: string | null;
  automationMode: string | null;
}

let state: State;

beforeEach(() => {
  state = {
    responseInsertPayload: null,
    responseUpdatePayload: null,
    assignmentUpdatePayload: null,
    existingResponse: null,
    existingResponseError: null,
    existingResponseQueue: [],
    existingReadCount: 0,
    responseUpdateFilters: [],
    responseUpdateMatchedRows: () => state.existingResponse !== null,
    responseInsertErrorQueue: [],
    currentAssignmentStatus: "pendente",
    pydanticFields: [
      { name: "q1", type: "single", required: true, options: ["a", "b"] },
    ],
    schemaVersion: { major: 1, minor: 0, patch: 0 },
    documentExcludedAt: null,
    automationMode: null,
  };
  vi.mocked(revalidatePath).mockClear();
  vi.mocked(revalidateTag).mockClear();
  drainAutoReviewReconciliationRequests.mockClear();
});

// Builder generico awaitable: usado quando o resultado final eh `{ error: null }`
// e o encadeamento termina em await (sem `.single()`).
function thenableOk() {
  const chain: Record<string, unknown> = {};
  chain.eq = () => chain;
  chain.then = (resolve: (v: { error: null }) => unknown) =>
    resolve({ error: null });
  return chain;
}

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServer: async () => ({
    from: (table: string) => {
      if (table === "profiles") {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({
                data: { first_name: "Test", last_name: "User" },
              }),
            }),
          }),
        };
      }
      if (table === "projects") {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({
                data: {
                  pydantic_hash: "hash-1",
                  pydantic_fields: state.pydanticFields,
                  schema_version_major: state.schemaVersion.major,
                  schema_version_minor: state.schemaVersion.minor,
                  schema_version_patch: state.schemaVersion.patch,
                  round_strategy: "schema_version",
                  current_round_id: "round-1",
                  automation_mode: state.automationMode,
                },
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === "responses") {
        return {
          select: () => {
            const c: Record<string, unknown> = {};
            c.eq = () => c;
            const read = async () => {
              state.existingReadCount += 1;
              // Fila opcional: permite que a releitura do retry veja um estado
              // diferente do da primeira tentativa, que é o cenário real de
              // conflito (outra sessão criou a linha no meio).
              const queued = state.existingResponseQueue?.shift();
              if (queued !== undefined) return { data: queued, error: null };
              return { data: state.existingResponse, error: state.existingResponseError };
            };
            c.single = read;
            c.maybeSingle = read;
            return c;
          },
          insert: async (payload: Record<string, unknown>) => {
            state.responseInsertPayload = payload;
            const err = state.responseInsertErrorQueue?.shift() ?? null;
            return { error: err };
          },
          // O canal de escrita passou a ser UPDATE-por-chave-lógica +
          // .select("id"): o rowcount devolvido aqui é o que decide se o save
          // cai no INSERT. Registrar os filtros é o que permite provar que a
          // chave lógica — e não `id` — é quem endereça a linha (#609).
          update: (payload: Record<string, unknown>) => {
            state.responseUpdatePayload = payload;
            state.responseUpdateFilters = [];
            const c: Record<string, unknown> = {};
            c.eq = (column: string, value: unknown) => {
              state.responseUpdateFilters.push({ column, value });
              return c;
            };
            c.select = () => ({
              then: (resolve: (v: { data: unknown; error: null }) => unknown) =>
                resolve({
                  data: state.responseUpdateMatchedRows() ? [{ id: "resp-1" }] : [],
                  error: null,
                }),
            });
            return c;
          },
        };
      }
      if (table === "documents") {
        return {
          select: () => {
            const c: Record<string, unknown> = {};
            c.eq = () => c;
            c.maybeSingle = async () => ({
              data: { excluded_at: state.documentExcludedAt },
            });
            return c;
          },
        };
      }
      if (table === "assignments") {
        return {
          select: () => {
            const c: Record<string, unknown> = {};
            c.eq = () => c;
            c.maybeSingle = async () => ({
              data: state.currentAssignmentStatus
                ? { status: state.currentAssignmentStatus }
                : null,
            });
            return c;
          },
          update: (payload: Record<string, unknown>) => {
            state.assignmentUpdatePayload = payload;
            return thenableOk();
          },
        };
      }
      return {};
    },
  }),
}));

async function loadSaveResponse() {
  const saveResponse = (await import("@/actions/responses")).saveResponse;
  return (
    projectId: string,
    documentId: string,
    answers: Record<string, unknown>,
    opts: Partial<SaveResponseOpts> = {},
  ) =>
    saveResponse(projectId, documentId, answers, {
      expectedRoundId: "round-1",
      ...opts,
    });
}

describe("saveResponse — gravação pelo envio explícito", () => {
  it("com todos os campos preenchidos promove assignment para concluido", async () => {
    const saveResponse = await loadSaveResponse();
    const r = await saveResponse("proj-1", "doc-1", { q1: "a" });
    expect(r.success).toBe(true);
    expect(state.assignmentUpdatePayload?.status).toBe("concluido");
    expect(typeof state.assignmentUpdatePayload?.completed_at).toBe("string");
  });

  it("grava response com is_partial=false", async () => {
    const saveResponse = await loadSaveResponse();
    await saveResponse("proj-1", "doc-1", { q1: "a" });
    expect(state.responseInsertPayload?.is_partial).toBe(false);
  });

  it("editar uma response já submetida invalida imediatamente a auto-revisão", async () => {
    state.existingResponse = { id: "resp-1", is_partial: false };
    state.currentAssignmentStatus = "concluido";
    state.automationMode = "compare_humans";
    const saveResponse = await loadSaveResponse();

    const result = await saveResponse("proj-1", "doc-1", { q1: "b" });

    expect(result.success).toBe(true);
    expect(drainAutoReviewReconciliationRequests).toHaveBeenCalledWith({
      projectId: "proj-1",
    });
  });

  it("envio sobre response parcial sobrescreve is_partial: true -> false (UPDATE)", async () => {
    // A linha parcial pode vir de um envio incompleto anterior ou, nas anteriores
    // ao #608, do auto-save que marcava "nunca submetida". Completar o conjunto
    // e enviar deve fazer UPDATE com is_partial=false nos dois casos.
    state.existingResponse = { id: "resp-1", is_partial: true };
    const saveResponse = await loadSaveResponse();
    await saveResponse("proj-1", "doc-1", { q1: "a" });
    expect(state.responseUpdatePayload?.is_partial).toBe(false);
    expect(state.assignmentUpdatePayload?.status).toBe("concluido");
  });

  it("submit explicito com obrigatoria em branco grava is_partial=true e devolve a contagem", async () => {
    // O sinal descreve o conjunto GRAVADO, nao o canal da escrita: sem isso, um
    // envio incompleto ficava indistinguivel de uma conclusao — o documento
    // voltava a fila e o pesquisador lia como "nao salvou" (#519).
    state.pydanticFields = [
      { name: "q1", type: "text", required: true, hash: "h-q1" },
      { name: "q2", type: "text", required: true, hash: "h-q2" },
    ];
    const saveResponse = await loadSaveResponse();
    const r = await saveResponse("proj-1", "doc-1", { q1: "a" });
    expect(state.responseInsertPayload?.is_partial).toBe(true);
    // E o cliente recebe os NOMES, não uma contagem: é deles que sai o enunciado
    // no toast e o campo até o qual a tela rola (#608). Uma contagem ao lado da
    // lista permitiria representar as duas em desacordo.
    expect(r.success && r.missingRequiredFields).toEqual(["q2"]);
  });

  it("envio que ENCOLHE uma response submetida devolve is_partial=true", async () => {
    // A heranca do sinal ("ja foi submetida uma vez") sobrevivia a uma escrita
    // posterior com menos respostas, carimbando de submetido um conjunto
    // incompleto. Distinto do caso vizinho, onde o conjunto continua completo.
    state.pydanticFields = [
      { name: "q1", type: "text", required: true, hash: "h-q1" },
      { name: "q2", type: "text", required: true, hash: "h-q2" },
    ];
    state.existingResponse = {
      id: "resp-1",
      is_partial: false,
      answers: { q1: "a", q2: "b" },
      answer_field_hashes: { q1: "h-q1", q2: "h-q2" },
    };
    const saveResponse = await loadSaveResponse();
    await saveResponse("proj-1", "doc-1", { q1: "a" });
    expect(state.responseUpdatePayload?.answers).toEqual({ q1: "a" });
    expect(state.responseUpdatePayload?.is_partial).toBe(true);
  });

  it("campo obrigatorio criado depois NAO rebaixa codificacao antiga", async () => {
    // Espelho do caso real: a codificacao estava completa contra o schema da
    // epoca; o campo novo so entra na regua se o carimbo provar que ele existia.
    state.pydanticFields = [
      { name: "q1", type: "text", required: true, hash: "h-q1" },
      { name: "q_novo", type: "text", required: true, hash: "h-novo" },
    ];
    state.existingResponse = {
      id: "resp-1",
      is_partial: false,
      answers: { q1: "a" },
      answer_field_hashes: { q1: "h-q1" },
    };
    const saveResponse = await loadSaveResponse();
    await saveResponse("proj-1", "doc-1", { q1: "a" });
    expect(state.responseUpdatePayload?.is_partial).toBe(false);
    expect(state.responseUpdatePayload?.answer_field_hashes).toEqual({ q1: "h-q1" });
  });

  it("preserva resposta stale e seu hash sem usá-la para concluir a codificação", async () => {
    state.pydanticFields = [
      {
        name: "q_stale",
        type: "single",
        required: true,
        options: ["X", "Y"],
        hash: "h-stale-new",
      },
      { name: "q_txt", type: "text", required: true, hash: "h-text" },
    ];
    state.existingResponse = {
      id: "resp-1",
      is_partial: false,
      answers: { q_stale: "A", q_txt: "antigo" },
      answer_field_hashes: { q_stale: "h-stale-old", q_txt: "h-text" },
    };

    const saveResponse = await loadSaveResponse();
    const result = await saveResponse("proj-1", "doc-1", { q_txt: "novo" });

    expect(result.success).toBe(true);
    expect(state.responseUpdatePayload?.answers).toEqual({
      q_stale: "A",
      q_txt: "novo",
    });
    expect(state.responseUpdatePayload?.answer_field_hashes).toEqual({
      q_stale: "h-stale-old",
      q_txt: "h-text",
    });
    expect(state.assignmentUpdatePayload?.status).toBe("em_andamento");
  });

  it("doc codificado antes do bump NAO passa a dever o campo novo (#520)", async () => {
    // Critério de aceite da #520: a codificação foi completa à época; o schema
    // ganhou um obrigatório depois. Basta o pesquisador reabrir o doc e tocar
    // qualquer coisa para o save reestampar o mapa — e a leitura retroativa
    // (backlog, reconciliação) passar a considerar a codificação incompleta.
    state.pydanticFields = [
      { name: "q1", type: "single", required: true, options: ["a", "b"], hash: "h1" },
      { name: "q_novo", type: "single", required: true, options: ["x"], hash: "h-novo" },
    ];
    state.existingResponse = {
      id: "resp-1",
      is_partial: false,
      answers: { q1: "a" },
      answer_field_hashes: { q1: "h1" },
    };

    const saveResponse = await loadSaveResponse();
    const result = await saveResponse("proj-1", "doc-1", { q1: "b" });

    expect(result.success).toBe(true);
    const gravado = state.responseUpdatePayload?.answer_field_hashes as AnswerFieldHashes;
    expect(gravado).toEqual({ q1: "h1" });
    // A leitura retroativa continua enxergando a codificação como completa.
    expect(
      isCodingComplete(
        state.pydanticFields as PydanticField[],
        state.responseUpdatePayload?.answers as Record<string, unknown>,
        gravado,
      ),
    ).toBe(true);
  });

  it("campo criado depois entra no mapa quando o pesquisador o responde (#520)", async () => {
    state.pydanticFields = [
      { name: "q1", type: "single", required: true, options: ["a", "b"], hash: "h1" },
      { name: "q_novo", type: "single", required: true, options: ["x"], hash: "h-novo" },
    ];
    state.existingResponse = {
      id: "resp-1",
      is_partial: false,
      answers: { q1: "a" },
      answer_field_hashes: { q1: "h1" },
    };

    const saveResponse = await loadSaveResponse();
    await saveResponse("proj-1", "doc-1", { q1: "a", q_novo: "x" });

    expect(state.responseUpdatePayload?.answer_field_hashes).toEqual({
      q1: "h1",
      q_novo: "h-novo",
    });
    expect(state.assignmentUpdatePayload?.status).toBe("concluido");
  });

  it("response legacy INCOMPLETA conserva o sentinela em vez de ganhar chaves (#520)", async () => {
    // `q_novo` fica em branco, então a recodificação não fica completa contra o
    // schema atual e o sentinela é conservado. Desde o #608 a incompletude é a
    // condição inteira — antes o auto-save também suprimia a promoção, e era ele
    // que este caso exercitava.
    state.pydanticFields = [
      { name: "q1", type: "single", required: true, options: ["a", "b"], hash: "h1" },
      { name: "q_novo", type: "single", required: true, options: ["x"], hash: "h-novo" },
    ];
    state.existingResponse = {
      id: "resp-1",
      is_partial: false,
      answers: { q1: "a" },
      answer_field_hashes: null,
    };

    const saveResponse = await loadSaveResponse();
    await saveResponse("proj-1", "doc-1", { q1: "b" });

    expect(state.responseUpdatePayload?.answer_field_hashes).toEqual({});
  });

  it("codificacao nova estampa o schema atual inteiro (INSERT)", async () => {
    state.pydanticFields = [
      { name: "q1", type: "single", required: true, options: ["a", "b"], hash: "h1" },
      { name: "q2", type: "text", required: true, hash: "h2" },
    ];

    const saveResponse = await loadSaveResponse();
    await saveResponse("proj-1", "doc-1", { q1: "a" });

    expect(state.responseInsertPayload?.answer_field_hashes).toEqual({
      q1: "h1",
      q2: "h2",
    });
  });

  it("response legacy preserva a proveniencia de schema ja gravada (#520)", async () => {
    // Conservar o sentinela `{}` joga a leitura de staleness no fallback do
    // schema inteiro (`isFieldStale`), que compara `pydantic_hash`. Promover a
    // coluna no mesmo save tornaria esse fallback permissivo — a codificacao
    // antiga passaria a ser lida como feita contra o schema de hoje, e nenhum
    // campo apareceria stale. Omitir as colunas preserva o que esta na linha.
    //
    // `q2` em branco mantém a recodificação incompleta, que é o que conserva o
    // sentinela. O caso simétrico — recodificação COMPLETA, que promove tudo —
    // é o teste da #548 mais abaixo, e é ele que fixa a fronteira entre os dois.
    state.pydanticFields = [
      { name: "q1", type: "single", required: true, options: ["a", "b"], hash: "h1" },
      { name: "q2", type: "text", required: true, hash: "h2" },
    ];
    state.existingResponse = {
      id: "resp-1",
      is_partial: false,
      answers: { q1: "a" },
      answer_field_hashes: null,
    };

    const saveResponse = await loadSaveResponse();
    await saveResponse("proj-1", "doc-1", { q1: "b" });

    const payload = state.responseUpdatePayload ?? {};
    expect(payload).not.toHaveProperty("pydantic_hash");
    expect(payload).not.toHaveProperty("schema_version_major");
    expect(payload).not.toHaveProperty("schema_version_minor");
    expect(payload).not.toHaveProperty("schema_version_patch");
    expect(payload).not.toHaveProperty("version_inferred_from");
    // O resto do save segue normal. E o ramo legacy de buildReconciledFieldHashes
    // NAO recarimba hash (conserva o sentinela `{}`), mesmo com revisao real de
    // valor — liga o mapa per-campo as colunas preservadas no mesmo caso.
    expect(payload.answers).toEqual({ q1: "b" });
    expect(payload.answer_field_hashes).toEqual({});
  });

  it("response com proveniencia per-campo promove as colunas ao REVISAR um valor", async () => {
    // Com o mapa herdado nao vazio, a leitura de staleness usa o snapshot
    // per-campo (nao `pydantic_hash`), entao promover as colunas de versao aqui
    // e seguro. E `q1` mudou de "a" para "b": houve revisao real, entao as
    // colunas avancam para o schema de hoje.
    state.pydanticFields = [
      { name: "q1", type: "single", required: true, options: ["a", "b"], hash: "h1" },
    ];
    state.existingResponse = {
      id: "resp-1",
      is_partial: false,
      answers: { q1: "a" },
      answer_field_hashes: { q1: "h1" },
    };

    const saveResponse = await loadSaveResponse();
    await saveResponse("proj-1", "doc-1", { q1: "b" });

    expect(state.responseUpdatePayload?.pydantic_hash).toBe("hash-1");
    expect(state.responseUpdatePayload?.schema_version_major).toBe(1);
    expect(state.responseUpdatePayload?.version_inferred_from).toBe("live_save");
  });

  it("toque sem revisao preserva as colunas de versao da epoca (#529)", async () => {
    // Prova do vermelho do #529: o pesquisador reabre um doc codificado sob a
    // versao anterior e re-envia o MESMO valor, sem editar nada (o gatilho
    // original era o auto-save por navegacao; hoje e um clique em Enviar sobre
    // um formulario intocado). Nenhum campo e revisado, entao o mapa per-campo (#528) ja
    // conserva a epoca — as colunas de versao devem acompanhar e NAO promover
    // para o schema de hoje. Antes deste fix, `buildResponsePayload` promovia em
    // todo save, deixando a linha assimetrica (hashes de epoca x versao de hoje)
    // e fazendo-a contar como da versao corrente no gate `latest_major`.
    state.pydanticFields = [
      { name: "q1", type: "single", required: true, options: ["a", "b"], hash: "h1" },
    ];
    state.existingResponse = {
      id: "resp-1",
      is_partial: false,
      answers: { q1: "a" },
      answer_field_hashes: { q1: "h1" },
    };

    const saveResponse = await loadSaveResponse();
    await saveResponse("proj-1", "doc-1", { q1: "a" });

    const payload = state.responseUpdatePayload ?? {};
    expect(payload).not.toHaveProperty("pydantic_hash");
    expect(payload).not.toHaveProperty("schema_version_major");
    expect(payload).not.toHaveProperty("schema_version_minor");
    expect(payload).not.toHaveProperty("schema_version_patch");
    expect(payload).not.toHaveProperty("version_inferred_from");
  });

  it("codificacao nova com mapa vazio ainda promove as colunas de versao (INSERT)", async () => {
    // O guard e so para response existente. Num projeto sem campos o mapa sai
    // vazio sem que isso signifique "legacy": nao ha proveniencia anterior a
    // preservar, e omitir as colunas gravaria a linha nova sem vinculo algum
    // com o schema. Este e o unico cenario que distingue o `!!existing`.
    state.pydanticFields = [];

    const saveResponse = await loadSaveResponse();
    await saveResponse("proj-1", "doc-1", {});

    expect(state.responseInsertPayload?.answer_field_hashes).toEqual({});
    expect(state.responseInsertPayload?.pydantic_hash).toBe("hash-1");
    expect(state.responseInsertPayload?.schema_version_major).toBe(1);
    expect(state.responseInsertPayload?.version_inferred_from).toBe("live_save");
  });

  it("submit que recodifica a response legacy por completo a devolve à fila latest_major (#548)", async () => {
    // Critério de aceite da #548, acoplando saveResponse a
    // responseQualifiesForVersion: uma response legacy (sentinela) recodificada
    // por inteiro num submit explícito precisa (a) estampar a proveniência
    // corrente, (b) promover pydantic_hash + schema_version e (c) voltar a
    // qualificar para o piso `latest_major`. Antes do #548 o mapa saía `{}`, as
    // colunas eram omitidas e o gate curto-circuitava em `pydantic_hash === null`.
    state.pydanticFields = [
      { name: "q1", type: "single", required: true, options: ["a", "b"], hash: "h1" },
    ];
    state.existingResponse = {
      id: "resp-1",
      is_partial: false,
      answers: { q1: "a" },
      answer_field_hashes: null,
    };

    const saveResponse = await loadSaveResponse();
    // Envio que completa o schema atual.
    await saveResponse("proj-1", "doc-1", { q1: "b" });

    // (a) proveniência corrente estampada — deixa de ser o sentinela.
    expect(state.responseUpdatePayload?.answer_field_hashes).toEqual({ q1: "h1" });
    // (b) colunas de versão promovidas.
    expect(state.responseUpdatePayload?.pydantic_hash).toBe("hash-1");
    expect(state.responseUpdatePayload?.schema_version_major).toBe(1);
    expect(state.responseUpdatePayload?.version_inferred_from).toBe("live_save");

    // (c) o payload gravado qualifica para o piso da major corrente.
    const payload = state.responseUpdatePayload as Record<string, unknown>;
    const versioned: VersionedResponse = {
      respondent_type: "humano",
      is_latest: true,
      pydantic_hash: payload.pydantic_hash as string,
      schema_version_major: payload.schema_version_major as number,
      schema_version_minor: payload.schema_version_minor as number,
      schema_version_patch: payload.schema_version_patch as number,
    };
    expect(
      responseQualifiesForVersion(
        versioned,
        { major: 1, minor: 0, patch: 0 },
        { pydanticHash: "hash-1", version: { major: 1, minor: 0, patch: 0 } },
      ),
    ).toBe(true);
  });

  it("envio com campo obrigatorio vazio mantem pendente em em_andamento", async () => {
    const saveResponse = await loadSaveResponse();
    await saveResponse("proj-1", "doc-1", { q1: "" });
    expect(state.assignmentUpdatePayload?.status).toBe("em_andamento");
  });

  it("envio incompleto rebaixa is_partial mas NAO regride o assignment concluido", async () => {
    // Os dois sinais divergem de propósito, e é este o caso que os separa: o
    // conjunto gravado deixou de estar completo (`is_partial` volta a true),
    // mas a conclusão foi um ato do pesquisador e só ele a desfaz. Quem sustenta
    // a segunda metade é o guard de `keepCodingAssignmentInProgress` — sem ele,
    // reabrir e apagar uma resposta tiraria o documento de "concluído".
    //
    // Até o #608 o mesmo cenário era alcançado pelo auto-save de navegação; hoje
    // exige um clique em Enviar, mas a invariante é a mesma.
    state.currentAssignmentStatus = "concluido";
    state.existingResponse = {
      id: "resp-1",
      is_partial: false,
      answers: { q1: "a" },
      answer_field_hashes: { q1: "h1" },
    };
    const saveResponse = await loadSaveResponse();
    await saveResponse("proj-1", "doc-1", { q1: "" });

    expect(state.responseUpdatePayload?.is_partial).toBe(true);
    // Nenhum update em assignments — o status nao muda.
    expect(state.assignmentUpdatePayload).toBeNull();
  });

  it("o envio dispara revalidatePath e revalidateTag das rotas relevantes", async () => {
    const saveResponse = await loadSaveResponse();
    await saveResponse("proj-1", "doc-1", { q1: "a" });
    expect(revalidatePath).toHaveBeenCalledWith("/projects/proj-1/analyze/code");
    expect(revalidatePath).toHaveBeenCalledWith("/projects/proj-1/analyze/compare");
    expect(revalidatePath).toHaveBeenCalledWith("/projects/proj-1/reviews");
    expect(revalidateTag).toHaveBeenCalledWith("project-proj-1-progress", { expire: 60 });
  });

  it("opts.notes serializa em justifications._notes", async () => {
    const saveResponse = await loadSaveResponse();
    await saveResponse("proj-1", "doc-1", { q1: "a" }, { notes: "comentario" });
    expect(state.responseInsertPayload?.justifications).toEqual({
      _notes: "comentario",
    });
  });
});

describe("saveResponse — documento excluído (fora do escopo aprovado)", () => {
  it("rejeita save quando o doc tem excluded_at", async () => {
    state.documentExcludedAt = "2026-07-01T00:00:00Z";
    const saveResponse = await loadSaveResponse();
    const r = await saveResponse("proj-1", "doc-1", { q1: "a" });
    expect(r).toEqual({
      success: false,
      error: "Documento removido do escopo do projeto",
    });
    expect(state.responseInsertPayload).toBeNull();
    expect(state.responseUpdatePayload).toBeNull();
  });

  it("pedido apenas PENDENTE não bloqueia o save (reversível)", async () => {
    // O guard olha só excluded_at; pendência não impede persistir dado humano.
    state.documentExcludedAt = null;
    const saveResponse = await loadSaveResponse();
    const r = await saveResponse("proj-1", "doc-1", { q1: "a" });
    expect(r.success).toBe(true);
  });
});

describe("saveResponse — unicidade da resposta corrente (#609)", () => {
  it("UPDATE endereça a linha pela CHAVE LÓGICA, nunca por id", async () => {
    // Este é o guard que impede a volta ao read-then-write: se o UPDATE
    // voltasse a filtrar por `existing.id`, quem decidiria INSERT vs UPDATE
    // seria de novo a leitura, feita em outra transação.
    state.existingResponse = { id: "resp-1", is_partial: true };
    const saveResponse = await loadSaveResponse();
    await saveResponse("proj-1", "doc-1", { q1: "a" });

    const columns = state.responseUpdateFilters.map((f) => f.column);
    expect(columns).toEqual([
      "project_id",
      "document_id",
      "respondent_id",
      "respondent_type",
      "round_id",
      "is_latest",
    ]);
    expect(state.responseUpdateFilters).toContainEqual({
      column: "respondent_id",
      value: "user-1",
    });
    expect(columns).not.toContain("id");
    expect(state.responseInsertPayload).toBeNull();
  });

  it("UPDATE que não afeta linha nenhuma cai para INSERT, mesmo com existing lido", async () => {
    // A linha foi demovida entre a leitura e a escrita (unificação de membros,
    // por exemplo). O rowcount é a autoridade, não o `existing`.
    state.existingResponse = { id: "resp-1", is_partial: true };
    state.responseUpdateMatchedRows = () => false;
    const saveResponse = await loadSaveResponse();
    const r = await saveResponse("proj-1", "doc-1", { q1: "a" });

    expect(r.success).toBe(true);
    expect(state.responseInsertPayload).not.toBeNull();
    expect(state.responseInsertPayload?.is_latest).toBe(true);
    expect(state.responseInsertPayload?.respondent_type).toBe("humano");
  });

  it("23505 do índice humano relê o estado e o segundo payload preserva o que a vencedora gravou", async () => {
    // Primeira leitura não vê linha -> INSERT -> perde a corrida. A releitura
    // enxerga a linha da vencedora, e é dela que sai o snapshot preservado
    // (#484): reaplicar o payload da primeira tentativa apagaria esse valor.
    //
    // `q2` guarda um valor que o schema atual não sabe exibir (fora das
    // opções). É exatamente o caso que o #484 protege: o formulário nunca o
    // apresentou, então o submit sem ele não significa apagar — e só se
    // preserva quem leu a linha da vencedora.
    state.existingResponse = null;
    state.existingResponseQueue = [
      null,
      {
        id: "resp-vencedora",
        is_partial: false,
        answers: { q1: "a", q2: "valor-da-vencedora" },
        answer_field_hashes: null,
      },
    ];
    state.responseInsertErrorQueue = [
      {
        code: "23505",
        message:
          'duplicate key value violates unique constraint "responses_one_latest_human_per_document"',
      },
    ];
    // Na segunda volta existe linha corrente, então o UPDATE afeta 1.
    let attempt = 0;
    state.responseUpdateMatchedRows = () => {
      attempt += 1;
      return attempt > 1;
    };
    state.pydanticFields = [
      { name: "q1", type: "single", required: true, options: ["a", "b"] },
      { name: "q2", type: "single", options: ["x", "y"] },
    ];

    const saveResponse = await loadSaveResponse();
    const r = await saveResponse("proj-1", "doc-1", { q1: "a" });

    expect(r.success).toBe(true);
    expect(state.existingReadCount).toBe(2);
    const answers = state.responseUpdatePayload?.answers as Record<string, unknown>;
    expect(answers.q2).toBe("valor-da-vencedora");
  });

  it("23505 de OUTRA constraint não vira retry — propaga o erro", async () => {
    state.existingResponse = null;
    state.responseInsertErrorQueue = [
      { code: "23505", message: 'duplicate key value violates unique constraint "outra_coisa"' },
    ];
    const saveResponse = await loadSaveResponse();
    const r = await saveResponse("proj-1", "doc-1", { q1: "a" });

    expect(r.success).toBe(false);
    expect(state.existingReadCount).toBe(1);
  });

  it("erro do trigger (23514) propaga sem retry", async () => {
    state.existingResponse = null;
    state.responseInsertErrorQueue = [
      { code: "23514", message: "codificador não pode responder documento em comparação" },
    ];
    const saveResponse = await loadSaveResponse();
    const r = await saveResponse("proj-1", "doc-1", { q1: "a" });

    expect(r).toEqual({
      success: false,
      error: "codificador não pode responder documento em comparação",
    });
    expect(state.existingReadCount).toBe(1);
  });

  it("rodada alterada atomicamente no banco devolve mensagem de recarga", async () => {
    state.existingResponse = null;
    state.responseInsertErrorQueue = [
      { code: "40001", message: "a rodada atual mudou; recarregue o formulario" },
    ];
    const saveResponse = await loadSaveResponse();
    const r = await saveResponse("proj-1", "doc-1", { q1: "a" });

    expect(r).toEqual({
      success: false,
      error: "A rodada mudou enquanto este formulário estava aberto. Recarregue a página.",
    });
    expect(state.assignmentUpdatePayload).toBeNull();
  });

  it("conflito nas DUAS tentativas devolve erro explícito, sem girar", async () => {
    state.existingResponse = null;
    const conflict = {
      code: "23505",
      message:
        'duplicate key value violates unique constraint "responses_one_latest_human_per_document"',
    };
    state.responseInsertErrorQueue = [conflict, conflict];
    const saveResponse = await loadSaveResponse();
    const r = await saveResponse("proj-1", "doc-1", { q1: "a" });

    expect(r.success).toBe(false);
    expect(state.existingReadCount).toBe(2);
  });

  it("projeto sem schema grava a resposta e NÃO sincroniza fila de codificação", async () => {
    // Sem campos não há régua de completude a aplicar, então não há status de
    // assignment a derivar. É o único caso em que o sync é pulado.
    state.pydanticFields = [];
    const saveResponse = await loadSaveResponse();
    const r = await saveResponse("proj-1", "doc-1", {});

    expect(r.success).toBe(true);
    expect(state.responseInsertPayload).not.toBeNull();
    expect(state.assignmentUpdatePayload).toBeNull();
  });

  it("falha ao LER a resposta corrente aborta o save — não cria linha nova", async () => {
    // O bug que transformava uma duplicata em série: o erro do SELECT era
    // descartado, `existing` vinha nulo e o save seguia para o INSERT.
    state.existingResponseError = { message: "timeout ao ler responses" };
    const saveResponse = await loadSaveResponse();
    const r = await saveResponse("proj-1", "doc-1", { q1: "a" });

    expect(r).toEqual({ success: false, error: "timeout ao ler responses" });
    expect(state.responseInsertPayload).toBeNull();
    expect(state.responseUpdatePayload).toBeNull();
  });
});
