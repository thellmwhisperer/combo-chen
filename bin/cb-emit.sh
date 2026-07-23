#!/bin/sh
# Append one validated Combo v1 event to a run journal.
set -eu

usage() {
  echo "usage: cb-emit --run <runId> --agent <agent> --code <0|1> --event <name> [--payload <json>]" >&2
  exit 64
}

run=''
agent=''
code=''
event=''
payload='{}'
while [ "$#" -gt 0 ]; do
  case "$1" in
    --run|--agent|--code|--event|--payload)
      [ "$#" -ge 2 ] || usage
      key=$1
      value=$2
      shift 2
      case "$key" in
        --run) run=$value ;;
        --agent) agent=$value ;;
        --code) code=$value ;;
        --event) event=$value ;;
        --payload) payload=$value ;;
      esac
      ;;
    *) usage ;;
  esac
done

case "$run" in ''|-*|*[!a-z0-9-]*) echo "cb-emit: invalid run id" >&2; exit 64 ;; esac
case "$agent" in chain|launcher|coder|reviewer|gate|cleaner) ;; *) echo "cb-emit: invalid agent" >&2; exit 64 ;; esac
case "$code" in 0|1) ;; *) echo "cb-emit: code must be 0 or 1" >&2; exit 64 ;; esac
if ! printf '%s' "$payload" | jq -e 'type == "object"' >/dev/null 2>&1; then
  echo "cb-emit: payload must be a JSON object" >&2
  exit 64
fi
payload=$(printf '%s' "$payload" | jq -c .)

predicate=
case "$agent:$code:$event" in
  chain:0:run_created) predicate='has("work_item") and has("repo") and (.work_item|type=="string") and (.repo|type=="string")' ;;
  chain:1:chain_stopped) predicate='(.reason|type=="string" and length>0)' ;;
  launcher:0:launch_ready) predicate='(.worktree|type=="string" and length>0) and (.branch|type=="string" and length>0) and (.base_sha|type=="string" and length>0) and (.runway_kind|type=="string" and length>0) and (.lease_id|type=="string" and length>0)' ;;
  launcher:1:launch_not_ready) predicate='(.reasons|type=="array" and length>0 and all(.[]; type=="string" and length>0))' ;;
  coder:0:coder_ready) predicate='(.sha|type=="string" and length>0) and (.branch|type=="string" and length>0)' ;;
  coder:1:coder_not_ready) predicate='(.errors|type=="array" and length>0 and all(.[]; type=="string" and length>0))' ;;
  reviewer:0:lgtm) predicate='(.sha|type=="string" and length>0) and (.round|type=="number" and floor==. and .>0) and (.members|type=="array" and length>0 and all(.[]; type=="string" and length>0))' ;;
  reviewer:1:needs_change) predicate='(.sha|type=="string" and length>0) and (.round|type=="number" and floor==. and .>0) and (.member|type=="string" and length>0) and (.artifact|type=="string" and length>0)' ;;
  reviewer:0:member_result) predicate='(.member|type=="string" and length>0) and (.round|type=="number" and floor==. and .>0) and (.sha|type=="string" and length>0) and ((has("skipped")|not) or (.skipped|type=="boolean"))' ;;
  reviewer:1:member_result) predicate='(.member|type=="string" and length>0) and (.round|type=="number" and floor==. and .>0) and (.sha|type=="string" and length>0) and (((.artifact?|type=="string" and length>0)) or (.errors?|type=="array" and length>0 and all(.[]; type=="string" and length>0)))' ;;
  gate:0:gate_ok) predicate='((.outcome=="merged") or (.outcome=="validated")) and (.sha|type=="string" and length>0) and ((has("pr")|not) or (.pr|type=="string" and length>0))' ;;
  gate:1:gate_failed) predicate='(.reason|type=="string" and length>0) and ((has("step")|not) or (.step|type=="string" and length>0))' ;;
  gate:0:gate_progress|gate:1:gate_progress) predicate='(.state|type=="string" and length>0)' ;;
  cleaner:0:cleaned) predicate='true' ;;
  cleaner:1:clean_failed) predicate='(.reasons|type=="array" and length>0 and all(.[]; type=="string" and length>0))' ;;
  *) echo "cb-emit: event is not valid for agent/code" >&2; exit 64 ;;
esac

runs_dir=${CB_RUNS_DIR:-"$HOME/.combo-chen/runs"}
run_dir=$runs_dir/$run
journal=$run_dir/journal.jsonl
[ -d "$run_dir" ] && [ -w "$run_dir" ] || { echo "cb-emit: run directory is not writable: $run_dir" >&2; exit 73; }

# Mechanical claims are observed here rather than trusted from a caller.
worktree=${CB_WORKTREE:-}
base_sha=${CB_BASE_SHA:-}
if [ -f "$run_dir/config.env" ]; then
  # config.env is the run's trusted, immutable launch snapshot.
  # shellcheck disable=SC1090
  . "$run_dir/config.env"
  worktree=${CB_WORKTREE:-$worktree}
  base_sha=${CB_BASE_SHA:-$base_sha}
