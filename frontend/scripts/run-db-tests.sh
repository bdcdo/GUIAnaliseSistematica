#!/usr/bin/env bash
#
# Roda TODAS as suítes de contrato do banco numa varredura única e reporta cada
# uma, em vez do encadeamento por `&&` do antigo `test:db`. O `&&` parava na
# primeira falha e escondia as demais — foi por isso que quatro suítes ficaram
# vermelhas na main sem ninguém ver (issue #557). Aqui nenhuma falha interrompe
# a varredura; o exit code agrega o resultado do conjunto de gate.
#
# Dois formatos de suíte convivem (ver run-sql-test.sh): `responses_llm_actor_
# integrity` é pgTAP e roda por `supabase test db`; as demais sinalizam falha
# com `RAISE EXCEPTION 'FALHOU ...'` e rodam por psql com ON_ERROR_STOP=1.
#
# Três guardas fecham os modos de drift que originaram ou disfarçariam a #557:
#   1. Drift disco↔runner: a causa raiz da #557 foi uma suíte .test.sql fora de
#      toda cadeia. Aqui, qualquer .test.sql no disco não classificado em um dos
#      três conjuntos — ou qualquer suíte listada sem arquivo no disco — derruba
#      o gate ANTES de rodar. O estado "suíte fora do gate" fica irrepresentável.
#   2. KNOWN_RED que fica verde: quando uma órfã rastreada passa a passar, o gate
#      falha pedindo a promoção para GATE_SUITES — a exceção não apodrece
#      silenciosamente até alguém reparar (drift no sentido bom, mas ainda drift).
#   3. Diagnóstico em falha: a saída de cada suíte vai para um log; em FAIL de
#      gate a cauda é impressa, sem exigir re-run do npm script individual.

# Sem `-e`: a varredura precisa continuar após uma suíte falhar.
set -uo pipefail

cd "$(dirname "$0")/.." || exit 2

# Preflight: o container precisa estar RODANDO, não só existir. Um container
# parado passaria por `docker inspect` puro e cada suíte falharia com a saída
# suprimida — 13 FAIL opacos em vez de uma mensagem legível.
CONTAINER="${SUPABASE_DB_CONTAINER:-supabase_db_frontend}"
if [[ "$(docker inspect -f '{{.State.Running}}' "${CONTAINER}" 2>/dev/null)" != true ]]; then
  echo "container ${CONTAINER} não está rodando — rode 'npx supabase start' antes." >&2
  exit 2
fi

TESTS_DIR="supabase/tests"

# pgTAP — roda por `supabase test db`.
PGTAP_SUITES=(
  responses_llm_actor_integrity
  response_references_document_scoped
)

# Suítes de gate (fail-closed): qualquer falha aqui derruba o exit code.
GATE_SUITES=(
  canonical_project_identity_rls
  clerk_mapping_completion
  auto_review_assignment_sync
  atomic_replace_rpcs
  explicit_assignment_rounds
  llm_rate_limit
  member_permission_rpcs
  project_members_column_guard
  responses_one_latest_human
  auto_review_assignment_concurrency
  responses_latest_human_concurrency
  response_round_serialization
  unmark_equivalence_atomic
  auto_review_reconciliation_outbox
  arbitration_reopen
  rls_audit
  remove_project_member_self_identity
)

# Órfãs quebradas pela era da migration 20260717120000 (índice único one-latest
# de LLM e connstr de dblink), fora do escopo da #557 e rastreadas em issues
# próprias. Rodam e são reportadas, mas NÃO derrubam o gate até serem
# consertadas. Isto NÃO é silenciamento: cada uma aparece no resumo com sua
# issue; ao consertar, mover para GATE_SUITES (a guarda 2 força esse passo).
declare -A KNOWN_RED=(
  [schema_revision_rpcs]="#571"
  [schema_revision_serialization]="#572"
)

# ── Guarda 1: drift entre o runner e o disco (fecha a causa raiz da #557). ────
# O conjunto classificado é a união dos três; a fonte da verdade de "quem é
# suíte" é o glob *.test.sql. Divergência nos dois sentidos derruba o gate antes
# de rodar qualquer coisa.
declare -A CLASSIFIED=()
for s in "${PGTAP_SUITES[@]}" "${GATE_SUITES[@]}" "${!KNOWN_RED[@]}"; do
  CLASSIFIED["$s"]=1
