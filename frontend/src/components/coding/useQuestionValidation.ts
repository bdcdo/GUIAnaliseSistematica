import { useCallback, useMemo, useState, type RefObject } from "react";
import { toast } from "sonner";
import { getScrollBehavior } from "@/lib/scroll";
import { isFieldAnswered, requiredHumanFields } from "@/lib/coding-completeness";
import type { PydanticField } from "@/lib/types";

/**
 * Handler de envio de uma codificação. Resolve com os NOMES das obrigatórias que
 * o servidor ainda considera em aberto no conjunto gravado — vazio/`undefined`
 * quando a codificação ficou completa, ou quando o envio nem chegou a acontecer
 * (erro de transporte, guard de save em voo). É por este valor de retorno, e não
 * por um canal de estado à parte, que o veredito do servidor chega ao painel:
 * quem sabe rolar até a pergunta é o `QuestionsPanel`, dono dos refs, e quem
 * sabe o veredito é o container que fez a escrita.
 */
export type CodingSubmitHandler = () =>
  | void
  | Promise<readonly string[] | undefined>;

/**
 * Estado de destaque de obrigatórias faltantes + validação de envio. O
 * highlight de um campo some assim que ele recebe resposta (`handleAnswerWithClear`),
 * e a validação de envio bloqueia por `submitting`/`outOfScopeBlocked` além de
 * checar as obrigatórias visíveis.
 */
