#!/usr/bin/env bash
# @overview Native P4 envelope for the mechanical Treehouse Cleaner. It
#   validates Launcher custody plus a terminal Gate result, delegates one exact
#   non-forcing release to cb-cleaner.sh, retries only an exact immutable
#   recorded failure, and replays a sealed release without duplicating the
#   effect.
#
#   READING GUIDE
#   -------------
#   1. Envelope containment       <- reject untrusted paths and config.
#   2. publish_outcome            <- one collision-safe P4 output.
#   3. Custody/Gate verification  <- bind cleanup to Launcher and terminal Gate.
#   4. Retry, release, or replay  <- exact Treehouse path, never a fallback.
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
#   usage, fail_contract, file_identity, file_inode, reserve_output_staging,
#   remove_owned_output_staging, publish_outcome, reject,
#   validate_latest_gate_terminal, recheck_authorized_gate_terminal,
#   validate_cleaner_seal, read_cleaner_failure_reasons
#
# @exports none
# @deps bash, jq, mktemp, realpath, stat, bin/cb-cleaner.sh
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
runs_root=${run_root%/*}
[ -d "$runs_root" ] && [ ! -L "$runs_root" ] \
  && [ "$(realpath "$runs_root" 2>/dev/null)" = "$runs_root" ] \
  && [ "$run_root" = "$runs_root/$run" ] \
  || fail_contract "run directory does not match its canonical runs root" 73
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
output_tmp=
output_tmp_owned=0
output_tmp_identity=
output_fd_open=0
file_identity() {
  stat -c '%d:%i' "$1" 2>/dev/null \
    || stat -f '%d:%i' "$1" 2>/dev/null
}

file_inode() {
  stat -Lc '%i' "$1" 2>/dev/null \
    || stat -f '%i' "$1" 2>/dev/null
}

remove_owned_output_staging() {
  local current_identity
  [ "$output_tmp_owned" -eq 1 ] || return 0
  [ -f "$output_tmp" ] && [ ! -L "$output_tmp" ] || return 1
  current_identity=$(file_identity "$output_tmp") || return 1
  [ "$current_identity" = "$output_tmp_identity" ] || return 1
  rm -f -- "$output_tmp" || return 1
  output_tmp_owned=0
}

cleanup() {
  local current_identity
  if [ "$output_fd_open" -eq 1 ]; then
    exec 3>&- 2>/dev/null || true
    output_fd_open=0
  fi
  if [ "$output_tmp_owned" -eq 1 ] \
    && [ -f "$output_tmp" ] && [ ! -L "$output_tmp" ]; then
    current_identity=$(file_identity "$output_tmp" 2>/dev/null || true)
    if [ -n "$current_identity" ] \
      && [ "$current_identity" = "$output_tmp_identity" ]; then
      rm -f -- "$output_tmp"
    fi
  fi
}
trap cleanup 0
trap 'exit 130' 1 2 15

reserve_output_staging() {
  local previous_umask
  previous_umask=$(umask)
  umask 077
  output_tmp=$(mktemp \
    "$invocation_dir/.cleaner-adapter-output.XXXXXXXX") || {
      umask "$previous_umask"
      return 1
    }
  umask "$previous_umask"
  output_tmp_owned=1
  [ -f "$output_tmp" ] && [ ! -L "$output_tmp" ] || return 1
  [ "$(realpath "$output_tmp" 2>/dev/null)" = "$output_tmp" ] || return 1
  output_tmp_identity=$(file_identity "$output_tmp") || return 1
  [ -n "$output_tmp_identity" ]
}

publish_outcome() {
  local code=$1 payload=$2 path_identity fd_inode output_mode
  reserve_output_staging \
    || fail_contract "cannot reserve Cleaner output staging" 73
  exec 3<>"$output_tmp" \
    || fail_contract "cannot open Cleaner output staging" 73
  output_fd_open=1
  path_identity=$(file_identity "$output_tmp") \
    || fail_contract "cannot identify Cleaner output staging" 73
  fd_inode=$(file_inode /dev/fd/3) \
    || fail_contract "cannot identify Cleaner output descriptor" 73
  [ "$path_identity" = "$output_tmp_identity" ] \
    && [ "$fd_inode" = "${output_tmp_identity#*:}" ] \
    || fail_contract "Cleaner output staging was replaced" 73
  if ! jq -cn \
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
    ' >&3; then
    fail_contract "cannot write Cleaner output staging" 73
  fi
  if ! exec 3>&-; then
    fail_contract "cannot close Cleaner output staging" 73
  fi
  output_fd_open=0
  path_identity=$(file_identity "$output_tmp") \
    || fail_contract "cannot recheck Cleaner output staging" 73
  [ "$path_identity" = "$output_tmp_identity" ] \
    || fail_contract "Cleaner output staging changed after write" 73
  chmod 0444 "$output_tmp" \
    || fail_contract "cannot protect Cleaner output" 73
  output_mode=$(stat -c '%a' "$output_tmp" 2>/dev/null \
    || stat -f '%Lp' "$output_tmp" 2>/dev/null || true)
  [ "$output_mode" = 444 ] \
    || fail_contract "Cleaner output staging is not immutable" 73
  [ -d "$invocation_dir" ] && [ ! -L "$invocation_dir" ] \
    && [ "$(realpath "$invocation_dir" 2>/dev/null)" = "$invocation_dir" ] \
    || fail_contract "Cleaner invocation changed before publication" 73
  [ "$output" = "$invocation_dir/adapter-output.json" ] \
    && [ ! -e "$output" ] && [ ! -L "$output" ] \
    || fail_contract "Cleaner output destination became unsafe" 73
  ln "$output_tmp" "$output" 2>/dev/null \
    || fail_contract "Cleaner output publication collision" 73
  remove_owned_output_staging \
    || fail_contract "cannot remove Cleaner output staging" 73
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

gate_validation_reason=gate:attempt_inventory_invalid
gate_snapshot=
gate_terminal=
validate_latest_gate_terminal() {
  local gate_step_dirs attempt_dirs gate_step attempt_dir attempt_name
  local attempt_number latest='' count=0 result result_mode
  local result_identity result_identity_after result_json result_json_after
  local inventory_snapshot='' directory_identity
  shopt -s nullglob
  gate_step_dirs=("$run_root"/steps/*-gate)
  shopt -u nullglob
  [ "${#gate_step_dirs[@]}" -eq 1 ] || {
    gate_validation_reason=gate:attempt_inventory_invalid
    return 1
  }
  gate_step=${gate_step_dirs[0]}
  [ -d "$gate_step" ] && [ ! -L "$gate_step" ] \
    && [ "$(realpath "$gate_step" 2>/dev/null)" = "$gate_step" ] || {
      gate_validation_reason=gate:attempt_inventory_invalid
      return 1
    }
  shopt -s nullglob
  attempt_dirs=("$gate_step"/attempt-*)
  shopt -u nullglob
  [ "${#attempt_dirs[@]}" -gt 0 ] || {
    gate_validation_reason=gate:terminal_missing
    return 1
  }
  for attempt_dir in "${attempt_dirs[@]}"; do
    [ -d "$attempt_dir" ] && [ ! -L "$attempt_dir" ] \
      && [ "$(realpath "$attempt_dir" 2>/dev/null)" = "$attempt_dir" ] || {
        gate_validation_reason=gate:attempt_inventory_invalid
        return 1
      }
    attempt_name=${attempt_dir##*/}
    attempt_number=${attempt_name#attempt-}
    case "$attempt_number" in
      ''|0|0*|*[!0-9]*)
        gate_validation_reason=gate:attempt_inventory_invalid
        return 1
        ;;
    esac
    count=$((count + 1))
    if [ -z "$latest" ] \
      || [ "${#attempt_number}" -gt "${#latest}" ] \
      || { [ "${#attempt_number}" -eq "${#latest}" ] \
        && [[ "$attempt_number" > "$latest" ]]; }; then
      latest=$attempt_number
    fi
    directory_identity=$(file_identity "$attempt_dir") || {
      gate_validation_reason=gate:attempt_inventory_invalid
      return 1
    }
    inventory_snapshot=$inventory_snapshot"$attempt_number:$directory_identity;"
  done
  [ "$latest" = "$count" ] || {
    gate_validation_reason=gate:attempt_inventory_invalid
    return 1
  }
  result=$gate_step/attempt-$latest/result.json
  [ -f "$result" ] && [ ! -L "$result" ] || {
    gate_validation_reason=gate:terminal_missing
    return 1
  }
  [ "$(realpath "$result" 2>/dev/null)" = "$result" ] || {
    gate_validation_reason=gate:terminal_invalid
    return 1
  }
  result_mode=$(stat -c '%a' "$result" 2>/dev/null \
    || stat -f '%Lp' "$result" 2>/dev/null || true)
  [ "$result_mode" = 444 ] || {
    gate_validation_reason=gate:terminal_invalid
    return 1
  }
  result_identity=$(file_identity "$result") || {
    gate_validation_reason=gate:terminal_invalid
    return 1
  }
  result_json=$(jq -cS '.' "$result" 2>/dev/null) || {
    gate_validation_reason=gate:terminal_invalid
    return 1
  }
  if ! jq -e --arg run "$run" --argjson attempt "$latest" '
    def strings:
      type=="array" and all(.[]; type=="string" and length>0);
    def sha:
      type=="string" and test("^[0-9a-f]{40}([0-9a-f]{24})?$");
    def artifacts:
      type=="array" and all(.[];
        type=="object" and keys==["id","path"] and
        (.id|type=="string" and test("^[a-z][a-z0-9._-]*$")) and
        (.path|type=="string" and startswith("artifacts/")) and
        (.path|explode|all(.[]; .>=32 and .!=127)) and
        (.path|split("/")|all(.[]; length>0 and .!="." and .!="..")));
    type=="object" and
    keys==[
      "artifacts","attempt","errors","events","exit_class","reasons","role",
      "run_id","schema","step_id"
    ] and
    .schema=="combo.step-output/v1" and .run_id==$run and
    .step_id=="gate" and .role=="gate" and .attempt==$attempt and
    (.artifacts|artifacts) and (.reasons|strings) and (.errors|strings) and
    if .exit_class=="completed" then
      (.events|type=="array" and length==1) and
      (.events[0]|type=="object" and keys==["code","event","payload"]) and
      .errors==[] and
      ((.events[0].code==0 and .events[0].event=="gate_ok" and
        (.events[0].payload.outcome=="merged" or
         .events[0].payload.outcome=="validated") and
        (.events[0].payload.sha|sha)) or
       (.events[0].code==1 and .events[0].event=="gate_failed" and
        (.events[0].payload.reason|type=="string" and length>0)))
    elif .exit_class=="technical_error" then
      .events==[] and (.errors|length>0)
    elif .exit_class=="cancelled" then
      .events==[] and .errors==[] and (.reasons|length>0)
    else false end
  ' <<<"$result_json" >/dev/null 2>&1; then
    gate_validation_reason=gate:terminal_invalid
    return 1
  fi
  result_identity_after=$(file_identity "$result") || {
    gate_validation_reason=gate:terminal_invalid
    return 1
  }
  result_json_after=$(jq -cS '.' "$result" 2>/dev/null) || {
    gate_validation_reason=gate:terminal_invalid
    return 1
  }
  [ "$result_identity_after" = "$result_identity" ] \
    && [ "$result_json_after" = "$result_json" ] || {
      gate_validation_reason=gate:terminal_replaced
      return 1
    }
  gate_terminal=$result
  gate_snapshot=$inventory_snapshot"|$latest:$result_identity:$result_json"
  gate_validation_reason=
}

