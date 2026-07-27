import { buildFieldHashMap } from "@/lib/answer-staleness";
import { isCodingComplete } from "@/lib/coding-completeness";
import { dropHiddenConditionals, isFieldVisible } from "@/lib/conditional";
import { isOtherValue } from "@/lib/other-option";
import { resolveAllowOther, resolveTarget } from "@/lib/pydantic-field";
import { stableStringify } from "@/lib/schema-utils";
import type { AnswerFieldHashes, PydanticField } from "@/lib/types";

const hasOwn = (value: object, key: string): boolean => Object.hasOwn(value, key);

function humanFields(fields: PydanticField[]): PydanticField[] {
  return fields.filter(
    (field) => resolveTarget(field.target) !== "llm_only" && resolveTarget(field.target) !== "none",
  );
}

function isAllowedOption(field: PydanticField, value: unknown): value is string {
  return (
    (typeof value === "string" && (field.options ?? []).includes(value)) ||
    (resolveAllowOther(field.allow_other) && isOtherValue(value))
  );
}

function keepIfStillPresentable(field: PydanticField, value: unknown): unknown {
  if (value === undefined || value === null) return undefined;
  if (!field.options) return value;
  if (field.type === "single") {
    return isAllowedOption(field, value) ? value : undefined;
  }
  if (field.type === "multi") {
    const kept = Array.isArray(value) ? value.filter((item) => isAllowedOption(field, item)) : [];
    return kept.length > 0 ? kept : undefined;
  }
  return value;
}

// Projeção canônica das respostas armazenadas que pode ser exibida pelo
// formulário atual. O valor bruto permanece no banco até que o pesquisador
// altere explicitamente a projeção apresentada.
export function sanitizeStoredAnswers(
  allFields: PydanticField[],
  answers: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!answers) return {};
  if (allFields.length === 0) return answers;

  const entries: Array<[string, unknown]> = [];
  for (const field of humanFields(allFields)) {
    if (!hasOwn(answers, field.name)) continue;
    const kept = keepIfStillPresentable(field, answers[field.name]);
    if (kept !== undefined) entries.push([field.name, kept]);
  }
  const clean = Object.fromEntries(entries) as Record<string, unknown>;
  return dropHiddenConditionals(allFields, clean);
}

export interface PersistedResponseSnapshot {
  submittedAnswers: Record<string, unknown>;
  persistedAnswers: Record<string, unknown>;
  answerFieldHashes: Exclude<AnswerFieldHashes, null>;
  // True quando ESTE save gravou proveniência do schema de HOJE no mapa
  // per-campo — o sinal único que autoriza promover as colunas de versão da
  // response (`pydantic_hash` + `schema_version_*`, ver `buildResponsePayload`).
  // É simétrico ao mapa por construção: vem do MESMO ponto que decide quais
  // hashes ficam com a época de hoje (`buildReconciledFieldHashes`), cobrindo os
  // três ramos em que isso acontece:
  //   - codificação nova (o schema de hoje é o da codificação);
  //   - recodificação COMPLETA que desliga o sentinela legacy (#548) — submit
  //     explícito que estampa o mapa corrente inteiro;
  //   - revisão de valor numa response não-legacy (#529) — `changedFieldNames ∩
  //     persistedAnswers ≠ ∅`.
  // "Trafegou no formulário" ou re-confirmar o mesmo valor sem recodificar NÃO
  // conta: a linha conserva a época e fica fora do gate `latest_major` até ser
  // de fato recodificada.
  stampsCurrentSchema: boolean;
}

/**
 * Snapshot da response anterior do mesmo respondente para o documento, ou
 * `null` quando a codificação começa agora. Os dois dados vêm juntos num só
 * campo porque a distinção "não existe response" × "existe sem proveniência
 * (legacy)" decide qual mapa de hashes é gravado — e um par solto
 * (`storedHashes` ausente + flag de codificação nova) permitiria representar a
 * combinação impossível "codificação nova com snapshot anterior".
 */
interface ExistingResponseSnapshot {
  answers: Record<string, unknown> | null | undefined;
  hashes: AnswerFieldHashes;
}

interface BuildPersistedResponseSnapshotParams {
  fields: PydanticField[];
  existing: ExistingResponseSnapshot | null;
  rawSubmittedAnswers: Record<string, unknown>;
}

function samePresentedValue(
  presented: Record<string, unknown>,
  submitted: Record<string, unknown>,
  fieldName: string,
): boolean {
  const wasPresented = hasOwn(presented, fieldName);
  const wasSubmitted = hasOwn(submitted, fieldName);
  if (wasPresented !== wasSubmitted) return false;
  if (!wasPresented) return true;
  return stableStringify(presented[fieldName]) === stableStringify(submitted[fieldName]);
}

