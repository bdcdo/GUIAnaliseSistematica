import { describe, it, expect, vi, beforeEach } from "vitest";
import { toast } from "sonner";
import { notifySaved } from "@/lib/coding-save-feedback";
import type { PydanticField } from "@/lib/types";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), warning: vi.fn() },
}));

beforeEach(() => {
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.warning).mockClear();
});

const field = (name: string, description?: string): PydanticField =>
  ({ name, type: "text", options: null, description }) as PydanticField;

const FIELDS = [
  field("deferimento", "Houve deferimento do pedido?"),
  field("valor", "Valor da condenação"),
  field("sem_enunciado", ""),
];

// A distinção "salvo" vs "concluído" é a metade cliente do #519: um envio que
// deixou obrigatórias em aberto não pode devolver o mesmo sinal de conclusão. Uma
// troca warning→success ou um erro de plural aqui passaria por todos os gates —
// por isso as strings exatas são fixadas.
//
// Desde o #608 a mensagem NOMEIA a pergunta: "falta 1 obrigatória" dizia que algo
// estava pendente sem dizer o quê, e quem não achava a pergunta concluía que o
// sistema tinha errado. As asserções abaixo fixam o enunciado porque é ele — e
// não o nome técnico do campo — que a pesquisadora reconhece na tela.
describe("notifySaved — feedback de save distingue salvo × pendente", () => {
  it("lista vazia (inclui o legacy, sem régua) → sucesso", () => {
    // `[]` é truthy em JS: se o ramo de pendência testasse a lista em vez do
    // tamanho dela, uma codificação COMPLETA receberia o aviso de pendência.
    // É também a forma em que chega uma resposta legacy, sem schema a avaliar.
    notifySaved([], FIELDS);
    expect(toast.success).toHaveBeenCalledWith("Respostas salvas!");
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it("1 obrigatória em aberto → aviso nomeando o enunciado", () => {
    notifySaved(["deferimento"], FIELDS);
    expect(toast.warning).toHaveBeenCalledWith(
      'Salvo — falta responder "Houve deferimento do pedido?"',
    );
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("N obrigatórias → nomeia a primeira e conta o resto", () => {
    // É até a PRIMEIRA que a tela rola (ver `pointAtFields`), então é ela que
    // precisa ser reconhecível; o resto vira contagem.
    notifySaved(["deferimento", "valor"], FIELDS);
    expect(toast.warning).toHaveBeenCalledWith(
      'Salvo — falta responder "Houve deferimento do pedido?" (e mais 1)',
    );
  });

  it("mais de duas → plural na contagem do resto", () => {
    notifySaved(["deferimento", "valor", "sem_enunciado"], FIELDS);
    expect(toast.warning).toHaveBeenCalledWith(
      'Salvo — falta responder "Houve deferimento do pedido?" (e mais 2)',
    );
  });

  it("campo sem enunciado cai no nome técnico, não em string vazia", () => {
    notifySaved(["sem_enunciado"], FIELDS);
    expect(toast.warning).toHaveBeenCalledWith(
      'Salvo — falta responder "sem_enunciado"',
    );
  });

  it("campo ausente do schema carregado → manda recarregar, não procurar na tela", () => {
    // O caso que produz a pendência: a pergunta nasceu DEPOIS que o formulário
    // abriu, então ela não está na tela e não há para onde rolar. Mandar
    // procurá-la seria pior do que a mensagem genérica que o #608 substituiu.
    notifySaved(["criado_depois"], FIELDS);
    const [msg] = vi.mocked(toast.warning).mock.calls[0] as [string];
    expect(msg).toContain("criada depois que você abriu este documento");
    expect(msg).toContain("Recarregue a página");
    expect(msg).not.toContain("criado_depois");
  });

  // As duas asserções abaixo fixam a mesma invariante por dois ângulos: a
  // pergunta NOMEADA aqui tem de ser a MESMA até a qual `pointAtFields` rola, e
  // lá a escolha é o primeiro pendente na ordem em que o formulário renderiza.
  // Enquanto isto lia `missingNames[0]` — a ordem do SCHEMA —, o toast citava uma
  // pergunta e a tela saltava para outra.
  it("nomeia pela ordem de `fields`, não pela ordem em que o servidor listou", () => {
    // A pesquisadora arrastou "valor" para cima de "deferimento": é "valor" que
    // ela vê primeiro, e é para ele que a tela vai.
    const reordenado = [FIELDS[1]!, FIELDS[0]!, FIELDS[2]!];
    notifySaved(["deferimento", "valor"], reordenado);
    expect(toast.warning).toHaveBeenCalledWith(
      'Salvo — falta responder "Valor da condenação" (e mais 1)',
    );
  });

  it("nome desconhecido primeiro não engole o conhecido que vem depois", () => {
    // Basta UMA pendência estar na tela para o scroll acontecer. Mandar
    // recarregar aqui contradiria o que a página faz no mesmo instante.
    notifySaved(["criado_depois", "deferimento"], FIELDS);
    expect(toast.warning).toHaveBeenCalledWith(
      'Salvo — falta responder "Houve deferimento do pedido?" (e mais 1)',
    );
  });

  it("só manda recarregar quando NENHUM dos nomes está na tela", () => {
    notifySaved(["criado_depois", "outro_novo"], FIELDS);
    const [msg] = vi.mocked(toast.warning).mock.calls[0] as [string];
    expect(msg).toContain("criada depois que você abriu este documento");
    expect(msg).toContain("(e mais 1)");
  });
});
