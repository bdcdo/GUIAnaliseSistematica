#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
checker="$repo_root/.github/scripts/check-frontend-fly-machines.sh"
workflow="$repo_root/.github/workflows/frontend-fly-deploy.yml"
fly_config="$repo_root/frontend/fly.toml"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
mkdir -p "$tmp_dir/bin"

cat >"$tmp_dir/bin/flyctl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

case "${1:-} ${2:-}" in
  "machine list") printf '%s' "$MACHINES_JSON" ;;
  "checks list") printf '%s' "$CHECKS_JSON" ;;
  *) echo "flyctl inesperado: $*" >&2; exit 64 ;;
esac
EOF
chmod +x "$tmp_dir/bin/flyctl"
cat >"$tmp_dir/bin/sleep" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$tmp_dir/bin/sleep"

# autostop/autostart sao emitidos como JSON cru (nao entre aspas) porque o
# flyctl serializa "off" como o booleano false; passar a string "stop" aqui
# reproduz a outra forma que a API aceita para o mesmo campo.
machine() {
  local state="${1:-started}"
  local region="${2:-gru}"
  local cpu_kind="${3:-shared}"
  local cpus="${4:-1}"
  local memory_mb="${5:-512}"
  local autostop="${6:-false}"
  local autostart="${7:-true}"
  printf '[{"id":"machine-1","state":"%s","region":"%s","config":{"guest":{"cpu_kind":"%s","cpus":%s,"memory_mb":%s},"services":[{"internal_port":3000,"autostop":%s,"autostart":%s}]}}]' \
    "$state" "$region" "$cpu_kind" "$cpus" "$memory_mb" "$autostop" "$autostart"
}

run_checker() {
  env \
    "PATH=$tmp_dir/bin:$PATH" \
    MACHINES_JSON="$MACHINES_JSON" \
    CHECKS_JSON="$CHECKS_JSON" \
    bash "$checker" "$1"
}

expect_failure() {
  if "$@" >/dev/null 2>&1; then
    echo "comando deveria ter falhado: $*" >&2
    exit 1
  fi
}

bash -n "$checker" "$0"

MACHINES_JSON='[]'
CHECKS_JSON='{}'
run_checker pre >/dev/null
MACHINES_JSON="$(machine)"
run_checker pre >/dev/null
MACHINES_JSON="[$(machine | sed 's/^\[//; s/\]$//'),$(machine | sed 's/^\[//; s/\]$//')]"
expect_failure run_checker pre
MACHINES_JSON='{"unexpected":"shape"}'
expect_failure run_checker pre

MACHINES_JSON="$(machine)"
CHECKS_JSON='{"machine-1":[{"name":"servicecheck-00-http-3000","status":"passing"}]}'
run_checker post >/dev/null

for invalid_machine in \
  "$(machine stopped)" \
  "$(machine started iad)" \
  "$(machine started gru performance)" \
  "$(machine started gru shared 2)" \
  "$(machine started gru shared 1 1024)" \
  "$(machine started gru shared 1 512 true)" \
  "$(machine started gru shared 1 512 '"stop"')" \
  "$(machine started gru shared 1 512 '"suspend"')" \
  "$(machine started gru shared 1 512 false false)" \
  "$(machine | jq -c '[.[0] | .config.services = []]')" \
  "$(machine | jq -c '[.[0] | del(.config.services)]')"
do
  MACHINES_JSON="$invalid_machine"
  expect_failure run_checker post
done

MACHINES_JSON="$(machine)"
CHECKS_JSON='{}'
expect_failure run_checker post
CHECKS_JSON='{"machine-1":[{"name":"servicecheck-00-http-3000","status":"critical"}]}'
expect_failure run_checker post

ruby -ryaml -e '
  workflow = YAML.safe_load(File.read(ARGV.fetch(0)), aliases: true)
  trigger = workflow["on"] || workflow[true]
  paths = trigger.fetch("push").fetch("paths")
  abort("mudança no checker precisa disparar o workflow") unless paths.include?(".github/scripts/check-frontend-fly-machines.sh")
  steps = workflow.fetch("jobs").fetch("deploy").fetch("steps")
  runs = steps.filter_map { |step| step["run"] }
  pre = runs.index { |run| run.include?("check-frontend-fly-machines.sh pre") }
  deploy = runs.index { |run| run.include?("flyctl deploy") && run.include?("--ha=false") }
  post = runs.index { |run| run.include?("check-frontend-fly-machines.sh post") }
  abort("workflow sem ordem preflight -> deploy -> postflight") unless pre && deploy && post && pre < deploy && deploy < post
' "$workflow"

# A comparação é por linha inteira e sobre o fly.toml já sem comentários: o
# arquivo documenta em prosa os valores que estas asserções rejeitam (o bloco
# do always-on cita "min_machines_running = 1"), então um grep de substring
# passaria a casar a documentação em vez da diretiva e aprovaria justamente a
# mudança que deveria barrar. O -Fx também dispensa escapar os metacaracteres
# de regex que aparecem nos valores.
fly_directives="$(sed 's/#.*//; s/[[:space:]]*$//; s/^[[:space:]]*//' "$fly_config")"

assert_directive() {
  grep -Fxq "$1" <<<"$fly_directives" && return 0
  echo "frontend/fly.toml sem a diretiva esperada: $1" >&2
  exit 1
}

assert_directive 'strategy = "bluegreen"'
# Always-on é asserido aqui, e não só documentado no fly.toml, porque a volta
# silenciosa do scale-to-zero foi o que tirou o site do ar em 2026-08-10: a
# Machine parou por ociosidade e o host de gru não tinha CPU livre para
# reacendê-la. Reintroduzir "stop"/0 tem que passar por esta linha.
assert_directive 'auto_stop_machines = "off"'
assert_directive 'auto_start_machines = true'
assert_directive 'min_machines_running = 1'
assert_directive 'swap_size_mb = 512'
assert_directive 'size = "shared-cpu-1x"'
assert_directive 'memory = "512mb"'

echo "Contrato de Machines do frontend validado."
