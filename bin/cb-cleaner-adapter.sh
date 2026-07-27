#!/usr/bin/env bash
# @overview Native P4 envelope for the mechanical Treehouse Cleaner. It
#   validates Launcher custody plus a terminal Gate result, delegates one exact
#   non-forcing release to cb-cleaner.sh, and replays a sealed release without
#   duplicating the effect.
#
#   READING GUIDE
#   -------------
#   1. Envelope containment       <- reject untrusted paths and config.
#   2. publish_outcome            <- one collision-safe P4 output.
#   3. Custody/Gate verification  <- bind cleanup to Launcher and terminal Gate.
#   4. Release or replay          <- exact Treehouse path, never a fallback.
#
#   MAIN FLOW
#   ---------
#   step input -> custody + Gate terminal -> mechanical Cleaner -> output
#
#   PUBLIC API
#   ----------
#   cb-cleaner-adapter.sh --input PATH --output PATH
#
#   INTERNALS
#   ---------
#   usage, fail_contract, publish_outcome, reject, validate_cleaner_seal
#
# @exports none
# @deps bash, jq, realpath, stat, bin/cb-cleaner.sh
set -euo pipefail

usage() {
  echo "usage: cb-cleaner-adapter --input <path> --output <path>" >&2
  exit 64
}

fail_contract() {
  echo "cb-cleaner-adapter: $1" >&2
  exit "${2:-64}"
}

[ "$#" -eq 4 ] || usage
[ "$1" = --input ] || usage
input=$2
[ "$3" = --output ] || usage
output=$4
command -v jq >/dev/null 2>&1 || fail_contract "jq is required" 73
command -v realpath >/dev/null 2>&1 || fail_contract "realpath is required" 73

# -- 1/4 CORE · Validate and contain the universal envelope -- <- START HERE
[ -f "$input" ] && [ ! -L "$input" ] \
  || fail_contract "input is missing or unsafe" 73
[ "$(realpath "$input" 2>/dev/null)" = "$input" ] \
  || fail_contract "input path must be canonical" 73
if ! jq -e --arg input "$input" --arg output "$output" '
  type=="object" and
  keys==[
    "adapter_id","attempt","candidate_sha","config","paths",
    "prior_artifacts","role","run_id","schema","step_id"
  ] and
  .schema=="combo.step-input/v1" and .step_id=="cleaner" and
  .role=="cleaner" and
  (.run_id|type=="string" and test("^[a-z0-9][a-z0-9-]*$")) and
  (.attempt|type=="number" and floor==. and .>0) and
  (.candidate_sha==null or
    (.candidate_sha |
      type=="string" and test("^[0-9a-f]{40}([0-9a-f]{24})?$"))) and
  (.prior_artifacts|type=="array") and
  .paths.input_path==$input and .paths.output_path==$output and
  .config=={schema:"combo.cleaner/treehouse/v1"}
' "$input" >/dev/null 2>&1; then
  fail_contract "invalid Cleaner envelope or config"
fi

run=$(jq -r '.run_id' "$input")
attempt=$(jq -r '.attempt' "$input")
run_dir=$(jq -r '.paths.run_dir' "$input")
invocation_dir=$(jq -r '.paths.invocation_dir' "$input")
[ -d "$run_dir" ] && [ ! -L "$run_dir" ] \
  || fail_contract "run directory is missing or unsafe" 73
run_root=$(realpath "$run_dir" 2>/dev/null) \
  || fail_contract "cannot resolve run directory" 73
[ "$run_root" = "$run_dir" ] \
  || fail_contract "run directory path must be canonical" 73
[ -d "$invocation_dir" ] && [ ! -L "$invocation_dir" ] \
  || fail_contract "invocation directory is missing or unsafe" 73
[ "$(realpath "$invocation_dir" 2>/dev/null)" = "$invocation_dir" ] \
  || fail_contract "invocation directory path must be canonical" 73
