#!/bin/sh
# Stateful stand-in for the docker CLI, used by compose-rolling-behavior.test.ts.
# State lives in <this dir>/../state:
#   containers/<id>/{service,hash,image,running,created,final_health,polls_left}
#   cfg/services                     active services (`config --services`)
#   cfg/hash.<svc>                   current config hash (`config --hash`)
#   cfg/images.<svc>                 image refs of the service (`config --images`)
#   cfg/imageid.<ref, / and : as _>  id of an image (`image inspect`)
#   cfg/newimage.<svc>               image id of a replica created by `up`
#   cfg/newhealth.<svc>              healthy | unhealthy | never | none | noneonce | delay:<n>
#   cfg/up.fail.<svc>                `up` naming the service fails
#   cfg/stop.noop, cfg/rm.fail       stop does nothing / rm fails
#   cfg/stop.slow                    stop takes 3 s before it acts
#   calls.log                        one line per invocation
#   violations.log                   `up` without service names
D="$(cd "$(dirname "$0")/.." && pwd)/state"
echo "docker $*" >> "$D/calls.log"
cmd="$1"
shift

cget() { cat "$D/containers/$1/$2" 2>/dev/null; }
cset() { printf '%s' "$3" > "$D/containers/$1/$2"; }
exists() { [ -d "$D/containers/$1" ]; }
next_n() { n=$(cat "$D/counter" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$D/counter"; echo "$n"; }

ids_of() {
  for d in "$D"/containers/*; do
    [ -d "$d" ] || continue
    id=$(basename "$d")
    [ "$(cget "$id" service)" = "$1" ] || continue
    if [ "$2" = all ] || [ "$(cget "$id" running)" = true ]; then echo "$id"; fi
  done
}

health_now() {
  left=$(cget "$1" polls_left)
  if [ -n "$left" ] && [ "$left" -gt 0 ]; then
    cset "$1" polls_left $((left - 1))
    # noneonce: the engine has not attached the health monitor on the first poll.
    if [ -f "$D/containers/$1/pre_health" ]; then cat "$D/containers/$1/pre_health"; echo; else echo starting; fi
    return
  fi
  cget "$1" final_health
}

create() {
  n=$(next_n)
  id="$1-new-$n"
  mkdir -p "$D/containers/$id"
  cset "$id" service "$1"
  cset "$id" hash "$(cat "$D/cfg/hash.$1")"
  cset "$id" image "$(cat "$D/cfg/newimage.$1")"
  cset "$id" running true
  cset "$id" created "$(printf '2026-10-15T10:%02d:00.000000000Z' "$n")"
  mode=$(cat "$D/cfg/newhealth.$1" 2>/dev/null || echo healthy)
  case "$mode" in
    healthy) cset "$id" final_health healthy; cset "$id" polls_left 0;;
    delay:*) cset "$id" final_health healthy; cset "$id" polls_left "$(echo "$mode" | cut -d: -f2)";;
    unhealthy) cset "$id" final_health unhealthy; cset "$id" polls_left 0;;
    never) cset "$id" final_health starting; cset "$id" polls_left 0;;
    none) cset "$id" final_health none; cset "$id" polls_left 0;;
    noneonce) cset "$id" final_health healthy; cset "$id" polls_left 1; cset "$id" pre_health none;;
  esac
  echo "$id"
}

case "$cmd" in
  ps)
    all=0
    svc=""
    while [ $# -gt 0 ]; do
      case "$1" in
        -a|-aq) all=1;;
        --filter) shift; case "$1" in label=com.docker.compose.service=*) svc="${1#label=com.docker.compose.service=}";; esac;;
      esac
      shift
    done
    if [ "$all" = 1 ]; then ids_of "$svc" all; else ids_of "$svc" running; fi
    ;;
  inspect)
    fmt="$2"
    id="$3"
    exists "$id" || { echo "Error: No such object: $id" >&2; exit 1; }
    case "$fmt" in
      *config-hash*) echo "$(cget "$id" hash)";;
      "{{.Image}}") echo "$(cget "$id" image)";;
      *.Created*) h=$(health_now "$id"); echo "$(cget "$id" created) $(cget "$id" running) $h $id";;
      *.State.Status*) st=exited; [ "$(cget "$id" running)" = true ] && st=running; h=$(health_now "$id"); echo "$st $h";;
      *.State.Running*) echo "$(cget "$id" running)";;
    esac
    ;;
  image)
    shift
    while [ $# -gt 1 ]; do
      case "$1" in --format) shift;; esac
      shift
    done
    f="$D/cfg/imageid.$(echo "$1" | tr '/:' '__')"
    if [ -f "$f" ]; then cat "$f"; echo; else exit 1; fi
    ;;
  stop)
    [ -f "$D/cfg/stop.noop" ] && exit 0
    [ -f "$D/cfg/stop.slow" ] && sleep 3
    for id in "$@"; do
      case "$id" in -*) continue;; esac
      if exists "$id"; then cset "$id" running false; fi
    done
    ;;
  rm)
    [ -f "$D/cfg/rm.fail" ] && exit 1
    for id in "$@"; do
      case "$id" in -*) continue;; esac
      rm -rf "$D/containers/$id"
    done
    ;;
  compose)
    while [ $# -gt 0 ]; do
      case "$1" in
        -p|--project-directory|--env-file|-f) shift 2;;
        *) break;;
      esac
    done
    sub="$1"
    shift
    case "$sub" in
      config)
        case "$1" in
          --hash) echo "decoy 0000"; echo "$2 $(cat "$D/cfg/hash.$2")";;
          --images) cat "$D/cfg/images.$2";;
          --services) cat "$D/cfg/services";;
        esac
        ;;
      build|pull) ;;
      up)
        scale=""
        norecreate=0
        names=""
        while [ $# -gt 0 ]; do
          case "$1" in
            --scale) scale="$2"; shift;;
            --pull) shift;;
            --no-recreate) norecreate=1;;
            -*) ;;
            *) names="$names $1";;
          esac
          shift
        done
        if [ -z "$names" ]; then
          echo "up without service names" >> "$D/violations.log"
          exit 1
        fi
        for svc in $names; do
          if [ -f "$D/cfg/up.fail.$svc" ]; then echo "up failed for $svc" >&2; exit 1; fi
          have=$(ids_of "$svc" all | grep -c .)
          if [ -z "$scale" ]; then
            # Without --scale Compose converges to the default of one container
            # and removes the highest-numbered one, whatever its state or release.
            while [ "$have" -gt 1 ]; do
              last=$(ids_of "$svc" all | tail -n 1)
              rm -rf "$D/containers/$last"
              have=$((have - 1))
            done
          fi
          if [ -n "$scale" ]; then
            want=$(echo "$scale" | cut -d= -f2)
            while [ "$have" -lt "$want" ]; do create "$svc" > /dev/null; have=$((have + 1)); done
            # Compose scales down by removing the highest-numbered container.
            while [ "$have" -gt "$want" ]; do
              last=$(ids_of "$svc" all | tail -n 1)
              rm -rf "$D/containers/$last"
              have=$((have - 1))
            done
          elif [ "$have" -eq 0 ]; then
            create "$svc" > /dev/null
          elif [ "$norecreate" -eq 0 ]; then
            # Like Compose: a container whose config hash is current is left alone.
            for id in $(ids_of "$svc" all); do
              if [ "$(cget "$id" hash)" != "$(cat "$D/cfg/hash.$svc")" ]; then rm -rf "$D/containers/$id"; create "$svc" > /dev/null; fi
            done
          fi
        done
        ;;
    esac
    ;;
esac
exit 0
