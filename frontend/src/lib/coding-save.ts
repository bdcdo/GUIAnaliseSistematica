import {
  saveResponse,
  type SaveResponseOpts,
  type SaveResponseResult,
} from "@/actions/responses";

// Mensagem única desde o #608. Havia uma segunda, para o autosave de navegação,
// porque aquele save era fire-and-forget e a troca de documento já tinha
// acontecido quando o toast aparecia — "nesta página" apontaria para o lugar
// errado. Removidos os gatilhos automáticos, todo save é aguardado e o
// pesquisador continua no documento quando o toast chega.
export const CODING_SAVE_TRANSPORT_ERROR =
  "Não foi possível salvar suas respostas. Suas alterações continuam nesta página. Tente novamente sem recarregar.";

// Server Actions rejeitam a Promise quando o transporte falha antes de o
// handler executar. Normalizar essa rejeição preserva um único contrato para
// todos os callers: o rascunho só é limpo quando `success` é true.
export async function saveCodingResponse(
  projectId: string,
  documentId: string,
  answers: Record<string, unknown>,
  opts: SaveResponseOpts,
): Promise<SaveResponseResult> {
  try {
    return await saveResponse(projectId, documentId, answers, opts);
  } catch {
    return { success: false, error: CODING_SAVE_TRANSPORT_ERROR };
  }
}
