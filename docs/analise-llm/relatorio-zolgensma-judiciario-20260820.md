# Análise de divergência — Zolgensma - Judiciario

Projeto `00779233-85be-43cd-9d97-65ddb63b8b34` · schema **v1.8.0** · modo `auto_review_llm` · modelo `google_genai/gemini-3.7-flash`

## Como ler estes números

- **Rodada de LLM analisada**: `7d11f634-413f-40ce-9a99-412b3eccadcd` de 2026-08-14T12:10:25, 26 respostas, schema v1.6.0 — **esta rodada não está vigente no app** (`is_latest = false`), porque uma nova rodada de codificação foi iniciada depois dela; as respostas continuam íntegras no banco e são analisáveis.
- **Rodada de codificação**: 'Teste 2 do formulário (v2)'. Cada rodada é uma coleta separada, com formulário e codificadores próprios; somá-las faria codificadores de rodadas diferentes parecerem codificadores do mesmo documento.
- **25 perguntas analisadas**, 6 fora — ausente na rodada LLM: `campo_a`, `q2_data_da_decisao`; schema mudou desde a rodada: `q11_incorporado_sus_ans`, `q15_ilegalidade_nao_incorporacao`, `q17_comprovacao_mbe`; target=llm_only: `llm_ambiguidades`.
- **Gabarito de cada célula**: 130 vieram de veredito de comparação e 403 da concordância unânime dos codificadores (tratada como gabarito, convenção padrão em análise de conteúdo). 9 células divergiram sem que ninguém resolvesse e ficaram de fora. Incluir as células concordantes é essencial: a fila de Comparação só mostra o que divergiu, então medir apenas sobre ela responderia "com que frequência um humano diverge do gabarito **dado que já houve divergência**" — que com dois codificadores é 100% por construção.

**Duas ressalvas que limitam a leitura destes números:**

1. **O gabarito não é independente do LLM.** O revisor vê qual card é do LLM ao decidir, e em 16 células o veredito foi exatamente a resposta do modelo. Onde isso acontece, o LLM acerta por construção — por isso a coluna `erro LLM` traz também a variante *leave-one-out*, que exclui essas células, simétrica ao mesmo tratamento aplicado do lado humano.
2. **Os documentos multi-codificados não são amostra aleatória.** Foram escolhidos por atribuição, não sorteados da população de documentos, então as taxas aqui descrevem este conjunto e não se generalizam sem cuidado.

**Classes:** `instrumento ambíguo` = os próprios humanos não convergem (α < 0.667, ou piso de ruído alto, ou vereditos "ambíguo"); `LLM desalinhado` = humanos convergem **e** o erro do modelo supera o limite superior do intervalo do piso; `dados insuficientes` = menos de 5 documentos comparáveis.

## Sumário por pergunta

| Pergunta | Tipo | Docs | Concord. | α [IC95] | Piso de ruído | Erro LLM | Erro LLM (LOO) | Classe |
|---|---|---:|---:|---:|---:|---:|---:|---|
| `q1_numero_processo` | text | 17 | 88% | — | 12% [0–29] | 6% (1/17) | 6% (1/17) | ok |
| `q3_medicamento` | text | 17 | 65% | — | 35% [12–59] | 24% (4/17) | 24% (4/17) | instrumento ambíguo |
| `q4_doenca_paciente` | text | 17 | 29% | — | 75% [50–94] | 25% (4/16) | 33% (4/12) | instrumento ambíguo |
| `q5_data_nascimento_paciente` | date | 17 | 94% | +0.94 [+0.80, +1.00] | 6% [0–18] | 0% (0/17) | 0% (0/17) | ok |
| `q6_idade_paciente` | text | 17 | 82% | — | 24% [6–41] | 18% (3/17) | 19% (3/16) | ok |
| `q7_decisao_e_liminar` | single | 17 | 82% | +0.82 [+0.62, +1.00] | 18% [0–35] | 6% (1/17) | 6% (1/17) | ok |
| `q8_houve_liminar` | single | 14 | 93% | +0.93 [+0.76, +1.00] | 14% [0–36] | 0% (0/14) | 0% (0/13) | ok |
| `q9_registro_anvisa` | single | 17 | 100% | +1.00 [+1.00, +1.00] | 0% [0–0] | 0% (0/17) | 0% (0/17) | ok |
| `q10_off_label` | single | 17 | 29% | +0.29 [+0.07, +0.49] | 76% [59–94] | 6% (1/17) | 6% (1/16) | instrumento ambíguo |
| `q12_uso_conforme_incorporacao` | single | 0 | — | — | — | — | — | dados insuficientes |
| `q13_pericia_medica` | single | 17 | 82% | +0.82 [+0.61, +1.00] | 18% [0–35] | 12% (2/17) | 12% (2/17) | ok |
| `q14_negativa_administrativa` | single | 17 | 76% | +0.76 [+0.51, +0.94] | 29% [12–53] | 0% (0/17) | 0% (0/16) | ok |
| `q16_possibilidade_substituicao` | single | 17 | 88% | +0.88 [+0.68, +1.00] | 12% [0–29] | 18% (3/17) | 18% (3/17) | ok |
| `q18_imprescindibilidade_clinica` | single | 17 | 71% | +0.70 [+0.44, +0.93] | 29% [6–53] | 6% (1/17) | 6% (1/17) | ok |
| `q19_incapacidade_financeira` | single | 17 | 88% | +0.88 [+0.69, +1.00] | 12% [0–29] | 6% (1/17) | 6% (1/17) | ok |
| `q20_questionou_merito_conitec` | single | 17 | 71% | +0.70 [+0.44, +0.88] | 35% [12–59] | 6% (1/17) | 7% (1/14) | ok |
| `q21_questionou_merito_negativa` | single | 17 | 59% | +0.58 [+0.31, +0.81] | 53% [29–76] | 18% (3/17) | 20% (3/15) | instrumento ambíguo |
| `q22_nota_tecnica_natjus` | single | 17 | 82% | +0.82 [+0.62, +1.00] | 24% [6–47] | 24% (4/17) | 25% (4/16) | ok |
| `q23_natjus_converge_juiz` | single | 11 | 100% | +1.00 [+1.00, +1.00] | 0% [0–0] | 0% (0/10) | 0% (0/10) | ok |
| `q24_natjus_converge_conitec` | single | 11 | 91% | +0.90 [+0.69, +1.00] | 9% [0–27] | 20% (2/10) | 20% (2/10) | ok |
| `q25_citacao_natjus_decisao` | single | 11 | 45% | +0.44 [+0.12, +0.70] | 55% [27–82] | 40% (4/10) | 40% (4/10) | instrumento ambíguo |
| `q26_avaliacao_conitec` | single | 17 | 71% | +0.70 [+0.45, +0.87] | 35% [12–59] | 12% (2/17) | 12% (2/16) | ok |
| `q27_decisao_concede` | single | 17 | 100% | +1.00 [+1.00, +1.00] | 0% [0–0] | 0% (0/17) | 0% (0/17) | ok |
| `q28_fontes_evidencia` | multi | 17 | 12% | +0.09 [-0.07, +0.23] | 82% [64–96] | 93% (13/14) | 93% (13/14) | instrumento ambíguo |
| `q29_ressarcimento_liminar` | single | 17 | 88% | +0.88 [+0.68, +1.00] | 18% [0–35] | 6% (1/17) | 6% (1/16) | ok |

---

## `q28_fontes_evidencia` — Quais fontes de evidência foram utilizadas para fundamentar a decisão?

**Tipo:** `multi` · **Opções:** Registro ANVISA · Relatório Conitec · Lista (Rename/rol da ANS) ou PCDT/DUT · Nota técnica NAT-JUS · Laudo pericial · Laudo de médico juntado pelo autor da ação

**Classe:** instrumento ambíguo

**Concordância inter-humana:** 12% dos 17 pares em 17 documentos · α = +0.09 [-0.07, +0.23]

**Piso de ruído:** 82% bruto, 82% leave-one-out, IC95 64%–96% (n=14 documentos)

**α por opção:** `Registro ANVISA`: +0.06 · `Relatório Conitec`: +0.15 · `Lista (Rename/rol da ANS) ou PCDT/DUT`: +0.05 · `Nota técnica NAT-JUS`: +0.17 · `Laudo pericial`: +0.87 · `Laudo de médico juntado pelo autor da ação`: +0.35 · `Outro: Ausência de alternativa terapêutica disponível`: +0.00 · `Outro: extinção do processo sem julgamento de mérito`: —

**Respostas humanas (n=40):**

**Nota técnica NAT-JUS**: 4 · **Registro ANVISA, Relatório Conitec, Nota técnica NAT-JUS**: 4 · **Relatório Conitec**: 2 · **Registro ANVISA, Relatório Conitec, Nota técnica NAT-JUS, Laudo de médico juntado pelo autor da ação**: 2 · **Lista (Rename/rol da ANS) ou PCDT/DUT**: 2 · **Registro ANVISA, Relatório Conitec, Nota técnica NAT-JUS, Lista (Rename/rol da ANS) ou PCDT/DUT**: 1 · **Registro ANVISA, Nota técnica NAT-JUS, Laudo de médico juntado pelo autor da ação**: 1 · **Lista (Rename/rol da ANS) ou PCDT/DUT, Registro ANVISA, Nota técnica NAT-JUS, Laudo de médico juntado pelo autor da ação**: 1 · _(+23 outras)_

**Sinais de ambiguidade:** 1 célula(s) com revisores discordando entre si.

### Casos em que o LLM divergiu do gabarito (13)

#### Caso 1 — 5001589-11.2024.4.03.6133

_revisado 2026-08-17T19:24 · por c73ffb91-38b7-43df-9751-137690a96ea8_

- **LLM respondeu:** Registro ANVISA, Relatório Conitec, Lista (Rename/rol da ANS) ou PCDT/DUT, Nota técnica NAT-JUS, Laudo pericial, Laudo de médico juntado pelo autor da ação
- **Justificativa LLM:**
> O magistrado analisa o registro na Anvisa, os relatórios 595 e 1063 da Conitec, o PCDT da doença, a Nota Técnica nº 5239/2024 do NAT-JUS/SP, o laudo pericial judicial e os relatórios dos médicos assistentes juntados pela parte autora.
- **Gabarito:** {"Registro ANVISA":true,"Relatório Conitec":true,"Lista (Rename/rol da ANS) ou PCDT/DUT":true,"Nota técnica NAT-JUS":true,"Laudo pericial":true,"Laudo de médico juntado pelo autor da ação":false}

