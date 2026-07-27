#!/usr/bin/env bash
# @overview Native P4 envelope for the mechanical Treehouse Launcher. It
#   validates one combo.step-input/v1, publishes run-local launch inputs once,
#   delegates acquisition to cb-launcher.sh, and normalizes custody facts.
#
#   READING GUIDE
#   -------------
#   1. Envelope containment       <- validate paths before run-local writes.
#   2. publish_outcome            <- one collision-safe P4 output.
#   3. Launch input publication   <- immutable readiness plus mechanical config.
#   4. Custody normalization      <- exact read-only seven-key handoff or failure.
#
#   MAIN FLOW
#   ---------
#   step input -> launch snapshots -> mechanical Launcher -> custody -> output
#
#   PUBLIC API
#   ----------
#   cb-launcher-adapter.sh --input PATH --output PATH
#
#   INTERNALS
#   ---------
#   usage, fail_contract, publish_outcome, quote_sh, reject,
#   validate_ownership
#
# @exports none
# @deps bash, jq, realpath, stat, bin/cb-launcher.sh
set -euo pipefail

usage() {
  echo "usage: cb-launcher-adapter --input <path> --output <path>" >&2
  exit 64
}

fail_contract() {
  echo "cb-launcher-adapter: $1" >&2
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
  def text:
    type=="string" and length>0 and
    (explode | all(.[]; .>=32 and .!=127));
  def seat:
    type=="object" and keys==["auth_cmd","harness","id"] and
    (.id|type=="string" and test("^[A-Za-z0-9][A-Za-z0-9._-]*$")) and
    (.harness|text) and (.auth_cmd|text);
  type=="object" and
  keys==[
    "adapter_id","attempt","candidate_sha","config","paths",
    "prior_artifacts","role","run_id","schema","step_id"
  ] and
  .schema=="combo.step-input/v1" and .step_id=="launcher" and
  .role=="launcher" and
  (.run_id|type=="string" and test("^[a-z0-9][a-z0-9-]*$")) and
  (.attempt|type=="number" and floor==. and .>0) and
  .candidate_sha==null and
  (.prior_artifacts|type=="array" and length==0) and
  .paths.input_path==$input and .paths.output_path==$output and
  (.config |
    type=="object" and
    keys==[
      "base_ref","readiness","repo_dir","schema","setup_command"
    ] and
    .schema=="combo.launcher/treehouse/v1" and
    (.repo_dir|text and startswith("/")) and
    (.base_ref|text) and (.setup_command|type=="string") and
    (.readiness |
      type=="object" and keys==["required_seats","seats"] and
      (.required_seats |
        type=="array" and length>0 and
        all(.[]; type=="string" and
          test("^[A-Za-z0-9][A-Za-z0-9._-]*$")) and
        length==(unique|length)) and
      (.seats |
        type=="array" and all(.[]; seat) and
        ([.[].id]|length==(unique|length))) and
      ([.required_seats[] as $required |
        any(.seats[]; .id==$required)] | all)))
' "$input" >/dev/null 2>&1; then
  fail_contract "invalid Launcher envelope or config"
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
  "$run_root"/steps/*-launcher/attempt-"$attempt") ;;
  *) fail_contract "invocation directory escapes Launcher step" 73 ;;
esac
[ "$output" = "$invocation_dir/adapter-output.json" ] \
  || fail_contract "output path escapes invocation" 73
[ ! -e "$output" ] && [ ! -L "$output" ] \
  || fail_contract "output already exists" 73
# -/ 1/4

# -- 2/4 HELPER · Publish one normalized step outcome --
output_tmp=$invocation_dir/.launcher-adapter-output.$$
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
          run_id:$run,step_id:"launcher",role:"launcher",attempt:$attempt,
          exit_class:"completed",
          events:[{
            code:$code,
            event:(if $code==0 then "launch_ready" else "launch_not_ready" end),
            payload:$payload
          }],
          artifacts:[],reasons:[],errors:[]
        }
      '
  } >"$output_tmp"; then
    :
  else
    set +C
    fail_contract "cannot stage Launcher output" 73
  fi
  set +C
  chmod 0444 "$output_tmp" \
    || fail_contract "cannot protect Launcher output" 73
  ln "$output_tmp" "$output" 2>/dev/null \
    || fail_contract "Launcher output publication collision" 73
  rm -f -- "$output_tmp"
  output_tmp_owned=0
  exit 0
}

reject() {
  local reason=$1
  publish_outcome 1 "$(jq -cn --arg reason "$reason" '{reasons:[$reason]}')"
}

quote_sh() {
  printf "'"
  printf '%s' "$1" | sed "s/'/'\\\\''/g"
  printf "'"
}
# -/ 2/4

# -- 3/4 CORE · Publish mechanical launch inputs exactly once --
repo_dir=$(jq -r '.config.repo_dir' "$input")
base_ref=$(jq -r '.config.base_ref' "$input")
setup_command=$(jq -r '.config.setup_command' "$input")
[ -d "$repo_dir" ] && [ ! -L "$repo_dir" ] \
  || reject "repo:missing_or_unsafe"
repo_dir=$(realpath "$repo_dir" 2>/dev/null) \
  || reject "repo:missing_or_unsafe"
git -C "$repo_dir" rev-parse --git-dir >/dev/null 2>&1 \
  || reject "repo:not_git"

agents_dir=$run_root/agents
[ ! -L "$agents_dir" ] || reject "agents:unsafe"
mkdir -p "$agents_dir" || reject "agents:create_failed"
[ "$(realpath "$agents_dir" 2>/dev/null)" = "$run_root/agents" ] \
  || reject "agents:unsafe"
ownership=$agents_dir/launcher.ownership.json
readiness=$run_root/launcher-readiness.json
config_env=$run_root/config.env

if [ ! -e "$ownership" ] && [ ! -L "$ownership" ]; then
  readiness_json=$(jq -c '.config.readiness' "$input") \
    || reject "readiness:write_failed"
  if [ ! -e "$readiness" ] && [ ! -L "$readiness" ]; then
    readiness_tmp=$run_root/.launcher-readiness.json.tmp.$$
    set -C
    if printf '%s\n' "$readiness_json" >"$readiness_tmp"; then
      :
    else
      set +C
      reject "readiness:write_failed"
    fi
    set +C
    chmod 0444 "$readiness_tmp" || reject "readiness:protect_failed"
    ln "$readiness_tmp" "$readiness" 2>/dev/null \
      || reject "readiness:publication_collision"
    rm -f "$readiness_tmp"
  else
    readiness_mode=$(stat -c '%a' "$readiness" 2>/dev/null \
      || stat -f '%Lp' "$readiness" 2>/dev/null || true)
    [ -f "$readiness" ] && [ ! -L "$readiness" ] \
      && [ "$(realpath "$readiness" 2>/dev/null)" = "$readiness" ] \
      && [ "$readiness_mode" = 444 ] \
      && jq -e --argjson expected "$readiness_json" \
        '.==$expected' "$readiness" >/dev/null 2>&1 \
      || reject "readiness:resume_mismatch"
  fi

  config_text=$(
    printf 'CB_REPO_DIR='
    quote_sh "$repo_dir"
    printf '\nCB_RUNWAY_MODE='
    quote_sh treehouse
    printf '\nCB_READINESS_FILE='
    quote_sh "$readiness"
    printf '\nCB_BASE_REF='
    quote_sh "$base_ref"
    printf '\nCB_SETUP_CMD='
    quote_sh "$setup_command"
    printf '\nCB_CLEAN_CUSTODY_CMD='
    quote_sh 'exit 0'
  ) || reject "config:write_failed"
  if [ ! -e "$config_env" ] && [ ! -L "$config_env" ]; then
    config_tmp=$run_root/.config.env.adapter.tmp.$$
    set -C
    if printf '%s\n' "$config_text" >"$config_tmp"; then
      :
    else
      set +C
      reject "config:write_failed"
    fi
    set +C
    chmod 0600 "$config_tmp" || reject "config:protect_failed"
    ln "$config_tmp" "$config_env" 2>/dev/null \
      || reject "config:publication_collision"
    rm -f "$config_tmp"
  else
    config_mode=$(stat -c '%a' "$config_env" 2>/dev/null \
      || stat -f '%Lp' "$config_env" 2>/dev/null || true)
    [ -f "$config_env" ] && [ ! -L "$config_env" ] \
      && [ "$(realpath "$config_env" 2>/dev/null)" = "$config_env" ] \
      && [ "$config_mode" = 600 ] \
      && [ "$(cat "$config_env" 2>/dev/null)" = "$config_text" ] \
      || reject "config:resume_mismatch"
  fi

  script_dir=$(CDPATH='' cd -- "$(dirname "${BASH_SOURCE[0]}")" && pwd)
  set +e
  CB_RUNS_DIR=${CB_RUNS_DIR:-"$HOME/.combo-chen/runs"} \
    sh "$script_dir/cb-launcher.sh" "$run" </dev/null >/dev/null 2>&1
  launcher_status=$?
  set -e
  if [ "$launcher_status" -ne 0 ]; then
    reasons=$(jq -Rrs '
      [split("\n")[] | fromjson? |
        select(.agent=="launcher" and .event=="launch_not_ready") |
        .payload.reasons] | last // ["launcher:mechanical_failure"]
    ' "$run_root/journal.jsonl" 2>/dev/null \
      || printf '["launcher:mechanical_failure"]')
    publish_outcome 1 "$(jq -cn --argjson reasons "$reasons" \
      '{reasons:$reasons}')"
  fi
fi
# -/ 3/4

# -- 4/4 CORE · Validate and normalize immutable Launcher custody --
validate_ownership() {
  [ -f "$ownership" ] && [ ! -L "$ownership" ] || return 1
  [ "$(realpath "$ownership" 2>/dev/null)" = "$ownership" ] || return 1
  local mode observed_base
  mode=$(stat -c '%a' "$ownership" 2>/dev/null \
    || stat -f '%Lp' "$ownership" 2>/dev/null || true)
  [ "$mode" = 444 ] || return 1
  jq -e --arg run "$run" --arg repo "$repo_dir" '
    def sha:
      type=="string" and test("^[0-9a-f]{40}([0-9a-f]{24})?$");
    def text:
      type=="string" and length>0 and
      (explode | all(.[]; .>=32 and .!=127));
    type=="object" and
    keys==[
      "base_sha","branch","lease_id","repo_dir","run","runway_kind","worktree"
    ] and
    .run==$run and .runway_kind=="treehouse" and .repo_dir==$repo and
    (.worktree|text and startswith("/")) and
    .branch==("combo/" + $run) and (.base_sha|sha) and .lease_id==$run
  ' "$ownership" >/dev/null 2>&1 || return 1
  observed_base=$(jq -r '.base_sha' "$ownership")
  git -C "$repo_dir" rev-parse --verify \
    "$observed_base^{commit}" >/dev/null 2>&1
}

validate_ownership || reject "ownership:invalid_or_rewritten"
payload=$(jq -c '
  {
    worktree:.worktree,
    branch:.branch,
    base_sha:.base_sha,
    runway_kind:.runway_kind,
    lease_id:.lease_id
  }
' "$ownership")
publish_outcome 0 "$payload"
# -/ 4/4
