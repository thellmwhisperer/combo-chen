#!/usr/bin/env bash
# @overview P7 No-Mistakes Gate adapter for the universal P4 envelope. It
#   verifies the Launcher-owned exact candidate before and after one documented
#   axi invocation, seals its effective binary/argv before launch, adopts that
#   same invocation after interruption, and seals/replays the typed terminal
#   outcome without duplicating delivery. Merge authority is a later P7 slice,
#   so this version accepts manual merge mode only.
#
#   READING GUIDE
#   -------------
#   1. Universal input validation <- contain paths and freeze adapter config.
#   2. Launcher custody preflight <- prove worktree, branch, clean exact HEAD.
#   3. Invocation/terminal replay <- seal or adopt one documented axi run.
#   4. Terminal normalization     <- exact identity plus passed/failed/cancelled.
#
#   MAIN FLOW
#   ---------
#   step input -> exact custody -> terminal replay | sealed axi run -> result
#
#   PUBLIC API
#   ----------
#   cb-gate.sh --input <path> --output <path>  Run one validated-mode Gate.
#
#   INTERNALS
#   ---------
#   usage, fail_contract, publish_result, publish_gate_failed,
#   verify_candidate, toon_scalar, publish_terminal_result,
#   validate_invocation
#
# @exports none
# @deps bash, git, jq, realpath, no-mistakes-compatible configured binary
set -euo pipefail

usage() {
  echo "usage: cb-gate --input <path> --output <path>" >&2
  exit 64
}

fail_contract() {
  echo "cb-gate: $1" >&2
  exit "${2:-64}"
}

input=
output=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --input)
      [ "$#" -ge 2 ] || usage
      input=$2
      shift 2
      ;;
    --output)
      [ "$#" -ge 2 ] || usage
      output=$2
      shift 2
      ;;
    *) usage ;;
  esac
done
[ -n "$input" ] && [ -n "$output" ] || usage

command -v git >/dev/null 2>&1 || fail_contract "git is required" 73
command -v jq >/dev/null 2>&1 || fail_contract "jq is required" 73
command -v realpath >/dev/null 2>&1 || fail_contract "realpath is required" 73

output_tmp=
output_tmp_owned=0
receipt_tmp=
receipt_tmp_owned=0
terminal_tmp=
terminal_tmp_owned=0
invocation_tmp=
invocation_tmp_owned=0
cleanup() {
  [ "$output_tmp_owned" -eq 0 ] || rm -f -- "$output_tmp"
  [ "$receipt_tmp_owned" -eq 0 ] || rm -f -- "$receipt_tmp"
  [ "$terminal_tmp_owned" -eq 0 ] || rm -f -- "$terminal_tmp"
  [ "$invocation_tmp_owned" -eq 0 ] || rm -f -- "$invocation_tmp"
}
trap cleanup 0
trap 'exit 130' 1 2 15

# -- 1/4 CORE · Validate universal input and contained output -- <- START HERE
[ -f "$input" ] && [ ! -L "$input" ] \
  || fail_contract "input is missing or unsafe" 73
input_real=$(realpath "$input" 2>/dev/null) \
  || fail_contract "cannot resolve input" 73
[ "$input_real" = "$input" ] || fail_contract "input path must be canonical"

if ! jq -e '
  def sha:
    type=="string" and test("^[0-9a-f]{40}([0-9a-f]{24})?$");
  def clean_string:
    type=="string" and length>0 and
    (explode | all(.[]; .>=32 and .!=127));
  def clean_strings:
    type=="array" and all(.[]; clean_string);
  type=="object" and
  keys==[
    "adapter_id","attempt","candidate_sha","config","paths",
    "prior_artifacts","role","run_id","schema","step_id"
  ] and
  .schema=="combo.step-input/v1" and .role=="gate" and .step_id=="gate" and
  (.run_id|type=="string" and test("^[a-z0-9-]+$")) and
  (.attempt|type=="number" and floor==. and .>0) and
  (.candidate_sha|sha) and
  (.paths|type=="object" and
    keys==[
      "artifacts_dir","input_path","invocation_dir","output_path",
      "run_dir","steps_dir"
    ] and all(.[]; clean_string)) and
  (.prior_artifacts|type=="array") and
  (.config |
    type=="object" and
    keys==[
      "approval","arguments","binary","intent","merge","review","schema"
    ] and
    .schema=="combo.gate.no-mistakes/v0" and
    (.binary|clean_string) and
    (.arguments|clean_strings) and
    (.intent|clean_string) and
    (.approval=="auto" or .approval=="manual") and
    (.review|type=="boolean") and
    (.merge=="manual"))
