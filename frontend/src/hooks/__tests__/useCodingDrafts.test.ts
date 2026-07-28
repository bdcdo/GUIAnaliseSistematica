// @vitest-environment jsdom
//
// I/O e política do rascunho local de respostas (#608). O que se fixa aqui é
// aquilo de que a promessa "fechar a aba não perde trabalho" depende: o debounce
// e seus flushes, o compare-and-swap entre abas, o GC que impede a quota de
// degradar em silêncio, e o descarte no envio confirmado. A classificação pura
// é coberta por `lib/__tests__/coding-draft.test.ts`.
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCodingDrafts, type UseCodingDraftsParams } from "../useCodingDrafts";
import {
  CODING_DRAFT_FORMAT_VERSION,
  codingDraftStorageKey,
  parseCodingDraft,
  type CodingSnapshot,
} from "@/lib/coding-draft";
import type { PydanticField } from "@/lib/types";

const FIELDS: PydanticField[] = [
  { name: "q1", type: "text", options: null, description: "" },
  { name: "q2", type: "text", options: null, description: "" },
];

const USER = "user-1";
const PROJECT = "project-1";
const DOC = "doc-1";
const KEY = codingDraftStorageKey({ userId: USER, projectId: PROJECT, documentId: DOC });

const EMPTY: CodingSnapshot = { answers: {}, notes: "" };
const snap = (answers: Record<string, unknown>, notes = ""): CodingSnapshot => ({
  answers,
  notes,
});

