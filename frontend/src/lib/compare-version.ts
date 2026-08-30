// Primitivas puras de versão de schema para a aba Comparar.
//
// Vivem num módulo próprio (sem `server-only`, sem React) para serem
// compartilhadas entre o Server Component da página (compare/page.tsx) e a
// Server Action de sincronização (compare-sync.ts), e para serem testáveis por
// Vitest. Antes, `versionGte`/`parseVersionStr`/`resolveMinVersion` viviam
// inline e não-exportadas em compare/page.tsx, e o predicado de qualificação
// por versão estava duplicado de forma divergente em compare-sync.ts — drift
// que era a causa do assignment de comparação não fechar (ver #168 e o
// princípio anti-drift do CLAUDE.md, mesmo racional do #63 para schema-utils).

// Sentinelas do filtro de versão da aba Comparar. São a FONTE ÚNICA das strings
// mágicas: `resolveMinVersion` casa contra elas, `COMPARE_DEFAULT_VERSION`
// (compare-filters.ts) é definido a partir delas e o `SelectItem` do filtro
// (CompareFilters.tsx) usa-as como `value`. Sem isto, trocar o valor do default
// num lugar (ex.: a constante) deixaria `resolveMinVersion` cair no
// `parseVersionStr → null` e desativar o piso silenciosamente em fila/gatilho/
// fecho, além de o `Select` controlado ficar com `value` sem option (#247).
export const VERSION_FILTER_ALL = "all";
export const VERSION_FILTER_LATEST_MAJOR = "latest_major";

// Default VIVO de versão da aba Comparar — fonte única consumida pelos TRÊS
// pontos que precisam concordar sobre "qual versão a fila reflete por padrão":
//   1. a página (compareDefaultsForMode, via compare/page.tsx);
//   2. o filtro do cliente (CompareFilters.effectiveDefaults, via prop
//      defaultVersion plumbada por page → ComparePage → CompareNav);
//   3. o fecho do parecer (compare-sync.ts) e o gatilho (auto-comparison.ts),
//      ambos via `versionGate` abaixo.
// É distinto de DEFAULT_COMPARE_FILTERS.version ("all"), a base para
// callers/testes que NÃO derivam do automation_mode. Vive aqui (e é
// re-exportado por compare-filters.ts) para que `versionGate` o use sem import
// circular — o VALOR é o sentinela canônico VERSION_FILTER_LATEST_MAJOR (mesma
// string que `resolveMinVersion` casa e que o `SelectItem` do filtro usa), então
// trocar o default não dessincroniza fila/filtro/gatilho/fecho (ver #247, e o
// acoplamento visão==fecho do #217/#218).
export const COMPARE_DEFAULT_VERSION = VERSION_FILTER_LATEST_MAJOR;

export interface SchemaVersion {
  major: number;
  minor: number;
  patch: number;
}

// Campos mínimos de uma resposta necessários para decidir se ela qualifica sob
// um piso de versão. Tanto `CompareResponse` (página) quanto a linha buscada em
// compare-sync.ts satisfazem este shape.
//
// `is_partial` é obrigatório de propósito (não opcional): é o que obriga cada
// caller a trazer a coluna do banco. Antes do #678 ela não era pedida em lugar
// nenhum da comparação, e o resultado foi contar rascunho como codificação em
// 21 dos 194 documentos ativos do Zolgensma. Tornar o campo opcional aqui
// reabriria exatamente esse buraco, agora em silêncio.
export interface VersionedResponse {
  respondent_type: "humano" | "llm";
  is_latest: boolean;
  is_partial: boolean;
  pydantic_hash: string | null;
  schema_version_major: number | null;
  schema_version_minor: number | null;
  schema_version_patch: number | null;
}

// Compara (a) >= (b) em ordem semver major > minor > patch.
export function versionGte(a: SchemaVersion, b: SchemaVersion): boolean {
  if (a.major !== b.major) return a.major > b.major;
  if (a.minor !== b.minor) return a.minor > b.minor;
  return a.patch >= b.patch;
}

export function parseVersionStr(s: string): SchemaVersion | null {
  const m = s.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  return {
    major: Number.parseInt(m[1], 10),
    minor: Number.parseInt(m[2], 10),
    patch: Number.parseInt(m[3], 10),
  };
}