' "$input" >/dev/null 2>&1; then
  fail_contract "invalid universal Gate input or No-Mistakes config"
fi

run=$(jq -r '.run_id' "$input")
attempt=$(jq -r '.attempt' "$input")
candidate_sha=$(jq -r '.candidate_sha' "$input")
run_dir=$(jq -r '.paths.run_dir' "$input")
invocation_dir=$(jq -r '.paths.invocation_dir' "$input")
declared_input=$(jq -r '.paths.input_path' "$input")
declared_output=$(jq -r '.paths.output_path' "$input")
[ "$declared_input" = "$input" ] || fail_contract "input path disagrees with envelope"
[ "$declared_output" = "$output" ] || fail_contract "output path disagrees with envelope"

runs_dir=${CB_RUNS_DIR:-"$HOME/.combo-chen/runs"}
[ -d "$runs_dir" ] && [ ! -L "$runs_dir" ] \
  || fail_contract "runs directory is missing or unsafe" 73
[ -d "$run_dir" ] && [ ! -L "$run_dir" ] \
  || fail_contract "run directory is missing or unsafe" 73
runs_root=$(realpath "$runs_dir" 2>/dev/null) \
  || fail_contract "cannot resolve runs directory" 73
run_root=$(realpath "$run_dir" 2>/dev/null) \
  || fail_contract "cannot resolve run directory" 73
case "$run_root" in "$runs_root"/"$run") ;; *) fail_contract "run directory escapes runs root" 73 ;; esac
[ -d "$invocation_dir" ] && [ ! -L "$invocation_dir" ] \
  || fail_contract "invocation directory is missing or unsafe" 73
[ "$(realpath "$invocation_dir" 2>/dev/null)" = "$invocation_dir" ] \
  || fail_contract "invocation directory path must be canonical" 73
