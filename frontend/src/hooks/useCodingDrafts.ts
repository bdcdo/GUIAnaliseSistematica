import { useCallback, useEffect, useRef, useState } from "react";
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

// I/O e política do rascunho local de respostas (#608). A camada pura vive em
// `lib/coding-draft.ts`; aqui mora tudo que toca `window`.
//
// Instanciado UMA vez, em `CodingPage`, servindo os dois modos. Isso é seguro
// porque o espaço de `docId` é particionado por construção: `useBrowseCoding`
// devolve `browseDocId: null` para documento atribuído, então um mesmo id nunca
// é editado pelos dois modos.
//
// O hook não é dono das respostas — Atribuídos as guarda num reducer e Explorar
// num filho keyed. Ele é armazenamento + política, e recebe conteúdo por chamada.

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
  recovery: CodingDraftRecovery;
  isHydrated: boolean;
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
  openDocId: string | null;
  // O que o servidor entregou no render para o documento aberto.
  remote: CodingSnapshot | null;
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
export function collectCodingDraftGarbage(
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

export function useCodingDrafts(params: UseCodingDraftsParams): CodingDraftsApi {
  const { projectId, userId, enabled, openDocId } = params;

  // Refs atualizados a cada render, para que os effects de flush possam ser
  // registrados uma única vez e ainda ler o estado mais recente — mesmo padrão
  // que `useAutosaveOnExit` usa.
  const stateRef = useRef<Map<string, DocDraftState>>(new Map());
  const timersRef = useRef<Map<string, number>>(new Map());
  const keyPartsRef = useRef({ projectId, userId, enabled });
  keyPartsRef.current = { projectId, userId, enabled };
  const remoteRef = useRef(params.remote);
  remoteRef.current = params.remote;
  const fieldsRef = useRef(params.fields);
  fieldsRef.current = params.fields;

  const [recovery, setRecovery] = useState<CodingDraftRecovery>({ kind: "none" });
  const [storageAvailable, setStorageAvailable] = useState(true);
  const [staleDiscardedCount, setStaleDiscardedCount] = useState(0);
  // A tela de codificação não pode esperar hidratação atrás de um skeleton — ela
  // mostra o texto do documento a partir do servidor. `isHydrated` protege só a
  // faixa de recuperação, que é UI aditiva: um elemento que aparece, não uma
  // página que troca.
  const [isHydrated, setIsHydrated] = useState(false);
  useEffect(() => setIsHydrated(true), []);

  const persist = useCallback((docId: string, token: string) => {
    const { projectId: pid, userId: uid, enabled: on } = keyPartsRef.current;
    if (!on) return;
    const state = stateRef.current.get(docId);
    // Timer atrasado não grava conteúdo velho: o token precisa ainda ser o
    // corrente. É por isso que o debounce é indexado pelo token, não por contador.
    if (!state || !state.draft || state.writeToken !== token) return;

    const scope = scopeFor({ projectId: pid, userId: uid }, docId);
    const envelope: CodingDraftEnvelope = {
      formatVersion: CODING_DRAFT_FORMAT_VERSION,
      writeToken: token,
      userId: uid,
      projectId: pid,
      documentId: docId,
      updatedAt: Date.now(),
      base: state.base,
      draft: state.draft,
    };

    let outcome = writeSlotIfTokenMatches(scope, envelope, state.persistedToken);
    if (outcome === "unavailable") {
      // Evicção de emergência: quota estourada é recuperável se houver rascunho
      // velho nosso ocupando espaço. Só depois de tentar é que se desiste.
      const freed = collectCodingDraftGarbage(uid, Date.now(), codingDraftStorageKey(scope));
      if (freed.removed > 0) {
        outcome = writeSlotIfTokenMatches(scope, envelope, state.persistedToken);
      }
    }

    if (outcome === "written") {
      stateRef.current.set(docId, { ...state, persistedToken: token, blocked: false });
      setStorageAvailable(true);
      return;
    }
    // Falha NÃO avança `persistedToken`: a próxima edição tenta de novo. Avançá-lo
    // faria a aba colidir com o próprio lixo e nunca mais gravar na sessão.
    stateRef.current.set(docId, { ...state, blocked: outcome === "blocked" });
    if (outcome === "unavailable") setStorageAvailable(false);
  }, []);

  const scheduleWrite = useCallback(
    (docId: string, token: string) => {
      const existing = timersRef.current.get(docId);
      if (existing) window.clearTimeout(existing);
      timersRef.current.set(
        docId,
        window.setTimeout(() => {
          timersRef.current.delete(docId);
          persist(docId, token);
        }, DRAFT_DEBOUNCE_MS),
      );
    },
    [persist],
  );

  const flushAll = useCallback(() => {
    for (const [docId, timer] of timersRef.current) {
      window.clearTimeout(timer);
      const token = stateRef.current.get(docId)?.writeToken;
      if (token) persist(docId, token);
    }
    timersRef.current.clear();
  }, [persist]);

  const dropSlot = useCallback((docId: string, nextBase?: CodingSnapshot) => {
    const { projectId: pid, userId: uid } = keyPartsRef.current;
    const state = stateRef.current.get(docId);
    const timer = timersRef.current.get(docId);
    if (timer) {
      window.clearTimeout(timer);
      timersRef.current.delete(docId);
    }
    const scope = scopeFor({ projectId: pid, userId: uid }, docId);
    // Normalmente apaga-se pelo `persistedToken` — "o que esta aba gravou e
    // ainda acredita ser dela". Mas um envelope apenas OFERECIDO (escrito numa
    // sessão anterior, ainda não retomado) não tem estado em memória, e sem o
    // fallback abaixo o botão "Descartar" não apagava nada: a faixa voltaria na
    // abertura seguinte. Ler o token do slot é seguro porque
    // `deleteSlotIfTokenMatches` só remove um envelope legível cujo token bate —
    // um `newer-format`, de aba mais nova, continua intocado.
    const token = state?.persistedToken ?? readSlot(scope).envelope?.writeToken ?? null;
    deleteSlotIfTokenMatches(scope, token);
    stateRef.current.set(docId, {
      base: nextBase ?? state?.base ?? { answers: {}, notes: "" },
      draft: null,
      writeToken: null,
      persistedToken: null,
      blocked: false,
    });
  }, []);

  const recordDraft = useCallback(
    (docId: string, draft: CodingSnapshot) => {
      if (!keyPartsRef.current.enabled) return;
      const previous = stateRef.current.get(docId);
      // Sem baseline registrado não há como decidir o que é edição. Isso só
      // ocorre para um documento que nunca foi aberto — não há caminho de UI que
      // edite um documento fechado —, e inventar um baseline vazio gravaria o
      // formulário inteiro como se fosse rascunho.
      if (!previous) return;

      // Voltar ao baseline não é "rascunho vazio", é ausência de rascunho: manter
      // o envelope faria a faixa oferecer, na próxima abertura, um rascunho
      // idêntico ao que o servidor já tem.
      if (sameCodingSnapshot(draft, previous.base, fieldsRef.current)) {
        dropSlot(docId, previous.base);
        return;
      }
      const token = makeId("cdraft");
      stateRef.current.set(docId, { ...previous, draft, writeToken: token });
      scheduleWrite(docId, token);
    },
    [dropSlot, scheduleWrite],
  );

  const restoreDraft = useCallback((docId: string): CodingSnapshot | null => {
    const { projectId: pid, userId: uid } = keyPartsRef.current;
    const slot = readSlot(scopeFor({ projectId: pid, userId: uid }, docId));
    if (!slot.envelope) {
      setRecovery({ kind: "none" });
      return null;
    }
    // O envelope permanece no slot: retomar não é enviar. Assumimos a posse dele
    // para que o compare-and-swap das próximas escritas case.
    stateRef.current.set(docId, {
      base: slot.envelope.base,
      draft: slot.envelope.draft,
      writeToken: slot.envelope.writeToken,
      persistedToken: slot.envelope.writeToken,
      blocked: false,
    });
    setRecovery({ kind: "none" });
    return slot.envelope.draft;
  }, []);

  const discardDraft = useCallback(
    (docId: string) => {
      dropSlot(docId);
      setRecovery({ kind: "none" });
    },
    [dropSlot],
  );

  const submitConfirmed = useCallback(
    (docId: string, saved: CodingSnapshot) => {
      // A escrita aconteceu: o rascunho virou redundante por definição, mesmo
      // que o documento siga pendente por obrigatória em aberto. Manter deixaria
      // o indicador de "não enviado" aceso sobre trabalho que FOI enviado.
      //
      // O baseline é rebaseado para o que foi gravado — sem isso, a próxima
      // tecla criaria um rascunho cujo `base` é o seed stale do RSC, e reabrir o
      // documento depois acusaria "o documento foi salvo depois" contra uma
      // escrita nossa.
      dropSlot(docId, saved);
      setRecovery({ kind: "none" });
    },
    [dropSlot],
  );

  // Leitura e classificação ao abrir um documento. Roda pós-hidratação, fora do
  // seed do reducer: semear o formulário a partir do rascunho SERIA aplicá-lo em
  // silêncio, e a issue pede o contrário.
  useEffect(() => {
    if (!isHydrated || !enabled || !openDocId) {
      setRecovery({ kind: "none" });
      return;
    }
    const scope = scopeFor({ projectId, userId }, openDocId);
    const slot = readSlot(scope);
    setStorageAvailable(slot.available);
    if (slot.staleFormat) setStaleDiscardedCount((n) => n + 1);

    const remote = remoteRef.current ?? { answers: {}, notes: "" };

    // Abrir estabelece o baseline do documento — o hook é dono único dele a
    // partir daqui. Preserva `persistedToken` de uma edição anterior nesta mesma
    // sessão (ir e voltar entre documentos não pode fazer a aba perder a posse
    // do próprio slot).
    const previous = stateRef.current.get(openDocId);
    stateRef.current.set(openDocId, {
      base: remote,
      draft: previous?.draft ?? null,
      writeToken: previous?.writeToken ?? null,
      persistedToken: previous?.persistedToken ?? null,
      blocked: previous?.blocked ?? false,
    });

    const classified = classifyCodingDraft(slot.envelope, remote, fieldsRef.current);
    if (classified.kind === "redundant" && slot.envelope) {
      // Repete o servidor: some do caminho em vez de virar ruído recorrente.
      deleteSlotIfTokenMatches(scope, slot.envelope.writeToken);
      setRecovery({ kind: "none" });
      return;
    }
    if (classified.kind === "resumable" || classified.kind === "diverged") {
      // Posse do slot é assumida só ao retomar; até lá, apenas oferecemos.
      setRecovery(classified);
      return;
    }
    setRecovery({ kind: "none" });
  }, [isHydrated, enabled, openDocId, projectId, userId]);

  // GC uma vez por mount, pós-hidratação.
  useEffect(() => {
    if (!isHydrated || !enabled) return;
    const keep = openDocId
      ? codingDraftStorageKey(scopeFor({ projectId, userId }, openDocId))
      : null;
    const result = collectCodingDraftGarbage(userId, Date.now(), keep);
    if (result.staleDiscarded > 0) setStaleDiscardedCount((n) => n + result.staleDiscarded);
    // Roda no mount; `openDocId` entra como valor inicial apenas — reagir a cada
    // navegação transformaria o GC num custo por documento visitado.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isHydrated, enabled, userId, projectId]);

  // Flush garantido nos três gatilhos que o navegador oferece, mais o unmount.
  // O `beforeunload` aqui só persiste; quem avisa a pesquisadora é o guard de
  // navegação.
  useEffect(() => {
    const flush = () => flushAll();
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", flush);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("beforeunload", flush);
      flush();
    };
  }, [flushAll]);

  return {
    recordDraft,
    restoreDraft,
    discardDraft,
    submitConfirmed,
    recovery,
    isHydrated,
    storageAvailable,
    staleDiscardedCount,
  };
}
