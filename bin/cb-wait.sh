#!/bin/sh
# Print the first matching Combo v1 journal event after a sequence number.
set -eu

usage() {
  echo "usage: cb-wait <runId> --agent <agent> --events <e1,e2> --after-seq <n> [--timeout <seconds>]" >&2
  exit 64
}

[ "$#" -ge 1 ] || usage
run=$1
shift
agent=''
events=''
after_seq=''
timeout=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --agent|--events|--after-seq|--timeout)
      [ "$#" -ge 2 ] || usage
      key=$1
      value=$2
      shift 2
      case "$key" in
        --agent) agent=$value ;;
        --events) events=$value ;;
        --after-seq) after_seq=$value ;;
        --timeout) timeout=$value ;;
      esac
      ;;
    *) usage ;;
  esac
done
case "$run" in ''|-*|*[!a-z0-9-]*) usage ;; esac
case "$agent" in chain|launcher|coder|reviewer|gate|cleaner) ;; *) usage ;; esac
case "$events" in ''|,*|*,|*,,*) usage ;; esac
case "$after_seq" in ''|*[!0-9]*) usage ;; esac
case "$timeout" in ''|*[!0-9]*) [ -z "$timeout" ] || usage ;; esac

journal=${CB_RUNS_DIR:-"$HOME/.combo-chen/runs"}/$run/journal.jsonl
poll=${CB_WAIT_POLL_SECONDS:-1}
started=$(date +%s)
warned=0
while :; do
  if [ -f "$journal" ]; then
    rows=$(jq -Rsc '[split("\n")[] | select(length>0) | . as $raw | try {raw:$raw,event:($raw|fromjson)} catch {raw:$raw,invalid:true}]' "$journal")
    invalid=$(printf '%s' "$rows" | jq '[.[] | select(.invalid==true)] | length')
    if [ "$invalid" -gt 0 ] && [ "$warned" -eq 0 ]; then
      echo "cb-wait: warning: ignoring $invalid malformed journal line(s)" >&2
      warned=1
    fi
    match=$(printf '%s' "$rows" | jq -r --arg agent "$agent" --arg events "$events" --argjson after "$after_seq" '
      ($events|split(",")) as $wanted |
      [.[] | select(.invalid!=true) | .event as $event | select(($event.seq|type)=="number" and $event.seq>$after and $event.agent==$agent and ($wanted|index($event.event))!=null) | $event] |
      sort_by(.seq) | first // empty | @json')
    if [ -n "$match" ]; then printf '%s\n' "$match"; exit 0; fi
  fi
  if [ -n "$timeout" ] && [ $(( $(date +%s) - started )) -ge "$timeout" ]; then exit 2; fi
  sleep "$poll"
done