export function useQuestionValidation(
  visibleFields: PydanticField[],
  answers: Record<string, unknown>,
  onAnswer: (fieldName: string, value: unknown) => void,
  onSubmit: CodingSubmitHandler,
  submitting: boolean,
  outOfScopeBlocked: boolean,
  questionRefs: RefObject<(HTMLDivElement | null)[]>,
): {
  highlightedFields: Set<string>;
  isAnswered: (field: PydanticField) => boolean;
  handleAnswerWithClear: (fieldName: string, value: unknown) => void;
  handleSubmitWithValidation: () => void;
  requiredFields: PydanticField[];
  answeredRequiredCount: number;
  missingRequiredCount: number;
} {
  const [highlightedFields, setHighlightedFields] = useState<Set<string>>(new Set());

  // Contagem e bloqueio derivam da MESMA régua canônica do servidor
  // (`requiredHumanFields`/`isFieldAnswered`, coding-completeness.ts). Sem
  // `answerFieldHashes` = staleness-blind, igual ao gate inline de saveResponse
  // (coding-sync.ts). Antes esta contagem usava `visibleFields.filter(resolveRequired)`,
  // que incluía `llm_only` no denominador (o bloqueio já o excluía), fazendo o
  // header mostrar "N-1/N" para sempre com o submit liberado.
  // Memoizado para estabilizar a identidade de `requiredFields` (dep de
  // `handleSubmitWithValidation`) entre renders sem mudança de campos/respostas.
  //
  // O cliente ser staleness-blind é de propósito: opera sempre contra o schema
  // atual carregado no formulário, não contra o carimbo de uma escrita anterior.
  // A assimetria com o gate de `is_partial` (staleness-aware, ver
  // coding-completeness) é intencional — ao reeditar um doc cujo schema cresceu, o
  // botão cobra o campo novo, o comportamento correto para uma re-submissão.
  const requiredFields = useMemo(
    () => requiredHumanFields(visibleFields, answers),
    [visibleFields, answers],
  );
  const answeredRequiredCount = useMemo(
    () => requiredFields.filter((f) => isFieldAnswered(f, answers[f.name])).length,
    [requiredFields, answers],
  );
  const missingRequiredCount = requiredFields.length - answeredRequiredCount;

  const isAnswered = useCallback(
    (field: PydanticField) => isFieldAnswered(field, answers[field.name]),
    [answers],
  );

  const handleAnswerWithClear = useCallback(
    (fieldName: string, value: unknown) => {
      onAnswer(fieldName, value);
      setHighlightedFields((prev) => {
        if (!prev.has(fieldName)) return prev;
        const next = new Set(prev);
        next.delete(fieldName);
        return next;
      });
    },
    [onAnswer],
  );

  // Destaca as pendências e leva a pesquisadora até a primeira delas. Extraído
  // do caminho de validação local porque o veredito do servidor precisa da
  // MESMA mecânica: um envio que grava mas deixa obrigatória em aberto tem de
  // apontar a pergunta do mesmo jeito que o bloqueio pré-clique aponta (#608).
  // Duas cópias divergiriam no dia em que uma delas fosse ajustada.
  //
  // Nome que não está em `visibleFields` — a pergunta nasceu depois que o
  // formulário abriu — não tem para onde rolar, e é o próprio JavaScript que
  // resolve: `findIndex` devolve -1, `questionRefs.current[-1]` é `undefined` e
  // os `?.` abaixo tornam scroll e foco no-ops. Uma guarda explícita para esse
  // caso seria inobservável (nenhuma mutação a mata) — o destaque ainda é
  // registrado, para o campo já entrar marcado se um render posterior o trouxer,
  // e quem avisa a pesquisadora é o toast do chamador.
  const pointAtFields = useCallback(
    (names: readonly string[]) => {
      // Um só `Set`: o mesmo conjunto destaca os campos e localiza o primeiro.
      const pending = new Set(names);
      setHighlightedFields(pending);
      const firstIdx = visibleFields.findIndex((f) => pending.has(f.name));
      const firstEl = questionRefs.current[firstIdx];
      firstEl?.scrollIntoView({ behavior: getScrollBehavior(), block: "center" });
      // O ref é o card da pergunta (HTMLDivElement), não o input. Focar o
      // primeiro controle dentro de `[data-question-body]` (o corpo da resposta)
      // — não do card inteiro — leva o cursor à pendência e evita cair no
      // drag-handle de reordenar, que precede o corpo quando o card é arrastável
      // (o caso normal na codificação). Fallback para o card se o marcador faltar.
      const focusRoot =
        firstEl?.querySelector<HTMLElement>("[data-question-body]") ?? firstEl;
      focusRoot
        ?.querySelector<HTMLElement>(
          'input, textarea, select, button, [tabindex]:not([tabindex="-1"])',
        )
        ?.focus({ preventScroll: true });
    },
    [visibleFields, questionRefs],
  );

  const handleSubmitWithValidation = useCallback(() => {
    if (submitting || outOfScopeBlocked) return;

    const unanswered = requiredFields
      .filter((f) => !isAnswered(f))
      .map((f) => f.name);

    if (unanswered.length > 0) {
      pointAtFields(unanswered);
      toast.warning("Preencha todas as perguntas obrigatórias");
      return;
    }

    // O envio pode gravar e AINDA devolver pendências: a régua do cliente é
    // staleness-blind contra o schema carregado, e o servidor reavalia contra o
    // carimbo per-campo da própria escrita. Quando as duas discordam, quem tem
    // razão é o servidor — e a lista que ele devolve é o que faz a tela apontar.
    //
    // A ramificação (em vez de `await` no handler inteiro) mantém SÍNCRONO o
    // caminho de cima: a validação local é uma decisão do cliente e o destaque
    // tem de acontecer no mesmo tick do clique. Um handler `async` empurraria
    // esse feedback imediato para um microtask sem nenhum ganho.
    const submitted = onSubmit();
    if (submitted) {
      void submitted.then((missing) => {
        if (missing?.length) pointAtFields(missing);
      });
    }
  }, [
    requiredFields,
    isAnswered,
    onSubmit,
    submitting,
    outOfScopeBlocked,
    pointAtFields,
  ]);

  return {
    highlightedFields,
    isAnswered,
    handleAnswerWithClear,
    handleSubmitWithValidation,
    requiredFields,
    answeredRequiredCount,
    missingRequiredCount,
  };
}
