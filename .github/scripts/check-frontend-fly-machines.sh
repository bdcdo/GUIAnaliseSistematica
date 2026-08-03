#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fly_config="$repo_root/frontend/fly.toml"
mode="${1:-}"

if [[ "$mode" != "pre" && "$mode" != "post" ]]; then
  echo "uso: $0 pre|post" >&2
  exit 64
fi

machines_json="$(flyctl machine list -c "$fly_config" --json)"
if ! machine_count="$(jq -er '
  if type == "array" then length
  else error("resposta de Machines não é um array")
  end
' <<<"$machines_json")"; then
  echo "Não foi possível interpretar a lista de Machines do frontend." >&2
  exit 1
fi

if [[ "$mode" == "pre" ]]; then
  if ((machine_count > 1)); then
    echo "Deploy recusado: o frontend tem $machine_count Machines; reduza explicitamente para no máximo uma antes do deploy." >&2
    exit 1
  fi
  echo "Preflight Fly aprovado: $machine_count Machine(s)."
  exit 0
fi

if ((machine_count != 1)); then
  echo "Deploy inválido: esperado exatamente uma Machine do frontend, encontrado $machine_count." >&2
  exit 1
fi

if ! jq -e '
  length == 1
  and .[0].state == "started"
  and .[0].region == "gru"
  and .[0].config.guest.cpu_kind == "shared"
  and .[0].config.guest.cpus == 1
  and .[0].config.guest.memory_mb == 512
' >/dev/null <<<"$machines_json"; then
  echo "Deploy inválido: a Machine deve estar iniciada em gru com shared-cpu-1x e 512 MB." >&2
  exit 1
fi

machine_id="$(jq -er '.[0].id | select(type == "string" and length > 0)' <<<"$machines_json")"
readonly health_attempts=12
readonly health_interval_seconds=10

for ((attempt = 1; attempt <= health_attempts; attempt += 1)); do
  if checks_json="$(flyctl checks list -c "$fly_config" --json)" && jq -e --arg machine_id "$machine_id" '
    type == "object"
    and ((.[$machine_id] // null) as $checks
      | ($checks | type) == "array"
      and ($checks | length) > 0
      and all($checks[]; .status == "passing"))
  ' >/dev/null <<<"$checks_json"; then
    echo "Postflight Fly aprovado: uma Machine saudável em gru, shared-cpu-1x/512 MB."
    exit 0
  fi

  if ((attempt < health_attempts)); then
    echo "Health ainda não passou (tentativa $attempt/$health_attempts); nova verificação em ${health_interval_seconds}s."
    sleep "$health_interval_seconds"
  fi
done

echo "Deploy inválido: a Machine não apresentou health check verde após $health_attempts tentativa(s)." >&2
exit 1
