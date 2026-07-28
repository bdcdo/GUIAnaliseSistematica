import { toast } from "sonner";
import type { PydanticField } from "@/lib/types";

// Rótulo humano de um campo pendente. `description` é o enunciado que a
// pesquisadora lê no formulário; o `name` (identificador do schema) só aparece
// quando não há enunciado — melhor um nome técnico do que nenhum.
function labelOf(field: PydanticField): string {
  return field.description?.trim() || field.name;
}

// Feedback de um save bem-sucedido de codificação. Salvar com sucesso e
// concluir a codificação são coisas diferentes, e o toast precisa distingui-las:
// enquanto os dois casos diziam "Respostas salvas!", um envio que deixou
// obrigatórias em aberto — porque o schema mudou entre o carregamento do
// formulário e o envio — devolvia ao pesquisador o mesmo sinal de conclusão, e o
// documento reaparecia na fila depois. Quem lê isso conclui que a codificação
// não salvou (#519).
//
// Desde o #608 a mensagem NOMEIA a pergunta que falta, em vez de só contá-la:
// "falta 1 obrigatória" informa que algo está pendente sem dizer o quê, e o
// pesquisador que não encontra a pergunta relê a tela inteira ou conclui que o
// sistema está errado. Quando falta mais de uma, nomear a primeira e contar o
// resto — é até ela que a tela rola, então é ela que precisa ser reconhecível.
//
// `missingNames` vem do servidor e descreve o conjunto GRAVADO, não o que a tela
// mostrava; uma resposta legacy (sem schema) chega como lista vazia, porque não
// há régua a aplicar. `fields` é o schema que o formulário
// renderizou — pode estar defasado em relação ao do servidor, e é justamente
// esse descompasso que produz a pendência (ver o ramo sem correspondência).
export function notifySaved(
  missingNames: readonly string[],
  fields: readonly PydanticField[],
): void {
  if (!missingNames.length) {
    toast.success("Respostas salvas!");
    return;
  }

  const [firstName, ...rest] = missingNames;
  const known = fields.find((f) => f.name === firstName);
  const resto = rest.length === 1 ? " (e mais 1)" : rest.length ? ` (e mais ${rest.length})` : "";

  // Sem correspondência no schema carregado: a pergunta nasceu depois que o
  // formulário abriu, então ela não está na tela e não há para onde rolar.
  // Dizer "recarregue" é a única instrução acionável aqui — mandar procurar uma
  // pergunta que não existe na página seria pior do que a mensagem genérica que
  // este PR substitui.
  if (!known) {
    toast.warning(
      `Salvo — falta uma pergunta obrigatória criada depois que você abriu este documento${resto}. Recarregue a página para respondê-la.`,
    );
    return;
  }

  toast.warning(`Salvo — falta responder "${labelOf(known)}"${resto}`);
}
