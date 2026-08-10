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

machine() {
  local state="${1:-started}"
  local region="${2:-gru}"
  local cpu_kind="${3:-shared}"
  local cpus="${4:-1}"
  local memory_mb="${5:-512}"
  printf '[{"id":"machine-1","state":"%s","region":"%s","config":{"guest":{"cpu_kind":"%s","cpus":%s,"memory_mb":%s}}}]' \
    "$state" "$region" "$cpu_kind" "$cpus" "$memory_mb"
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
  "$(machine started gru shared 1 1024)"
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

grep -Fq 'strategy = "bluegreen"' "$fly_config"
# Always-on é asserido aqui, e não só documentado no fly.toml, porque a volta
# silenciosa do scale-to-zero foi o que tirou o site do ar em 2026-08-10: a
# Machine parou por ociosidade e o host de gru não tinha CPU livre para
# reacendê-la. Reintroduzir "stop"/0 tem que passar por esta linha.
grep -Fq 'auto_stop_machines = "off"' "$fly_config"
grep -Fq 'auto_start_machines = true' "$fly_config"
grep -Fq 'min_machines_running = 1' "$fly_config"
grep -Fq 'swap_size_mb = 512' "$fly_config"
grep -Fq 'size = "shared-cpu-1x"' "$fly_config"
grep -Fq 'memory = "512mb"' "$fly_config"

echo "Contrato de Machines do frontend validado."