**Outras respostas humanas neste documento:**

- **luizscho**: Registro ANVISA, Relatório Conitec, Lista (Rename/rol da ANS) ou PCDT/DUT, Laudo pericial, Nota técnica NAT-JUS, Laudo de médico juntado pelo autor da ação
- **matheuscadedi**: Relatório Conitec, Nota técnica NAT-JUS, Lista (Rename/rol da ANS) ou PCDT/DUT

#### Caso 2 — 1086747-81.2022.4.01.3400

_revisado 2026-08-18T13:06 · por 857e19b7-3789-40df-9a34-2a6109eb02db_

- **LLM respondeu:** Registro ANVISA, Relatório Conitec, Nota técnica NAT-JUS, Laudo de médico juntado pelo autor da ação
- **Justificativa LLM:**
> A fundamentação utiliza o registro na ANVISA, a recomendação de incorporação da Conitec, a Nota Técnica do Natjus-DF e relatórios/exames médicos acostados aos autos.
- **Gabarito:** {"Registro ANVISA":true,"Relatório Conitec":true,"Lista (Rename/rol da ANS) ou PCDT/DUT":false,"Nota técnica NAT-JUS":true,"Laudo pericial":false,"Laudo de médico juntado pelo autor da ação":false}

**Outras respostas humanas neste documento:**

- **naomi.dnsn**: Nota técnica NAT-JUS
- **Pedro Gomes**: Registro ANVISA, Relatório Conitec, Nota técnica NAT-JUS, Lista (Rename/rol da ANS) ou PCDT/DUT

#### Caso 3 — 1045955-17.2024.4.01.3400

_revisado 2026-08-17T20:12 · por c73ffb91-38b7-43df-9751-137690a96ea8_

- **LLM respondeu:** Registro ANVISA, Relatório Conitec, Lista (Rename/rol da ANS) ou PCDT/DUT, Nota técnica NAT-JUS, Laudo de médico juntado pelo autor da ação
- **Justificativa LLM:**
> A decisão faz referência expressa ao registro na Anvisa, ao PCDT de AME e RENAME, aos Relatórios de Recomendação da CONITEC, à Nota Técnica do NATJUS/DF e à prescrição/relatório do médico assistente juntados pelo autor.
- **Gabarito:** Registro ANVISA, Relatório Conitec, Nota técnica NAT-JUS

**Outras respostas humanas neste documento:**

- **luizscho**: Relatório Conitec, Nota técnica NAT-JUS
- **marianapuschel**: Registro ANVISA, Relatório Conitec, Nota técnica NAT-JUS

#### Caso 4 — 1001623-26.2022.8.26.0127

_revisado 2026-08-17T22:42 · por d9b22caa-ab02-41e1-9d1e-da51035663c0_

- **LLM respondeu:** Registro ANVISA, Laudo pericial, Laudo de médico juntado pelo autor da ação, Nota técnica NAT-JUS
- **Justificativa LLM:**
> A fundamentação se apoia na prescrição do médico assistente, na perícia do IMESC, no registro sanitário na Anvisa e aborda a Nota Técnica do NAT-Jus: "prescrição médica fundamentada... A perícia realizada pelo IMESC... compatível com o registro sanitário do medicamento junto à Anvisa... A nota técnica do NAT-Jus, apesar de registrá-la nos autos, tem caráter opinativo".
- **Gabarito:** {"Registro ANVISA":true,"Relatório Conitec":false,"Lista (Rename/rol da ANS) ou PCDT/DUT":false,"Nota técnica NAT-JUS":true,"Laudo pericial":true,"Laudo de médico juntado pelo autor da ação":true}

**Outras respostas humanas neste documento:**

- **Pedro Gomes**: Laudo de médico juntado pelo autor da ação, Laudo pericial, Relatório Conitec, Registro ANVISA, Nota técnica NAT-JUS, Lista (Rename/rol da ANS) ou PCDT/DUT
- **marianapuschel**: Laudo pericial, Laudo de médico juntado pelo autor da ação

#### Caso 5 — 1090103-50.2023.4.01.3400

_revisado 2026-08-15T23:03 · por dcbc9803-6efb-469b-892f-25e029d47424_

- **LLM respondeu:** Registro ANVISA, Relatório Conitec, Nota técnica NAT-JUS, Laudo pericial, Laudo de médico juntado pelo autor da ação
- **Justificativa LLM:**
> A sentença menciona o registro na Anvisa ('medicamento pleiteado foi devidamente registrado na ANVISA em 14.08.2020'), relatório Conitec ('Relatório de Recomendação... CONITEC'), laudo juntado pela autora ('exame genético e relatório médico juntado aos autos'), Nota Técnica do NATJUS ('Nota Técnica do NATJUS, que assim concluiu') e a perícia médica ('analisando detidamente o Laudo Pericial juntado aos autos').
- **Gabarito:** {"Registro ANVISA":false,"Relatório Conitec":true,"Lista (Rename/rol da ANS) ou PCDT/DUT":false,"Nota técnica NAT-JUS":true,"Laudo pericial":true,"Laudo de médico juntado pelo autor da ação":true}

**Outras respostas humanas neste documento:**

- **naomi.dnsn**: Relatório Conitec, Nota técnica NAT-JUS, Laudo pericial
- **matheuscadedi**: Nota técnica NAT-JUS, Laudo pericial

#### Caso 6 — 1026431-34.2024.4.01.3400

_revisado 2026-08-17T01:43 · por 334390e4-358d-44bd-b04a-2bbf4bc1bdd7_

- **LLM respondeu:** Lista (Rename/rol da ANS) ou PCDT/DUT, Nota técnica NAT-JUS, Relatório Conitec
- **Justificativa LLM:**
> "sopesando as conclusões ténicas ofertadas pelo NATJUS", "Protocolos Clínicos de Diretrizes Terapêuticas para tratamento de Atrofia Muscular Espinhal (AME) no Sistema Único de Saúde - SUS" e "analisado pela Rede Pública e encontra-se incorporado para tratamento de Atrofia Muscular Espinha (AME) TIPO 1". O magistrado baseou-se no PCDT, na nota do NAT-JUS e na análise de incorporação da rede pública.
- **Gabarito:** {"Registro ANVISA":false,"Relatório Conitec":true,"Lista (Rename/rol da ANS) ou PCDT/DUT":true,"Nota técnica NAT-JUS":true,"Laudo pericial":false,"Laudo de médico juntado pelo autor da ação":false}

**Outras respostas humanas neste documento:**

- **matheuscadedi**: Nota técnica NAT-JUS
- **leitedesouza.jacqueline**: Lista (Rename/rol da ANS) ou PCDT/DUT

#### Caso 7 — 1094213-58.2024.4.01.3400

_revisado 2026-08-17T23:13 · por d9b22caa-ab02-41e1-9d1e-da51035663c0_

- **LLM respondeu:** Registro ANVISA, Relatório Conitec, Lista (Rename/rol da ANS) ou PCDT/DUT, Nota técnica NAT-JUS, Laudo de médico juntado pelo autor da ação
- **Justificativa LLM:**
> A decisão fundamentou-se no registro da ANVISA, na recomendação e relatórios da CONITEC, na Portaria do PCDT da AME, na Nota Técnica do NATJUS e no laudo médico emitido por médica da UFRJ juntado pela parte autora.
- **Gabarito:** {"Registro ANVISA":true,"Relatório Conitec":true,"Lista (Rename/rol da ANS) ou PCDT/DUT":true,"Nota técnica NAT-JUS":true,"Laudo pericial":false,"Laudo de médico juntado pelo autor da ação":true}

**Outras respostas humanas neste documento:**

- **naomi.dnsn**: Registro ANVISA, Relatório Conitec, Laudo de médico juntado pelo autor da ação
- **luizscho**: Nota técnica NAT-JUS, Lista (Rename/rol da ANS) ou PCDT/DUT, Relatório Conitec, Registro ANVISA

#### Caso 8 — 1020049-65.2024.8.26.0564

_revisado 2026-08-18T13:11 · por 857e19b7-3789-40df-9a34-2a6109eb02db_

- **LLM respondeu:** Nota técnica NAT-JUS, Laudo pericial
- **Justificativa LLM:**
> A magistrada embasa o julgamento na nota técnica do NAT-Jus e no laudo pericial judicial: "Observo que houve parecer desfavorável emitido pelo NatJus às fls. 263/273... Foi feita a perícia, e ficou constatado no laudo pericial que, atualmente, o medicamento Zolgensma se enquadra como uma das três alternativas terapêuticas...".
- **Gabarito:** {"Registro ANVISA":false,"Relatório Conitec":false,"Lista (Rename/rol da ANS) ou PCDT/DUT":false,"Nota técnica NAT-JUS":true,"Laudo pericial":true,"Laudo de médico juntado pelo autor da ação":false}

**Outras respostas humanas neste documento:**

- **naomi.dnsn**: Laudo pericial
- **marianapuschel**: Registro ANVISA, Nota técnica NAT-JUS, Laudo pericial

#### Caso 9 — 5009478-51.2019.4.02.5120

_revisado 2026-08-17T16:45 · por 334390e4-358d-44bd-b04a-2bbf4bc1bdd7_

- **LLM respondeu:** Registro ANVISA, Relatório Conitec, Lista (Rename/rol da ANS) ou PCDT/DUT, Nota técnica NAT-JUS, Laudo de médico juntado pelo autor da ação
- **Justificativa LLM:**
> A decisão menciona registro na Anvisa, relatórios e portaria da Conitec (Portaria SCTIE/MS nº 26/2021), listas do SUS e PCDT, parecer técnico do NAT (evento 31) e os laudos médicos acostados pela autora (eventos 15 e 96).
- **Gabarito:** Relatório Conitec

**Outras respostas humanas neste documento:**

- **naomi.dnsn**: Relatório Conitec
- **matheuscadedi**: Relatório Conitec

#### Caso 10 — 1027146-13.2023.4.01.3400

_revisado 2026-08-17T14:50 · por 334390e4-358d-44bd-b04a-2bbf4bc1bdd7_

- **LLM respondeu:** Registro ANVISA, Relatório Conitec, Nota técnica NAT-JUS, Laudo pericial, Laudo de médico juntado pelo autor da ação
- **Justificativa LLM:**
> O texto cita expressamente a Nota Técnica do NAT-JUS (relatório), o registro na ANVISA, parecer favorável da Conitec, laudo pericial judicial e relatórios/prescrições médicas juntadas pelo autor.
- **Gabarito:** Registro ANVISA, Relatório Conitec, Laudo pericial

