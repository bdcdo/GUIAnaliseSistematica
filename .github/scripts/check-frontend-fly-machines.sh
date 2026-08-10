#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fly_config="$repo_root/frontend/fly.toml"
mode="${1:-}"

# Cardinalidade contratada. Duas Machines eliminam o ponto único de falha por
# host (#664): com uma só, perder o host derruba a produção e ela não se
# recupera sozinha — em 2026-08-10 o host de gru ficou sem CPU livre e foi
# preciso `machine clone` manual para outro host.
readonly expected_machines=2
# Região contratada, declarada aqui uma vez porque os dois modos dependem dela:
# o postflight exige que as Machines estejam nela, e o preflight precisa recusar
# o que estiver fora (ver a verificação logo abaixo).
readonly expected_region="gru"

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

# Vale para os DOIS modos. No preflight não é redundante com a contagem: o
# `flyctl machine list` enxerga todas as regiões, mas o `flyctl scale count` do
# workflow é escopado em `--region $expected_region`. Uma Machine em gru mais
# uma fora passaria pela contagem (2 <= 2) e a escala levaria gru de 1 para 2,
# totalizando 3 — divergência criada DEPOIS do gate que existe para recusá-la, e
# que travaria todo deploy seguinte no preflight. Recusar aqui custa exigir que
# um `machine clone` de incidente fora de gru seja resolvido antes do deploy.
if ! jq -e --arg region "$expected_region" 'all(.[]; .region == $region)' >/dev/null <<<"$machines_json"; then
  echo "Deploy recusado: há Machine do frontend fora de $expected_region; a escala do workflow é escopada nessa região e não convergiria a cardinalidade total." >&2
  exit 1
fi

if [[ "$mode" == "pre" ]]; then
  if ((machine_count > expected_machines)); then
    echo "Deploy recusado: o frontend tem $machine_count Machines; o contrato é $expected_machines. Reduza explicitamente antes do deploy." >&2
    exit 1
  fi
  # Menos de $expected_machines é tolerado aqui de propósito: o `flyctl scale
  # count` do workflow roda DEPOIS deste gate e é quem converge de volta para
  # duas. Exigir a cardinalidade cheia já no preflight impediria o deploy de se
  # auto-curar depois de perder uma Machine.
  echo "Preflight Fly aprovado: $machine_count Machine(s)."
  exit 0
fi

if ((machine_count != expected_machines)); then
  echo "Deploy inválido: esperado exatamente $expected_machines Machines do frontend, encontrado $machine_count." >&2
  exit 1
fi

# `all` quantifica sobre TODAS as Machines em vez de inspecionar .[0]: com mais
# de uma, validar só a primeira aprovaria um deploy em que a segunda subiu
# parada ou com outro tamanho. A região não entra aqui — já foi verificada
# acima, para os dois modos, e repeti-la abriria espaço para as duas definições
# divergirem.
if ! jq -e '
  all(.[];
    .state == "started"
    and .config.guest.cpu_kind == "shared"
    and .config.guest.cpus == 1
    and .config.guest.memory_mb == 512)
' >/dev/null <<<"$machines_json"; then
  echo "Deploy inválido: todas as Machines devem estar iniciadas com shared-cpu-1x e 512 MB." >&2
  exit 1
fi

# O autostop é conferido na config APLICADA, e não só no fly.toml, porque foi
# por aí que o site caiu em 2026-08-10 e por aí que ele voltou: a Machine foi
# recriada com `machine clone` (que herda a config da origem, ainda com
# autostop ligado) e só depois corrigida com `machine update --autostop=off`,
# tudo fora do fluxo de deploy. O grep do fly.toml prova a intenção declarada;
# esta asserção prova o que a Machine de fato tem.
#
# Quantifica sobre TODAS as Machines pelo mesmo motivo da validação de forma
# acima: com duas, conferir só a config aplicada de .[0] aprovaria um deploy em
# que a segunda ficou com o autostop ligado — e é justamente a segunda que
# tende a nascer de um `scale count`/`clone`, fora do fluxo que corrige a config.
#
# `== false` é fail-closed de propósito: o flyctl serializa "off" como booleano
# false, então as formas string ("stop", "suspend"), o true e o campo ausente
# (null) reprovam todos.
if ! jq -e '
  all(.[];
    (.config.services | type) == "array"
    and (.config.services | length) > 0
    and all(.config.services[]; .autostop == false and .autostart == true))
' >/dev/null <<<"$machines_json"; then
  echo "Deploy inválido: todas as Machines precisam estar com autostop desligado e autostart ligado." >&2
  exit 1
fi

machine_ids_json="$(jq -er '[.[].id | select(type == "string" and length > 0)]' <<<"$machines_json")"
if ! jq -e --argjson expected "$expected_machines" 'length == $expected' >/dev/null <<<"$machine_ids_json"; then
  echo "Deploy inválido: não foi possível ler o id de todas as $expected_machines Machines." >&2
  exit 1
fi
readonly health_attempts=12
readonly health_interval_seconds=10

for ((attempt = 1; attempt <= health_attempts; attempt += 1)); do
  # `. as $by_machine` é necessário porque dentro de `all($ids[]; ...)` o `.`
  # já é o id sob teste, não o mapa raiz. Uma Machine verde e outra vermelha
  # não pode aprovar o deploy.
  if checks_json="$(flyctl checks list -c "$fly_config" --json)" && jq -e --argjson ids "$machine_ids_json" '
    . as $by_machine
    | type == "object"
    and all($ids[];
      . as $id
      | ($by_machine[$id] // null) as $checks
      | ($checks | type) == "array"
      and ($checks | length) > 0
      and all($checks[]; .status == "passing"))
  ' >/dev/null <<<"$checks_json"; then
    echo "Postflight Fly aprovado: $expected_machines Machines saudáveis em $expected_region, shared-cpu-1x/512 MB."
    exit 0
  fi

  if ((attempt < health_attempts)); then
    echo "Health ainda não passou (tentativa $attempt/$health_attempts); nova verificação em ${health_interval_seconds}s."
    sleep "$health_interval_seconds"
  fi
done

echo "Deploy inválido: as $expected_machines Machines não apresentaram health check verde após $health_attempts tentativa(s)." >&2
exit 1
