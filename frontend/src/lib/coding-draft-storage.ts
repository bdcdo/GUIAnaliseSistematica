import {
  CODING_DRAFT_FORMAT_VERSION,
  classifyCodingDraft,
  codingDraftStorageKey,
  codingDraftUserPrefix,
  envelopeMatchesScope,
  readCodingDraft,
  sameCodingSnapshot,
  type CodingDraftEnvelope,
  type CodingDraftRecovery,
  type CodingDraftScope,
  type CodingSnapshot,
} from "@/lib/coding-draft";
import { makeId } from "@/lib/utils";
import type { PydanticField } from "@/lib/types";

// Acesso ao localStorage para o rascunho local de respostas (#608): leitura,
// compare-and-swap, remoção e coleta de lixo. Sem React e sem estado próprio —
// cada função recebe o escopo e devolve um resultado tipado, e nenhuma delas
// lança (storage indisponível vira `unavailable`, nunca exceção na tela).
//
// A camada acima (`useCodingDrafts`) cuida do ciclo de vida React; a de baixo
// (`lib/coding-draft.ts`) é pura e não conhece `window`.

const DRAFT_DEBOUNCE_MS = 300;

// Um slot por documento escala para centenas de chaves, e o padrão herdado de
// `useSchemaDraft` (um slot por projeto) não tem GC, TTL nem teto — lá isso
// nunca importou. Aqui importa, e as três coisas entram junto com a feature:
// quota estourada degrada em silêncio, que é exatamente o modo de falha que
// esta issue existe para eliminar.
const DRAFT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_DRAFTS_PER_USER = 100;

interface DocDraftState {
  // O que estava na tela quando este rascunho nasceu.
  base: CodingSnapshot;
  // Conteúdo pendente de escrita, ou `null` quando o documento está limpo.
  draft: CodingSnapshot | null;
  // Token do envelope que queremos gravar (rotaciona a cada edição).
  writeToken: string | null;
  // "O que esta aba gravou por último e ainda acredita ser dela". É SEMPRE por
  // ele que se apaga — nunca pelo token submetido. Ver a armadilha em
  // `useSchemaDraft.ts:369-376`: o debounce rotaciona o token durante o save, e
  // apagar pelo token errado deixa o envelope órfão E zera `persistedToken`,
  // envenenando toda escrita seguinte da sessão.
  persistedToken: string | null;
  // Slot tomado por uma aba que sabe mais (formato maior) ou por outro token.
  blocked: boolean;
}

export interface CodingDraftsApi {
  // Registra a edição corrente. Idempotente: conteúdo igual ao baseline limpa o
  // slot em vez de gravar rascunho vazio.
  //
  // O baseline NÃO é parâmetro. Ele é estabelecido na abertura do documento (a
  // partir do que o servidor entregou) e rebaseado por `submitConfirmed`, e o
  // hook é seu dono único. Quando o consumidor também o passava a cada tecla,
  // havia duas fontes para o mesmo fato e a do consumidor sempre vencia — o que
  // tornava o rebase pós-envio inobservável e deixava um `base` stale entrar no
  // envelope. Sem o parâmetro, esse estado não é construível.
  recordDraft(docId: string, draft: CodingSnapshot): void;
  // Devolve o conteúdo a aplicar e marca a oferta como resolvida. NÃO apaga o
  // envelope: retomar não é enviar, e o trabalho segue não-enviado.
  restoreDraft(docId: string): CodingSnapshot | null;
  discardDraft(docId: string): void;
  // Chamado quando o servidor confirmou a ESCRITA (`success: true`), inclusive
  // quando o documento segue pendente por obrigatória em aberto.
  submitConfirmed(docId: string, saved: CodingSnapshot): void;
  // Abre um documento: estabelece o baseline a partir do que o servidor
  // entregou e classifica o slot. Chamado de um effect pelo consumidor — e não
  // recebido como parâmetro — porque o documento ativo só é conhecido DEPOIS dos
  // hooks de modo, que por sua vez precisam do `recordDraft` daqui.
  //
  // Como a leitura do storage acontece só aqui, e effects não rodam no SSR, o
  // primeiro render do cliente é idêntico ao do servidor por construção: nenhuma
  // flag de hidratação é necessária.
  openDocument(docId: string | null, remote: CodingSnapshot | null): void;
  recovery: CodingDraftRecovery;
  storageAvailable: boolean;
  staleDiscardedCount: number;
}