**Outras respostas humanas neste documento:**

- **naomi.dnsn**: Registro ANVISA, Relatório Conitec, Laudo pericial
- **leitedesouza.jacqueline**: Registro ANVISA, Laudo pericial

#### Caso 11 — 5018265-24.2022.4.02.5101

_revisado 2026-08-17T23:12 · por 76b5b21c-59e7-4fbd-b080-cdfda5d4eb17_

- **LLM respondeu:** Registro ANVISA, Relatório Conitec, Nota técnica NAT-JUS, Laudo de médico juntado pelo autor da ação
- **Justificativa LLM:**
> A decisão cita expressamente o laudo da médica assistente ("ev. 1, LAUDO9/11"), o parecer do "NAT", a bula registrada na "ANVISA" e o "Relatório nº 793 da CONITEC".
- **Gabarito:** {"Registro ANVISA":true,"Relatório Conitec":true,"Lista (Rename/rol da ANS) ou PCDT/DUT":false,"Nota técnica NAT-JUS":true,"Laudo pericial":false,"Laudo de médico juntado pelo autor da ação":true}

**Outras respostas humanas neste documento:**

- **marianapuschel**: Registro ANVISA, Relatório Conitec, Nota técnica NAT-JUS
- **matheuscadedi**: Registro ANVISA, Relatório Conitec

#### Caso 12 — 5000260-12.2025.4.03.6138

_revisado 2026-08-15T23:17 · por dcbc9803-6efb-469b-892f-25e029d47424_

- **LLM respondeu:** Registro ANVISA, Relatório Conitec, Nota técnica NAT-JUS, Laudo de médico juntado pelo autor da ação
- **Justificativa LLM:**
> O texto faz menção ao relatório médico inicial ('relatório médico de ID 358102633 que acompanha a inicial'), registro na Anvisa ('apesar de registrado na ANVISA em 2017'), decisão da Conitec ('A CONITEC recomendou não incorporar...') e parecer do NAT-JUS ('Nota Técnica do NATJUS/SP').
- **Gabarito:** {"Registro ANVISA":true,"Relatório Conitec":true,"Lista (Rename/rol da ANS) ou PCDT/DUT":true,"Nota técnica NAT-JUS":true,"Laudo pericial":false,"Laudo de médico juntado pelo autor da ação":false}

**Outras respostas humanas neste documento:**

- **Pedro Gomes**: Registro ANVISA, Relatório Conitec, Nota técnica NAT-JUS
- **matheuscadedi**: Nota técnica NAT-JUS, Lista (Rename/rol da ANS) ou PCDT/DUT

#### Caso 13 — 1000113-21.2023.4.01.3603

_revisado 2026-08-17T19:40 · por c73ffb91-38b7-43df-9751-137690a96ea8_

- **LLM respondeu:** Registro ANVISA, Relatório Conitec, Lista (Rename/rol da ANS) ou PCDT/DUT, Nota técnica NAT-JUS, Laudo pericial, Laudo de médico juntado pelo autor da ação
- **Justificativa LLM:**
> A decisão menciona o registro na Anvisa, a recomendação da Conitec, o PCDT da AME, a Nota Técnica do NAT-JUS ('id 1525056851'), o laudo médico pericial produzido por carta precatória ('laudo médico de Id 1856711691') e relatórios/laudos médicos assistenciais acostados à inicial.
- **Gabarito:** {"Registro ANVISA":true,"Relatório Conitec":true,"Lista (Rename/rol da ANS) ou PCDT/DUT":false,"Nota técnica NAT-JUS":true,"Laudo pericial":true,"Laudo de médico juntado pelo autor da ação":true,"Outro: Ausência de alternativa terapêutica disponível":true}

**Outras respostas humanas neste documento:**

- **matheuscadedi**: Laudo pericial, Outro: Ausência de alternativa terapêutica disponível
- **wangdanielwl**: Laudo pericial, Nota técnica NAT-JUS, Registro ANVISA, Laudo de médico juntado pelo autor da ação, Relatório Conitec

---

## `q25_citacao_natjus_decisao` — Como se dá a citação do parecer do NAT-Jus na decisão do juiz?

**Tipo:** `single` · **Opções:** Somente cita a decisão, mas não discute o teor da decisão · Cita a decisão da NAT-JUS e discute os seus argumentos para concordar com a tomada de decisão do NAT · Cita a decisão da NAT-JUS e discute os seus argumentos para discordar com a tomada de decisão do NAT · Não cita o parecer do Nat-Jus

**Classe:** instrumento ambíguo

**Concordância inter-humana:** 45% dos 11 pares em 11 documentos · α = +0.44 [+0.12, +0.70]

**Piso de ruído:** 27% bruto, 55% leave-one-out, IC95 27%–82% (n=11 documentos)

**Respostas humanas (n=29):**

**Cita a decisão da NAT-JUS e discute os seus argumentos para concordar com a tomada de decisão do NAT**: 15 · **Somente cita a decisão, mas não discute o teor da decisão**: 11 · **Cita a decisão da NAT-JUS e discute os seus argumentos para discordar com a tomada de decisão do NAT**: 3

### Casos em que o LLM divergiu do gabarito (5)

#### Caso 1 — 1001623-26.2022.8.26.0127

_revisado 2026-08-17T22:40 · por d9b22caa-ab02-41e1-9d1e-da51035663c0_

- **LLM respondeu:** Cita a decisão da NAT-JUS e discute os seus argumentos para discordar com a tomada de decisão do NAT
- **Justificativa LLM:**
> A magistrada cita o parecer expressamente e rebate seu valor decisório: "A nota técnica do NAT-Jus, apesar de registrá-la nos autos, tem caráter opinativo e genérico, sem valor vinculante. Não se sobrepõe ao laudo do médico que acompanha o autor, tampouco afasta a necessidade concreta do tratamento".
- **Gabarito:** Somente cita a decisão, mas não discute o teor da decisão

**Outras respostas humanas neste documento:**

- **marianapuschel**: Somente cita a decisão, mas não discute o teor da decisão

#### Caso 2 — 1004976-13.2024.4.01.3400

_revisado 2026-08-17T22:48 · por 76b5b21c-59e7-4fbd-b080-cdfda5d4eb17_

- **LLM respondeu:** Cita a decisão da NAT-JUS e discute os seus argumentos para concordar com a tomada de decisão do NAT
- **Justificativa LLM:**
> O juiz analisa que, conforme a Nota Técnica do Natjus/DF, o diagnóstico está fechado e o medicamento é adequado, fundamentando sua procedência nesse parecer.
- **Gabarito:** Somente cita a decisão, mas não discute o teor da decisão

**Outras respostas humanas neste documento:**

- **luizscho**: Somente cita a decisão, mas não discute o teor da decisão
- **Pedro Gomes**: Cita a decisão da NAT-JUS e discute os seus argumentos para concordar com a tomada de decisão do NAT

#### Caso 3 — 1094213-58.2024.4.01.3400

_revisado 2026-08-17T23:11 · por d9b22caa-ab02-41e1-9d1e-da51035663c0_

- **LLM respondeu:** Cita a decisão da NAT-JUS e discute os seus argumentos para concordar com a tomada de decisão do NAT
- **Justificativa LLM:**
> O juiz transcreve trechos dos quesitos respondidos na Nota Técnica do NATJUS e utiliza seus argumentos técnicos sobre a superioridade do Zolgensma frente ao nusinersena e risdiplam para fundamentar o deferimento.
- **Gabarito:** Somente cita a decisão, mas não discute o teor da decisão

**Outras respostas humanas neste documento:**

- **naomi.dnsn**: Somente cita a decisão, mas não discute o teor da decisão
- **luizscho**: Somente cita a decisão, mas não discute o teor da decisão

#### Caso 4 — 1020049-65.2024.8.26.0564

_revisado 2026-08-18T13:10 · por 857e19b7-3789-40df-9a34-2a6109eb02db_

- **LLM respondeu:** Cita a decisão da NAT-JUS e discute os seus argumentos para concordar com a tomada de decisão do NAT
- **Justificativa LLM:**
> A magistrada cita o parecer desfavorável e o utiliza como elemento de convencimento: "Observo que houve parecer desfavorável emitido pelo NatJus às fls. 263/273, especialmente à fl. 268, tendo em vista que o paciente não se enquadra nas indicações previstas no respectivo relatório técnico."
- **Gabarito:** Somente cita a decisão, mas não discute o teor da decisão

**Outras respostas humanas neste documento:**

- **naomi.dnsn**: Somente cita a decisão, mas não discute o teor da decisão
- **marianapuschel**: Somente cita a decisão, mas não discute o teor da decisão

#### Caso 5 — 1013994-92.2023.4.01.3400

_revisado 2026-08-18T00:20 · por 76b5b21c-59e7-4fbd-b080-cdfda5d4eb17_

- **LLM respondeu:** Cita a decisão da NAT-JUS e discute os seus argumentos para concordar com a tomada de decisão do NAT
- **Justificativa LLM:**
> O julgado examina expressamente a nota técnica ao refutar a tese de fragilidade arguida pela União, assentando que 'a Nota produzida no bojo dos autos de origem trata pormenorizadamente acerca dos quesitos necessários ao conhecimento da doença e dos demais aspectos relevantes'.
- **Gabarito:** Somente cita a decisão, mas não discute o teor da decisão

**Outras respostas humanas neste documento:**

- **naomi.dnsn**: Somente cita a decisão, mas não discute o teor da decisão
- **Pedro Gomes**: Cita a decisão da NAT-JUS e discute os seus argumentos para concordar com a tomada de decisão do NAT

---

## `q4_doenca_paciente` — Doença do paciente

**Orientação aos pesquisadores:** Manter a redação exata usada no documento, a mais completa possível. Pode copiar direto da decisão, não precisa remover letras maiúsculas nem nada do gênero. Se colocar só o CID e não o nome, preencher só esse campo. Se for o contrário, preencha somente o nome. Se tiver ambas as informações, coloque-as

**Tipo:** `text` · **Opções:** —

**Classe:** instrumento ambíguo

**Concordância inter-humana:** 29% dos 17 pares em 17 documentos · _campo aberto — sem correção por acaso_

**Piso de ruído:** 50% bruto, 75% leave-one-out, IC95 50%–94% (n=16 documentos)

**Respostas humanas (n=40):**

