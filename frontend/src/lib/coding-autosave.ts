import {
  saveResponse,
  type SaveResponseOpts,
  type SaveResponseResult,
} from "@/actions/responses";
import { toast } from "sonner";

// Duas mensagens porque os dois caminhos deixam o pesquisador em lugares
// diferentes quando o transporte falha. No save aguardado (Enviar / Voltar) ele
// continua no documento, e pedir retry sem recarregar é a instrução correta. No
// autosave de navegação (`autosaveDirtyDoc`) o save é fire-and-forget e a troca
// de documento já aconteceu quando o toast aparece — dizer "nesta página"
// apontaria para o lugar errado.
export const CODING_SAVE_TRANSPORT_ERROR =
  "Não foi possível salvar suas respostas. Suas alterações continuam nesta página. Tente novamente sem recarregar.";

export const CODING_AUTOSAVE_TRANSPORT_ERROR =
  "Não foi possível salvar automaticamente. As respostas continuam no documento, que segue pendente. Volte a ele e envie novamente, sem recarregar.";

// Server Actions rejeitam a Promise quando o transporte falha antes de o
// handler executar. Normalizar essa rejeição preserva um único contrato para
// todos os callers: o rascunho só é limpo quando `success` é true.
//
// `transportError` é parâmetro porque só o caller sabe onde o pesquisador vai
// estar quando o toast aparecer — ver o comentário das duas constantes acima.
export async function saveCodingResponse(
  projectId: string,
  documentId: string,
  answers: Record<string, unknown>,
  opts: SaveResponseOpts = {},
  transportError: string = CODING_SAVE_TRANSPORT_ERROR,
): Promise<SaveResponseResult> {
  try {
    return await saveResponse(projectId, documentId, answers, opts);
  } catch {
    return { success: false, error: transportError };
  }
}

interface AutosaveDirtyDocParams {
  projectId: string;
  docId: string;
  answers: Record<string, unknown>;
  notes: string;
  /**
   * Único callback de sucesso, e não um par `markClean` + "rebaseia o rascunho":
   * uma escrita confirmada produz DOIS efeitos que precisam acontecer juntos —
   * limpar a sujeira e reassentar o baseline do rascunho local no que foi
   * gravado. Com dois parâmetros, um call site podia passar só o primeiro, e foi
   * exatamente o que aconteceu quando o rascunho local (#608) entrou: a
   * navegação salvava, limpava a sujeira e deixava o envelope para trás, e
   * reabrir o documento oferecia "alterações não enviadas" sobre trabalho já
   * enviado. Com um callback só, esse estado não é construível.
   *
   * Recebe o snapshot GRAVADO para que o caller não precise recompor o que
   * acabou de mandar ao servidor.
   */
  onSaved: (docId: string, saved: { answers: Record<string, unknown>; notes: string }) => void;
}

/**
 * Autosave fire-and-forget de um doc sujo ao navegar (trocar de doc ou de
 * ordenação no modo Atribuídos). Salva com `isAutoSave: true`, notifica o
 * caller no sucesso (ver `onSaved`) e mostra toast no erro. O caller é
 * responsável pelo guard de `isDirty` antes de chamar.
 *
 * O back do modo Explorar NÃO usa este helper: lá o save é aguardado (`await`)
 * para manter o rascunho intacto se falhar (#257) — semântica diferente.
 */
export function autosaveDirtyDoc({
  projectId,
  docId,
  answers,
  notes,
  onSaved,
}: AutosaveDirtyDocParams): void {
  void saveCodingResponse(
    projectId,
    docId,
    answers,
    { notes, isAutoSave: true },
    CODING_AUTOSAVE_TRANSPORT_ERROR,
  )
    .then((result) => {
      if (result.success) {
        onSaved(docId, { answers, notes });
      } else {
        toast.error(result.error);
      }
    })
    // `saveCodingResponse` não rejeita — este `catch` cobre o que vem DEPOIS do
    // save (`onSaved` do caller, render do toast). Sem ele vira unhandled
    // rejection, e o `void` já satisfaz o `no-floating-promises`, então nenhum
    // gate reclamaria. O doc simplesmente segue sujo, que é o estado seguro.
    .catch(() => {});
}