fi
if [ -f "$journal" ] && { [ -z "$worktree" ] || [ -z "$base_sha" ]; }; then
  launch_payload=$(jq -Rrs '[split("\n")[] | fromjson? | select(.agent=="launcher" and .event=="launch_ready") | .payload] | last // {}' "$journal")
  [ -n "$worktree" ] || worktree=$(printf '%s' "$launch_payload" | jq -r '.worktree // empty')
  [ -n "$base_sha" ] || base_sha=$(printf '%s' "$launch_payload" | jq -r '.base_sha // empty')
fi
case "$agent:$event" in
  coder:coder_ready)
    [ -n "$worktree" ] && [ -n "$base_sha" ] || { echo "cb-emit: coder_ready requires launch worktree and base sha" >&2; exit 65; }
    commits=$(git -C "$worktree" rev-list --count "$base_sha..HEAD" 2>/dev/null) || { echo "cb-emit: cannot verify coder commits" >&2; exit 65; }
    [ "$commits" -gt 0 ] && [ -z "$(git -C "$worktree" status --porcelain)" ] || { echo "cb-emit: coder_ready requires commits and a clean worktree" >&2; exit 65; }
    sha=$(git -C "$worktree" rev-parse HEAD)
    branch=$(git -C "$worktree" branch --show-current)
    [ -n "$branch" ] || { echo "cb-emit: coder_ready requires a branch" >&2; exit 65; }
    payload=$(printf '%s' "$payload" | jq -c --arg sha "$sha" --arg branch "$branch" '. + {sha:$sha, branch:$branch}')
    ;;
  reviewer:needs_change)
    artifact=$(printf '%s' "$payload" | jq -r '.artifact // empty')
    case "$artifact" in /*) artifact_path=$artifact ;; *) artifact_path=$run_dir/$artifact ;; esac
    [ -s "$artifact_path" ] || { echo "cb-emit: needs_change requires a non-empty findings artifact" >&2; exit 65; }
    ;;
  reviewer:lgtm)
    [ -n "$worktree" ] || { echo "cb-emit: lgtm requires launch worktree" >&2; exit 65; }
    observed=$(git -C "$worktree" rev-parse HEAD 2>/dev/null) || { echo "cb-emit: cannot verify lgtm sha" >&2; exit 65; }
    claimed=$(printf '%s' "$payload" | jq -r '.sha // empty')
    [ "$claimed" = "$observed" ] || { echo "cb-emit: lgtm sha does not match worktree HEAD" >&2; exit 65; }
    ;;
esac
if ! printf '%s' "$payload" | jq -e "$predicate" >/dev/null 2>&1; then
  echo "cb-emit: payload does not satisfy the event schema" >&2
  exit 64
fi

lock=$run_dir/.journal.lock
started=$(date +%s)
lock_timeout=${CB_JOURNAL_LOCK_TIMEOUT_SECONDS:-5}
stale_after=${CB_JOURNAL_LOCK_STALE_SECONDS:-30}
while ! mkdir "$lock" 2>/dev/null; do
  now=$(date +%s)
  mtime=$(stat -f %m "$lock" 2>/dev/null || stat -c %Y "$lock" 2>/dev/null || printf '%s' "$now")
  if [ $((now - mtime)) -ge "$stale_after" ]; then rmdir "$lock" 2>/dev/null || true; fi
  [ $((now - started)) -lt "$lock_timeout" ] || { echo "cb-emit: journal lock timeout" >&2; exit 75; }
  sleep 0.01
done
cleanup() { rmdir "$lock" 2>/dev/null || true; }
trap cleanup 0
trap 'exit 130' 1 2 15

: >>"$journal"
rows=$(jq -Rsc '[split("\n")[] | select(length>0) | . as $raw | try {raw:$raw,event:($raw|fromjson)} catch {raw:$raw,invalid:true}]' "$journal")
invalid=$(printf '%s' "$rows" | jq '[.[] | select(.invalid==true)] | length')
if [ "$invalid" -gt 0 ]; then echo "cb-emit: warning: ignoring $invalid malformed journal line(s)" >&2; fi
existing=$(printf '%s' "$rows" | jq -r --arg agent "$agent" --argjson code "$code" --arg event "$event" --argjson payload "$payload" '
  [.[] | select(.invalid!=true) | select(.event.agent==$agent and .event.code==$code and .event.event==$event and ((.event.payload.sha // null)==($payload.sha // null)) and ((.event.payload.round // null)==($payload.round // null)) and ((.event.payload.member // null)==($payload.member // null)) and (if (.event.payload.sha // .event.payload.round // .event.payload.member) == null then .event.payload==$payload else true end))] | first | .raw // empty')
if [ -n "$existing" ]; then
  printf '%s\n' "$existing"
  exit 0
fi
seq=$(printf '%s' "$rows" | jq '[.[] | select(.invalid!=true)] | length + 1')
ts=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
line=$(jq -cn --argjson seq "$seq" --arg ts "$ts" --arg run "$run" --arg agent "$agent" --argjson code "$code" --arg event "$event" --argjson payload "$payload" '{seq:$seq,ts:$ts,run:$run,agent:$agent,code:$code,event:$event,payload:$payload}')
if [ -s "$journal" ]; then
  last_byte=$(tail -c 1 "$journal" | od -An -tuC | tr -d ' ')
  [ "$last_byte" = 10 ] || printf '\n' >>"$journal"
fi
printf '%s\n' "$line" >>"$journal"
printf '%s\n' "$line"