export function formatVersion(v: SchemaVersion): string {
  return `${v.major}.${v.minor}.${v.patch}`;
}

// Comparador 3-way ascendente para strings "X.Y.Z" (ordem major > minor >
// patch). Strings malformadas (parseVersionStr → null) ordenam como {0,0,0},
// isto é, antes de qualquer versão válida — determinístico, sem lançar.
export function compareVersions(a: string, b: string): number {
  const va = parseVersionStr(a) ?? { major: 0, minor: 0, patch: 0 };
  const vb = parseVersionStr(b) ?? { major: 0, minor: 0, patch: 0 };
  if (va.major !== vb.major) return va.major - vb.major;
  if (va.minor !== vb.minor) return va.minor - vb.minor;
  return va.patch - vb.patch;
}

// Piso de versão para o filtro "última grande versão".
//
// Em projetos major ≥ 1 a fronteira de rodada é o MAJOR corrente
// (`{major,0,0}`). Mas projetos costumam viver inteiros em `0.x`: MINOR é
// bumpado automaticamente a cada save de schema e MAJOR é um gesto manual raro
// do coordenador. Em `0.x` nunca houve quebra MAJOR, então ancorar em
// `{0,0,0}` aceitaria TODAS as minors e o filtro não separaria rodada nenhuma
// (bug: respostas de schemas antigos misturadas com as atuais). Para major 0,
// a fronteira significativa é o MINOR corrente (`{0,minor,0}`); patch é
// cosmético e não invalida respostas, então o piso mantém todos os patches da
// minor corrente.
export function latestMajorAnchor(v: SchemaVersion): SchemaVersion {
  if (v.major === 0) return { major: 0, minor: v.minor, patch: 0 };
  return { major: v.major, minor: 0, patch: 0 };
}

// Resolve o filtro de versão da UI num piso `SchemaVersion` (ou null = sem
// filtro). `filter` é `CompareFiltersValue["version"]`: "all" | "latest_major"
// | "X.Y.Z".
export function resolveMinVersion(
  filter: string,
  projectCurrent: SchemaVersion,
): SchemaVersion | null {
  if (filter === VERSION_FILTER_ALL) return null;
  if (filter === VERSION_FILTER_LATEST_MAJOR)
    return latestMajorAnchor(projectCurrent);
  return parseVersionStr(filter);
}

// Contexto de versão do projeto, necessário para o fallback por hash abaixo.
export interface ProjectVersionContext {
  pydanticHash: string | null;
  version: SchemaVersion;
}

// Linha de `projects` reduzida ao mínimo para derivar o contexto de versão.
export interface ProjectVersionRow {
  pydantic_hash?: string | null;
  schema_version_major?: number | null;
  schema_version_minor?: number | null;
  schema_version_patch?: number | null;
}

// Deriva o `SchemaVersion` corrente do projeto e o `ProjectVersionContext` a
// partir de uma linha de `projects`, com os fallbacks canônicos
// {major 0, minor 1, patch 0}. FONTE ÚNICA dessa derivação, consumida por
// compare/page.tsx, compare-sync.ts e auto-comparison.ts — antes ela vivia
// copiada (verbatim) nos três, e o fallback `minor: 1` é load-bearing
// (`latestMajorAnchor` ancora em {0,minor,0} para projetos 0.x): uma cópia
// "corrigida" para `minor: 0` num só lugar dessincronizaria gatilho/fila/fecho,
// a exata classe de drift que este módulo existe para evitar (ver cabeçalho e
// #247). Cada caller resolve seu próprio `minVersion`: a página a partir da URL
// (`filters.version`), o fecho/gatilho a partir de `COMPARE_DEFAULT_VERSION`.
export function deriveProjectVersionContext(project: ProjectVersionRow): {
  version: SchemaVersion;
  ctx: ProjectVersionContext;
} {
  const version: SchemaVersion = {
    major: project.schema_version_major ?? 0,
    minor: project.schema_version_minor ?? 1,
    patch: project.schema_version_patch ?? 0,
  };
  return {
    version,
    ctx: { pydanticHash: project.pydantic_hash ?? null, version },
  };
}