done

drift=()
for f in "${TESTS_DIR}"/*.test.sql; do
  [[ -e "$f" ]] || continue
  base="$(basename "$f" .test.sql)"
  [[ -n "${CLASSIFIED[$base]:-}" ]] || drift+=("não classificada no runner: ${base}")
done
for s in "${!CLASSIFIED[@]}"; do
  [[ -f "${TESTS_DIR}/${s}.test.sql" ]] || drift+=("listada mas ausente no disco: ${s}")
done
if [[ ${#drift[@]} -gt 0 ]]; then
  echo "▸ drift entre o runner e ${TESTS_DIR}/ — corrija antes de rodar:" >&2
  printf '   - %s\n' "${drift[@]}" >&2
  echo "adicione a suíte a GATE_SUITES/KNOWN_RED (ou remova a entrada obsoleta)." >&2
  exit 1
fi

pass=()
fail_gate=()
fail_known=()
promote=()

# Log por suíte para diagnóstico em falha (guarda 3), limpo ao sair.
LOG_DIR="$(mktemp -d)"
trap 'rm -rf "${LOG_DIR}"' EXIT

run_pgtap() {
  npx supabase test db "${TESTS_DIR}/$1.test.sql" --local >"${LOG_DIR}/$1.log" 2>&1
}

run_psql() {
  bash scripts/run-sql-test.sh "${TESTS_DIR}/$1.test.sql" >"${LOG_DIR}/$1.log" 2>&1
}

tail_log() {
  echo "    ── saída (cauda):"
  tail -n 15 "${LOG_DIR}/$1.log" | sed 's/^/    /'
}

report() {
  local suite="$1" code="$2" gated="$3"
  if [[ ${code} -eq 0 ]]; then
    if [[ ${gated} == known ]]; then
      # Guarda 2: órfã conhecida-vermelha passou — força a promoção.
      printf '  VERDE %s (era conhecida-vermelha %s — promova para GATE_SUITES)\n' \
        "${suite}" "${KNOWN_RED[$suite]}"
      promote+=("${suite}")
    else
      printf '  PASS  %s\n' "${suite}"
      pass+=("${suite}")
    fi
  elif [[ ${gated} == gate ]]; then
    printf '  FAIL  %s\n' "${suite}"
    fail_gate+=("${suite}")
    tail_log "${suite}"
  else
    printf '  RED*  %s (conhecida, %s)\n' "${suite}" "${KNOWN_RED[$suite]}"
    fail_known+=("${suite}")
  fi
}

echo "▸ suítes de contrato do banco (varredura completa)"

for s in "${PGTAP_SUITES[@]}"; do
  run_pgtap "$s"; report "$s" $? gate
done
for s in "${GATE_SUITES[@]}"; do
  run_psql "$s"; report "$s" $? gate
done
for s in "${!KNOWN_RED[@]}"; do
  run_psql "$s"; report "$s" $? known
done

echo "────────────────────────────────────────"
printf 'PASS=%d  FAIL(gate)=%d  RED*(conhecida)=%d  VERDE(promover)=%d\n' \
  "${#pass[@]}" "${#fail_gate[@]}" "${#fail_known[@]}" "${#promote[@]}"

if [[ ${#fail_known[@]} -gt 0 ]]; then
  echo "RED* (não bloqueia; rastreada em issue): ${fail_known[*]}"
fi

status=0
if [[ ${#promote[@]} -gt 0 ]]; then
  echo "PROMOVER: ${promote[*]} ficou(ram) verde(s) — mova de KNOWN_RED para GATE_SUITES." >&2
  status=1
fi
if [[ ${#fail_gate[@]} -gt 0 ]]; then
  echo "FALHOU: ${fail_gate[*]}"
  status=1
fi
if [[ ${status} -eq 0 ]]; then
  echo "OK: todas as suítes de gate passaram."
fi
exit ${status}