export interface UseCodingDraftsParams {
  projectId: string;
  // O membro DONO da escrita (`ownMemberUserId`), nunca o observado sob
  // impersonação — ver o comentário de `CodingDraftScope`.
  userId: string;
  // `false` sob impersonação ou rodada anterior: a tela é read-only e gravar
  // rascunho ali depositaria trabalho num slot que ninguém vai enviar.
  enabled: boolean;
  fields: PydanticField[];
}

type StorageWrite = "written" | "blocked" | "unavailable";

function scopeFor(
  params: { userId: string; projectId: string },
  documentId: string,
): CodingDraftScope {
  return { userId: params.userId, projectId: params.projectId, documentId };
}

function readSlot(scope: CodingDraftScope): {
  available: boolean;
  envelope: CodingDraftEnvelope | null;
  staleFormat: boolean;
} {
  if (typeof window === "undefined") {
    return { available: false, envelope: null, staleFormat: false };
  }
  try {
    const read = readCodingDraft(window.localStorage.getItem(codingDraftStorageKey(scope)));
    if (read.kind === "draft") {
      // Segunda barreira: a chave disse que é deste documento, o conteúdo
      // precisa concordar. Discordância vira "sem rascunho", nunca aplicação
      // cruzada — ver `envelopeMatchesScope`.
      if (!envelopeMatchesScope(read.draft, scope)) {
        return { available: true, envelope: null, staleFormat: true };
      }
      return { available: true, envelope: read.draft, staleFormat: false };
    }
    return { available: true, envelope: null, staleFormat: read.kind === "stale-format" };
  } catch {
    return { available: false, envelope: null, staleFormat: false };
  }
}

function writeSlotIfTokenMatches(
  scope: CodingDraftScope,
  envelope: CodingDraftEnvelope,
  expectedToken: string | null,
): StorageWrite {
  if (typeof window === "undefined") return "unavailable";
  try {
    const key = codingDraftStorageKey(scope);
    const stored = readCodingDraft(window.localStorage.getItem(key));
    // Envelope que este build não sabe ler pertence a uma aba mais nova;
    // sobrescrevê-lo apagaria trabalho irrecuperável.
    if (stored.kind === "newer-format") return "blocked";
    const storedToken = stored.kind === "draft" ? stored.draft.writeToken : null;
    if (storedToken !== expectedToken) return "blocked";
    window.localStorage.setItem(key, JSON.stringify(envelope));
    return "written";
  } catch {
    return "unavailable";
  }
}