**doenca:  Atrofia Muscular Espinhal (AME) do Tipo 1**: 3 · **doenca: Atrofia Muscular Espinhal Tipo II (AME)**: 2 · **cid: G12.0, doenca: Atrofia Muscular Espinhal tipo I - AME**: 2 · **doenca: Amiotrofia Muscular Espinhal Tipo III (AME Tipo III)**: 2 · **doenca: Atrofia Muscular Espinhal (AME) Tipo I**: 2 · **doenca: Amiotrofia Muscular Espinhal Tipo I**: 2 · **cid: CID10: G12.0, doenca: Amiotrofia Espinhal Tipo I**: 1 · **doenca: Amiotrofia Espinhal Tipo I**: 1 · _(+25 outras)_

**Sinais de ambiguidade:** 1 veredito(s) "ambíguo", 3 célula(s) com revisores discordando entre si.

### Casos em que o LLM divergiu do gabarito (4)

#### Caso 1 — 1086747-81.2022.4.01.3400

_revisado 2026-08-18T13:00 · por 857e19b7-3789-40df-9a34-2a6109eb02db_

- **LLM respondeu:** doenca: Amiotrofia Espinhal Tipo I
- **Justificativa LLM:**
> doenca: No relatório é indicado expressamente: "a autora é menor e portadora de Amiotrofia Espinhal Tipo I".
cid: O parecer técnico citado na sentença indica o código da doença: "(CID10: G12.0)".
- **Gabarito:** cid: CID10: G12.0, doenca: Amiotrofia Espinhal Tipo I

**Outras respostas humanas neste documento:**

- **naomi.dnsn**: cid: CID10: G12.0, doenca: Amiotrofia Espinhal Tipo I
- **Pedro Gomes**: doenca: Amiotrofia Espinhal Tipo I

#### Caso 2 — 1045955-17.2024.4.01.3400

_revisado 2026-08-17T19:41 · por c73ffb91-38b7-43df-9751-137690a96ea8_

- **LLM respondeu:** doenca: Atrofia muscular espinhal do Tipo III
- **Justificativa LLM:**
> doenca: A doença é expressamente referida como: "diagnosticado com Atrofia muscular espinhal do Tipo III, CID G12.0, pela deleção no gene SMN1, doença conhecida como AME".
cid: O código CID é indicado diretamente no trecho: "CID G12.0".
- **Gabarito:** cid: G12.0, doenca: AME 5q do Tipo III

**Outras respostas humanas neste documento:**

- **luizscho**: cid: G12.0, doenca: AME 5q do Tipo III
- **marianapuschel**: cid: G12.0, doenca: Atrofia muscular espinhal do Tipo III

#### Caso 3 — 1090103-50.2023.4.01.3400

_revisado 2026-08-15T22:47 · por dcbc9803-6efb-469b-892f-25e029d47424_

- **LLM respondeu:** cid: G12.0, doenca: Atrofia Muscular Espinhal - AME, tipo 1
- **Justificativa LLM:**
> doenca: O relatório destaca: "Informou a parte autora Autora que é portadora de Atrofia Muscular Espinhal - AME, tipo 1, Cid: G120.".
cid: O texto registra: "PIETRA MAITE DA SILVA ARAUJO é portador de AMIOTROFIA ESPINHAL PROGRESSIVA (CIDIO: G12.0). ame tipo 1".
- **Gabarito:** cid: Cid: G120, doenca: Atrofia Muscular Espinhal - AME, tipo 1

**Outras respostas humanas neste documento:**

- **naomi.dnsn**: cid: Cid: G120, doenca: Atrofia Muscular Espinhal - AME, tipo 1
- **matheuscadedi**: cid: G120, doenca: Atrofia Muscular Espinhal - AME, tipo 1

#### Caso 4 — 1026431-34.2024.4.01.3400

_revisado 2026-08-14T21:04 · por 334390e4-358d-44bd-b04a-2bbf4bc1bdd7_

- **LLM respondeu:** doenca: Amiotrofia Muscular Espinhal Tipo I / Atrofia Muscular Espinhal (AME)
- **Justificativa LLM:**
> doenca: O relatório e a fundamentação indicam: "tem diagnóstico de Amiotrofia Muscular Espinhal Tipo I" e "diagnóstico de Atrofia Muscular Espinhal (AME)", sendo também discutida a hipótese de AME Tipo 2.
cid: Não há menção ao código CID no texto do documento.
- **Gabarito:** doenca: Amiotrofia Muscular Espinhal Tipo I

**Outras respostas humanas neste documento:**

- **matheuscadedi**: doenca: Amiotrofia Muscular Espinhal Tipo I
- **leitedesouza.jacqueline**: doenca: Amiotrofia Muscular Espinhal Tipo I

---

## `q3_medicamento` — Nome do medicamento pedido (copiar e colar)

**Orientação aos pesquisadores:** Copiar a redação exata usada no documento, sem alterações.

**Tipo:** `text` · **Opções:** —

**Classe:** instrumento ambíguo

**Concordância inter-humana:** 65% dos 17 pares em 17 documentos · _campo aberto — sem correção por acaso_

**Piso de ruído:** 18% bruto, 35% leave-one-out, IC95 12%–59% (n=17 documentos)

**Respostas humanas (n=40):**

**ZOLGENSMA**: 7 · **Zolgensma® (onasemnogene abeparvovec-xioi)**: 4 · **Nusinersena (Spinraza)**: 4 · **onasemnogene abeparvovec-xioi (Zolgensma®)**: 2 · **Zolgensma®**: 2 · **Zolgensma**: 2 · **NUSINERSENA (SPINRAZA)**: 2 · **ZOLGENSMA® - onasemnogene abeparvovec-xioi**: 1 · _(+16 outras)_

### Casos em que o LLM divergiu do gabarito (4)

#### Caso 1 — 5001589-11.2024.4.03.6133

_revisado 2026-07-29T23:06 · por 334390e4-358d-44bd-b04a-2bbf4bc1bdd7_

- **LLM respondeu:** Nusinersena (Spinraza) 12mg
- **Justificativa LLM:**
> O medicamento é descrito no relatório inicial: "pede que o réu seja condenado a fornecer o medicamento Nusinersena (Spinraza) 12mg, nas quantidades e prazos recomendados para consumo, conforme indicado pelo médico."
- **Gabarito:** Nusinersena (Spinraza)

**Outras respostas humanas neste documento:**

- **luizscho**: Nusinersena (Spinraza)
- **matheuscadedi**: Nusinersena (Spinraza)

#### Caso 2 — 1086747-81.2022.4.01.3400

_revisado 2026-08-18T13:00 · por 857e19b7-3789-40df-9a34-2a6109eb02db_

- **LLM respondeu:** ZOLGENSMA
- **Justificativa LLM:**
> O relatório inicial da sentença cita textualmente o pedido: "objetivando o fornecimento do medicamento ZOLGENSMA."
- **Gabarito:** ZOLGENSMA® - onasemnogene abeparvovec-xioi

**Outras respostas humanas neste documento:**

- **naomi.dnsn**: ZOLGENSMA
- **Pedro Gomes**: ZOLGENSMA® - onasemnogene abeparvovec-xioi

#### Caso 3 — 5009478-51.2019.4.02.5120

_revisado 2026-08-14T23:26 · por dcbc9803-6efb-469b-892f-25e029d47424_

- **LLM respondeu:** Nusinersena 2,4 mg/ml
- **Justificativa LLM:**
> O relatório inicial da sentença descreve o pedido da autora: "objetivando provimento jurisdicional que lhe assegure o recebimento de Nusinersena 2,4 mg/ml para o tratamento de Atrofia Muscular Espinhal tipo III".
- **Gabarito:**  Nusinersena

**Outras respostas humanas neste documento:**

- **naomi.dnsn**: Nusinersena 2,4 mg/ml
- **matheuscadedi**:  Nusinersena

#### Caso 4 — 1013994-92.2023.4.01.3400

_revisado 2026-08-14T21:05 · por 334390e4-358d-44bd-b04a-2bbf4bc1bdd7_

- **LLM respondeu:** Zolgensma®
- **Justificativa LLM:**
> O texto registra no relatório que a ação foi ajuizada "visando o fornecimento do medicamento Zolgensma®".
- **Gabarito:** Zolgensma

**Outras respostas humanas neste documento:**

- **naomi.dnsn**: Zolgensma
- **Pedro Gomes**: Zolgensma®

---

## `q21_questionou_merito_negativa` — Tribunal questionou o mérito da negativa administrativa (tribunal diverge dos fundamentos científicos, econômicos e de política pública da negativa administrativa)?

**Tipo:** `single` · **Opções:** Sim, tribunal questionou o mérito da negativa administrativa · Não, tribunal não questionou o mérito da negativa administrativa · Não se aplica, porque não houve negativa administrativa · Não informado 

**Classe:** instrumento ambíguo

**Concordância inter-humana:** 59% dos 17 pares em 17 documentos · α = +0.58 [+0.31, +0.81]

**Piso de ruído:** 32% bruto, 53% leave-one-out, IC95 29%–76% (n=17 documentos)

**Respostas humanas (n=40):**

**Não informado **: 22 · **Não se aplica, porque não houve negativa administrativa**: 9 · **Não, tribunal não questionou o mérito da negativa administrativa**: 6 · **Sim, tribunal questionou o mérito da negativa administrativa**: 3

**Sinais de ambiguidade:** 1 célula(s) com revisores discordando entre si.

### Casos em que o LLM divergiu do gabarito (3)

#### Caso 1 — 5014066-68.2024.4.03.6100

_revisado 2026-08-18T00:05 · por 76b5b21c-59e7-4fbd-b080-cdfda5d4eb17_

- **LLM respondeu:** Não informado 
- **Justificativa LLM:**
> O documento relata a resposta administrativa de que o fármaco ainda não é fornecido pelo SUS, mas o tribunal não aprofunda nem questiona diretamente os fundamentos administrativos da negativa.
- **Gabarito:** Não, tribunal não questionou o mérito da negativa administrativa

**Outras respostas humanas neste documento:**

- **Pedro Gomes**: Sim, tribunal questionou o mérito da negativa administrativa
- **wangdanielwl**: Não, tribunal não questionou o mérito da negativa administrativa

#### Caso 2 — 5018265-24.2022.4.02.5101

_revisado 2026-08-17T23:10 · por 76b5b21c-59e7-4fbd-b080-cdfda5d4eb17_

