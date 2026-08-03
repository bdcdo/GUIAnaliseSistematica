#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
notifier_workflow="$repo_root/.github/workflows/notify-deploy-failure.yml"
caller_workflows=(
  "$repo_root/.github/workflows/frontend-fly-deploy.yml"
  "$repo_root/.github/workflows/fly-deploy.yml"
)
workflows=("$notifier_workflow" "${caller_workflows[@]}")

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
notifier="$tmp_dir/notify-deploy-failure.sh"

ruby -ryaml -e '
  workflow = YAML.safe_load(File.read(ARGV.fetch(0)), aliases: true)
  step = workflow.fetch("jobs").fetch("notify").fetch("steps").fetch(0)
  abort("step canônico do notifier sem bloco run") unless step["run"].is_a?(String)
  print step.fetch("run")
' "$notifier_workflow" >"$notifier"

bash -n "$notifier" "$0"
ruby -ryaml -e 'ARGV.each { |path| abort("YAML inválido: #{path}") unless YAML.parse_file(path) }' "${workflows[@]}"

# GitHub expressions are compared as literal YAML strings inside Ruby.
# shellcheck disable=SC2016
ruby -ryaml -e '
  reusable_path = ARGV.fetch(0)
  reusable = YAML.safe_load(File.read(reusable_path), aliases: true)
  reusable_trigger = reusable["on"] || reusable[true]
  inputs = reusable_trigger.fetch("workflow_call").fetch("inputs")
  abort("notifier precisa receber somente deploy_app") unless inputs.keys == ["deploy_app"]

  notify = reusable.fetch("jobs").fetch("notify")
  abort("notifier não deve revalidar o resultado") if notify.key?("if")
  abort("notifier precisa somente de issues: write") unless notify.fetch("permissions") == { "issues" => "write" }
  abort("notifier reutilizável não pode fazer checkout") if notify.fetch("steps").any? { |step| step.fetch("uses", "").include?("checkout") }

  ARGV.drop(1).each do |path|
    workflow = YAML.safe_load(File.read(path), aliases: true)
    concurrency = workflow.fetch("concurrency")
    abort("caller precisa preservar todos os deploys: #{path}") unless concurrency["queue"] == "max"
    abort("caller não pode cancelar deploy em execução: #{path}") unless concurrency["cancel-in-progress"] == false

    caller = workflow.fetch("jobs").fetch("notify-failure")
    abort("caller sem dependência do deploy: #{path}") unless caller["needs"] == "deploy"
    abort("caller sem condição de failure: #{path}") unless caller.fetch("if").include?("needs.deploy.result == \u0027failure\u0027")
    abort("caller não usa workflow canônico: #{path}") unless caller["uses"] == "./.github/workflows/notify-deploy-failure.yml"
    abort("caller precisa somente de issues: write: #{path}") unless caller.fetch("permissions") == { "issues" => "write" }

    expected_app = File.basename(path).start_with?("frontend-") ? "gui-analise-sistematica-frontend" : "gui-analise-sistematica-api"
    abort("caller precisa passar somente a aplicação: #{path}") unless caller.fetch("with") == { "deploy_app" => expected_app }

    trigger = workflow["on"] || workflow[true]
    paths = trigger.fetch("push").fetch("paths")
    abort("mudança no notifier não pode disparar deploy: #{path}") if paths.any? { |entry| entry.include?("notify-deploy-failure") }
  end
' "$notifier_workflow" "${caller_workflows[@]}"

mkdir -p "$tmp_dir/bin"
cat >"$tmp_dir/bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

count=0
if [[ -f "$CAPTURE_DIR/call-count" ]]; then
  read -r count <"$CAPTURE_DIR/call-count"
fi
((count += 1))
printf '%s\n' "$count" >"$CAPTURE_DIR/call-count"

call_dir="$CAPTURE_DIR/call-$count"
mkdir -p "$call_dir"
printf '%s\n' "$@" >"$call_dir/args"

body_file_next=0
for arg in "$@"; do
  if [[ "$body_file_next" == "1" ]]; then
    cp "$arg" "$call_dir/body"
    break
  fi
  if [[ "$arg" == "--body-file" ]]; then
    body_file_next=1
  fi
done

if [[ "${1:-}" == "issue" && "${2:-}" == "list" ]]; then
  printf '%s' "${GH_LIST_OUTPUT:-}"
fi
EOF
chmod +x "$tmp_dir/bin/gh"

reset_capture() {
  rm -rf "$tmp_dir"/call-* "$tmp_dir/call-count"
}

common_env=(
  "PATH=$tmp_dir/bin:$PATH"
  "CAPTURE_DIR=$tmp_dir"
  "GH_TOKEN=test-token"
  "GITHUB_REPOSITORY=bdcdo/dataframeitGUI"
  "GITHUB_REPOSITORY_OWNER=bdcdo"
  "GITHUB_WORKFLOW=Deploy frontend (Fly.io)"
  "GITHUB_SHA=0123456789abcdef"
  "GITHUB_ACTOR=reviewer"
  "GITHUB_SERVER_URL=https://github.com"
  "GITHUB_RUN_ID=123"
  "DEPLOY_APP=gui-analise-sistematica-frontend"
)

incident_title='[Deploy quebrado] gui-analise-sistematica-frontend'

# Sem incidente aberto: cria uma issue atribuída com o contexto do caller.
reset_capture
env "${common_env[@]}" GH_LIST_OUTPUT= bash "$notifier" >/dev/null
grep -Fxq 'list' "$tmp_dir/call-1/args"
grep -Fxq 'number,title' "$tmp_dir/call-1/args"
grep -Fxq '[.[] | select(.title == env.INCIDENT_TITLE)][0].number // empty' "$tmp_dir/call-1/args"
grep -Fxq 'create' "$tmp_dir/call-2/args"
grep -Fxq "$incident_title" "$tmp_dir/call-2/args"
grep -Fq 'Deploy frontend (Fly.io)' "$tmp_dir/call-2/body"
grep -Fq 'gui-analise-sistematica-frontend' "$tmp_dir/call-2/body"
grep -Fq '0123456789abcdef' "$tmp_dir/call-2/body"
grep -Fq '@reviewer' "$tmp_dir/call-2/body"
grep -Fq 'https://github.com/bdcdo/dataframeitGUI/actions/runs/123' "$tmp_dir/call-2/body"
grep -Fq 'Feche esta issue somente depois' "$tmp_dir/call-2/body"
test ! -e "$tmp_dir/call-3"

# Incidente exato já aberto: comenta no existente sem criar outro.
reset_capture
env "${common_env[@]}" GH_LIST_OUTPUT=731 bash "$notifier" >/dev/null
grep -Fxq 'list' "$tmp_dir/call-1/args"
grep -Fxq 'comment' "$tmp_dir/call-2/args"
grep -Fxq '731' "$tmp_dir/call-2/args"
grep -Fq '## Falha em 0123456' "$tmp_dir/call-2/body"
grep -Fq 'https://github.com/bdcdo/dataframeitGUI/actions/runs/123' "$tmp_dir/call-2/body"
test ! -e "$tmp_dir/call-3"

echo "Validação da notificação de deploy passou."