validate_latest_gate_terminal || reject "$gate_validation_reason"
authorized_gate_snapshot=$gate_snapshot

recheck_authorized_gate_terminal() {
  validate_latest_gate_terminal || return 1
  [ "$gate_snapshot" = "$authorized_gate_snapshot" ]
}
# -/ 3/4

# -- 4/4 CORE · Replay or release the exact recorded Treehouse path --
cleaner_seal=$run_root/agents/cleaner.ownership.json
cleaner_seal_snapshot=
cleaner_seal_json=
validate_cleaner_seal() {
  local expected=$1 mode mode_after identity identity_after json json_after
  [ -f "$cleaner_seal" ] && [ ! -L "$cleaner_seal" ] || return 1
  [ "$(realpath "$cleaner_seal" 2>/dev/null)" = "$cleaner_seal" ] \
    || return 1
  mode=$(stat -c '%a' "$cleaner_seal" 2>/dev/null \
    || stat -f '%Lp' "$cleaner_seal" 2>/dev/null || true)
  [ "$mode" = 444 ] || return 1
  identity=$(file_identity "$cleaner_seal") || return 1
  json=$(jq -cS '.' "$cleaner_seal" 2>/dev/null) || return 1
  jq -e --arg run "$run" --arg expected "$expected" \
    --arg kind "$(jq -r '.runway_kind' "$ownership")" \
    --arg repo "$(jq -r '.repo_dir' "$ownership")" \
    --arg worktree "$(jq -r '.worktree' "$ownership")" \
    --arg branch "$(jq -r '.branch' "$ownership")" \
    --arg base "$(jq -r '.base_sha' "$ownership")" '
      def sha:
        type=="string" and test("^[0-9a-f]{40}([0-9a-f]{24})?$");
      def text:
        type=="string" and length>0 and
        (explode | all(.[]; .>=32 and .!=127));
      type=="object" and
      keys==[
        "base_sha","branch","reasons","released","repo_dir","run",
        "runway_kind","worktree"
      ] and
      .run==$run and .runway_kind==$kind and
      .repo_dir==$repo and .worktree==$worktree and .branch==$branch and
      .base_sha==$base and
      (.run|text) and (.runway_kind|text) and (.repo_dir|text) and
      (.worktree|text) and (.branch|text) and (.base_sha|sha) and
      if $expected=="released" then
        .released==true and .reasons==[]
      elif $expected=="failed" then
        .released==false and
        (.reasons |
          type=="array" and length>0 and
          all(.[]; type=="string" and length>0))
      else
        false
      end
    ' <<<"$json" >/dev/null 2>&1 || return 1
  identity_after=$(file_identity "$cleaner_seal") || return 1
  json_after=$(jq -cS '.' "$cleaner_seal" 2>/dev/null) || return 1
  mode_after=$(stat -c '%a' "$cleaner_seal" 2>/dev/null \
    || stat -f '%Lp' "$cleaner_seal" 2>/dev/null || true)
  [ "$identity_after" = "$identity" ] && [ "$json_after" = "$json" ] \
    && [ "$mode_after" = 444 ] && [ ! -L "$cleaner_seal" ] \
    && [ "$(realpath "$cleaner_seal" 2>/dev/null)" = "$cleaner_seal" ] \
    || return 1
  cleaner_seal_json=$json
  cleaner_seal_snapshot=$identity:$json
}