- **LLM respondeu:** Não se aplica, porque não houve negativa administrativa
- **Justificativa LLM:**
> Não há menção nos autos a uma recusa administrativa formal prévia sendo impugnada em seu mérito.
- **Gabarito:** Não informado 

**Outras respostas humanas neste documento:**

- **marianapuschel**: Não informado 
- **matheuscadedi**: Não informado 

#### Caso 3 — 1000113-21.2023.4.01.3603

_revisado 2026-08-17T22:52 · por d9b22caa-ab02-41e1-9d1e-da51035663c0_

- **LLM respondeu:** Não informado 
- **Justificativa LLM:**
> O documento relata a pretensão inicial da parte autora de fornecimento do medicamento pelo SUS, mas não traz detalhes nem discussão sobre os termos de uma negativa administrativa prévia específica.
- **Gabarito:** Não se aplica, porque não houve negativa administrativa

**Outras respostas humanas neste documento:**

- **matheuscadedi**: Não informado 
- **wangdanielwl**: Não se aplica, porque não houve negativa administrativa

---

## `q10_off_label` — Há indicação no relatório de que o pedido é para uso fora da bula, também chamado de off-label?

**Orientação aos pesquisadores:** O uso off-label (ou "fora da bula") refere-se à prescrição ou administração de um medicamento para (a) doença ou condição clínica diferente daquela para a qual ele foi registrado, (b) grupo de idade não previsto ou (c) com dose, frequência ou forma de aplicação diferente do que foi aprovado.

**Tipo:** `single` · **Opções:** Sim, é para uso off-label · Não é para uso off-label (há informação de que tratamento é para uso previsto na bula) · Não é informado se tratamento é ou não off-label · Medicamento não foi registrado ainda

**Classe:** instrumento ambíguo

**Concordância inter-humana:** 29% dos 17 pares em 17 documentos · α = +0.29 [+0.07, +0.49]

**Piso de ruído:** 41% bruto, 76% leave-one-out, IC95 59%–94% (n=17 documentos)

**Respostas humanas (n=40):**

**Não é informado se tratamento é ou não off-label**: 19 · **Não é para uso off-label (há informação de que tratamento é para uso previsto na bula)**: 14 · **Sim, é para uso off-label**: 7

**Sinais de ambiguidade:** 4 célula(s) com revisores discordando entre si.

### Casos em que o LLM divergiu do gabarito (1)

#### Caso 1 — 1084899-59.2022.4.01.3400

_revisado 2026-07-29T01:17 · por d9b22caa-ab02-41e1-9d1e-da51035663c0_

- **LLM respondeu:** Não é informado se tratamento é ou não off-label
- **Justificativa LLM:**
> Não há menção explícita no texto classificando o uso pretendido como off-label ou estritamente conforme a bula.
- **Gabarito:** Não é para uso off-label (há informação de que tratamento é para uso previsto na bula)

**Outras respostas humanas neste documento:**

- **wangdanielwl**: Não é informado se tratamento é ou não off-label
- **leitedesouza.jacqueline**: Não é para uso off-label (há informação de que tratamento é para uso previsto na bula)

---

## `q22_nota_tecnica_natjus` — Houve nota técnica de NAT-JUS?

**Tipo:** `single` · **Opções:** Sim, NAT-JUS recomenda uso do tratamento · Sim, mas NAT-JUS NÃO recomenda uso do tratamento · Não houve nota técnica de NAT-JUS (essa informação aparece expressamente) · Não informado se houve nota técnica de NAT-JUS · Sim, mas não é possível saber se o NAT-JUS recomenda ou não o uso do tratamento

**Classe:** ok

**Concordância inter-humana:** 82% dos 17 pares em 17 documentos · α = +0.82 [+0.62, +1.00]

**Piso de ruído:** 15% bruto, 24% leave-one-out, IC95 6%–47% (n=17 documentos)

**Respostas humanas (n=40):**

**Sim, mas NAT-JUS NÃO recomenda uso do tratamento**: 18 · **Sim, NAT-JUS recomenda uso do tratamento**: 11 · **Sim, mas não é possível saber se o NAT-JUS recomenda ou não o uso do tratamento**: 10 · **Não informado se houve nota técnica de NAT-JUS**: 1

**Sinais de ambiguidade:** 1 célula(s) com revisores discordando entre si.

### Casos em que o LLM divergiu do gabarito (4)

#### Caso 1 — 1090103-50.2023.4.01.3400

_revisado 2026-08-15T23:02 · por dcbc9803-6efb-469b-892f-25e029d47424_

- **LLM respondeu:** Sim, mas NAT-JUS NÃO recomenda uso do tratamento
- **Justificativa LLM:**
> A nota técnica do NATJUS transcrita na sentença conclui que 'considerando o protocolo do Ministério da Saúde de recomendação de incorporação do zolgensma e as recomendações das principais agências de avaliação de tecnologias em saúde, não há indicação do tratamento'.
- **Gabarito:** Sim, mas não é possível saber se o NAT-JUS recomenda ou não o uso do tratamento

**Outras respostas humanas neste documento:**

- **naomi.dnsn**: Sim, mas NAT-JUS NÃO recomenda uso do tratamento
- **matheuscadedi**: Sim, mas não é possível saber se o NAT-JUS recomenda ou não o uso do tratamento

#### Caso 2 — 1026431-34.2024.4.01.3400

_revisado 2026-08-17T20:18 · por c73ffb91-38b7-43df-9751-137690a96ea8_

- **LLM respondeu:** Sim, mas NAT-JUS NÃO recomenda uso do tratamento
- **Justificativa LLM:**
> "A nota técnica do NATJUS aportou aos autos no Id 2127956000, tendo o autor impugnado o laudo" e "analisando detidamente o caderno eletrônico, sobretudo sopesando as conclusões ténicas ofertadas pelo NATJUS [...] verifica-se que [...] inexiste indicação para o uso de ZOLGNESMA para crianças portadoras de AME tipo 2". A nota técnica não recomendou o tratamento diante da falta de indicação técnica para o caso.
- **Gabarito:** Sim, mas não é possível saber se o NAT-JUS recomenda ou não o uso do tratamento

**Outras respostas humanas neste documento:**

- **matheuscadedi**: Sim, mas NAT-JUS NÃO recomenda uso do tratamento
- **leitedesouza.jacqueline**: Sim, mas não é possível saber se o NAT-JUS recomenda ou não o uso do tratamento

#### Caso 3 — 5018265-24.2022.4.02.5101

_revisado 2026-08-17T23:11 · por 76b5b21c-59e7-4fbd-b080-cdfda5d4eb17_

- **LLM respondeu:** Sim, mas NAT-JUS NÃO recomenda uso do tratamento
- **Justificativa LLM:**
> Consta que "O NAT esclareceu em seu parecer que o medicamento possui indicação prevista em bula para o tratamento da AME para pacientes abaixo de 2 anos de idade" e que não integrava listas oficiais nem fora submetido à Conitec, sendo desfavorável à autora de 6 anos.
- **Gabarito:** Sim, mas não é possível saber se o NAT-JUS recomenda ou não o uso do tratamento

**Outras respostas humanas neste documento:**

- **marianapuschel**: Sim, mas não é possível saber se o NAT-JUS recomenda ou não o uso do tratamento
- **matheuscadedi**: Sim, mas não é possível saber se o NAT-JUS recomenda ou não o uso do tratamento

#### Caso 4 — 1000113-21.2023.4.01.3603

_revisado 2026-08-17T19:39 · por c73ffb91-38b7-43df-9751-137690a96ea8_

- **LLM respondeu:** Sim, NAT-JUS recomenda uso do tratamento
- **Justificativa LLM:**
> A decisão menciona que 'segundo o parecer técnico: [...] a doença faz com que seja imprescindível o uso do fármaco solicitado' e 'o Zolgensma® é um tratamento genético que busca reparar genes para que eles sejam capazes de produzir proteínas em quantidades normais, oferecendo opção terapêutica resolutiva'.
- **Gabarito:** Sim, mas não é possível saber se o NAT-JUS recomenda ou não o uso do tratamento

**Outras respostas humanas neste documento:**

- **matheuscadedi**: Sim, mas não é possível saber se o NAT-JUS recomenda ou não o uso do tratamento
- **wangdanielwl**: Sim, mas não é possível saber se o NAT-JUS recomenda ou não o uso do tratamento

---

## `q24_natjus_converge_conitec` — A recomendação do NAT-JUS converge com a Conitec?

**Tipo:** `single` · **Opções:** Sim · Não · Somente para algum dos medicamentos pleiteados (em caso de haver mais de um) · Não informado

**Classe:** ok

**Concordância inter-humana:** 91% dos 11 pares em 11 documentos · α = +0.90 [+0.69, +1.00]

**Piso de ruído:** 5% bruto, 9% leave-one-out, IC95 0%–27% (n=11 documentos)

**Respostas humanas (n=29):**

**Sim**: 24 · **Não informado**: 5

**Sinais de ambiguidade:** 1 célula(s) com revisores discordando entre si.

### Casos em que o LLM divergiu do gabarito (3)

#### Caso 1 — 5014066-68.2024.4.03.6100

_revisado 2026-08-18T00:08 · por 76b5b21c-59e7-4fbd-b080-cdfda5d4eb17_

- **LLM respondeu:** Não informado
- **Justificativa LLM:**
> A sentença não discute explicitamente se a conclusão do parecer do NatJus coincide ou diverge formalmente da posição/portaria final de incorporação da Conitec.
- **Gabarito:** Sim

**Outras respostas humanas neste documento:**

- **Pedro Gomes**: Sim
- **wangdanielwl**: Sim

#### Caso 2 — 1004976-13.2024.4.01.3400

_revisado 2026-08-17T22:48 · por 76b5b21c-59e7-4fbd-b080-cdfda5d4eb17_

- **LLM respondeu:** Não informado
- **Justificativa LLM:**
> Não há discussão nos autos confrontando diretamente a conclusão do parecer do NAT-JUS com eventuais posicionamentos específicos da Conitec para o subtipo da autora.
- **Gabarito:** Sim

**Outras respostas humanas neste documento:**

- **luizscho**: Sim
- **Pedro Gomes**: Não informado

#### Caso 3 — 1026431-34.2024.4.01.3400

_revisado 2026-08-17T20:19 · por c73ffb91-38b7-43df-9751-137690a96ea8_

