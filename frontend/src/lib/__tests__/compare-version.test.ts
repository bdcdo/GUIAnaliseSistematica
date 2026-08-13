import { describe, it, expect } from "vitest";
import {
  versionGte,
  parseVersionStr,
  formatVersion,
  compareVersions,
  latestMajorAnchor,
  resolveMinVersion,
  responseQualifiesForVersion,
  type SchemaVersion,
  type VersionedResponse,
} from "@/lib/compare-version";
import {
  DEFAULT_COMPARE_FILTERS,
  COMPARE_DEFAULT_VERSION,
  compareDefaultsForMode,
} from "@/lib/compare-filters";
import { computeDivergentFieldNames } from "@/lib/compare-divergence";
import { resolveCompareStatus } from "@/lib/compare-assignment-status";
import type { PydanticField } from "@/lib/types";

const v = (major: number, minor: number, patch: number): SchemaVersion => ({
  major,
  minor,
  patch,
});

function resp(overrides: Partial<VersionedResponse>): VersionedResponse {
  return {
    respondent_type: "llm",
    is_latest: true,
    is_partial: false,
    pydantic_hash: "hash-atual",
    schema_version_major: 0,
    schema_version_minor: 20,
    schema_version_patch: 0,
    ...overrides,
  };
}

describe("parseVersionStr", () => {
  it("parseia X.Y.Z", () => {
    expect(parseVersionStr("0.20.3")).toEqual(v(0, 20, 3));
    expect(parseVersionStr("2.0.0")).toEqual(v(2, 0, 0));
  });
  it("retorna null para entrada inválida", () => {
    expect(parseVersionStr("latest_major")).toBeNull();
    expect(parseVersionStr("1.2")).toBeNull();
    expect(parseVersionStr("")).toBeNull();
  });
});

describe("formatVersion", () => {
  it("formata em X.Y.Z", () => {
    expect(formatVersion(v(0, 20, 0))).toBe("0.20.0");
  });
});

describe("versionGte", () => {
  it("compara em ordem major > minor > patch", () => {
    expect(versionGte(v(0, 20, 3), v(0, 20, 0))).toBe(true);
    expect(versionGte(v(0, 20, 0), v(0, 20, 0))).toBe(true);
    expect(versionGte(v(0, 19, 9), v(0, 20, 0))).toBe(false);
    expect(versionGte(v(1, 0, 0), v(0, 99, 99))).toBe(true);
  });
});

describe("compareVersions", () => {
  it("ordena strings X.Y.Z em major > minor > patch", () => {
    expect(compareVersions("0.20.3", "0.20.0")).toBeGreaterThan(0);
    expect(compareVersions("0.19.9", "0.20.0")).toBeLessThan(0);
    expect(compareVersions("1.0.0", "0.99.99")).toBeGreaterThan(0);
    expect(compareVersions("0.20.0", "0.20.0")).toBe(0);
  });
  it("ordena descendente via sort((a, b) => compareVersions(b, a))", () => {
    const versions = ["0.2.0", "1.0.0", "0.10.0", "0.2.1"];
    expect(versions.toSorted((a, b) => compareVersions(b, a))).toEqual([
      "1.0.0",
      "0.10.0",
      "0.2.1",
      "0.2.0",
    ]);
  });
  it("malformadas ordenam como {0,0,0}, antes de versões válidas", () => {
    expect(compareVersions("lixo", "0.0.1")).toBeLessThan(0);
    expect(compareVersions("lixo", "0.0.0")).toBe(0);
  });
});