case "$invocation_dir" in "$run_root"/steps/*/attempt-"$attempt") ;; *) fail_contract "invocation directory escapes attempt" 73 ;; esac
[ "$output" = "$invocation_dir/adapter-output.json" ] \
  || fail_contract "output path escapes invocation"
[ ! -e "$output" ] && [ ! -L "$output" ] \
  || fail_contract "output path already exists" 73
output_tmp=$invocation_dir/.adapter-output.json.tmp.$$
[ ! -e "$output_tmp" ] && [ ! -L "$output_tmp" ] \
  || fail_contract "output staging path already exists" 73
# -/ 1/4

publish_result() {
  local json=$1
  set -C
  if exec 3>"$output_tmp"; then
    output_tmp_owned=1
  else
    set +C
    fail_contract "cannot reserve output staging path" 73
  fi
  set +C
  printf '%s\n' "$json" >&3
  exec 3>&-
  chmod 0444 "$output_tmp" || fail_contract "cannot make output read-only" 73
  if ! ln "$output_tmp" "$output" 2>/dev/null; then
    fail_contract "output publication collision" 73
  fi
  rm -f -- "$output_tmp"
  output_tmp_owned=0
}

publish_gate_failed() {
  local reason=$1 artifacts=${2:-'[]'}
  publish_result "$(
    jq -cn \
      --arg run "$run" --argjson attempt "$attempt" \
      --arg reason "$reason" --argjson artifacts "$artifacts" '
        {
          schema:"combo.step-output/v1",
          run_id:$run,
          step_id:"gate",
          role:"gate",
          attempt:$attempt,
          exit_class:"completed",
          events:[{
            code:1,
            event:"gate_failed",
            payload:{reason:$reason}
          }],
          artifacts:$artifacts,
          reasons:[],
          errors:[]
        }
      '
  )"
}

toon_scalar() {
  local prefix=$1 path=$2
  awk -v prefix="$prefix" '
    index($0, prefix)==1 {
      value=substr($0, length(prefix)+1)
      sub(/^[[:space:]]+/, "", value)
      sub(/[[:space:]]+$/, "", value)
      if (value ~ /^".*"$/) {
        value=substr(value, 2, length(value)-2)
      }
      count++
      result=value
    }
    END {
      if (count==1 && length(result)>0) print result
      else exit 1
    }
  ' "$path"
}

publish_terminal_result() {
  local terminal_json=$1 terminal_receipt terminal_result terminal_artifacts
  terminal_receipt=$(printf '%s\n' "$terminal_json" |
    jq -r '.no_mistakes.receipt')
  terminal_result=$(printf '%s\n' "$terminal_json" | jq -c '.result')
  terminal_artifacts=$(jq -cn \
    --arg invocation "$invocation_rel" \
    --arg receipt "$terminal_receipt" --arg terminal "$terminal_rel" '
      [
        {id:"gate-invocation",path:$invocation},
        {id:"no-mistakes-outcome",path:$receipt},
        {id:"gate-terminal",path:$terminal}
      ]
    ')
  publish_result "$(
    jq -cn \
      --arg run "$run" --argjson attempt "$attempt" \
      --argjson result "$terminal_result" \
      --argjson artifacts "$terminal_artifacts" '
        {
          schema:"combo.step-output/v1",
          run_id:$run,
          step_id:"gate",
          role:"gate",
          attempt:$attempt,
          exit_class:$result.exit_class,
          events:$result.events,
          artifacts:$artifacts,
          reasons:$result.reasons,
          errors:$result.errors
        }
      '
  )"
}

# -- 2/4 CORE · Verify Launcher custody and the exact reviewed candidate --
ownership=$run_root/agents/launcher.ownership.json
[ -f "$ownership" ] && [ ! -L "$ownership" ] \
  || fail_contract "Launcher ownership is missing or unsafe" 73
[ "$(realpath "$ownership" 2>/dev/null)" = "$ownership" ] \
  || fail_contract "Launcher ownership path must be canonical" 73
if ! jq -e --arg run "$run" '
  def sha:
    type=="string" and test("^[0-9a-f]{40}([0-9a-f]{24})?$");
  def text:
    type=="string" and length>0 and
    (explode | all(.[]; .>=32 and .!=127));
  type=="object" and .run==$run and
  (.runway_kind=="treehouse" or .runway_kind=="git-worktree-explicit") and
  (.repo_dir|text) and (.worktree|text) and (.branch|text) and
  (.base_sha|sha) and
  if .runway_kind=="treehouse" then
    keys==[
      "base_sha","branch","lease_id","repo_dir","run","runway_kind","worktree"
    ] and (.lease_id|text)
  else
    keys==[
      "base_sha","branch","ownership_id","repo_dir","run","runway_kind","worktree"
    ] and (.ownership_id|text)
  end
' "$ownership" >/dev/null 2>&1; then
  fail_contract "invalid Launcher ownership"
fi

worktree=$(jq -r '.worktree' "$ownership")
branch=$(jq -r '.branch' "$ownership")
[ -d "$worktree" ] && [ ! -L "$worktree" ] \
  || fail_contract "Launcher worktree is missing or unsafe" 73
worktree_root=$(realpath "$worktree" 2>/dev/null) \
  || fail_contract "cannot resolve Launcher worktree" 73
[ "$worktree_root" = "$worktree" ] \
  || fail_contract "Launcher worktree path must be canonical" 73

verify_candidate() {
  local observed_branch observed_head dirty
  observed_branch=$(git -C "$worktree" symbolic-ref --quiet --short HEAD 2>/dev/null) \
    || return 1
  observed_head=$(git -C "$worktree" rev-parse --verify HEAD 2>/dev/null) \
    || return 1
  [ "$observed_branch" = "$branch" ] || return 1
  [ "$observed_head" = "$candidate_sha" ] || return 1
  dirty=$(git -C "$worktree" status --porcelain 2>/dev/null) || return 1
  [ -z "$dirty" ]
}

if ! verify_candidate; then
  publish_gate_failed candidate_head_changed
  exit 0
fi
# -/ 2/4

# -- 3/4 CORE · Replay a terminal seal or invoke documented No-Mistakes argv --
artifacts_dir=$run_root/artifacts
[ -d "$artifacts_dir" ] && [ ! -L "$artifacts_dir" ] \
  || fail_contract "artifacts directory is missing or unsafe" 73
[ "$(realpath "$artifacts_dir" 2>/dev/null)" = "$artifacts_dir" ] \
  || fail_contract "artifacts directory path must be canonical" 73
gate_artifacts=$artifacts_dir/gate
if ! mkdir "$gate_artifacts" 2>/dev/null; then
  [ -d "$gate_artifacts" ] && [ ! -L "$gate_artifacts" ] \
    || fail_contract "cannot create Gate artifacts directory" 73
fi
[ -d "$gate_artifacts" ] && [ ! -L "$gate_artifacts" ] \
  || fail_contract "Gate artifacts directory is unsafe" 73
[ "$(realpath "$gate_artifacts" 2>/dev/null)" = "$gate_artifacts" ] \
  || fail_contract "Gate artifacts directory path must be canonical" 73

invocation_rel=artifacts/gate/invocation.json
invocation=$run_root/$invocation_rel
invocation_tmp=$gate_artifacts/.invocation.json.tmp.$$
terminal_rel=artifacts/gate/terminal.json
terminal=$run_root/$terminal_rel
terminal_tmp=$gate_artifacts/.terminal.json.tmp.$$
if [ -e "$terminal" ] || [ -L "$terminal" ]; then
  [ -f "$terminal" ] && [ ! -L "$terminal" ] \
    || fail_contract "Gate terminal seal is unsafe" 73
  [ "$(realpath "$terminal" 2>/dev/null)" = "$terminal" ] \
    || fail_contract "Gate terminal seal path must be canonical" 73
  terminal_json=$(jq -c '.' "$terminal" 2>/dev/null) \
    || fail_contract "invalid Gate terminal seal" 73
  if ! printf '%s\n' "$terminal_json" | jq -e \
    --arg run "$run" --arg branch "$branch" --arg worktree "$worktree" \
    --arg sha "$candidate_sha" --arg invocation "$invocation_rel" '
      def clean:
        type=="string" and length>0 and
        (explode | all(.[]; .>=32 and .!=127));
      def clean_or_empty:
        type=="string" and
        (length==0 or (explode | all(.[]; .>=32 and .!=127)));
      . as $terminal |
      type=="object" and
      keys==[
        "branch","candidate_sha","invocation","no_mistakes",
        "normalized_outcome","result","run_id","schema","worktree"
      ] and
      .schema=="combo.gate-terminal/v1" and
      .run_id==$run and .branch==$branch and .worktree==$worktree and
      .candidate_sha==$sha and .invocation==$invocation and
      (.normalized_outcome |
        .=="validated" or .=="failed" or .=="cancelled") and
      (.no_mistakes |
        type=="object" and keys==["outcome","pr","receipt","run_id"] and
        (.run_id|clean) and
        (.outcome |
          .=="passed" or .=="checks-passed" or
          .=="failed" or .=="cancelled") and
        (.pr|clean_or_empty) and
        (.receipt |
          type=="string" and
          test("^artifacts/gate/no-mistakes-attempt-[1-9][0-9]*\\.toon$"))) and
      (.result |
        type=="object" and
        keys==["errors","events","exit_class","reasons"]) and
      if .normalized_outcome=="validated" then
        (.no_mistakes.outcome=="passed" or
          .no_mistakes.outcome=="checks-passed") and
        .result=={
          exit_class:"completed",
          events:[{
            code:0,
            event:"gate_ok",
            payload:(
              {outcome:"validated",sha:$sha} +
              if $terminal.no_mistakes.pr=="" then
                {}
              else
                {pr:$terminal.no_mistakes.pr}
              end
            )
          }],
          reasons:[],
          errors:[]
        }
      elif .normalized_outcome=="failed" then
        .no_mistakes.outcome=="failed" and
        .result=={
          exit_class:"completed",
          events:[{
            code:1,
            event:"gate_failed",
            payload:{reason:"no_mistakes_failed"}
          }],
          reasons:[],
          errors:[]
        }
      else
        .no_mistakes.outcome=="cancelled" and
        .result=={
          exit_class:"cancelled",
          events:[],
          reasons:["no_mistakes_cancelled"],
          errors:[]
        }
      end
    ' >/dev/null 2>&1; then
    fail_contract "invalid Gate terminal seal" 73
  fi
  [ -f "$invocation" ] && [ ! -L "$invocation" ] \
    || fail_contract "Gate invocation seal is missing or unsafe" 73
  [ "$(realpath "$invocation" 2>/dev/null)" = "$invocation" ] \
    || fail_contract "Gate invocation seal path must be canonical" 73
  if ! jq -e \
    --arg run "$run" --arg branch "$branch" --arg worktree "$worktree" \
    --arg sha "$candidate_sha" --argjson attempt "$attempt" '
      def clean:
        type=="string" and length>0 and
        (explode | all(.[]; .>=32 and .!=127));
      type=="object" and
      keys==[
        "argv","binary","branch","candidate_sha","initial_attempt",
        "run_id","schema","worktree"
      ] and
      .schema=="combo.gate-invocation/v1" and
      .run_id==$run and .branch==$branch and .worktree==$worktree and
      .candidate_sha==$sha and
      (.initial_attempt |
        type=="number" and floor==. and .>0 and .<=$attempt) and
      (.binary|clean) and
      (.argv|type=="array" and length>0 and all(.[]; clean))
    ' "$invocation" >/dev/null 2>&1; then
    fail_contract "invalid Gate invocation seal" 73
  fi
  terminal_receipt_rel=$(printf '%s\n' "$terminal_json" |
    jq -r '.no_mistakes.receipt')
  terminal_receipt=$run_root/$terminal_receipt_rel
  [ -f "$terminal_receipt" ] && [ ! -L "$terminal_receipt" ] \
    || fail_contract "Gate terminal receipt is missing or unsafe" 73
  [ "$(realpath "$terminal_receipt" 2>/dev/null)" = "$terminal_receipt" ] \
    || fail_contract "Gate terminal receipt path must be canonical" 73
  publish_terminal_result "$terminal_json"
  exit 0
fi
[ ! -e "$terminal_tmp" ] && [ ! -L "$terminal_tmp" ] \
  || fail_contract "Gate terminal staging path already exists" 73

binary=$(jq -r '.config.binary' "$input")
case "$binary" in
  */*)
    case "$binary" in /*) ;; *) fail_contract "No-Mistakes binary path must be absolute" ;; esac
    [ -f "$binary" ] && [ ! -L "$binary" ] && [ -x "$binary" ] \
      || fail_contract "No-Mistakes binary is missing or unsafe" 73
    binary_path=$(realpath "$binary" 2>/dev/null) \
      || fail_contract "cannot resolve No-Mistakes binary" 73
    [ "$binary_path" = "$binary" ] \
      || fail_contract "No-Mistakes binary path must be canonical" 73
    ;;
  *)
    binary_path=$(command -v "$binary" 2>/dev/null) \
      || fail_contract "No-Mistakes binary is unavailable" 73
    ;;
esac

approval=$(jq -r '.config.approval' "$input")
review=$(jq -r '.config.review' "$input")
intent=$(jq -r '.config.intent' "$input")
nm_args=(axi run --intent "$intent")
configured_args=()
while IFS= read -r -d '' argument; do
  configured_args+=("$argument")
done < <(jq -j '.config.arguments[] | . + "\u0000"' "$input")
expected_args=$(jq -r '.config.arguments | length' "$input")
[ "${#configured_args[@]}" -eq "$expected_args" ] \
  || fail_contract "No-Mistakes arguments were truncated" 73

argument_index=0
while [ "$argument_index" -lt "$expected_args" ]; do
  argument=${configured_args[$argument_index]}
  case "$argument" in
    --auto-merge|--auto-merge=*|-y|-y=*|--yes|--yes=*|--intent|--intent=*)
      fail_contract "reserved No-Mistakes argument: $argument"
      ;;
    --skip)
      [ "$review" = true ] \
        || fail_contract "review=false cannot be combined with a configured --skip"
      argument_index=$((argument_index + 1))
      [ "$argument_index" -lt "$expected_args" ] \
        || fail_contract "configured --skip is missing its value"
      skip_value=${configured_args[$argument_index]}
      case ",$skip_value," in
        *,review,*) fail_contract "review=true forbids skipping review" ;;
      esac
      nm_args+=(--skip "$skip_value")
      ;;
    --skip=*)
      [ "$review" = true ] \
        || fail_contract "review=false cannot be combined with a configured --skip"
      skip_value=${argument#*=}
      [ -n "$skip_value" ] || fail_contract "configured --skip is missing its value"
      case ",$skip_value," in
        *,review,*) fail_contract "review=true forbids skipping review" ;;
      esac
      nm_args+=("$argument")
      ;;
    *)
      nm_args+=("$argument")
      ;;
  esac
  argument_index=$((argument_index + 1))
done
if [ "$review" = false ]; then
  nm_args+=(--skip=review)
fi
if [ "$approval" = auto ]; then
  nm_args+=(--yes)
fi

nm_args_json=$(
  printf '%s\0' "${nm_args[@]}" |
    jq -Rs 'split("\u0000") | .[:-1]'
) || fail_contract "cannot freeze No-Mistakes argv" 73

validate_invocation() {
  local json=$1
  printf '%s\n' "$json" | jq -e \
    --arg run "$run" --arg branch "$branch" --arg worktree "$worktree" \
    --arg sha "$candidate_sha" --arg binary "$binary_path" \
    --argjson attempt "$attempt" --argjson argv "$nm_args_json" '
      def clean:
        type=="string" and length>0 and
        (explode | all(.[]; .>=32 and .!=127));
      type=="object" and
      keys==[
        "argv","binary","branch","candidate_sha","initial_attempt",
        "run_id","schema","worktree"
      ] and
      .schema=="combo.gate-invocation/v1" and
      .run_id==$run and .branch==$branch and .worktree==$worktree and
      .candidate_sha==$sha and .binary==$binary and .argv==$argv and
      (.initial_attempt |
        type=="number" and floor==. and .>0 and .<=$attempt) and
      (.binary|clean) and
      (.argv|type=="array" and length>0 and all(.[]; clean))
    ' >/dev/null 2>&1
}

if [ -e "$invocation" ] || [ -L "$invocation" ]; then
  [ -f "$invocation" ] && [ ! -L "$invocation" ] \
    || fail_contract "Gate invocation seal is unsafe" 73
else
  [ ! -e "$invocation_tmp" ] && [ ! -L "$invocation_tmp" ] \
    || fail_contract "Gate invocation staging path already exists" 73
  invocation_json=$(jq -cn \
    --arg run "$run" --arg branch "$branch" --arg worktree "$worktree" \
    --arg sha "$candidate_sha" --arg binary "$binary_path" \
    --argjson attempt "$attempt" --argjson argv "$nm_args_json" '
      {
        schema:"combo.gate-invocation/v1",
        run_id:$run,
        branch:$branch,
        worktree:$worktree,
        candidate_sha:$sha,
        initial_attempt:$attempt,
        binary:$binary,
        argv:$argv
      }
    ')
  set -C
  if exec 6>"$invocation_tmp"; then
    invocation_tmp_owned=1
  else
    set +C
    fail_contract "cannot reserve Gate invocation staging path" 73
  fi
  set +C
  printf '%s\n' "$invocation_json" >&6
  exec 6>&-
  chmod 0444 "$invocation_tmp" \
    || fail_contract "cannot make Gate invocation read-only" 73
  if ln "$invocation_tmp" "$invocation" 2>/dev/null; then
    rm -f -- "$invocation_tmp"
    invocation_tmp_owned=0
  else
    rm -f -- "$invocation_tmp"
    invocation_tmp_owned=0
    [ -f "$invocation" ] && [ ! -L "$invocation" ] \
      || fail_contract "Gate invocation publication collision" 73
  fi
fi
[ "$(realpath "$invocation" 2>/dev/null)" = "$invocation" ] \
  || fail_contract "Gate invocation seal path must be canonical" 73
invocation_json=$(jq -c '.' "$invocation" 2>/dev/null) \
  || fail_contract "invalid Gate invocation seal" 73
validate_invocation "$invocation_json" \
  || fail_contract "Gate invocation seal disagrees with this retry" 73

sealed_binary=$(printf '%s\n' "$invocation_json" | jq -r '.binary')
sealed_args=()
while IFS= read -r -d '' argument; do
  sealed_args+=("$argument")
done < <(printf '%s\n' "$invocation_json" |
  jq -j '.argv[] | . + "\u0000"')
sealed_expected=$(printf '%s\n' "$invocation_json" | jq -r '.argv | length')
[ "${#sealed_args[@]}" -eq "$sealed_expected" ] \
  || fail_contract "sealed No-Mistakes argv was truncated" 73

receipt_rel=artifacts/gate/no-mistakes-attempt-$attempt.toon
receipt=$run_root/$receipt_rel
receipt_tmp=$gate_artifacts/.no-mistakes-attempt-$attempt.toon.tmp.$$
[ ! -e "$receipt" ] && [ ! -L "$receipt" ] \
  || fail_contract "No-Mistakes receipt already exists" 73
[ ! -e "$receipt_tmp" ] && [ ! -L "$receipt_tmp" ] \
  || fail_contract "No-Mistakes receipt staging path already exists" 73
set -C
if exec 4>"$receipt_tmp"; then
  receipt_tmp_owned=1
else
  set +C
  fail_contract "cannot reserve No-Mistakes receipt staging path" 73
fi
set +C

set +e
(
  cd "$worktree" || exit 73
  "$sealed_binary" "${sealed_args[@]}"
) </dev/null >&4
nm_status=$?
set -e
exec 4>&-
chmod 0444 "$receipt_tmp" || fail_contract "cannot make No-Mistakes receipt read-only" 73
if ! ln "$receipt_tmp" "$receipt" 2>/dev/null; then
  fail_contract "No-Mistakes receipt publication collision" 73
fi
rm -f -- "$receipt_tmp"
receipt_tmp_owned=0
artifacts=$(jq -cn \
  --arg invocation "$invocation_rel" --arg receipt "$receipt_rel" '
    [
      {id:"gate-invocation",path:$invocation},
      {id:"no-mistakes-outcome",path:$receipt}
    ]
  ')
# -/ 3/4

# -- 4/4 CORE · Validate typed identity and normalize terminal outcome --
nm_outcome=$(toon_scalar "outcome:" "$receipt" 2>/dev/null || true)
nm_run_id=$(toon_scalar "  id:" "$receipt" 2>/dev/null || true)
nm_branch=$(toon_scalar "  branch:" "$receipt" 2>/dev/null || true)
nm_head=$(toon_scalar "  head:" "$receipt" 2>/dev/null || true)
nm_pr=$(toon_scalar "  pr:" "$receipt" 2>/dev/null || true)

if ! verify_candidate; then
  publish_gate_failed candidate_head_changed "$artifacts"
  exit 0
fi
if [ "$nm_branch" != "$branch" ]; then
  publish_gate_failed no_mistakes_branch_mismatch "$artifacts"
  exit 0
fi
case "$nm_run_id" in
  ''|*[!A-Za-z0-9_-]*)
    publish_gate_failed no_mistakes_run_id_invalid "$artifacts"
    exit 0
    ;;
esac
case "$nm_head" in
  ''|*[!0-9a-f]*) publish_gate_failed no_mistakes_head_mismatch "$artifacts"; exit 0 ;;
esac
[ "${#nm_head}" -ge 7 ] && [ "${#nm_head}" -le "${#candidate_sha}" ] \
  || { publish_gate_failed no_mistakes_head_mismatch "$artifacts"; exit 0; }
case "$candidate_sha" in
  "$nm_head"*) ;;
  *) publish_gate_failed no_mistakes_head_mismatch "$artifacts"; exit 0 ;;
esac

case "$nm_outcome" in
  passed|checks-passed)
    [ "$nm_status" -eq 0 ] \
      || { publish_gate_failed no_mistakes_exit_mismatch "$artifacts"; exit 0; }
    payload=$(jq -cn --arg sha "$candidate_sha" --arg pr "$nm_pr" '
      {outcome:"validated",sha:$sha} +
      if $pr=="" then {} else {pr:$pr} end
    ')
    normalized_outcome=validated
    normalized_result=$(jq -cn --argjson payload "$payload" '
      {
        exit_class:"completed",
        events:[{code:0,event:"gate_ok",payload:$payload}],
        reasons:[],
        errors:[]
      }
    ')
    ;;
  failed)
    normalized_outcome=failed
    normalized_result=$(jq -cn '
      {
        exit_class:"completed",
        events:[{
          code:1,
          event:"gate_failed",
          payload:{reason:"no_mistakes_failed"}
        }],
        reasons:[],
        errors:[]
      }
    ')
    ;;
  cancelled)
    normalized_outcome=cancelled
    normalized_result=$(jq -cn '
      {
        exit_class:"cancelled",
        events:[],
        reasons:["no_mistakes_cancelled"],
        errors:[]
      }
    ')
    ;;
  *)
    fail_contract "unrecognized No-Mistakes outcome (${nm_outcome:-missing}, exit $nm_status)" 70
    ;;
esac

terminal_json=$(jq -cn \
  --arg run "$run" --arg branch "$branch" --arg worktree "$worktree" \
  --arg sha "$candidate_sha" --arg nm_run "$nm_run_id" \
  --arg nm_outcome "$nm_outcome" --arg pr "$nm_pr" \
  --arg invocation "$invocation_rel" --arg receipt "$receipt_rel" \
  --arg normalized "$normalized_outcome" \
  --argjson result "$normalized_result" '
    {
      schema:"combo.gate-terminal/v1",
      run_id:$run,
      branch:$branch,
      worktree:$worktree,
      candidate_sha:$sha,
      invocation:$invocation,
      no_mistakes:{
        run_id:$nm_run,
        outcome:$nm_outcome,
        pr:$pr,
        receipt:$receipt
      },
      normalized_outcome:$normalized,
      result:$result
    }
  ')
set -C
if exec 5>"$terminal_tmp"; then
  terminal_tmp_owned=1
else
  set +C
  fail_contract "cannot reserve Gate terminal staging path" 73
fi
set +C
printf '%s\n' "$terminal_json" >&5
exec 5>&-
chmod 0444 "$terminal_tmp" || fail_contract "cannot make Gate terminal seal read-only" 73
if ! ln "$terminal_tmp" "$terminal" 2>/dev/null; then
  fail_contract "Gate terminal publication collision" 73
fi
rm -f -- "$terminal_tmp"
terminal_tmp_owned=0
publish_terminal_result "$terminal_json"
# -/ 4/4