- **LLM respondeu:** Sim
- **Justificativa LLM:**
> "o medicamento ZOLGENSMA foi analisado pela Rede Pública e encontra-se incorporado para tratamento de Atrofia Muscular Espinha (AME) TIPO 1, para criança com até 6 (seis) meses de idade [...] sopesando as conclusões ténicas ofertadas pelo NATJUS [...] inexiste indicação para o uso de ZOLGNESMA para crianças portadoras de AME tipo 2". As conclusões do NAT-JUS alinham-se às diretrizes da incorporação do SUS/Conitec.
- **Gabarito:** Não informado

**Outras respostas humanas neste documento:**

- **matheuscadedi**: Não informado

---

## `q6_idade_paciente` — Idade do paciente de acordo com o documento

**Orientação aos pesquisadores:** Sempre coletar a informação mais detalhada possível e na forma que foi escrita no documento. Por exemplo: se há menção a ano e meses de vida, ambas as informações devem ser registradas.

Colocar apenas número e unidade (meses, anos). Não precisa colocar XX anos de vida ou XX anos de idade.

Se o Natjus fala em uma idade pretérita e o juiz fala em uma mais avançada, colocar a do juiz

**Tipo:** `text` · **Opções:** Não informada

**Classe:** ok

**Concordância inter-humana:** 82% dos 17 pares em 17 documentos · _campo aberto — sem correção por acaso_

**Piso de ruído:** 18% bruto, 24% leave-one-out, IC95 6%–41% (n=17 documentos)

**Respostas humanas (n=40):**

**Não informada**: 20 · **5 meses**: 3 · **5 meses e 1 dia**: 2 · **12 meses **: 2 · **1 ano e 5 meses**: 2 · **12 anos**: 1 · **1 ano e 11 meses**: 1 · **menos de 6 meses**: 1 · _(+8 outras)_

### Casos em que o LLM divergiu do gabarito (3)

#### Caso 1 — 1090103-50.2023.4.01.3400

_revisado 2026-08-15T22:50 · por dcbc9803-6efb-469b-892f-25e029d47424_

- **LLM respondeu:** mais de 6 meses de idade
- **Justificativa LLM:**
> Na fundamentação, o magistrado afirma: "para o presente caso, tratamento de paciente pediátrico, com mais de 6 meses de idade com AME Tipo 1...".
- **Gabarito:** Não informada

**Outras respostas humanas neste documento:**

- **naomi.dnsn**: Não informada
- **matheuscadedi**: Não informada

#### Caso 2 — 5014066-68.2024.4.03.6100

_revisado 2026-07-27T22:51 · por dcbc9803-6efb-469b-892f-25e029d47424_

- **LLM respondeu:** 5 (cinco) meses
- **Justificativa LLM:**
> A idade do autor é mencionada na fundamentação da sentença: "a r. decisão que deferiu a tutela de urgência (Id. 332370407), determinando o fornecimento imediato do fármaco em discussão, foi proferida quando o autor possuía 5 (cinco) meses de idade".
- **Gabarito:** 5 meses

**Outras respostas humanas neste documento:**

- **Pedro Gomes**: 5 meses
- **wangdanielwl**: 5 meses

#### Caso 3 — 1094213-58.2024.4.01.3400

_revisado 2026-08-17T22:44 · por d9b22caa-ab02-41e1-9d1e-da51035663c0_

- **LLM respondeu:** 4 meses
- **Justificativa LLM:**
> O documento pontua que: "Informa que o autor, à época da inicial, tinha 4 meses de idade", constando também no laudo "4 meses de vida".
- **Gabarito:** Não informado

**Outras respostas humanas neste documento:**

- **naomi.dnsn**: 4 meses
- **luizscho**: Quase 2 anos

---

## `q16_possibilidade_substituicao` — De acordo com tribunal, há possibilidade de substituição por outro medicamento constante das listas do SUS e dos protocolos clínicos e diretrizes terapêuticas?

**Tipo:** `single` · **Opções:** Não há possibilidade de substituição por outro medicamento constante das listas do SUS e dos protocolos clínicos e diretrizes terapêuticas · Sim, há possibilidade de substituição por outro medicamento constante das listas do SUS e dos protocolos clínicos e diretrizes terapêuticas · Não informado se há possibilidade de substituição por outro medicamento constante das listas do SUS e dos protocolos clínicos e diretrizes terapêuticas

**Classe:** ok

**Concordância inter-humana:** 88% dos 17 pares em 17 documentos · α = +0.88 [+0.68, +1.00]

**Piso de ruído:** 6% bruto, 12% leave-one-out, IC95 0%–29% (n=17 documentos)

**Respostas humanas (n=40):**

**Não informado se há possibilidade de substituição por outro medicamento constante das listas do SUS e dos protocolos clínicos e diretrizes terapêuticas**: 17 · **Não há possibilidade de substituição por outro medicamento constante das listas do SUS e dos protocolos clínicos e diretrizes terapêuticas**: 15 · **Sim, há possibilidade de substituição por outro medicamento constante das listas do SUS e dos protocolos clínicos e diretrizes terapêuticas**: 8

**Sinais de ambiguidade:** 1 célula(s) com revisores discordando entre si.

### Casos em que o LLM divergiu do gabarito (3)

#### Caso 1 — 1045955-17.2024.4.01.3400

_revisado 2026-08-17T20:07 · por c73ffb91-38b7-43df-9751-137690a96ea8_

- **LLM respondeu:** Não há possibilidade de substituição por outro medicamento constante das listas do SUS e dos protocolos clínicos e diretrizes terapêuticas
- **Justificativa LLM:**
> O tribunal cita que "não havia tratamento medicamentoso disponível no SUS específico para o tratamento da AME 5q tipos II e III" e que para tais casos "o SUS fornece cuidados de suporte, reabilitação e paliativos", demonstrando a inexistência de fármaco substituto incorporado para o subtipo.
- **Gabarito:** Não informado se há possibilidade de substituição por outro medicamento constante das listas do SUS e dos protocolos clínicos e diretrizes terapêuticas

**Outras respostas humanas neste documento:**

- **luizscho**: Não informado se há possibilidade de substituição por outro medicamento constante das listas do SUS e dos protocolos clínicos e diretrizes terapêuticas
- **marianapuschel**: Não informado se há possibilidade de substituição por outro medicamento constante das listas do SUS e dos protocolos clínicos e diretrizes terapêuticas

#### Caso 2 — 1020049-65.2024.8.26.0564

_revisado 2026-08-18T13:09 · por 857e19b7-3789-40df-9a34-2a6109eb02db_

- **LLM respondeu:** Não informado se há possibilidade de substituição por outro medicamento constante das listas do SUS e dos protocolos clínicos e diretrizes terapêuticas
- **Justificativa LLM:**
> A decisão menciona que existem outras alternativas terapêuticas (Risdiplam e Nusinersen), mas não faz menção específica às listas do SUS ou aos PCDT, tratando-se de ação em face de plano de saúde privado: "Conforme destacado pela perita à fl. 1222, no item 2 'os tratamentos disponibilizados, até o momento, são três: Risdiplam, Nusinersen e Onasemnogeno abeparvoveque'".
- **Gabarito:** Sim, há possibilidade de substituição por outro medicamento constante das listas do SUS e dos protocolos clínicos e diretrizes terapêuticas
- **Comentário do revisor:**
> Pergunta está confundindo o LLM por mencionar apenas SUS e não saúde suplementar

**Outras respostas humanas neste documento:**

- **naomi.dnsn**: Sim, há possibilidade de substituição por outro medicamento constante das listas do SUS e dos protocolos clínicos e diretrizes terapêuticas
- **marianapuschel**: Sim, há possibilidade de substituição por outro medicamento constante das listas do SUS e dos protocolos clínicos e diretrizes terapêuticas

#### Caso 3 — 5009478-51.2019.4.02.5120

_revisado 2026-08-14T23:34 · por dcbc9803-6efb-469b-892f-25e029d47424_

- **LLM respondeu:** Não há possibilidade de substituição por outro medicamento constante das listas do SUS e dos protocolos clínicos e diretrizes terapêuticas
- **Justificativa LLM:**
> O texto cita a decisão do TRF2 que destacou: "Medicamento requerido, aprovado pela ANVISA - NUSINERSEN (SPINRAZA) - apresenta eficácia em interromper a progressão da doença diagnosticada, e nessa indicação não encontra similar nos medicamentos oferecidos pelo SUS". Isso demonstra que não há alternativa similar na lista do SUS para o tratamento da doença.
- **Gabarito:** Não informado se há possibilidade de substituição por outro medicamento constante das listas do SUS e dos protocolos clínicos e diretrizes terapêuticas

**Outras respostas humanas neste documento:**

- **naomi.dnsn**: Não informado se há possibilidade de substituição por outro medicamento constante das listas do SUS e dos protocolos clínicos e diretrizes terapêuticas
- **matheuscadedi**: Não informado se há possibilidade de substituição por outro medicamento constante das listas do SUS e dos protocolos clínicos e diretrizes terapêuticas

---

## `q13_pericia_medica` — Houve produção de perícia médica ordenada pelo(a) juiz(a)?

**Orientação aos pesquisadores:** Para essa pergunta, desconsidere NatJus.

**Tipo:** `single` · **Opções:** Sim, perícia recomenda uso do tratamento · Sim, mas perícia NÃO recomenda uso do tratamento · Não houve produção de perícia (essa informação aparece expressamente) · Não informado se houve produção de perícia · Sim, mas não dá para saber se perícia recomenda

**Classe:** ok

**Concordância inter-humana:** 82% dos 17 pares em 17 documentos · α = +0.82 [+0.61, +1.00]

**Piso de ruído:** 9% bruto, 18% leave-one-out, IC95 0%–35% (n=17 documentos)

**Respostas humanas (n=40):**

**Não informado se houve produção de perícia**: 18 · **Não houve produção de perícia (essa informação aparece expressamente)**: 8 · **Sim, perícia recomenda uso do tratamento**: 7 · **Sim, mas não dá para saber se perícia recomenda**: 6 · **Sim, mas perícia NÃO recomenda uso do tratamento**: 1

### Casos em que o LLM divergiu do gabarito (2)

#### Caso 1 — 1001623-26.2022.8.26.0127

_revisado 2026-08-17T22:36 · por d9b22caa-ab02-41e1-9d1e-da51035663c0_

- **LLM respondeu:** Sim, perícia recomenda uso do tratamento
- **Justificativa LLM:**
> A sentença refere que "A perícia realizada pelo IMESC, bem como a documentação médica produzida pela parte autora, confirmam a gravidade do quadro clínico, a ausência de terapias alternativas e a existência de indicação clara, segura e compatível".
- **Gabarito:** Sim, mas não dá para saber se perícia recomenda

