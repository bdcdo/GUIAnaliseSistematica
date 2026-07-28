// Canal entre a tela que tem trabalho não enviado e os pontos de navegação que
// a tiram de cena (#608). Existe porque `ProjectTabs` e a página de codificação
// são IRMÃOS sob o layout do projeto (`projects/[id]/layout.tsx`), não
// ancestral e descendente: nenhum provider React os cobre sem inventar um
// client wrapper novo no layout que serve todas as telas do projeto.
//
// Um registro de módulo é a forma honesta do fato que se quer transportar —
// "há trabalho não enviado NESTA aba do navegador" é propriedade da aba, não da
// árvore React. É o mesmo motivo pelo qual `useDirtyDocs` já é um store externo
// em vez de estado levantado.
//
// Deliberadamente NÃO reusa o `guardNavigation` da Comparação
// (`ComparePage.tsx`): lá o predicado VETA a navegação e não oferece saída,
// porque o veredito pendente está a um clique de ser confirmado. Aqui a
// pesquisadora precisa poder sair — o trabalho está guardado no rascunho local
// — e a única coisa que não pode acontecer é sair sem saber. Contratos opostos;
// unificá-los numa abstração só produziria uma camada que não serve bem a
// nenhum dos dois.

/**
 * Recebe o que fazer se a navegação for autorizada e devolve se ela pode
 * seguir AGORA. Ao devolver `false`, o guard assume a responsabilidade de
 * guardar `proceed` e executá-lo caso a pessoa confirme a saída — quem chamou
 * não precisa (nem deve) tentar de novo.
 */
export type UnsavedWorkGuard = (proceed: () => void) => boolean;

let currentGuard: UnsavedWorkGuard | null = null;

/**
 * Registra o guard ativo e devolve o desregistro. O desregistro é
 * **compare-and-clear**, nunca um `currentGuard = null` cego: sob StrictMode (e
 * em qualquer remontagem rápida) o React monta o substituto ANTES de rodar o
 * cleanup do anterior, então um clear incondicional desarmaria um guard vivo e
 * a tela ficaria desprotegida sem nada indicar o problema.
 */
export function registerUnsavedWorkGuard(guard: UnsavedWorkGuard): () => void {
  currentGuard = guard;
  return () => {
    if (currentGuard === guard) currentGuard = null;
  };
}

/**
 * Ponto de consulta de quem navega. Devolve `true` quando não há nada a
 * proteger — sem guard registrado (qualquer tela fora da codificação) ou com o
 * guard liberando. Devolve `false` quando a saída foi interceptada.
 *
 * Fail-open de propósito: uma tela sem trabalho pendente jamais deve ficar
 * presa por causa deste módulo.
 *
 * ATENÇÃO ao contrato assimétrico: com `true`, `proceed` **não** foi chamado —
 * navegar continua sendo responsabilidade de quem consultou. Num `<Link>` isso
 * sai de graça (a navegação nativa é o "quem consultou"), mas quem só sabe
 * navegar pelo `proceed` precisa invocá-lo: ver `navigateGuarded`.
 */
export function requestNavigation(proceed: () => void): boolean {
  if (!currentGuard) return true;
  return currentGuard(proceed);
}

/**
 * Navegação programática guardada — para quem NÃO tem navegação nativa a que
 * recorrer (um `<button>` que faz `router.push`). Fecha as duas metades do
 * contrato de `requestNavigation` num só lugar: se a saída foi liberada,
 * navega; se foi interceptada, o guard já ficou com o `proceed`.
 *
 * Existe porque a metade "liberada" é fácil de esquecer, e esquecê-la não
 * quebra nada visível na codificação (onde há guard): o botão simplesmente para
 * de funcionar em todas as OUTRAS telas, onde `requestNavigation` devolve
 * `true` de imediato.
 */
export function navigateGuarded(proceed: () => void): void {
  if (requestNavigation(proceed)) proceed();
}

/** O mínimo de um evento de clique que a decisão abaixo consulta. */
export interface GuardableClickEvent {
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  button: number;
  preventDefault: () => void;
}

/**
 * Handler de clique em `<Link>` que passa pelo guard. Compartilhado por todos os
 * links que tiram a pesquisadora da tela (abas do projeto, logo do Header): a
 * regra de qual clique conta como saída é uma só, e duplicá-la por call site é
 * como um deles fica para trás quando a regra muda.
 *
 * Clique modificado (Ctrl/Cmd/Shift/Alt, ou botão que não o principal) abre em
 * outra aba ou janela e NÃO tira ninguém desta tela — interceptá-lo mostraria um
 * aviso sobre uma saída que não vai acontecer. `event.button` é 0 nos `onClick`
 * do React, mas a checagem fica junto das outras para o dia em que algum caller
 * usar `onMouseDown`.
 *
 * NÃO cobre o botão voltar/avançar do navegador: `popstate` chega depois de a
 * navegação já ter acontecido, e o App Router não oferece um ponto de veto
 * síncrono. Fora de escopo por ora — é uma lacuna conhecida, e é justamente por
 * ela que o aviso não deve ser descrito como garantia.
 */
export function guardedLinkClick(
  event: GuardableClickEvent,
  proceed: () => void,
): void {
  if (
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey ||
    event.button !== 0
  ) {
    return;
  }
  if (requestNavigation(proceed)) return;
  event.preventDefault();
}
