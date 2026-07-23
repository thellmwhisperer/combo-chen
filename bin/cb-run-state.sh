#!/bin/sh
# Deterministically fold a Combo v1 journal to its current phase.
set -eu

[ "$#" -eq 1 ] || { echo "usage: cb-run-state <runId>" >&2; exit 64; }
run=$1
case "$run" in ''|-*|*[!a-z0-9-]*) echo "usage: cb-run-state <runId>" >&2; exit 64 ;; esac
journal=${CB_RUNS_DIR:-"$HOME/.combo-chen/runs"}/$run/journal.jsonl
if [ ! -f "$journal" ]; then
  echo created
  exit 0
fi
rows=$(jq -Rsc '[split("\n")[] | select(length>0) | . as $raw | try {event:($raw|fromjson)} catch {invalid:true}]' "$journal")
invalid=$(printf '%s' "$rows" | jq '[.[] | select(.invalid==true)] | length')
if [ "$invalid" -gt 0 ]; then echo "cb-run-state: warning: ignoring $invalid malformed journal line(s)" >&2; fi
conflicts=$(printf '%s' "$rows" | jq '
  [.[] | select(.invalid!=true) | .event] | sort_by(.seq) as $e |
  (["launcher","gate","cleaner"] | map(. as $a |
    [$e[] | select(
      (.agent=="launcher" and (.event=="launch_ready" or .event=="launch_not_ready")) or
      (.agent=="gate" and (.event=="gate_ok" or .event=="gate_failed")) or
      (.agent=="cleaner" and (.event=="cleaned" or .event=="clean_failed"))) |
      select(.agent==$a) | .code] as $codes |
    ([$codes | to_entries[] | select(.value==0) | .key] | first) as $success |
    ([$codes | to_entries[] | select(.value==1) | .key] | last) as $failure |
    ($success!=null and $failure!=null and $success<$failure)) | any) or
  ([$e[] | select(.agent=="reviewer" and (.event=="lgtm" or .event=="needs_change")) | [.payload.sha,.payload.round,.event]] | group_by(.[0:2]) | any(length>1))')
if [ "$conflicts" = true ]; then echo "cb-run-state: warning: conflicting product events; highest seq wins" >&2; fi

printf '%s' "$rows" | jq -r '
  [.[] | select(.invalid!=true) | .event | select((.seq|type)=="number")] | sort_by(.seq) |
  reduce .[] as $e (
    {phase:"created", round:1, member:"pending", failures:{}};
    if $e.event=="run_created" then .phase="launching"
    elif $e.event=="launch_ready" then .phase="coding" | .failures|=del(.launcher)
    elif $e.event=="launch_not_ready" then .phase="cleaning" | .failures.launcher={reason:"launch_not_ready",seq:$e.seq}
    elif $e.event=="chain_stopped" then .phase="cleaning" | .failures.chain={reason:$e.payload.reason,seq:$e.seq}
    elif $e.event=="coder_ready" then .phase="reviewing" | .member="pending"
    elif $e.event=="coder_not_ready" then .phase="coding"
    elif $e.event=="member_result" then .round=$e.payload.round | .member=$e.payload.member
    elif $e.event=="needs_change" then .phase="coding" | .round=($e.payload.round+1) | .member="pending"
    elif $e.event=="lgtm" then .phase="gating"
    elif $e.event=="gate_progress" then .
    elif $e.event=="gate_ok" then .phase="cleaning" | .failures|=del(.gate)
    elif $e.event=="gate_failed" then .phase="cleaning" | .failures.gate={reason:$e.payload.reason,seq:$e.seq}
    elif $e.event=="cleaned" then .failures|=del(.cleaner) | .phase=(if (.failures|length)==0 then "done" else "failed" end)
    elif $e.event=="clean_failed" then .phase="failed" | .failures.cleaner={reason:"clean_failed",seq:$e.seq}
    else . end
  ) |
  if .phase=="reviewing" then "reviewing(round=\(.round), member=\(.member))"
  elif .phase=="failed" then
    ([.failures | to_entries[] | {agent:.key,reason:.value.reason,seq:.value.seq}] | sort_by(.seq) | first) as $failure |
    "failed(\($failure.agent), \($failure.reason))"
  else .phase end'