**Outras respostas humanas neste documento:**

- **Pedro Gomes**: Sim, perícia recomenda uso do tratamento
- **marianapuschel**: Sim, mas não dá para saber se perícia recomenda

#### Caso 2 — 5014066-68.2024.4.03.6100

_revisado 2026-08-18T00:03 · por 76b5b21c-59e7-4fbd-b080-cdfda5d4eb17_

- **LLM respondeu:** Não houve produção de perícia (essa informação aparece expressamente)
- **Justificativa LLM:**
> O juízo dispensou a realização de perícia médica e julgou antecipadamente a lide: "Houve saneamento do feito (ID. 347770127) [...] bem como encerrada a instrução diante da suficiência dos elementos apresentados nos autos" e "julgar antecipadamente a lide, nos termos do artigo 355, inciso I, do CPC, diante da desnecessidade de produção de outras provas".
- **Gabarito:** Não informado se houve produção de perícia

**Outras respostas humanas neste documento:**

- **Pedro Gomes**: Não informado se houve produção de perícia
- **wangdanielwl**: Não informado se houve produção de perícia

---

## `q26_avaliacao_conitec` — Houve avaliação da Conitec para o medicamento em questão?

**Tipo:** `single` · **Opções:** Sim, e tratamento foi recomendado para incorporação do subtipo · Sim, mas tratamento NÃO foi recomendado para incorporação do subtipo · Não houve avaliação da Conitec (essa informação aparece expressamente) · Não informado se houve relatório de avaliação da Conitec · Sim, mas tratamento NÃO foi recomendado para incorporação para nenhum subtipo da doença

**Classe:** ok

**Concordância inter-humana:** 71% dos 17 pares em 17 documentos · α = +0.70 [+0.45, +0.87]

**Piso de ruído:** 21% bruto, 35% leave-one-out, IC95 12%–59% (n=17 documentos)

**Respostas humanas (n=40):**

**Sim, e tratamento foi recomendado para incorporação do subtipo**: 20 · **Sim, mas tratamento NÃO foi recomendado para incorporação do subtipo**: 12 · **Não informado se houve relatório de avaliação da Conitec**: 6 · **Não houve avaliação da Conitec (essa informação aparece expressamente)**: 1 · **Sim, mas tratamento NÃO foi recomendado para incorporação para nenhum subtipo da doença**: 1

### Casos em que o LLM divergiu do gabarito (2)

#### Caso 1 — 1004976-13.2024.4.01.3400

_revisado 2026-08-17T22:51 · por 76b5b21c-59e7-4fbd-b080-cdfda5d4eb17_

- **LLM respondeu:** Não informado se houve relatório de avaliação da Conitec
- **Justificativa LLM:**
> A sentença menciona a incorporação do fármaco pela Portaria SCTIE/MS nº 172/2022 para AME Tipo I e cita o PCDT da Conitec para Tipos 1 e 2, mas não informa expressamente se houve avaliação da Conitec para o Zolgensma no subtipo Tipo II da demandante.
- **Gabarito:** Sim, e tratamento foi recomendado para incorporação do subtipo

**Outras respostas humanas neste documento:**

- **luizscho**: Sim, e tratamento foi recomendado para incorporação do subtipo
- **Pedro Gomes**: Não informado se houve relatório de avaliação da Conitec

#### Caso 2 — 1026431-34.2024.4.01.3400

_revisado 2026-08-17T01:43 · por 334390e4-358d-44bd-b04a-2bbf4bc1bdd7_

- **LLM respondeu:** Sim, e tratamento foi recomendado para incorporação do subtipo
- **Justificativa LLM:**
> "IV) o medicamento ZOLGENSMA foi analisado pela Rede Pública e encontra-se incorporado para tratamento de Atrofia Muscular Espinha (AME) TIPO 1, para criança com até 6 (seis) meses de idade, desde o dia 06/12/2022". O texto confirma a incorporação do fármaco para o subtipo específico (AME tipo 1 até 6 meses).
- **Gabarito:** Sim, mas tratamento NÃO foi recomendado para incorporação do subtipo

**Outras respostas humanas neste documento:**

- **matheuscadedi**: Não informado se houve relatório de avaliação da Conitec
- **leitedesouza.jacqueline**: Sim, mas tratamento NÃO foi recomendado para incorporação do subtipo

---

## `q1_numero_processo` — Número do processo judicial

**Orientação aos pesquisadores:** Incluir apenas o número do processo judicial do próprio caso. Não considerar números de outros processos que eventualmente sejam citados na decisão.

**Tipo:** `text` · **Opções:** Não identificável

**Classe:** ok

**Concordância inter-humana:** 88% dos 17 pares em 17 documentos · _campo aberto — sem correção por acaso_

**Piso de ruído:** 6% bruto, 12% leave-one-out, IC95 0%–29% (n=17 documentos)

**Respostas humanas (n=40):**

**1086747-81.2022.4.01.3400**: 2 · **1004976-13.2024.4.01.3400**: 2 · **1000113-21.2023.4.01.3603**: 2 · **1027146-13.2023.4.01.3400**: 2 · **5000260-12.2025.4.03.6138**: 2 · **1020049-65.2024.8.26.0564**: 2 · **1084899-59.2022.4.01.3400**: 2 · **5018265-24.2022.4.02.5101**: 2 · _(+17 outras)_

### Casos em que o LLM divergiu do gabarito (1)

#### Caso 1 — 5009478-51.2019.4.02.5120

_revisado 2026-08-14T23:26 · por dcbc9803-6efb-469b-892f-25e029d47424_

- **LLM respondeu:** 5009478-51.2019.4.02.5120/RJ
- **Justificativa LLM:**
> O número do processo consta no cabeçalho da decisão: "PROCEDIMENTO COMUM Nº 5009478-51.2019.4.02.5120/RJ".
- **Gabarito:** 5009478-51.2019.4.02.5120

**Outras respostas humanas neste documento:**

- **naomi.dnsn**: 5009478-51.2019.4.02.5120
- **matheuscadedi**: 5009478-51.2019.4.02.5120

---

## `q7_decisao_e_liminar` — Decisão analisada é liminar?

**Tipo:** `single` · **Opções:** Sim · Não · Não é possível ter certeza 

**Classe:** ok

**Concordância inter-humana:** 82% dos 17 pares em 17 documentos · α = +0.82 [+0.62, +1.00]

**Piso de ruído:** 9% bruto, 18% leave-one-out, IC95 0%–35% (n=17 documentos)

**Respostas humanas (n=40):**

**Não**: 37 · **Sim**: 3

**Sinais de ambiguidade:** 1 célula(s) com revisores discordando entre si.

### Casos em que o LLM divergiu do gabarito (1)

#### Caso 1 — 1027146-13.2023.4.01.3400

_revisado 2026-08-17T14:47 · por 334390e4-358d-44bd-b04a-2bbf4bc1bdd7_

- **LLM respondeu:** Não
- **Justificativa LLM:**
> Trata-se de sentença de mérito: "SENTENÇA TIPO 'A'" e "JULGO PROCEDENTE O PEDIDO, com fulcro no art. 487, I, do CPC".
- **Gabarito:** Sim

**Outras respostas humanas neste documento:**

- **naomi.dnsn**: Sim
- **leitedesouza.jacqueline**: Não

---

## `q18_imprescindibilidade_clinica` — De acordo com tribunal, há imprescindibilidade clínica do tratamento, comprovada mediante laudo médico fundamentado?

**Tipo:** `single` · **Opções:** Sim, há imprescindibilidade clínica do tratamento, comprovada mediante laudo médico fundamentado · Não há imprescindibilidade clínica do tratamento, comprovada mediante laudo médico fundamentado · Não informado se há imprescindibilidade clínica do tratamento, comprovada mediante laudo médico fundamentado

**Classe:** ok

**Concordância inter-humana:** 71% dos 17 pares em 17 documentos · α = +0.70 [+0.44, +0.93]

**Piso de ruído:** 15% bruto, 29% leave-one-out, IC95 6%–53% (n=17 documentos)

**Respostas humanas (n=40):**

**Sim, há imprescindibilidade clínica do tratamento, comprovada mediante laudo médico fundamentado**: 18 · **Não há imprescindibilidade clínica do tratamento, comprovada mediante laudo médico fundamentado**: 14 · **Não informado se há imprescindibilidade clínica do tratamento, comprovada mediante laudo médico fundamentado**: 8

### Casos em que o LLM divergiu do gabarito (1)

#### Caso 1 — 5001589-11.2024.4.03.6133

_revisado 2026-08-17T19:25 · por c73ffb91-38b7-43df-9751-137690a96ea8_

- **LLM respondeu:** Não há imprescindibilidade clínica do tratamento, comprovada mediante laudo médico fundamentado
- **Justificativa LLM:**
> O magistrado rejeitou a fundamentação dos laudos do autor afirmando que: "O documento com ID 359700581, subscrito pelo Dr. Rodrigo Holanda, afiança 'ganhos importantes' sem fundamento em parâmetros objetivamente aferíveis e comprováveis (...) Dito de outro modo, não demonstrou a parte autora de forma concreta e objetiva os resultados supostamente alcançados".
- **Gabarito:** Não informado se há imprescindibilidade clínica do tratamento, comprovada mediante laudo médico fundamentado

**Outras respostas humanas neste documento:**

- **luizscho**: Não informado se há imprescindibilidade clínica do tratamento, comprovada mediante laudo médico fundamentado
- **matheuscadedi**: Não informado se há imprescindibilidade clínica do tratamento, comprovada mediante laudo médico fundamentado

---

## `q19_incapacidade_financeira` — De acordo com tribunal, há incapacidade financeira de arcar com o custeio do medicamento?

**Tipo:** `single` · **Opções:** Sim, há incapacidade financeira de arcar com o custeio do medicamento · Não há incapacidade financeira de arcar com o custeio do medicamento · Não informado se há incapacidade financeira de arcar com o custeio do medicamento

**Classe:** ok

**Concordância inter-humana:** 88% dos 17 pares em 17 documentos · α = +0.88 [+0.69, +1.00]

**Piso de ruído:** 6% bruto, 12% leave-one-out, IC95 0%–29% (n=17 documentos)

**Respostas humanas (n=40):**