describe("latestMajorAnchor", () => {
  // Núcleo da correção B2: em projetos major 0 o piso é o MINOR corrente,
  // não {0,0,0} (que aceitaria todas as minors e não separaria rodada nenhuma).
  it("ancora no minor corrente quando major é 0", () => {
    expect(latestMajorAnchor(v(0, 20, 0))).toEqual(v(0, 20, 0));
    expect(latestMajorAnchor(v(0, 20, 3))).toEqual(v(0, 20, 0));
    expect(latestMajorAnchor(v(0, 1, 5))).toEqual(v(0, 1, 0));
  });
  it("ancora no major corrente quando major >= 1", () => {
    expect(latestMajorAnchor(v(2, 5, 1))).toEqual(v(2, 0, 0));
    expect(latestMajorAnchor(v(1, 0, 0))).toEqual(v(1, 0, 0));
  });
});

describe("resolveMinVersion", () => {
  it("retorna null para 'all'", () => {
    expect(resolveMinVersion("all", v(0, 20, 0))).toBeNull();
  });
  it("regressão B2: latest_major em projeto 0.20.0 não vira {0,0,0}", () => {
    expect(resolveMinVersion("latest_major", v(0, 20, 0))).toEqual(v(0, 20, 0));
  });
  it("latest_major em projeto major >= 1 zera minor/patch", () => {
    expect(resolveMinVersion("latest_major", v(1, 2, 3))).toEqual(v(1, 0, 0));
  });
  it("parseia versão específica", () => {
    expect(resolveMinVersion("0.13.0", v(0, 20, 0))).toEqual(v(0, 13, 0));
  });
});

describe("responseQualifiesForVersion", () => {
  const floor = v(0, 20, 0); // piso latest_major de um projeto 0.20.0
  const proj = { pydanticHash: "hash-atual", version: v(0, 20, 0) };

  it("descarta resposta LLM superseded (is_latest=false)", () => {
    expect(
      responseQualifiesForVersion(resp({ is_latest: false }), floor, proj),
    ).toBe(false);
  });
  it("descarta resposta humana superseded (is_latest=false) — fix PR #213", () => {
    expect(
      responseQualifiesForVersion(
        resp({ respondent_type: "humano", is_latest: false }),
        floor,
        proj,
      ),
    ).toBe(false);
  });
  // Regra 2 (#678): rascunho nunca submetido não conta como codificação.
  // Antes desta regra, `is_latest` fazia as vezes de "codificou" e um
  // auto-save tirava o documento da fila do pesquisador e o empurrava para a
  // Comparação — 21 dos 194 documentos ativos do Zolgensma.
  it("descarta rascunho humano (is_partial=true) mesmo sendo is_latest", () => {
    expect(
      responseQualifiesForVersion(
        resp({ respondent_type: "humano", is_partial: true }),
        floor,
        proj,
      ),
    ).toBe(false);
  });
  it("descarta rascunho humano mesmo sem filtro de versão (minVersion null)", () => {
    // Discrimina a regra 2 da regra 3: sem piso, o predicado retornaria true
    // logo após o gate de is_latest se o rascunho não fosse barrado antes.
    expect(
      responseQualifiesForVersion(
        resp({ respondent_type: "humano", is_partial: true }),
        null,
        proj,
      ),
    ).toBe(false);
  });
  it("aceita resposta humana submetida (is_partial=false)", () => {
    // O par positivo da regra 2: sem ele, um predicado que devolvesse `false`
    // para tudo passaria nos dois casos acima.
    expect(
      responseQualifiesForVersion(
        resp({ respondent_type: "humano", is_partial: false }),
        floor,
        proj,
      ),
    ).toBe(true);
  });
  it("descarta rascunho LLM — redundante com a CHECK do banco, mas não confia nela", () => {
    // `responses_partial_llm_not_latest` já impede LLM parcial de ser
    // is_latest; a regra vale como defesa em profundidade se a constraint for
    // relaxada ou se a linha vier de fixture/backfill.
    expect(
      responseQualifiesForVersion(
        resp({ respondent_type: "llm", is_partial: true }),
        floor,
        proj,
      ),
    ).toBe(false);
  });
  it("descarta superseded humana mesmo sem filtro de versão (minVersion null)", () => {
    expect(
      responseQualifiesForVersion(
        resp({ respondent_type: "humano", is_latest: false }),
        null,
        proj,
      ),
    ).toBe(false);
  });
  it("com filtro ativo, descarta resposta pré-versionamento (pydantic_hash NULL)", () => {
    expect(
      responseQualifiesForVersion(resp({ pydantic_hash: null }), floor, proj),
    ).toBe(false);
  });
  it("sem filtro (minVersion null), pré-versionamento passa", () => {
    expect(
      responseQualifiesForVersion(resp({ pydantic_hash: null }), null, proj),
    ).toBe(true);
  });
  it("regressão B3: resposta humana de minor antiga (0.19.x) reprovada sob piso 0.20.0", () => {
    const old = resp({
      respondent_type: "humano",
      schema_version_minor: 19,
      schema_version_patch: 5,
    });
    expect(responseQualifiesForVersion(old, floor, proj)).toBe(false);
  });
  it("resposta da minor corrente (0.20.x) qualifica via semver", () => {
    expect(
      responseQualifiesForVersion(resp({ schema_version_patch: 2 }), floor, proj),
    ).toBe(true);
  });

  // Fallback por hash (cláusula 5): respostas LLM legadas têm schema_version
  // NULL. Sem o fallback, B2 esvaziaria a comparação dessas respostas.
  const nullVer = (hash: string | null) =>
    resp({
      schema_version_major: null,
      schema_version_minor: null,
      schema_version_patch: null,
      pydantic_hash: hash,
    });
  it("schema_version NULL + hash atual qualifica (proxy de versão corrente)", () => {
    expect(responseQualifiesForVersion(nullVer("hash-atual"), floor, proj)).toBe(
      true,
    );
  });
  it("schema_version NULL + hash antigo reprova (schema anterior)", () => {
    expect(responseQualifiesForVersion(nullVer("hash-antigo"), floor, proj)).toBe(
      false,
    );
  });
});