function reconcileAnswers(
  storedAnswers: Record<string, unknown> | null | undefined,
  presentedAnswers: Record<string, unknown>,
  submittedAnswers: Record<string, unknown>,
): { persistedAnswers: Record<string, unknown>; changedFieldNames: Set<string> } {
  const persistedAnswers: Record<string, unknown> = storedAnswers ? { ...storedAnswers } : {};
  const changedFieldNames = new Set<string>();
  const comparedFieldNames = new Set([
    ...Object.keys(presentedAnswers),
    ...Object.keys(submittedAnswers),
  ]);

  for (const fieldName of comparedFieldNames) {
    if (samePresentedValue(presentedAnswers, submittedAnswers, fieldName)) continue;
    changedFieldNames.add(fieldName);
    if (hasOwn(submittedAnswers, fieldName)) {
      persistedAnswers[fieldName] = submittedAnswers[fieldName];
    } else {
      delete persistedAnswers[fieldName];
    }
  }
  return { persistedAnswers, changedFieldNames };
}

function indexConditionalsByTrigger(fields: PydanticField[]): Map<string, PydanticField[]> {
  const conditionalsByTrigger = new Map<string, PydanticField[]>();
  for (const field of fields) {
    if (!field.condition) continue;
    const triggerName = field.condition.field.split(".", 1)[0];
    const siblings = conditionalsByTrigger.get(triggerName) ?? [];
    siblings.push(field);
    conditionalsByTrigger.set(triggerName, siblings);
  }
  return conditionalsByTrigger;
}

function becameHidden(
  field: PydanticField,
  previousAnswers: Record<string, unknown>,
  currentAnswers: Record<string, unknown>,
): boolean {
  return isFieldVisible(field, previousAnswers) && !isFieldVisible(field, currentAnswers);
}

function dropConditionalsAffectedByChanges(
  fields: PydanticField[],
  storedAnswers: Record<string, unknown> | null | undefined,
  answers: Record<string, unknown>,
  changedFieldNames: Set<string>,
): Record<string, unknown> {
  // A projeção pode ter omitido um filho stale antes da comparação. Derivar
  // a invalidação pelo grafo das conditions mantém esse filho ligado à
  // alteração deliberada do gatilho. A cascata só avança quando a visibilidade
  // canônica passa de visível para oculta; um intermediário ainda visível não
  // autoriza apagar descendentes que já estavam ocultos por outro motivo.
  const previousAnswers = storedAnswers ?? {};
  const conditionalsByTrigger = indexConditionalsByTrigger(fields);
  const pendingTriggerNames = [...changedFieldNames];
  const queuedTriggerNames = new Set(pendingTriggerNames);
  let persistedAnswers = answers;

  for (let index = 0; index < pendingTriggerNames.length; index += 1) {
    const changedTriggerName = pendingTriggerNames[index];
    for (const field of conditionalsByTrigger.get(changedTriggerName) ?? []) {
      if (!becameHidden(field, previousAnswers, persistedAnswers)) continue;
      persistedAnswers = dropHiddenConditionals([field], persistedAnswers);
      if (queuedTriggerNames.has(field.name)) continue;
      pendingTriggerNames.push(field.name);
      queuedTriggerNames.add(field.name);
    }
  }

  return persistedAnswers;
}

function withAnswerProvenanceFallback(
  hashes: Exclude<AnswerFieldHashes, null>,
  persistedAnswers: Record<string, unknown>,
): Exclude<AnswerFieldHashes, null> {
  // Resposta preservada de um campo que saiu do schema: a chave prova que ele
  // existia, o `null` admite que a proveniência não é mais reconstruível.
  for (const fieldName of Object.keys(persistedAnswers)) {
    if (!hasOwn(hashes, fieldName)) hashes[fieldName] = null;
  }
  return hashes;
}

// O conjunto de CHAVES responde "quais campos existiam quando esta codificação
// foi feita" (`fieldExistedWhenCoded`); o VALOR responde "contra qual versão do
// campo esta resposta foi dada" (`isFieldStale`). Por isso o mapa é herdado, não
// recarimbado: partir do schema de hoje faria toda codificação anterior a um
// bump "passar a dever" os campos novos e reaparecer como pendente sem o
// pesquisador ter feito nada (#520). Um campo novo só entra quando é de fato
// respondido — aí a chave é verdadeira e o hash atual é a proveniência correta.
// Nomes dos campos revisados neste save cujo valor persiste — o conjunto que
// ganha o hash de HOJE no ramo de herança de `buildReconciledFieldHashes`. Um
// campo revisado que ficou oculto/apagado (fora de `persistedAnswers`) não
// entra.
function revisedPersistedFieldNames(
  persistedAnswers: Record<string, unknown>,
  changedFieldNames: Set<string>,
): string[] {
  return [...changedFieldNames].filter((fieldName) => hasOwn(persistedAnswers, fieldName));
}