// Gate de versão do estado DEFAULT da fila: deriva o contexto do projeto e
// resolve o piso a partir de `COMPARE_DEFAULT_VERSION` ("latest_major"). FONTE
// ÚNICA do par {minVersion, ctx} aplicado fora da página — o gatilho
// (auto-comparison.ts) e o fecho (compare-sync.ts) usam ESTE helper, mantendo o
// acoplamento gatilho==fila==fecho do #247. A página NÃO usa `versionGate`: ela
// resolve `minVersion` a partir da URL (`filters.version`, que pode ser uma
// lente manual), mas a partir do MESMO `deriveProjectVersionContext`.
export function versionGate(project: ProjectVersionRow): {
  minVersion: SchemaVersion | null;
  ctx: ProjectVersionContext;
} {
  const { version, ctx } = deriveProjectVersionContext(project);
  return { minVersion: resolveMinVersion(COMPARE_DEFAULT_VERSION, version), ctx };
}

// Predicado único de qualificação de uma resposta sob um piso de versão.
// Regras, nesta ordem:
//   1. respostas superseded (is_latest=false) ficam de fora — humanas OU LLM.
//      Após o PR #213, uma codificação humana rebaixada (ao promover uma versão
//      mais recente no dedup de documentos, ou após unificação de membros) tem
//      is_latest=false e não deve reaparecer como segundo card / inflar a
//      contagem. Antes a cláusula mantinha humano por engano;
//   2. rascunhos (is_partial=true) ficam de fora. Para humano, `is_partial`
//      significa "nunca submetida" — o valor sai do botão, não do
//      preenchimento (`actions/responses.ts`, `isAutoSave`), com cliquet: uma
//      vez enviada, auto-save posterior não rebaixa o sinal. Para LLM
//      significa "cobertura abaixo do limiar", e a CHECK
//      `responses_partial_llm_not_latest` já garante que parcial nunca seja
//      is_latest — logo esta regra é redundante para LLM e load-bearing para
//      humano. Sem ela, `is_latest` virava proxy de "codificou" e um rascunho
//      auto-salvo tirava o documento da fila do próprio pesquisador e o
//      empurrava para a Comparação (#678). A auto-revisão já exigia
//      `is_partial = false` em seis camadas; a comparação era a metade do
//      sistema que não aplicava a regra;
//   3. sem filtro de versão (minVersion null = filtro "all"), qualifica;
//   4. respostas pré-versionamento (pydantic_hash NULL, gravadas antes da
//      migration 20260420) são descartadas com filtro ativo — não há como
//      situá-las;
//   5. com semver gravado (fonte de verdade), a versão da resposta precisa ser
//      >= o piso;
//   6. SEM semver gravado: as respostas LLM nascem com schema_version NULL
//      porque o backend não popula esses campos no insert (o B1 deste PR passa
//      a popular, mas só nos inserts futuros; as respostas legadas seguem NULL
//      até um backfill). Para não esvaziar a comparação, usamos o
//      `pydantic_hash` — que é sempre gravado — como proxy: se bate com o hash
//      atual do projeto, a resposta é da versão corrente e qualifica sob
//      qualquer piso <= corrente; senão é de um schema anterior e é descartada.
// NÃO inclui os filtros efêmeros de UI (`since`, `respondent`): esses são
// aplicados só na página, não na decisão de conclusão do assignment.
export function responseQualifiesForVersion(
  r: VersionedResponse,
  minVersion: SchemaVersion | null,
  project: ProjectVersionContext,
): boolean {
  if (!r.is_latest) return false;
  if (r.is_partial) return false;
  if (!minVersion) return true;
  if (r.pydantic_hash === null) return false;
  if (r.schema_version_major !== null) {
    const rv: SchemaVersion = {
      major: r.schema_version_major ?? 0,
      minor: r.schema_version_minor ?? 0,
      patch: r.schema_version_patch ?? 0,
    };
    return versionGte(rv, minVersion);
  }
  if (project.pydanticHash !== null && r.pydantic_hash === project.pydanticHash) {
    return versionGte(project.version, minVersion);
  }
  return false;
}