beforeEach(() => {
  window.localStorage.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// `openDocument` é o que estabelece o baseline e classifica o slot; no app ele é
// chamado de um effect do `CodingPage`, aqui é chamado explicitamente.
function render(
  over: Partial<UseCodingDraftsParams> & {
    openDocId?: string | null;
    remote?: CodingSnapshot | null;
  } = {},
) {
  const { openDocId = DOC, remote = EMPTY, ...rest } = over;
  const params: UseCodingDraftsParams = {
    projectId: PROJECT,
    userId: USER,
    enabled: true,
    fields: FIELDS,
    ...rest,
  };
  const view = renderHook((p: UseCodingDraftsParams) => useCodingDrafts(p), {
    initialProps: params,
  });
  act(() => {
    view.result.current.openDocument(openDocId, remote);
  });
  return view;
}

const flushDebounce = () => {
  act(() => {
    vi.advanceTimersByTime(300);
  });
};

const stored = (key = KEY) => parseCodingDraft(window.localStorage.getItem(key));

// Planta um envelope no localStorage. Os defaults vivem na desestruturação, e
// não em `??` por campo: além de mais curto, é o que mantém o helper abaixo do
// limiar de complexidade do gate.
function plant(
  over: Partial<{
    key: string;
    userId: string;
    projectId: string;
    documentId: string;
    writeToken: string;
    updatedAt: number;
    base: CodingSnapshot;
    draft: CodingSnapshot;
    formatVersion: number;
  }> = {},
) {
  const {
    userId = USER,
    projectId = PROJECT,
    documentId = DOC,
    writeToken = "tok-plantado",
    updatedAt = Date.now(),
    base = EMPTY,
    draft = snap({ q1: "do rascunho" }),
    formatVersion = CODING_DRAFT_FORMAT_VERSION,
    key = codingDraftStorageKey({ userId, projectId, documentId }),
  } = over;

  window.localStorage.setItem(
    key,
    JSON.stringify({
      formatVersion,
      writeToken,
      userId,
      projectId,
      documentId,
      updatedAt,
      base,
      draft,
    }),
  );
  return key;
}

describe("gravação e debounce", () => {
  it("não grava antes do debounce e grava depois", () => {
    const { result } = render();
    act(() => result.current.recordDraft(DOC, snap({ q1: "a" })));
    expect(stored()).toBeNull();
    flushDebounce();
    expect(stored()?.draft.answers).toEqual({ q1: "a" });
  });

  // Mutação vermelha: escrever a cada chamada em vez de reagendar. O debounce é
  // indexado pelo token justamente para que um timer atrasado não grave conteúdo
  // velho por cima do novo.
  it("edições sucessivas deixam um único envelope, com o conteúdo mais recente", () => {
    const { result } = render();
    act(() => result.current.recordDraft(DOC, snap({ q1: "a" })));
    act(() => result.current.recordDraft(DOC, snap({ q1: "ab" })));
    flushDebounce();
    expect(stored()?.draft.answers).toEqual({ q1: "ab" });
    expect(window.localStorage.length).toBe(1);
  });

  it("grava as notas junto das respostas", () => {
    const { result } = render();
    act(() => result.current.recordDraft(DOC, snap({}, "minha nota")));
    flushDebounce();
    expect(stored()?.draft.notes).toBe("minha nota");
  });

  // Voltar ao baseline é ausência de rascunho, não rascunho vazio. Mutação
  // vermelha: gravar sempre — a faixa passaria a oferecer, na abertura seguinte,
  // um rascunho idêntico ao que o servidor já tem.
  it("desfazer até o baseline apaga o slot", () => {
    const { result } = render();
    act(() => result.current.recordDraft(DOC, snap({ q1: "a" })));
    flushDebounce();
    expect(stored()).not.toBeNull();
    act(() => result.current.recordDraft(DOC, EMPTY));
    flushDebounce();
    expect(stored()).toBeNull();
  });

  it("o envelope carrega a identidade do escopo", () => {
    const { result } = render();
    act(() => result.current.recordDraft(DOC, snap({ q1: "a" })));
    flushDebounce();
    expect(stored()).toMatchObject({ userId: USER, projectId: PROJECT, documentId: DOC });
  });

  // O baseline é estabelecido ao abrir o documento, e o hook é seu dono único.
  // Mutação vermelha: cair para um baseline vazio quando não há registro — o
  // formulário inteiro seria gravado como se fosse edição da pesquisadora.
  it("não grava rascunho de documento que nunca foi aberto", () => {
    const { result } = render();
    act(() => result.current.recordDraft("doc-nunca-aberto", snap({ q1: "a" })));
    flushDebounce();
    expect(window.localStorage.length).toBe(0);
  });

  // Sob impersonação a tela é read-only; gravar ali depositaria trabalho num
  // slot que ninguém vai enviar. Mutação vermelha: ignorar `enabled`.
  it("com `enabled: false` não escreve nada", () => {
    const { result } = render({ enabled: false });
    act(() => result.current.recordDraft(DOC, snap({ q1: "a" })));
    flushDebounce();
    expect(window.localStorage.length).toBe(0);
  });
});

describe("flush — os gatilhos de que depende 'fechar a aba não perde trabalho'", () => {
  // `pagehide` dispara em TODO descarregamento da página, inclusive nos que um
  // `beforeunload` pegaria — por isso este hook não registra o segundo: ele não
  // acrescentaria cobertura e tiraria a página do back/forward cache no Firefox
  // e no Safari. O `beforeunload` de `useAutosaveOnExit` é outro caso: lá ele
  // serve ao aviso nativo do navegador, que só existe por meio dele.
  it("pagehide persiste antes do debounce", () => {
    const { result } = render();
    act(() => result.current.recordDraft(DOC, snap({ q1: "a" })));
    expect(stored()).toBeNull();
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(stored()?.draft.answers).toEqual({ q1: "a" });
  });

  it("visibilitychange com a aba oculta persiste; visível não", () => {
    const { result } = render();
    act(() => result.current.recordDraft(DOC, snap({ q1: "a" })));

    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(stored()).toBeNull();

    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(stored()?.draft.answers).toEqual({ q1: "a" });
  });

  it("unmount antes do debounce persiste", () => {
    const { result, unmount } = render();
    act(() => result.current.recordDraft(DOC, snap({ q1: "a" })));
    act(() => {
      unmount();
    });
    expect(stored()?.draft.answers).toEqual({ q1: "a" });
  });
});

describe("recuperação — oferecer, nunca aplicar em silêncio", () => {
  it("oferece o rascunho plantado ao abrir o documento", () => {
    plant({ draft: snap({ q1: "do rascunho" }) });
    const { result } = render();
    expect(result.current.recovery).toMatchObject({
      kind: "resumable",
      changedFields: ["q1"],
    });
  });

  // Mutação vermelha: aplicar o conteúdo no `recovery` sem passar por
  // `restoreDraft`. Oferecer e aplicar são coisas diferentes — é o requisito
  // central da issue.
  it("`restoreDraft` é o que devolve o conteúdo, e ele sobrevive no slot", () => {
    plant({ draft: snap({ q1: "do rascunho" }) });
    const { result } = render();
    let applied: CodingSnapshot | null = null;
    act(() => {
      applied = result.current.restoreDraft(DOC);
    });
    expect(applied).toEqual(snap({ q1: "do rascunho" }));
    // Retomar não é enviar: o trabalho segue não-enviado e o envelope fica.
    expect(stored()).not.toBeNull();
    expect(result.current.recovery.kind).toBe("none");
  });

  it("`discardDraft` apaga o slot e a oferta não volta", () => {
    plant();
    const { result } = render();
    expect(result.current.recovery.kind).toBe("resumable");
    act(() => result.current.discardDraft(DOC));
    expect(stored()).toBeNull();
    expect(result.current.recovery.kind).toBe("none");
  });

  it("rascunho que repete o servidor não é oferecido e é limpo do slot", () => {
    plant({ draft: snap({ q1: "igual" }) });
    const { result } = render({ remote: snap({ q1: "igual" }) });
    expect(result.current.recovery.kind).toBe("none");
    expect(stored()).toBeNull();
  });

  it("servidor que andou desde o rascunho é oferecido como `diverged`", () => {
    plant({ base: snap({ q1: "antigo" }), draft: snap({ q1: "rascunho" }) });
    const { result } = render({ remote: snap({ q1: "servidor-novo" }) });
    expect(result.current.recovery).toMatchObject({
      kind: "diverged",
      overwrittenFields: ["q1"],
    });
  });

  // Mutação vermelha: remover a checagem de escopo em `readSlot`. Aplicar as
  // respostas de um documento em outro é dado de pesquisa fabricado em silêncio.
  it("envelope cuja identidade discorda da chave não é oferecido", () => {
    plant({ key: KEY, documentId: "outro-doc" });
    const { result } = render();
    expect(result.current.recovery.kind).toBe("none");
  });

  it("sem documento aberto não há oferta", () => {
    plant();
    const { result } = render({ openDocId: null });
    expect(result.current.recovery.kind).toBe("none");
  });
});

describe("envio confirmado", () => {
  // O teste que fixa a decisão de desenho: `success: true` significa que a
  // escrita aconteceu, mesmo com obrigatória em aberto. Mutação vermelha:
  // preservar o rascunho quando o documento segue pendente — o indicador de
  // "não enviado" ficaria aceso sobre trabalho que FOI enviado.
  it("descarta o rascunho mesmo quando o documento segue pendente", () => {
    const { result } = render();
    act(() => result.current.recordDraft(DOC, snap({ q1: "a" })));
    flushDebounce();
    expect(stored()).not.toBeNull();

    act(() => result.current.submitConfirmed(DOC, snap({ q1: "a" })));
    expect(stored()).toBeNull();
  });

  // Mutação vermelha: não rebasear (`dropSlot(docId)` sem o snapshot salvo).
  // Sem o rebase, a próxima tecla nasce com o `base` do seed stale do RSC e
  // reabrir o documento acusaria "o documento foi salvo depois" contra uma
  // escrita nossa.
  it("rebaseia o baseline no que foi gravado", () => {
    const { result } = render();
    act(() => result.current.recordDraft(DOC, snap({ q1: "a" })));
    flushDebounce();
    act(() => result.current.submitConfirmed(DOC, snap({ q1: "a" })));

    // Continuar digitando depois do envio: o novo rascunho parte do que foi
    // gravado, então voltar ao valor enviado limpa o slot em vez de virar diff.
    act(() => result.current.recordDraft(DOC, snap({ q1: "a" })));
    flushDebounce();
    expect(stored()).toBeNull();

    act(() => result.current.recordDraft(DOC, snap({ q1: "ab" })));
    flushDebounce();
    expect(stored()?.base.answers).toEqual({ q1: "a" });
  });
});

describe("compare-and-swap entre abas", () => {
  // A decisão da chave por documento, provada. Mutação vermelha: uma chave por
  // projeto — a segunda aba ficaria `blocked` permanentemente contra a primeira,
  // perdendo a rede de proteção inteira num fluxo corriqueiro.
  it("duas abas em documentos diferentes não se bloqueiam", () => {
    const a = render({ openDocId: "doc-a", remote: EMPTY });
    const b = render({ openDocId: "doc-b", remote: EMPTY });

    act(() => a.result.current.recordDraft("doc-a", snap({ q1: "de A" })));
    act(() => b.result.current.recordDraft("doc-b", snap({ q1: "de B" })));
    flushDebounce();

    const keyA = codingDraftStorageKey({ userId: USER, projectId: PROJECT, documentId: "doc-a" });
    const keyB = codingDraftStorageKey({ userId: USER, projectId: PROJECT, documentId: "doc-b" });
    expect(stored(keyA)?.draft.answers).toEqual({ q1: "de A" });
    expect(stored(keyB)?.draft.answers).toEqual({ q1: "de B" });
  });

  // Mutação vermelha: remover o compare-and-swap. Duas abas no MESMO documento
  // são conflito de verdade, e a segunda não pode apagar o envelope da primeira.
  it("envelope de formato maior não é sobrescrito", () => {
    plant({ formatVersion: CODING_DRAFT_FORMAT_VERSION + 1 });
    const { result } = render();
    act(() => result.current.recordDraft(DOC, snap({ q1: "meu" })));
    flushDebounce();
    const rawStored = JSON.parse(window.localStorage.getItem(KEY) ?? "{}");
    expect(rawStored.formatVersion).toBe(CODING_DRAFT_FORMAT_VERSION + 1);
  });

  it("slot tomado por outro token não é sobrescrito", () => {
    const { result } = render();
    act(() => result.current.recordDraft(DOC, snap({ q1: "meu" })));
    flushDebounce();
    // Outra aba assume o slot entre duas escritas nossas.
    plant({ writeToken: "de-outra-aba", draft: snap({ q1: "da outra aba" }) });
    act(() => result.current.recordDraft(DOC, snap({ q1: "meu 2" })));
    flushDebounce();
    expect(stored()?.draft.answers).toEqual({ q1: "da outra aba" });
  });

  // Mutação vermelha: reportar `storageAvailable: false` só no caso
  // `unavailable`, deixando o `blocked` calado. Esta aba não está mantendo cópia
  // local nenhuma — não avisar é a mesma mentira que o indicador de "não
  // enviado" existe para eliminar, só que sobre a outra metade da promessa.
  it("slot tomado por outra aba avisa que a cópia local não está funcionando", () => {
    const { result } = render();
    expect(result.current.storageAvailable).toBe(true);

    plant({ writeToken: "de-outra-aba", draft: snap({ q1: "da outra aba" }) });
    act(() => result.current.recordDraft(DOC, snap({ q1: "meu" })));
    act(() => flushDebounce());

    expect(result.current.storageAvailable).toBe(false);
  });
});

describe("GC — a peça que impede a quota de degradar em silêncio", () => {
  const otherDocKey = (docId: string, userId = USER) =>
    codingDraftStorageKey({ userId, projectId: PROJECT, documentId: docId });

  it("apaga rascunho além do TTL", () => {
    const velho = otherDocKey("doc-velho");
    plant({ documentId: "doc-velho", updatedAt: Date.now() - 31 * 24 * 60 * 60 * 1000 });
    render();
    expect(window.localStorage.getItem(velho)).toBeNull();
  });

  it("preserva rascunho dentro do TTL", () => {
    plant({ documentId: "doc-recente", updatedAt: Date.now() - 1000 });
    render();
    expect(window.localStorage.getItem(otherDocKey("doc-recente"))).not.toBeNull();
  });

  // Mutação vermelha: varrer sem o prefixo do usuário. Numa máquina
  // compartilhada isso apaga o trabalho de um colega.
  it("nunca toca no slot de outro usuário, mesmo expirado", () => {
    plant({
      userId: "outro-user",
      documentId: "doc-x",
      updatedAt: Date.now() - 99 * 24 * 60 * 60 * 1000,
    });
    render();
    expect(window.localStorage.getItem(otherDocKey("doc-x", "outro-user"))).not.toBeNull();
  });

  // Mutação vermelha: tratar `newer-format` como lixo. É de uma aba que sabe
  // mais — apagá-lo destrói trabalho que não temos como recuperar.
  it("nunca apaga envelope de formato maior", () => {
    plant({
      documentId: "doc-novo",
      formatVersion: CODING_DRAFT_FORMAT_VERSION + 1,
      updatedAt: Date.now() - 99 * 24 * 60 * 60 * 1000,
    });
    render();
    expect(window.localStorage.getItem(otherDocKey("doc-novo"))).not.toBeNull();
  });

  // Mutação vermelha: não excluir `keepKey` da varredura — o GC apagaria o
  // rascunho do documento que está aberto na tela.
  it("nunca evicta o documento aberto, mesmo expirado", () => {
    plant({ documentId: DOC, updatedAt: Date.now() - 99 * 24 * 60 * 60 * 1000 });
    render();
    expect(window.localStorage.getItem(KEY)).not.toBeNull();
  });

  // Formato antigo não é recuperável por este build: ocupa quota e não pode ser
  // aplicado. Sai como qualquer outro lixo — o que NÃO pode sair é o de formato
  // MAIOR, coberto pelo caso acima.
  it("apaga envelope de formato antigo", () => {
    window.localStorage.setItem(otherDocKey("doc-lixo"), JSON.stringify({ formatVersion: 0 }));
    render();
    expect(window.localStorage.getItem(otherDocKey("doc-lixo"))).toBeNull();
  });

  it("apaga envelope cuja identidade embutida discorda da chave", () => {
    const key = otherDocKey("doc-mentiroso");
    plant({ key, documentId: "outro-completamente" });
    render();
    expect(window.localStorage.getItem(key)).toBeNull();
  });
});

describe("indisponibilidade do storage", () => {
  // Mutação vermelha: engolir a exceção e continuar reportando disponível. A
  // tela precisa poder avisar que a cópia local caiu — o indicador de "não
  // enviado" vem da sujeira em memória, não daqui, e os dois sinais são
  // distintos de propósito.
  it("quota estourada não lança e reporta `storageAvailable: false`", () => {
    const { result } = render();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("cheio", "QuotaExceededError");
    });
    act(() => result.current.recordDraft(DOC, snap({ q1: "a" })));
    flushDebounce();
    expect(result.current.storageAvailable).toBe(false);
  });

  // Mutação vermelha: avançar `persistedToken` mesmo em falha. A aba passaria a
  // colidir com o próprio lixo e nunca mais gravaria na sessão.
  it("depois de uma falha transitória, a próxima edição volta a gravar", () => {
    const { result } = render();
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => {
      throw new DOMException("cheio", "QuotaExceededError");
    });
    act(() => result.current.recordDraft(DOC, snap({ q1: "a" })));
    flushDebounce();
    expect(stored()).toBeNull();

    setItem.mockRestore();
    act(() => result.current.recordDraft(DOC, snap({ q1: "ab" })));
    flushDebounce();
    expect(stored()?.draft.answers).toEqual({ q1: "ab" });
    expect(result.current.storageAvailable).toBe(true);
  });
});
