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
 */
export function requestNavigation(proceed: () => void): boolean {
  if (!currentGuard) return true;
  return currentGuard(proceed);
}