case "$invocation_dir" in
  "$run_root"/steps/*-cleaner/attempt-"$attempt") ;;
  *) fail_contract "invocation directory escapes Cleaner step" 73 ;;
esac
[ "$output" = "$invocation_dir/adapter-output.json" ] \
  || fail_contract "output path escapes invocation" 73
[ ! -e "$output" ] && [ ! -L "$output" ] \
  || fail_contract "output already exists" 73
# -/ 1/4

# -- 2/4 HELPER · Publish one normalized step outcome --
output_tmp=$invocation_dir/.cleaner-adapter-output.$$
output_tmp_owned=0
cleanup() {
  [ "$output_tmp_owned" -eq 0 ] || rm -f -- "$output_tmp"
}
trap cleanup 0
trap 'exit 130' 1 2 15

publish_outcome() {
  local code=$1 payload=$2
  set -C
  if {
    output_tmp_owned=1
    jq -cn \
      --arg run "$run" --argjson attempt "$attempt" \
      --argjson code "$code" --argjson payload "$payload" '
        {
          schema:"combo.step-output/v1",
          run_id:$run,step_id:"cleaner",role:"cleaner",attempt:$attempt,
          exit_class:"completed",
          events:[{
            code:$code,
            event:(if $code==0 then "cleaned" else "clean_failed" end),
            payload:$payload
          }],
          artifacts:[],reasons:[],errors:[]
        }
      '
  } >"$output_tmp"; then
    :
  else
    set +C
    fail_contract "cannot stage Cleaner output" 73
  fi
  set +C
  chmod 0444 "$output_tmp" \
    || fail_contract "cannot protect Cleaner output" 73
  ln "$output_tmp" "$output" 2>/dev/null \
    || fail_contract "Cleaner output publication collision" 73
  rm -f -- "$output_tmp"
  output_tmp_owned=0
  exit 0
}

reject() {
  local reason=$1
  publish_outcome 1 "$(jq -cn --arg reason "$reason" '{reasons:[$reason]}')"
}
# -/ 2/4

# -- 3/4 CORE · Verify exact custody and a terminal Gate result --
ownership=$run_root/agents/launcher.ownership.json
[ -f "$ownership" ] && [ ! -L "$ownership" ] \
  || reject "ownership:missing_or_unsafe"
[ "$(realpath "$ownership" 2>/dev/null)" = "$ownership" ] \
  || reject "ownership:outside_run"
ownership_mode=$(stat -c '%a' "$ownership" 2>/dev/null \
  || stat -f '%Lp' "$ownership" 2>/dev/null || true)
[ "$ownership_mode" = 444 ] || reject "ownership:not_read_only"
if ! jq -e --arg run "$run" '
  def sha:
    type=="string" and test("^[0-9a-f]{40}([0-9a-f]{24})?$");
  def text:
    type=="string" and length>0 and
    (explode | all(.[]; .>=32 and .!=127));
  type=="object" and
  keys==[
    "base_sha","branch","lease_id","repo_dir","run","runway_kind","worktree"
  ] and
  .run==$run and .runway_kind=="treehouse" and .lease_id==$run and
  (.repo_dir|text and startswith("/")) and
  (.worktree|text and startswith("/")) and
  (.branch|text) and (.base_sha|sha)
' "$ownership" >/dev/null 2>&1; then
  reject "ownership:invalid_or_rewritten"
fi

shopt -s nullglob
gate_results=("$run_root"/steps/*-gate/attempt-*/result.json)
shopt -u nullglob
[ "${#gate_results[@]}" -gt 0 ] || reject "gate:terminal_missing"
gate_terminal=
for result in "${gate_results[@]}"; do
  [ -f "$result" ] && [ ! -L "$result" ] || continue
  [ "$(realpath "$result" 2>/dev/null)" = "$result" ] || continue
  result_mode=$(stat -c '%a' "$result" 2>/dev/null \
    || stat -f '%Lp' "$result" 2>/dev/null || true)
  [ "$result_mode" = 444 ] || continue
  if jq -e --arg run "$run" '
    .schema=="combo.step-output/v1" and .run_id==$run and
    .step_id=="gate" and .role=="gate" and
    ((.exit_class=="completed" and
      (.events[0].event=="gate_ok" or .events[0].event=="gate_failed")) or
     .exit_class=="technical_error" or .exit_class=="cancelled")
  ' "$result" >/dev/null 2>&1; then
    gate_terminal=$result
  fi
done
[ -n "$gate_terminal" ] || reject "gate:terminal_invalid"
# -/ 3/4

# -- 4/4 CORE · Replay or release the exact recorded Treehouse path --
cleaner_seal=$run_root/agents/cleaner.ownership.json
validate_cleaner_seal() {
  [ -f "$cleaner_seal" ] && [ ! -L "$cleaner_seal" ] || return 1
  jq -e --arg run "$run" \
    --arg kind "$(jq -r '.runway_kind' "$ownership")" \
    --arg repo "$(jq -r '.repo_dir' "$ownership")" \
    --arg worktree "$(jq -r '.worktree' "$ownership")" \
    --arg branch "$(jq -r '.branch' "$ownership")" \
    --arg base "$(jq -r '.base_sha' "$ownership")" '
      type=="object" and .run==$run and .runway_kind==$kind and
      .repo_dir==$repo and .worktree==$worktree and .branch==$branch and
      .base_sha==$base and .released==true and .reasons==[]
    ' "$cleaner_seal" >/dev/null 2>&1
}

if validate_cleaner_seal; then
  publish_outcome 0 "$(jq -c \
    '{runway_kind:.runway_kind,worktree:.worktree}' "$cleaner_seal")"
fi

script_dir=$(CDPATH='' cd -- "$(dirname "${BASH_SOURCE[0]}")" && pwd)
set +e
CB_RUNS_DIR=${CB_RUNS_DIR:-"$HOME/.combo-chen/runs"} \
  sh "$script_dir/cb-cleaner.sh" "$run" </dev/null >/dev/null 2>&1
cleaner_status=$?
set -e
if [ "$cleaner_status" -ne 0 ]; then
  reasons=$(jq -c '.reasons // ["cleaner:mechanical_failure"]' \
    "$cleaner_seal" 2>/dev/null \
    || printf '["cleaner:mechanical_failure"]')
  publish_outcome 1 "$(jq -cn --argjson reasons "$reasons" \
    '{reasons:$reasons}')"
fi
validate_cleaner_seal || reject "cleaner:release_unsealed"
publish_outcome 0 "$(jq -c \
  '{runway_kind:.runway_kind,worktree:.worktree}' "$cleaner_seal")"
# -/ 4/4
