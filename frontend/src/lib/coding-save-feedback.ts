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
// há régua a aplicar. `fields` é o schema que o formulário renderizou, NA ORDEM
// EM QUE ELE O RENDERIZOU — pode estar defasado em relação ao do servidor, e é
// justamente esse descompasso que produz a pendência (ver o ramo sem
// correspondência).
//
// A ordem de `fields` importa e é contratual: a pergunta nomeada aqui tem de ser
// a MESMA até a qual `pointAtFields` rola, e lá a escolha é o primeiro pendente
// na ordem de exibição. Nomear `missingNames[0]` — primeiro na ordem do schema —
// fazia o toast citar uma pergunta e a tela saltar para outra assim que a
// pesquisadora reordenava o formulário. Por isso os call sites passam
// `orderedFields`, e a busca abaixo varre `fields` (não `missingNames`).
export function notifySaved(
  missingNames: readonly string[],
  fields: readonly PydanticField[],
): void {
  if (!missingNames.length) {
    toast.success("Respostas salvas!");
    return;
  }

  const pending = new Set(missingNames);
  const first = fields.find((f) => pending.has(f.name));
  const rest = missingNames.length - 1;
  const resto = rest > 0 ? ` (e mais ${rest})` : "";

  // NENHUM dos nomes existe no schema carregado: as perguntas nasceram depois
  // que o formulário abriu, então não estão na tela e não há para onde rolar.
  // Dizer "recarregue" é a única instrução acionável aqui — mandar procurar uma
  // pergunta que não existe na página seria pior do que a mensagem genérica que
  // este PR substitui. Basta UMA ter correspondência para cairmos no ramo de
  // baixo: é para ela que a tela vai, e mandar recarregar contradiria o scroll.
  if (!first) {
    toast.warning(
      `Salvo — falta uma pergunta obrigatória criada depois que você abriu este documento${resto}. Recarregue a página para respondê-la.`,
    );
    return;
  }

  toast.warning(`Salvo — falta responder "${labelOf(first)}"${resto}`);
}