function deleteSlotIfTokenMatches(
  scope: CodingDraftScope,
  writeToken: string | null,
): boolean {
  if (!writeToken || typeof window === "undefined") return false;
  try {
    const key = codingDraftStorageKey(scope);
    const stored = readCodingDraft(window.localStorage.getItem(key));
    if (stored.kind !== "draft" || stored.draft.writeToken !== writeToken) return false;
    window.localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

interface GcResult {
  removed: number;
  staleDiscarded: number;
}

// Varredura escopada ao prefixo do PRÓPRIO usuário, uma vez por mount. Nunca
// toca em chave de outro usuário (numa máquina compartilhada isso seria apagar
// trabalho alheio) nem em envelope de formato maior (é de uma aba que sabe
// mais) nem no documento aberto.
function collectCodingDraftGarbage(
  userId: string,
  now: number,
  keepKey: string | null,
): GcResult {
  if (typeof window === "undefined") return { removed: 0, staleDiscarded: 0 };
  const result: GcResult = { removed: 0, staleDiscarded: 0 };
  try {
    const prefix = codingDraftUserPrefix(userId);
    const mine: Array<{ key: string; updatedAt: number }> = [];
    const doomed: string[] = [];

    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (!key || !key.startsWith(prefix) || key === keepKey) continue;
      const read = readCodingDraft(window.localStorage.getItem(key));
      if (read.kind === "newer-format") continue;
      if (read.kind !== "draft") {
        doomed.push(key);
        // "Havia trabalho aqui e não sei ler" é um fato que a pesquisadora
        // precisa saber; some do slot, não do aviso.
        if (read.kind === "stale-format") result.staleDiscarded += 1;
        continue;
      }
      const embedded = codingDraftStorageKey({
        userId: read.draft.userId,
        projectId: read.draft.projectId,
        documentId: read.draft.documentId,
      });
      if (key !== embedded) {
        // Identidade embutida discorda da chave: não dá para saber a que
        // documento o conteúdo pertence, e aplicar no errado seria pior.
        doomed.push(key);
        continue;
      }
      if (now - read.draft.updatedAt > DRAFT_TTL_MS) {
        doomed.push(key);
        continue;
      }
      mine.push({ key, updatedAt: read.draft.updatedAt });
    }

    // Teto: acima dele, sai o mais antigo primeiro.
    const overflow = mine.length + (keepKey ? 1 : 0) - MAX_DRAFTS_PER_USER;
    if (overflow > 0) {
      mine
        .toSorted((a, b) => a.updatedAt - b.updatedAt)
        .slice(0, overflow)
        .forEach((entry) => doomed.push(entry.key));
    }

    for (const key of doomed) {
      window.localStorage.removeItem(key);
      result.removed += 1;
    }
  } catch {
    // Storage indisponível: o GC é best-effort e nunca deve derrubar a tela.
  }
  return result;
}


// Sessão de rascunho: a máquina de estados por documento (debounce, posse do
// slot, descarte, abertura) fora do React.
//
// Extraída do hook porque ali ela era uma função de ~290 linhas com 20 hooks: o
// gate de complexidade a barrou, e a decomposição é a correção certa — nada aqui
// depende de render, só de eventos. O React fica com o que é dele (o estado que
// a faixa consome e os listeners de saída), e esta camada vira testável sem
// montar componente.
//
// Os `on*` são callbacks de notificação: a sessão não conhece `setState`.
export interface CodingDraftSessionCallbacks {
  onRecovery(recovery: CodingDraftRecovery): void;
  onStorageAvailable(available: boolean): void;
  onStaleDiscarded(count: number): void;
}

export interface CodingDraftSession {
  configure(keyParts: { projectId: string; userId: string; enabled: boolean }, fields: PydanticField[]): void;
  recordDraft(docId: string, draft: CodingSnapshot): void;
  restoreDraft(docId: string): CodingSnapshot | null;
  discardDraft(docId: string): void;
  submitConfirmed(docId: string, saved: CodingSnapshot): void;
  openDocument(docId: string | null, remote: CodingSnapshot | null): void;
  flushAll(): void;
}

// Estado mutável de uma sessão. Passado explicitamente às funções abaixo, que
// vivem no topo do módulo em vez de fechadas dentro da factory: uma factory com
// tudo dentro virava uma função de ~230 linhas, e o gate de complexidade a
// barrava. Como efeito colateral, cada operação fica legível isoladamente.
interface SessionState {
  states: Map<string, DocDraftState>;
  timers: Map<string, number>;
  keyParts: { projectId: string; userId: string; enabled: boolean };
  fields: PydanticField[];
  // Último documento aberto: o GC nunca evicta o slot dele.
  openDocId: string | null;
  // Distingue "nunca abriu" de "abriu o documento null": sem isto, a primeira
  // chamada com `null` cairia no guard de idempotência e o GC nunca rodaria.
  openedOnce: boolean;
}

function persist(
  st: SessionState,
  cb: CodingDraftSessionCallbacks,
  docId: string,
  token: string,
): void {
  const { projectId, userId, enabled } = st.keyParts;
  if (!enabled) return;
  const state = st.states.get(docId);
  // Timer atrasado não grava conteúdo velho: o token precisa ainda ser o
  // corrente. É por isso que o debounce é indexado pelo token, não por contador.
  if (!state?.draft || state.writeToken !== token) return;

  const scope = scopeFor({ projectId, userId }, docId);
  const envelope: CodingDraftEnvelope = {
    formatVersion: CODING_DRAFT_FORMAT_VERSION,
    writeToken: token,
    userId,
    projectId,
    documentId: docId,
    updatedAt: Date.now(),
    base: state.base,
    draft: state.draft,
  };

  let outcome = writeSlotIfTokenMatches(scope, envelope, state.persistedToken);
  if (outcome === "unavailable") {
    // Evicção de emergência: quota estourada é recuperável se houver rascunho
    // velho nosso ocupando espaço. Só depois de tentar é que se desiste.
    const freed = collectCodingDraftGarbage(userId, Date.now(), codingDraftStorageKey(scope));
    if (freed.removed > 0) {
      outcome = writeSlotIfTokenMatches(scope, envelope, state.persistedToken);
    }
  }

  if (outcome === "written") {
    st.states.set(docId, { ...state, persistedToken: token, blocked: false });
    cb.onStorageAvailable(true);
    return;
  }
  // Falha NÃO avança `persistedToken`: a próxima edição tenta de novo. Avançá-lo
  // faria a aba colidir com o próprio lixo e nunca mais gravar na sessão.
  st.states.set(docId, { ...state, blocked: outcome === "blocked" });
  if (outcome === "unavailable") cb.onStorageAvailable(false);
}

function scheduleWrite(
  st: SessionState,
  cb: CodingDraftSessionCallbacks,
  docId: string,
  token: string,
): void {
  const existing = st.timers.get(docId);
  if (existing) window.clearTimeout(existing);
  st.timers.set(
    docId,
    window.setTimeout(() => {
      st.timers.delete(docId);
      persist(st, cb, docId, token);
    }, DRAFT_DEBOUNCE_MS),
  );
}

function dropSlot(st: SessionState, docId: string, nextBase?: CodingSnapshot): void {
  const { projectId, userId } = st.keyParts;
  const state = st.states.get(docId);
  const timer = st.timers.get(docId);
  if (timer) {
    window.clearTimeout(timer);
    st.timers.delete(docId);
  }
  const scope = scopeFor({ projectId, userId }, docId);
  // Normalmente apaga-se pelo `persistedToken` — "o que esta aba gravou e ainda
  // acredita ser dela". Mas um envelope apenas OFERECIDO (escrito numa sessão
  // anterior, ainda não retomado) não tem estado em memória, e sem o fallback
  // abaixo o botão "Descartar" não apagava nada: a faixa voltaria na abertura
  // seguinte. Ler o token do slot é seguro porque `deleteSlotIfTokenMatches` só
  // remove um envelope legível cujo token bate — um `newer-format`, de aba mais
  // nova, continua intocado.
  const token = state?.persistedToken ?? readSlot(scope).envelope?.writeToken ?? null;
  deleteSlotIfTokenMatches(scope, token);
  st.states.set(docId, {
    base: nextBase ?? state?.base ?? { answers: {}, notes: "" },
    draft: null,
    writeToken: null,
    persistedToken: null,
    blocked: false,
  });
}

function recordDraftIn(
  st: SessionState,
  cb: CodingDraftSessionCallbacks,
  docId: string,
  draft: CodingSnapshot,
): void {
  if (!st.keyParts.enabled) return;
  const previous = st.states.get(docId);
  // Sem baseline registrado não há como decidir o que é edição. Isso só ocorre
  // para um documento que nunca foi aberto — não há caminho de UI que edite um
  // documento fechado —, e inventar um baseline vazio gravaria o formulário
  // inteiro como se fosse rascunho.
  if (!previous) return;

  // Voltar ao baseline não é "rascunho vazio", é ausência de rascunho: manter o
  // envelope faria a faixa oferecer, na próxima abertura, um rascunho idêntico
  // ao que o servidor já tem.
  if (sameCodingSnapshot(draft, previous.base, st.fields)) {
    dropSlot(st, docId, previous.base);
    return;
  }
  const token = makeId("cdraft");
  st.states.set(docId, { ...previous, draft, writeToken: token });
  scheduleWrite(st, cb, docId, token);
}

function openDocumentIn(
  st: SessionState,
  cb: CodingDraftSessionCallbacks,
  docId: string | null,
  remote: CodingSnapshot | null,
): void {
  const { projectId, userId, enabled } = st.keyParts;
  if (st.openedOnce && st.openDocId === docId) return;
  const firstOpen = !st.openedOnce;
  st.openedOnce = true;
  st.openDocId = docId;

  // O GC roda na PRIMEIRA abertura, não num efeito de mount: é aqui que se sabe
  // qual slot preservar. Antes disso `openDocument` ainda não foi chamado,
  // `keepKey` seria nulo, e o rascunho do documento na tela entraria na
  // varredura — expirado ou acima do teto, seria apagado debaixo da pesquisadora.
  if (firstOpen && enabled) {
    const keep = docId
      ? codingDraftStorageKey(scopeFor({ projectId, userId }, docId))
      : null;
    const collected = collectCodingDraftGarbage(userId, Date.now(), keep);
    if (collected.staleDiscarded > 0) cb.onStaleDiscarded(collected.staleDiscarded);
  }

  if (!enabled || !docId) {
    cb.onRecovery({ kind: "none" });
    return;
  }

  const scope = scopeFor({ projectId, userId }, docId);
  const slot = readSlot(scope);
  cb.onStorageAvailable(slot.available);
  if (slot.staleFormat) cb.onStaleDiscarded(1);

  const baseline = remote ?? { answers: {}, notes: "" };

  // Abrir estabelece o baseline do documento — a sessão é dona única dele a
  // partir daqui. Preserva `persistedToken` de uma edição anterior nesta mesma
  // sessão: ir e voltar entre documentos não pode fazer a aba perder a posse do
  // próprio slot.
  const previous = st.states.get(docId);
  st.states.set(docId, {
    base: previous?.draft ? previous.base : baseline,
    draft: previous?.draft ?? null,
    writeToken: previous?.writeToken ?? null,
    persistedToken: previous?.persistedToken ?? null,
    blocked: previous?.blocked ?? false,
  });

  const classified = classifyCodingDraft(slot.envelope, baseline, st.fields);
  if (classified.kind === "redundant" && slot.envelope) {
    // Repete o servidor: some do caminho em vez de virar ruído recorrente.
    deleteSlotIfTokenMatches(scope, slot.envelope.writeToken);
    cb.onRecovery({ kind: "none" });
    return;
  }
  // Posse do slot é assumida só ao retomar; até lá, apenas oferecemos.
  cb.onRecovery(
    classified.kind === "resumable" || classified.kind === "diverged"
      ? classified
      : { kind: "none" },
  );
}

export function createCodingDraftSession(
  cb: CodingDraftSessionCallbacks,
): CodingDraftSession {
  const st: SessionState = {
    states: new Map(),
    timers: new Map(),
    keyParts: { projectId: "", userId: "", enabled: false },
    fields: [],
    openDocId: null,
    openedOnce: false,
  };

  return {
    configure(keyParts, fields) {
      st.keyParts = keyParts;
      st.fields = fields;
    },
    recordDraft: (docId, draft) => recordDraftIn(st, cb, docId, draft),
    openDocument: (docId, remote) => openDocumentIn(st, cb, docId, remote),
    discardDraft(docId) {
      dropSlot(st, docId);
      cb.onRecovery({ kind: "none" });
    },
    submitConfirmed(docId, saved) {
      // A escrita aconteceu: o rascunho virou redundante por definição, mesmo
      // que o documento siga pendente por obrigatória em aberto. Manter deixaria
      // o indicador de "não enviado" aceso sobre trabalho que FOI enviado.
      //
      // O baseline é rebaseado para o que foi gravado — sem isso, a próxima
      // tecla criaria um rascunho cujo `base` é o seed stale do RSC, e reabrir o
      // documento depois acusaria "o documento foi salvo depois" contra uma
      // escrita nossa.
      dropSlot(st, docId, saved);
      cb.onRecovery({ kind: "none" });
    },
    restoreDraft(docId) {
      const { projectId, userId } = st.keyParts;
      const slot = readSlot(scopeFor({ projectId, userId }, docId));
      if (!slot.envelope) {
        cb.onRecovery({ kind: "none" });
        return null;
      }
      // O envelope permanece no slot: retomar não é enviar. Assumimos a posse
      // dele para que o compare-and-swap das próximas escritas case.
      st.states.set(docId, {
        base: slot.envelope.base,
        draft: slot.envelope.draft,
        writeToken: slot.envelope.writeToken,
        persistedToken: slot.envelope.writeToken,
        blocked: false,
      });
      cb.onRecovery({ kind: "none" });
      return slot.envelope.draft;
    },
    flushAll() {
      for (const [docId, timer] of st.timers) {
        window.clearTimeout(timer);
        const token = st.states.get(docId)?.writeToken;
        if (token) persist(st, cb, docId, token);
      }
      st.timers.clear();
    },
  };
}