read_cleaner_failure_reasons() {
  local mode identity identity_after json json_after reasons
  [ -f "$cleaner_seal" ] && [ ! -L "$cleaner_seal" ] || return 1
  [ "$(realpath "$cleaner_seal" 2>/dev/null)" = "$cleaner_seal" ] \
    || return 1
  mode=$(stat -c '%a' "$cleaner_seal" 2>/dev/null \
    || stat -f '%Lp' "$cleaner_seal" 2>/dev/null || true)
  [ "$mode" = 444 ] || return 1
  identity=$(file_identity "$cleaner_seal") || return 1
  json=$(jq -cS '.' "$cleaner_seal" 2>/dev/null) || return 1
  reasons=$(jq -c '
    if type=="object" and
      (.reasons|type=="array" and length>0 and
        all(.[]; type=="string" and length>0))
    then .reasons else error("invalid Cleaner failure reasons") end
  ' <<<"$json" 2>/dev/null) || return 1
  identity_after=$(file_identity "$cleaner_seal") || return 1
  json_after=$(jq -cS '.' "$cleaner_seal" 2>/dev/null) || return 1
  [ "$identity_after" = "$identity" ] && [ "$json_after" = "$json" ] \
    && [ ! -L "$cleaner_seal" ] \
    && [ "$(realpath "$cleaner_seal" 2>/dev/null)" = "$cleaner_seal" ] \
    || return 1
  printf '%s\n' "$reasons"
}

if [ -e "$cleaner_seal" ] || [ -L "$cleaner_seal" ]; then
  if validate_cleaner_seal released; then
    authorized_cleaner_seal_snapshot=$cleaner_seal_snapshot
    recheck_authorized_gate_terminal \
      || reject "${gate_validation_reason:-gate:terminal_replaced}"
    validate_cleaner_seal released \
      && [ "$cleaner_seal_snapshot" = \
        "$authorized_cleaner_seal_snapshot" ] \
      || reject "cleaner:release_seal_replaced"
    publish_outcome 0 "$(jq -c \
      '{runway_kind:.runway_kind,worktree:.worktree}' \
      <<<"$cleaner_seal_json")"
  elif validate_cleaner_seal failed; then
    authorized_cleaner_seal_snapshot=$cleaner_seal_snapshot
    recheck_authorized_gate_terminal \
      || reject "${gate_validation_reason:-gate:terminal_replaced}"
    validate_cleaner_seal failed \
      && [ "$cleaner_seal_snapshot" = \
        "$authorized_cleaner_seal_snapshot" ] \
      || reject "cleaner:release_seal_replaced"
  else
    reject "cleaner:release_seal_invalid"
  fi
fi

recheck_authorized_gate_terminal \
  || reject "${gate_validation_reason:-gate:terminal_replaced}"
script_dir=$(CDPATH='' cd -- "$(dirname "${BASH_SOURCE[0]}")" && pwd)
set +e
CB_RUNS_DIR=$runs_root \
  sh "$script_dir/cb-cleaner.sh" "$run" </dev/null >/dev/null 2>&1
cleaner_status=$?
set -e
if [ "$cleaner_status" -ne 0 ]; then
  reasons=$(read_cleaner_failure_reasons \
    || printf '["cleaner:mechanical_failure"]')
  publish_outcome 1 "$(jq -cn --argjson reasons "$reasons" \
    '{reasons:$reasons}')"
fi
validate_cleaner_seal released || reject "cleaner:release_unsealed"
recheck_authorized_gate_terminal \
  || reject "${gate_validation_reason:-gate:terminal_replaced}"
authorized_cleaner_seal_snapshot=$cleaner_seal_snapshot
validate_cleaner_seal released \
  && [ "$cleaner_seal_snapshot" = "$authorized_cleaner_seal_snapshot" ] \
  || reject "cleaner:release_seal_replaced"
publish_outcome 0 "$(jq -c \
  '{runway_kind:.runway_kind,worktree:.worktree}' <<<"$cleaner_seal_json")"
# -/ 4/4