**Sim, há incapacidade financeira de arcar com o custeio do medicamento**: 21 · **Não informado se há incapacidade financeira de arcar com o custeio do medicamento**: 19

**Sinais de ambiguidade:** 1 célula(s) com revisores discordando entre si.

### Casos em que o LLM divergiu do gabarito (1)

#### Caso 1 — 5001589-11.2024.4.03.6133

_revisado 2026-08-17T19:19 · por c73ffb91-38b7-43df-9751-137690a96ea8_

- **LLM respondeu:** Sim, há incapacidade financeira de arcar com o custeio do medicamento
- **Justificativa LLM:**
> O juiz registra que foi "deferida a gratuidade de justiça (ID 335587446)" e manteve a suspensão da exigibilidade das custas e honorários "em razão do deferimento de gratuidade da justiça, nos termos do artigo 98, §3º, do Código de Processo Civil".
- **Gabarito:** Não informado se há incapacidade financeira de arcar com o custeio do medicamento

**Outras respostas humanas neste documento:**

- **luizscho**: Não informado se há incapacidade financeira de arcar com o custeio do medicamento
- **matheuscadedi**: Não informado se há incapacidade financeira de arcar com o custeio do medicamento

---

## `q20_questionou_merito_conitec` — Tribunal questionou o mérito da recomendação da Conitec contrária à incorporação (tribunal diverge dos fundamentos científicos, econômicos e de política pública da Conitec para não recomendar o tratamento)?

**Tipo:** `single` · **Opções:** Sim, tribunal questionou o mérito da recomendação da Conitec contrária à incorporação · Não, tribunal não questionou o mérito da recomendação da Conitec contrária à incorporação · Não se aplica porque não houve recomendação da Conitec · Não informado se houve recomendação ou não da Conitec · Não se aplica, porque foi incorporado 

**Classe:** ok

**Concordância inter-humana:** 71% dos 17 pares em 17 documentos · α = +0.70 [+0.44, +0.88]

**Piso de ruído:** 26% bruto, 35% leave-one-out, IC95 12%–59% (n=17 documentos)

**Respostas humanas (n=40):**

**Não se aplica, porque foi incorporado **: 20 · **Não, tribunal não questionou o mérito da recomendação da Conitec contrária à incorporação**: 11 · **Não informado se houve recomendação ou não da Conitec**: 5 · **Não se aplica porque não houve recomendação da Conitec**: 2 · **Sim, tribunal questionou o mérito da recomendação da Conitec contrária à incorporação**: 2

### Casos em que o LLM divergiu do gabarito (1)

#### Caso 1 — 1090103-50.2023.4.01.3400

_revisado 2026-08-15T22:59 · por dcbc9803-6efb-469b-892f-25e029d47424_

- **LLM respondeu:** Não, tribunal não questionou o mérito da recomendação da Conitec contrária à incorporação
- **Justificativa LLM:**
> O juiz acolheu integralmente as diretrizes e critérios estabelecidos pela Conitec na Portaria SCTIE/MS nº 172/2022, utilizando a restrição clínica (paciente em ventilação invasiva prolongada) para justificar a improcedência do pedido.
- **Gabarito:** Não se aplica, porque foi incorporado 

**Outras respostas humanas neste documento:**

- **naomi.dnsn**: Não se aplica, porque foi incorporado 
- **matheuscadedi**: Não se aplica, porque foi incorporado 

---

## `q29_ressarcimento_liminar` — Quando houve concessão de liminar, mas a decisão de mérito foi contrária ao fundamento, decisão prevê ressarcimento, por parte do autor da ação, do valor dispendido pelo respondente para cumprimento da liminar?

**Tipo:** `single` · **Opções:** Sim, há ordem de ressarcimento do valor dispendido pelo respondente para cumprimento da liminar · Não há obrigação de ressarcimento do valor dispendido pelo respondente para cumprimento da liminar · Não há menção a ressarcimento do valor dispendido pelo respondente para cumprimento da liminar · Não se aplica

**Classe:** ok

**Concordância inter-humana:** 88% dos 17 pares em 17 documentos · α = +0.88 [+0.68, +1.00]

**Piso de ruído:** 12% bruto, 18% leave-one-out, IC95 0%–35% (n=17 documentos)

**Respostas humanas (n=40):**

**Não se aplica**: 34 · **Não há menção a ressarcimento do valor dispendido pelo respondente para cumprimento da liminar**: 3 · **Não há obrigação de ressarcimento do valor dispendido pelo respondente para cumprimento da liminar**: 3

**Sinais de ambiguidade:** 1 célula(s) com revisores discordando entre si.

### Casos em que o LLM divergiu do gabarito (1)

#### Caso 1 — 5009478-51.2019.4.02.5120

_revisado 2026-08-17T16:45 · por 334390e4-358d-44bd-b04a-2bbf4bc1bdd7_

- **LLM respondeu:** Não há menção a ressarcimento do valor dispendido pelo respondente para cumprimento da liminar
- **Justificativa LLM:**
> Apesar de haver liminar deferida pelo TRF2 e cumprida parcialmente pela União, o juiz apenas determinou: "Oficie-se ao Exmo. Relator do agravo de instrumento 5001875-24.2020.4.02.0000 para ciência, sendo certo que ao E. TRF cabe deliberar sobre os efeitos do referido recurso", não deliberando sobre ressarcimento.
- **Gabarito:** Não se aplica

**Outras respostas humanas neste documento:**

- **naomi.dnsn**: Não se aplica
- **matheuscadedi**: Não se aplica

---

## `q5_data_nascimento_paciente` — Data de nascimento do paciente

**Orientação aos pesquisadores:** Pode estar escrito DN abreviado

**Tipo:** `date` · **Opções:** Não informada

**Classe:** ok

**Concordância inter-humana:** 94% dos 17 pares em 17 documentos · α = +0.94 [+0.80, +1.00]

**Piso de ruído:** 3% bruto, 6% leave-one-out, IC95 0%–18% (n=17 documentos)

**Respostas humanas (n=40):**

**Não informada**: 27 · **09/09/2022**: 2 · **03/02/2024**: 2 · **28/08/2022**: 2 · **17/12/2022**: 2 · **01/07/2024**: 2 · **03/05/2010**: 1 · **11/01/2022**: 1 · _(+1 outras)_

---

## `q8_houve_liminar` — Se decisão analisada não é liminar, houve decisão liminar?

**Tipo:** `single` · **Opções:** Sim e a liminar foi DEFERIDA · Sim e a liminar foi INDEFERIDA · Não houve decisão liminar (essa informação aparece expressamente) · Não informado se houve decisão liminar

**Classe:** ok

**Concordância inter-humana:** 93% dos 14 pares em 14 documentos · α = +0.93 [+0.76, +1.00]

**Piso de ruído:** 11% bruto, 14% leave-one-out, IC95 0%–36% (n=14 documentos)

**Respostas humanas (n=37):**

**Sim e a liminar foi DEFERIDA**: 22 · **Sim e a liminar foi INDEFERIDA**: 12 · **Não informado se houve decisão liminar**: 2 · **Não houve decisão liminar (essa informação aparece expressamente)**: 1

**Sinais de ambiguidade:** 2 célula(s) com revisores discordando entre si.

---

## `q9_registro_anvisa` — Tem registro na Anvisa?

**Tipo:** `single` · **Opções:** Sim, há informação que tem registro · Não, há informação que não tem registro · Não é informado se tratamento é registrado ou não

**Classe:** ok

**Concordância inter-humana:** 100% dos 17 pares em 17 documentos · α = +1.00 [+1.00, +1.00]

**Piso de ruído:** 0% bruto, 0% leave-one-out, IC95 0%–0% (n=17 documentos)

**Respostas humanas (n=40):**

**Sim, há informação que tem registro**: 36 · **Não é informado se tratamento é registrado ou não**: 4

---

## `q14_negativa_administrativa` — Houve negativa de fornecimento do medicamento pela via administrativa?

**Tipo:** `single` · **Opções:** Sim, houve negativa de fornecimento pela via administrativa · Não houve negativa de fornecimento pela via administrativa (essa informação aparece expressamente) · Não informado se houve negativa de fornecimento do medicamento pela via administrativa

**Classe:** ok

**Concordância inter-humana:** 76% dos 17 pares em 17 documentos · α = +0.76 [+0.51, +0.94]

**Piso de ruído:** 18% bruto, 29% leave-one-out, IC95 12%–53% (n=17 documentos)

**Respostas humanas (n=40):**

**Não informado se houve negativa de fornecimento do medicamento pela via administrativa**: 29 · **Sim, houve negativa de fornecimento pela via administrativa**: 8 · **Não houve negativa de fornecimento pela via administrativa (essa informação aparece expressamente)**: 3

**Sinais de ambiguidade:** 2 célula(s) com revisores discordando entre si.

---

## `q23_natjus_converge_juiz` — A recomendação do NAT-JUS converge com a do juiz?

**Tipo:** `single` · **Opções:** Sim · Não · Somente para algum dos medicamentos pleiteados (em caso de haver mais de um) · Não informado

**Classe:** ok

**Concordância inter-humana:** 100% dos 11 pares em 11 documentos · α = +1.00 [+1.00, +1.00]

**Piso de ruído:** 0% bruto, 0% leave-one-out, IC95 0%–0% (n=11 documentos)

**Respostas humanas (n=29):**

**Sim**: 25 · **Não**: 4

---

## `q27_decisao_concede` — Decisão concede o tratamento para o paciente?

**Tipo:** `single` · **Opções:** Sim, concede integralmente o tratamento · Sim, concede parcialmente o tratamento · Não concede o tratamento · Não houve decisão de mérito

**Classe:** ok

**Concordância inter-humana:** 100% dos 17 pares em 17 documentos · α = +1.00 [+1.00, +1.00]

**Piso de ruído:** 0% bruto, 0% leave-one-out, IC95 0%–0% (n=17 documentos)

**Respostas humanas (n=40):**

**Sim, concede integralmente o tratamento**: 20 · **Não concede o tratamento**: 19 · **Não houve decisão de mérito**: 1

---

## Funil de filtros

| Etapa | Células restantes |
|---|---:|
| células brutas (resposta × campo) | 3488 |
| documentos ativos | 3044 |
| rodada de codificação: Teste 2 do formulário (v2) | 1779 |
| rodada de LLM selecionada | 1779 |
| sem llm_error | 1779 |
| rascunhos humanos fora | 1779 |
| campos comparáveis | 1504 |
| aplicáveis (schema da época + condicional) | 1464 |
