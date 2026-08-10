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

# O id é parametrizado porque CHECKS_JSON é indexado por id: com dois elementos
# de id igual, o caso "uma Machine saudável e outra não" seria indistinguível de
# "as duas saudáveis" e o teste de health passaria a ser vácuo.
#
# autostop/autostart sao emitidos como JSON cru (nao entre aspas) porque o
# flyctl serializa "off" como o booleano false; passar a string "stop" aqui
# reproduz a outra forma que a API aceita para o mesmo campo.
machine() {
  local id="${1:-machine-1}"
  local state="${2:-started}"
  local region="${3:-gru}"
  local cpu_kind="${4:-shared}"
  local cpus="${5:-1}"
  local memory_mb="${6:-512}"
  local autostop="${7:-false}"
  local autostart="${8:-true}"
  printf '{"id":"%s","state":"%s","region":"%s","config":{"guest":{"cpu_kind":"%s","cpus":%s,"memory_mb":%s},"services":[{"internal_port":3000,"autostop":%s,"autostart":%s}]}}' \
    "$id" "$state" "$region" "$cpu_kind" "$cpus" "$memory_mb" "$autostop" "$autostart"
}

machines() {
  local IFS=','
  printf '[%s]' "$*"
}

# Mapa machine_id -> checks, na forma que `flyctl checks list --json` devolve.
checks_for() {
  local out='{}' id
  for id in "$@"; do
    out="$(jq -c --arg id "$id" \
      '.[$id] = [{"name":"servicecheck-00-http-3000","status":"passing"}]' <<<"$out")"
  done
  printf '%s' "$out"
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

two_machines="$(machines "$(machine machine-1)" "$(machine machine-2)")"
two_healthy="$(checks_for machine-1 machine-2)"

# Preflight aceita 0..2: o `flyctl scale count 2` do workflow roda depois dele e
# converge, então recusar 1 impediria o deploy de se auto-curar depois de perder
# uma Machine. Acima do contrato, recusa.
CHECKS_JSON='{}'
MACHINES_JSON='[]'
run_checker pre >/dev/null
MACHINES_JSON="$(machines "$(machine machine-1)")"
run_checker pre >/dev/null
MACHINES_JSON="$two_machines"
run_checker pre >/dev/null
MACHINES_JSON="$(machines "$(machine machine-1)" "$(machine machine-2)" "$(machine machine-3)")"
expect_failure run_checker pre
MACHINES_JSON='{"unexpected":"shape"}'
expect_failure run_checker pre
# Machine fora de gru dentro do teto de contagem: o preflight não pode aprovar.
# O `flyctl scale count` é escopado em --region gru, então 1 em gru + 1 fora
# passaria pela contagem (2 <= 2) e a escala levaria o total a 3 — divergência
# criada depois do gate, que então travaria todo deploy seguinte.
MACHINES_JSON="$(machines "$(machine machine-1)" "$(machine machine-2 started iad)")"
expect_failure run_checker pre
MACHINES_JSON="$(machines "$(machine machine-1 started iad)")"
expect_failure run_checker pre

MACHINES_JSON="$two_machines"
CHECKS_JSON="$two_healthy"
run_checker post >/dev/null

# Cardinalidade: uma só deixou de bastar (#664), três também não.
MACHINES_JSON="$(machines "$(machine machine-1)")"
CHECKS_JSON="$(checks_for machine-1)"
expect_failure run_checker post
MACHINES_JSON="$(machines "$(machine machine-1)" "$(machine machine-2)" "$(machine machine-3)")"
CHECKS_JSON="$(checks_for machine-1 machine-2 machine-3)"
expect_failure run_checker post

# Forma inválida na SEGUNDA Machine: prova que a validação quantifica sobre
# todas em vez de inspecionar .[0].
CHECKS_JSON="$two_healthy"
for invalid_machine in \
  "$(machine machine-2 stopped)" \
  "$(machine machine-2 started iad)" \
  "$(machine machine-2 started gru performance)" \
  "$(machine machine-2 started gru shared 2)" \
  "$(machine machine-2 started gru shared 1 1024)" \
  "$(machine machine-2 started gru shared 1 512 true)" \
  "$(machine machine-2 started gru shared 1 512 '"stop"')" \
  "$(machine machine-2 started gru shared 1 512 '"suspend"')" \
  "$(machine machine-2 started gru shared 1 512 false false)" \
  "$(machine machine-2 | jq -c '.config.services = []')" \
  "$(machine machine-2 | jq -c 'del(.config.services)')"
do
  MACHINES_JSON="$(machines "$(machine machine-1)" "$invalid_machine")"
  expect_failure run_checker post
done

# ...e o espelho na primeira, para que trocar .[0] por .[1] também seja pego.
for invalid_machine in \
  "$(machine machine-1 stopped)" \
  "$(machine machine-1 started iad)" \
  "$(machine machine-1 started gru shared 1 512 true)"
do
  MACHINES_JSON="$(machines "$invalid_machine" "$(machine machine-2)")"
  expect_failure run_checker post
done

# Health por id. O caso decisivo é o mapa que cobre só a primeira Machine: é o
# único que reprova uma implementação que leia o id de .[0] e nunca olhe a
# segunda.
MACHINES_JSON="$two_machines"
CHECKS_JSON="$(checks_for machine-1)"
expect_failure run_checker post
CHECKS_JSON='{}'
expect_failure run_checker post
CHECKS_JSON="$(jq -c '.["machine-2"] = []' <<<"$two_healthy")"
expect_failure run_checker post
CHECKS_JSON="$(jq -c '.["machine-2"] = [{"name":"servicecheck-00-http-3000","status":"critical"}]' <<<"$two_healthy")"
expect_failure run_checker post
CHECKS_JSON="$(jq -c '.["machine-1"] = [{"name":"servicecheck-00-http-3000","status":"critical"}]' <<<"$two_healthy")"
expect_failure run_checker post

ruby -ryaml -e '
  workflow = YAML.safe_load(File.read(ARGV.fetch(0)), aliases: true)
  trigger = workflow["on"] || workflow[true]
  paths = trigger.fetch("push").fetch("paths")
  abort("mudança no checker precisa disparar o workflow") unless paths.include?(".github/scripts/check-frontend-fly-machines.sh")
  steps = workflow.fetch("jobs").fetch("deploy").fetch("steps")
  runs = steps.filter_map { |step| step["run"] }
  pre = runs.index { |run| run.include?("check-frontend-fly-machines.sh pre") }
  scale = runs.index { |run| run.include?("flyctl scale count 2") }
  deploy = runs.index { |run| run.include?("flyctl deploy") }
  post = runs.index { |run| run.include?("check-frontend-fly-machines.sh post") }
  # O scale fica entre preflight e deploy: `flyctl deploy` não cria a segunda
  # Machine sozinho, e `scale count` destrói excedentes — antes do preflight,
  # apagaria a divergência que ele existe para recusar.
  abort("workflow sem ordem preflight -> scale -> deploy -> postflight") unless pre && scale && deploy && post && pre < scale && scale < deploy && deploy < post
  # Os argumentos do scale carregam efeito em produção e por isso são asseridos
  # um a um: sem `--yes` o comando pede confirmação e o job morre (runner do
  # GitHub não tem TTY); sem `-a` explícito, o mesmo passo escalaria o app da
  # API; sem `--region`, a Machine nova nasce onde o scheduler decidir, e o
  # postflight exige gru.
  scale_run = runs.fetch(scale)
  ["--region gru", "--yes", "-a gui-analise-sistematica-frontend"].each do |arg|
    abort("passo de escala sem #{arg}") unless scale_run.include?(arg)
  end
  # --ha=false trava a cardinalidade em 1 do lado do flyctl e reintroduziria o
  # ponto único de falha do #664 sem tocar em nada que os outros gates leem.
  abort("--ha=false trava a cardinalidade em 1") if runs.any? { |run| run.include?("--ha=false") }
' "$workflow"

# A comparação é por linha inteira e sobre o fly.toml já sem comentários: o
# arquivo documenta em prosa os valores que estas asserções rejeitam (o bloco
# do always-on cita "min_machines_running = 1" como o valor anterior), então um
# grep de substring passaria a casar a documentação em vez da diretiva e
# aprovaria justamente a mudança que deveria barrar. O -Fx também dispensa
# escapar os metacaracteres de regex que aparecem nos valores.
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
assert_directive 'min_machines_running = 2'
assert_directive 'swap_size_mb = 512'
assert_directive 'size = "shared-cpu-1x"'
assert_directive 'memory = "512mb"'

echo "Contrato de Machines do frontend validado."
