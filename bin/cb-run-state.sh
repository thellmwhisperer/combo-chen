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
  [.[] | select(.invalid!=true) | .event] as $e |
  (["launcher","gate","cleaner"] | map(. as $a | [$e[] | select(.agent==$a and (.event|endswith("ready") or endswith("ok") or endswith("failed") or .=="cleaned")) | .code] | unique | length>1) | any) or
  ([$e[] | select(.agent=="reviewer" and (.event=="lgtm" or .event=="needs_change")) | [.payload.sha,.payload.round,.event]] | group_by(.[0:2]) | any(length>1))')
if [ "$conflicts" = true ]; then echo "cb-run-state: warning: conflicting product events; highest seq wins" >&2; fi

printf '%s' "$rows" | jq -r '
  [.[] | select(.invalid!=true) | .event | select((.seq|type)=="number")] | sort_by(.seq) |
  reduce .[] as $e (
    {phase:"created", round:1, member:"pending", failure_agent:null, failure_reason:null};
    if $e.event=="run_created" then .phase="launching"
    elif $e.event=="launch_ready" then .phase="coding" | (if .failure_agent=="launcher" then .failure_agent=null | .failure_reason=null else . end)
    elif $e.event=="launch_not_ready" then .phase="cleaning" | .failure_agent="launcher" | .failure_reason="launch_not_ready"
    elif $e.event=="chain_stopped" then .phase="cleaning" | .failure_agent="chain" | .failure_reason=$e.payload.reason
    elif $e.event=="coder_ready" then .phase="reviewing" | .member="pending"
    elif $e.event=="coder_not_ready" then .phase="coding"
    elif $e.event=="member_result" then .round=$e.payload.round | .member=$e.payload.member
    elif $e.event=="needs_change" then .phase="coding" | .round=($e.payload.round+1) | .member="pending"
    elif $e.event=="lgtm" then .phase="gating"
    elif $e.event=="gate_progress" then .
    elif $e.event=="gate_ok" then .phase="cleaning" | (if .failure_agent=="gate" then .failure_agent=null | .failure_reason=null else . end)
    elif $e.event=="gate_failed" then .phase="cleaning" | .failure_agent="gate" | .failure_reason=$e.payload.reason
    elif $e.event=="cleaned" then (if .failure_agent=="cleaner" then .failure_agent=null | .failure_reason=null else . end) | .phase=(if .failure_agent==null then "done" else "failed" end)
    elif $e.event=="clean_failed" then .phase="failed" | .failure_agent="cleaner" | .failure_reason="clean_failed"
    else . end
  ) |
  if .phase=="reviewing" then "reviewing(round=\(.round), member=\(.member))"
  elif .phase=="failed" then "failed(\(.failure_agent), \(.failure_reason))"
  else .phase end'