// O mapa per-campo reconciliado E se ESTE save gravou proveniência do schema de
// hoje nele. Os dois saem juntos porque a decisão é uma só, tomada aqui: quem
// consumir o sinal separado do mapa poderia divergir dele (foi o que quase
// aconteceu ao fundir #529 com #548 — o sinal derivado de `changedFieldNames`
// não enxergava a via de saída legacy). `stampsCurrentSchema` é o que autoriza
// promover as colunas de versão em `buildResponsePayload`.
interface ReconciledFieldHashes {
  hashes: Exclude<AnswerFieldHashes, null>;
  stampsCurrentSchema: boolean;
}

function buildReconciledFieldHashes(
  fields: PydanticField[],
  existing: ExistingResponseSnapshot | null,
  persistedAnswers: Record<string, unknown>,
  changedFieldNames: Set<string>,
): ReconciledFieldHashes {
  const currentHashes = buildFieldHashMap(fields);

  // Codificação nova: o schema de hoje É o schema da codificação, então todo
  // campo dele existia e nenhum obrigatório em branco deve ser perdoado.
  if (!existing) {
    return {
      hashes: withAnswerProvenanceFallback(currentHashes, persistedAnswers),
      stampsCurrentSchema: true,
    };
  }
  const storedHashes = existing.hashes;

  // `null`/`{}` são o sentinela legacy — "não dá para inferir quais campos
  // existiam", lido como "todos existiam". Herdar dele e acrescentar chaves
  // inverteria o sentinela em "só estes existiam", perdoando obrigatórios que
  // ficaram em branco de verdade. Permanece grosseiro até que uma codificação
  // nova estabeleça proveniência.
  //
  // Via de saída (#548): uma recodificação COMPLETA contra o schema ATUAL é o
  // único momento em que dá para afirmar que todos os campos de hoje existiam.
  // Aí estampamos o schema inteiro como uma codificação nova, desligando o
  // sentinela e marcando `stampsCurrentSchema` — o que libera
  // `buildResponsePayload` a promover `pydantic_hash` + `schema_version_*`, e a
  // response volta à fila `latest_major`. Uma gravação parcial conserva o
  // sentinela, mantendo o fallback de staleness conservador.
  //
  // Até o #608 a promoção era gateada também pelo canal de escrita
  // (`promoteLegacyIfComplete`, falso no auto-save, que não atestava nada).
  // Removido o auto-save, toda escrita que chega aqui é submit explícito: a
  // completude do conjunto gravado voltou a ser a condição inteira.
  if (!storedHashes || Object.keys(storedHashes).length === 0) {
    if (isCodingComplete(fields, persistedAnswers)) {
      return {
        hashes: withAnswerProvenanceFallback(currentHashes, persistedAnswers),
        stampsCurrentSchema: true,
      };
    }
    return { hashes: {}, stampsCurrentSchema: false };
  }

  const hashes: Exclude<AnswerFieldHashes, null> = { ...storedHashes };
  // Só o que o pesquisador revisou neste save ganha a proveniência de hoje;
  // o resto conserva a versão contra a qual foi respondido. Se algum campo foi
  // de fato revisado (#529), este save estampou proveniência corrente.
  const revised = revisedPersistedFieldNames(persistedAnswers, changedFieldNames);
  for (const fieldName of revised) {
    hashes[fieldName] = hasOwn(currentHashes, fieldName) ? currentHashes[fieldName] : null;
  }
  return {
    hashes: withAnswerProvenanceFallback(hashes, persistedAnswers),
    stampsCurrentSchema: revised.length > 0,
  };
}

// Reconcilia o snapshot armazenado com o formulário atual sem confundir
// "trafegou no formulário" com "foi revisado". Respostas e hashes são
// produzidos juntos para não permitir proveniência incompatível com o valor.
export function buildPersistedResponseSnapshot({
  fields,
  existing,
  rawSubmittedAnswers,
}: BuildPersistedResponseSnapshotParams): PersistedResponseSnapshot {
  const storedAnswers = existing?.answers;
  // A leitura sem schema expõe o JSON bruto por compatibilidade, mas não há
  // controles capazes de representar essas chaves no formulário. Portanto,
  // um submit vazio não pode ser interpretado como pedido para apagá-las.
  const presentedAnswers = fields.length === 0 ? {} : sanitizeStoredAnswers(fields, storedAnswers);
  const submittedAnswers = dropHiddenConditionals(fields, rawSubmittedAnswers);
  const reconciled = reconcileAnswers(
    storedAnswers,
    presentedAnswers,
    submittedAnswers,
  );
  const persistedAnswers = dropConditionalsAffectedByChanges(
    fields,
    storedAnswers,
    reconciled.persistedAnswers,
    reconciled.changedFieldNames,
  );
  const { hashes: answerFieldHashes, stampsCurrentSchema } = buildReconciledFieldHashes(
    fields,
    existing,
    persistedAnswers,
    reconciled.changedFieldNames,
  );

  return { submittedAnswers, persistedAnswers, answerFieldHashes, stampsCurrentSchema };
}