// O fecho do parecer (compare-sync.ts) deriva seu piso de versão do MESMO
// default VIVO da UI que compare/page.tsx usa — `COMPARE_DEFAULT_VERSION`
// ("latest_major"), o mesmo valor que `compareDefaultsForMode` retorna —, via
// `resolveMinVersion`. Estes testes travam esse contrato e reproduzem o
// incidente #217/#218 no pipeline puro do sync, sem Supabase.
describe("fecho espelha o filtro default da UI (#217/#218/#247)", () => {
  it("o default VIVO é latest_major e impõe o piso latestMajorAnchor", () => {
    // Trip-wire do acoplamento sync↔visão. Vigia o default VIVO (o que a página
    // de fato aplica via compareDefaultsForMode), NÃO DEFAULT_COMPARE_FILTERS —
    // foi exatamente esse descasamento que deixou o #247 regredir o #217 passar
    // batido. Se alguém mudar o default vivo sem realinhar o fecho, isto quebra.
    expect(COMPARE_DEFAULT_VERSION).toBe("latest_major");
    expect(compareDefaultsForMode("compare_humans", 2).version).toBe(
      COMPARE_DEFAULT_VERSION,
    );
    // DEFAULT_COMPARE_FILTERS.version segue "all" (base de outros callers), mas
    // NÃO é o piso do fecho — o fecho usa COMPARE_DEFAULT_VERSION.
    expect(DEFAULT_COMPARE_FILTERS.version).toBe("all");
    expect(resolveMinVersion(COMPARE_DEFAULT_VERSION, v(0, 20, 0))).toEqual(
      latestMajorAnchor(v(0, 20, 0)),
    );
  });

  // Incidente Zolgensma sob o default vivo latest_major: doc com codificações
  // humanas — uma SUPERSEDED (is_latest=false), uma pré-versionamento
  // (pydantic_hash NULL), uma de minor antiga (0.18.0) divergindo em "decisao",
  // e duas da MAJOR corrente (0.20.0) concordando. Sob latest_major o fecho
  // descarta superseded, pré-versionamento E a minor antiga, sobrando só a major
  // corrente — exatamente o que a revisora vê na fila default. A divergência que
  // só existe na rodada antiga (improc vs proc) NÃO trava o fecho: é o que
  // restaura o acoplamento visão==fecho do #218 (e evita a regressão do #217).
  type Row = VersionedResponse & {
    id: string;
    answers: Record<string, unknown>;
  };
  const proj = { pydanticHash: "hash-atual", version: v(0, 20, 0) };
  const minVersion = resolveMinVersion(COMPARE_DEFAULT_VERSION, v(0, 20, 0));
  // Piso antigo ('all' = null), para contraste com o comportamento que travava.
  const minVersionLegado = resolveMinVersion(
    DEFAULT_COMPARE_FILTERS.version,
    v(0, 20, 0),
  );

  const human = (
    id: string,
    answers: Record<string, unknown>,
    over: Partial<VersionedResponse>,
  ): Row => ({
    id,
    answers,
    respondent_type: "humano",
    is_latest: true,
    is_partial: false,
    pydantic_hash: "hash-atual",
    schema_version_major: 0,
    schema_version_minor: 20,
    schema_version_patch: 0,
    ...over,
  });

  const rows: Row[] = [
    human(
      "sup",
      { decisao: "improc", obs: "irrelevante" },
      { is_latest: false, pydantic_hash: "hash-antigo", schema_version_minor: 18 },
    ),
    human(
      "pre",
      { decisao: "improc", obs: "irrelevante" },
      {
        pydantic_hash: null,
        schema_version_major: null,
        schema_version_minor: null,
        schema_version_patch: null,
      },
    ),
    human(
      "v18",
      { decisao: "improc", obs: "irrelevante" },
      { pydantic_hash: "hash-018", schema_version_minor: 18 },
    ),
    human("v20a", { decisao: "proc", obs: "irrelevante" }, {}),
    human("v20b", { decisao: "proc", obs: "irrelevante" }, {}),
  ];

  const fields: PydanticField[] = [
    {
      name: "decisao",
      type: "single",
      options: ["proc", "improc"],
      description: "",
      target: "all",
    },
    { name: "obs", type: "text", options: null, description: "", target: "all" },
  ];

  const active = rows.filter((r) =>
    responseQualifiesForVersion(r, minVersion, proj),
  );
  const activeLegado = rows.filter((r) =>
    responseQualifiesForVersion(r, minVersionLegado, proj),
  );

  it("sob latest_major o fecho mantém só a major corrente (descarta antigas)", () => {
    expect(active.map((r) => r.id)).toEqual(["v20a", "v20b"]);
  });

  it("a divergência só existe nas rodadas antigas — invisível na fila default", () => {
    // Na major corrente os ativos concordam: nenhum campo diverge.
    expect(computeDivergentFieldNames(fields, active)).toEqual([]);
  });

  it("parecer fecha sem veredito pendente (acoplamento visão==fecho)", () => {
    const divergent = computeDivergentFieldNames(fields, active);
    expect(resolveCompareStatus(divergent, new Set())).toBe("concluido");
  });

  it("sob o piso antigo 'all', a divergência da rodada antiga travaria o fecho (regressão #217)", () => {
    // Contraste: com 'all' (minVersion null) a minor 0.18.0 e a pré-versionamento
    // voltam a contar, "decisao" diverge (improc vs proc) e o parecer NÃO fecha
    // sem resolver um campo que a fila latest_major nem mostra. É o cenário que o
    // default vivo latest_major evita.
    expect(activeLegado.map((r) => r.id)).toEqual(["pre", "v18", "v20a", "v20b"]);
    const divergentLegado = computeDivergentFieldNames(fields, activeLegado);
    expect(divergentLegado).toContain("decisao");
    expect(resolveCompareStatus(divergentLegado, new Set())).not.toBe(
      "concluido",
    );
  });
});
