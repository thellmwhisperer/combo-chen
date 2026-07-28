#!/usr/bin/env bash
# @overview Top-level Combo v1 Bash dispatcher. It mounts five canonical tmux
#   endpoints, dispatches each cb-step invocation through the owning visible
#   window, resumes collision-free attempts, and prints one truthful terminal
#   outcome whose trusted Gate seal also binds process status, while
#   cb-chain.sh remains the sole product state machine.
#
#   READING GUIDE
#   -------------
#   1. run_endpoint_job       <- execute and attest one step inside its window.
#   2. dispatch_step          <- publish a job, steer the endpoint, await receipt.
#   3. mount_endpoints        <- create or verify the five P2 role endpoints.
#   4. Public run path        <- drive/replay cb-chain and print terminal truth.
#
#   MAIN FLOW
#   ---------
#   run plan -> five tmux endpoints -> cb-chain -> endpoint jobs -> chain result
#
#   PUBLIC API
#   ----------
#   cb-run.sh RUN_ID  Mount or resume one compiled immutable plan.
#
#   INTERNALS
#   ---------
#   usage, fail_contract, resolve_dispatcher_executable, validate_run_root,
#   validate_bare_dispatch_name, validate_dispatch_directory,
#   validate_dispatch_destination, file_identity, file_inode,
#   observe_endpoint_receipt,
#   publish_text, shell_quote, run_endpoint_job, dispatch_step, mount_endpoints,
#   result_exit_status, trusted_gate_terminal_outcome, print_terminal_outcome
#
# @exports none
# @deps bash, jq, realpath, stat, tmux, bin/cb-agent-spawn.sh, bin/cb-send.sh,
#   bin/cb-tmux.sh, bin/cb-step.sh, bin/cb-chain.sh
set -euo pipefail

usage() {
  echo "usage: cb-run <runId>" >&2
  exit 64
}

fail_contract() {
  echo "cb-run: $1" >&2
  exit "${2:-64}"
}

resolve_dispatcher_executable() {
  local source=${BASH_SOURCE[0]} directory target hops=0
  case "$source" in
    /*) ;;
    *) source=$PWD/$source ;;
  esac
  while [ -L "$source" ]; do
    hops=$((hops + 1))
    [ "$hops" -le 40 ] || return 1
    directory=$(CDPATH='' cd -P -- "$(dirname "$source")" 2>/dev/null \
      && pwd) || return 1
    target=$(readlink "$source" 2>/dev/null) || return 1
    [ -n "$target" ] || return 1
    case "$target" in
      /*) source=$target ;;
      *) source=$directory/$target ;;
    esac
  done
  directory=$(CDPATH='' cd -P -- "$(dirname "$source")" 2>/dev/null \
    && pwd) || return 1
  source=$directory/$(basename "$source")
  [ -f "$source" ] && [ ! -L "$source" ] && [ -x "$source" ] || return 1
  [ "$(realpath "$source" 2>/dev/null)" = "$source" ] || return 1
  printf '%s\n' "$source"
}

script_path=$(resolve_dispatcher_executable) \
  || fail_contract "dispatcher executable is missing or unsafe" 73
script_dir=${script_path%/*}
runs_dir=${CB_RUNS_DIR:-"$HOME/.combo-chen/runs"}

validate_run_root() {
  local run=$1
  case "$run" in ''|-*|*[!a-z0-9-]*) return 1 ;; esac
  [ -d "$runs_dir" ] && [ ! -L "$runs_dir" ] || return 1
  [ -d "$runs_dir/$run" ] && [ ! -L "$runs_dir/$run" ] || return 1
  runs_root=$(realpath "$runs_dir" 2>/dev/null) || return 1
  run_root=$(realpath "$runs_dir/$run" 2>/dev/null) || return 1
  [ "$run_root" = "$runs_root/$run" ]
}

validate_bare_dispatch_name() {
  local name=$1 suffix=$2
  case "$name" in
    ''|.*|*/*|*\\*|*..*|*[!A-Za-z0-9._-]*) return 1 ;;
  esac
  case "$name" in
    *"$suffix") ;;
    *) return 1 ;;
  esac
}

validate_dispatch_directory() {
  local directory=$1 expected=$2
  [ -d "$directory" ] && [ ! -L "$directory" ] || return 1
  [ "$(realpath "$directory" 2>/dev/null)" = "$expected" ]
}

validate_dispatch_destination() {
  local directory=$1 name=$2 suffix=$3
  validate_bare_dispatch_name "$name" "$suffix" || return 1
  validate_dispatch_directory "$directory" "$directory" || return 1
  [ ! -e "$directory/$name" ] && [ ! -L "$directory/$name" ]
}

file_identity() {
  stat -c '%d:%i' "$1" 2>/dev/null \
    || stat -f '%d:%i' "$1" 2>/dev/null
}

file_inode() {
  stat -Lc '%i' "$1" 2>/dev/null \
    || stat -f '%i' "$1" 2>/dev/null
}

observe_endpoint_receipt() {
  local receipt=$1 expected=$2
  [ ! -L "$receipt" ] || return 2
  [ -e "$receipt" ] || return 1
  [ -f "$receipt" ] || return 2
  [ "$(realpath "$receipt" 2>/dev/null)" = "$expected" ] || return 2
}

publish_text() {
  local text=$1 directory=$2 staging_name=$3 target_name=$4 label=$5
  local staging target
  validate_bare_dispatch_name "$target_name" .json \
    || fail_contract "invalid $label basename" 73
  validate_dispatch_directory "$directory" "$directory" \
    || fail_contract "$label directory is unsafe" 73
  staging=$directory/$staging_name
  target=$directory/$target_name
  [ "$staging" = "$directory/$staging_name" ] \
    && [ "$target" = "$directory/$target_name" ] \
    || fail_contract "$label path escapes dispatch directory" 73
  [ ! -e "$staging" ] && [ ! -L "$staging" ] \
    || fail_contract "$label staging path already exists" 73
  set -C
  if printf '%s\n' "$text" >"$staging"; then
    :
  else
    set +C
    fail_contract "cannot write $label staging path" 73
  fi
  set +C
  chmod 0444 "$staging" || fail_contract "cannot protect $label" 73
  validate_dispatch_directory "$directory" "$directory" \
    || fail_contract "$label directory changed before publication" 73
  [ "$target" = "$directory/$target_name" ] \
    && [ ! -e "$target" ] && [ ! -L "$target" ] \
    || fail_contract "$label destination became unsafe" 73
  if ! ln "$staging" "$target" 2>/dev/null; then
    rm -f -- "$staging"
    return 1
  fi
  rm -f -- "$staging"
}

shell_quote() {
  printf "'"
  printf '%s' "$1" | sed "s/'/'\\\\''/g"
  printf "'"
}

# -- 1/4 CORE · run_endpoint_job -- <- START HERE
run_endpoint_job() {
  local run=$1 job_name=$2 job job_json role step attempt candidate prior
  local dispatch_dir jobs_dir receipt_name receipt receipt_tmp
  local meta expected_window actual_window pane_id result_path status
  local completed event log log_line

  validate_run_root "$run" \
    || fail_contract "endpoint job run directory is unsafe" 73
  dispatch_dir=$run_root/dispatch
  jobs_dir=$dispatch_dir/jobs
  validate_dispatch_directory "$dispatch_dir" "$run_root/dispatch" \
    || fail_contract "dispatch directory is missing or unsafe" 73
  validate_dispatch_directory "$jobs_dir" "$run_root/dispatch/jobs" \
    || fail_contract "endpoint jobs directory is missing or unsafe" 73
  validate_bare_dispatch_name "$job_name" .job.json \
    || fail_contract "invalid endpoint job basename" 73
  job=$jobs_dir/$job_name
  [ "$job" = "$jobs_dir/$job_name" ] \
    || fail_contract "endpoint job escapes dispatch directory" 73
  [ -f "$job" ] && [ ! -L "$job" ] \
    || fail_contract "endpoint job is missing or unsafe" 73
  [ "$(realpath "$job" 2>/dev/null)" = "$job" ] \
    || fail_contract "endpoint job path must be canonical" 73
  job_json=$(jq -cS '.' "$job" 2>/dev/null) \
    || fail_contract "invalid endpoint job" 73
  if ! jq -e --arg run "$run" --arg job "$job_name" '
    def sha:
      type=="string" and test("^[0-9a-f]{40}([0-9a-f]{24})?$");
    type=="object" and
    keys==[
      "attempt","candidate_sha","job_name","prior_artifacts","receipt_name",
      "role","run_id","schema","step_id"
    ] and
    .schema=="combo.endpoint-job/v1" and .run_id==$run and .job_name==$job and
    (.role=="launcher" or .role=="coder" or .role=="reviewer" or
      .role=="gate" or .role=="cleaner") and
    (.step_id|type=="string" and length>0) and
    (.attempt|type=="number" and floor==. and .>0) and
    (.candidate_sha==null or (.candidate_sha|sha)) and
    (.prior_artifacts|type=="array") and
    (.receipt_name|type=="string" and length>0)
  ' <<<"$job_json" >/dev/null 2>&1; then
    fail_contract "invalid endpoint job" 73
  fi
  receipt_name=$(jq -r '.receipt_name' <<<"$job_json")
  validate_bare_dispatch_name "$receipt_name" .receipt.json \
    || fail_contract "invalid endpoint receipt basename" 73
  receipt=$dispatch_dir/$receipt_name
  [ "$receipt" = "$dispatch_dir/$receipt_name" ] \
    || fail_contract "endpoint receipt escapes dispatch directory" 73
  validate_dispatch_destination "$dispatch_dir" "$receipt_name" .receipt.json \
    || fail_contract "endpoint receipt already exists or is unsafe" 73

  [ -n "${TMUX_PANE:-}" ] \
    || fail_contract "endpoint job is not running inside tmux" 73
  role=$(jq -r '.role' <<<"$job_json")
  step=$(jq -r '.step_id' <<<"$job_json")
  attempt=$(jq -r '.attempt' <<<"$job_json")
  candidate=$(jq -c '.candidate_sha' <<<"$job_json")
  prior=$(jq -c '.prior_artifacts' <<<"$job_json")

  meta=$run_root/agents/$role.meta
  [ -f "$meta" ] && [ ! -L "$meta" ] \
    || fail_contract "endpoint metadata is missing or unsafe" 73
  # shellcheck source=bin/cb-tmux.sh disable=SC1091
  . "$script_dir/cb-tmux.sh"
  expected_window=$(cb_tmux_meta_get "$meta" window_id 2>/dev/null || true)
  [ -n "$expected_window" ] \
    || fail_contract "endpoint metadata has no window id" 73
  pane_id=$TMUX_PANE
  actual_window=$(cb_tmux display-message -p -t "$pane_id" \
    '#{window_id}' 2>/dev/null || true)
  [ "$actual_window" = "$expected_window" ] \
    || fail_contract "job is running in the wrong endpoint window" 73
  cb_tmux_endpoint_ok "$(cb_tmux_session_name "$run")" \
    "$(cb_tmux_window_name "$run" "$role")" "$expected_window" \
    || fail_contract "endpoint window is not live" 73

  step_args=("$run" "$step" "$attempt")
  if [ "$candidate" != null ]; then
    step_args+=(--candidate-sha "$(jq -r '.candidate_sha' <<<"$job_json")")
  fi
  step_args+=(--prior-artifacts "$prior")
  set +e
  result_path=$(bash "$script_dir/cb-step.sh" "${step_args[@]}" </dev/null)
  status=$?
  set -e
  if [ "$status" -ne 0 ]; then
    result_path=
  fi

  completed=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  event=$(jq -cn \
    --arg run "$run" --arg role "$role" --arg step "$step" \
    --argjson attempt "$attempt" --arg job "$job" --arg pane "$pane_id" \
    --arg window "$actual_window" --arg result "$result_path" \
    --arg completed "$completed" --argjson status "$status" '
      {
        schema:"combo.endpoint-receipt/v1",
        run_id:$run,role:$role,step_id:$step,attempt:$attempt,
        job_path:$job,pane_id:$pane,window_id:$window,
        status:$status,result_path:$result,completed_at:$completed
      }
    ')
  receipt_tmp=.receipt.tmp.$$
  publish_text "$event" "$dispatch_dir" "$receipt_tmp" "$receipt_name" \
    "endpoint receipt" \
    || fail_contract "endpoint receipt publication collision" 73

  log=$run_root/dispatch-log.jsonl
  [ ! -L "$log" ] && { [ ! -e "$log" ] || [ -f "$log" ]; } \
    || fail_contract "dispatch log path is unsafe" 73
  log_line=$(jq -cn \
    --arg run "$run" --arg role "$role" --arg step "$step" \
    --argjson attempt "$attempt" --arg receipt "${receipt#"$run_root"/}" \
    --arg window "$actual_window" '
      {
        schema:"combo.endpoint-dispatch/v1",
        run_id:$run,role:$role,step_id:$step,attempt:$attempt,
        window_id:$window,receipt:$receipt
      }
    ')
  printf '%s\n' "$log_line" >>"$log" \
    || fail_contract "cannot append endpoint dispatch log" 73
  exit "$status"
}
# -/ 1/4

# -- 2/4 CORE · dispatch_step --
dispatch_step() {
  [ "$#" -eq 6 ] || fail_contract "invalid internal dispatch arguments"
  local run=$1 role=$2 step=$3 attempt=$4 candidate=$5 prior=$6
  local safe_step dispatch_dir jobs_dir job_name receipt_name job receipt
  local job_tmp command deadline status receipt_observation_status
  local receipt_json result wait_seconds ticks

  validate_run_root "$run" || fail_contract "unsafe dispatch run" 73
  case "$role" in launcher|coder|reviewer|gate|cleaner) ;;
    *) fail_contract "invalid dispatch role" ;;
  esac
  case "$attempt" in ''|0|0*|*[!0-9]*) fail_contract "invalid dispatch attempt" ;;
  esac
  if [ "$candidate" != null ]; then
    candidate=$(jq -cn --arg sha "$candidate" '$sha')
  fi
  jq -e '
    .==null or
    (type=="string" and test("^[0-9a-f]{40}([0-9a-f]{24})?$"))
  ' <<<"$candidate" >/dev/null 2>&1 \
    || fail_contract "invalid dispatch candidate"
  jq -e 'type=="array"' <<<"$prior" >/dev/null 2>&1 \
    || fail_contract "invalid dispatch artifacts"

  dispatch_dir=$run_root/dispatch
  jobs_dir=$dispatch_dir/jobs
  validate_dispatch_directory "$dispatch_dir" "$run_root/dispatch" \
    || fail_contract "dispatch directory is missing or unsafe" 73
  validate_dispatch_directory "$jobs_dir" "$run_root/dispatch/jobs" \
    || fail_contract "endpoint jobs directory is missing or unsafe" 73
  safe_step=${step//\//-}
  case "$safe_step" in
    ''|.*|*..*|*[!A-Za-z0-9._-]*)
    fail_contract "invalid dispatch step" ;;
  esac
  job_name=$safe_step-attempt-$attempt.job.json
  receipt_name=$safe_step-attempt-$attempt.receipt.json
  validate_bare_dispatch_name "$job_name" .job.json \
    || fail_contract "invalid endpoint job basename" 73
  validate_bare_dispatch_name "$receipt_name" .receipt.json \
    || fail_contract "invalid endpoint receipt basename" 73
  job=$jobs_dir/$job_name
  receipt=$dispatch_dir/$receipt_name
  job_tmp=.job.tmp.$$
  validate_dispatch_destination "$jobs_dir" "$job_name" .job.json \
    || fail_contract "endpoint job already exists or is unsafe" 73
  validate_dispatch_destination "$dispatch_dir" "$receipt_name" .receipt.json \
    || fail_contract "endpoint receipt already exists or is unsafe" 73

  job_json=$(jq -cn \
    --arg run "$run" --arg role "$role" --arg step "$step" \
    --argjson attempt "$attempt" --argjson candidate "$candidate" \
    --argjson prior "$prior" --arg job "$job_name" \
    --arg receipt "$receipt_name" '
      {
        schema:"combo.endpoint-job/v1",
        run_id:$run,role:$role,step_id:$step,attempt:$attempt,
        candidate_sha:$candidate,prior_artifacts:$prior,
        job_name:$job,receipt_name:$receipt
      }
    ')
  publish_text "$job_json" "$jobs_dir" "$job_tmp" "$job_name" "endpoint job" \
    || fail_contract "endpoint job publication collision" 73

  command="bash $(shell_quote "$script_path") --endpoint-job $(shell_quote "$run") $(shell_quote "$job_name")"
  CB_RUNS_DIR=$runs_dir sh "$script_dir/cb-send.sh" \
    "$run" "$role" "$command" </dev/null >/dev/null \
    || fail_contract "cannot steer $role endpoint" 75

  wait_seconds=${CB_DISPATCH_WAIT_SECONDS:-3660}
  case "$wait_seconds" in ''|*[!0-9]*)
    fail_contract "invalid CB_DISPATCH_WAIT_SECONDS" ;;
  esac
  deadline=$((SECONDS + wait_seconds))
  ticks=0
  while :; do
    if observe_endpoint_receipt "$receipt" "$dispatch_dir/$receipt_name"; then
      break
    else
      receipt_observation_status=$?
    fi
    [ "$receipt_observation_status" -eq 1 ] \
      || fail_contract "endpoint receipt path became unsafe" 73
    if [ "$SECONDS" -ge "$deadline" ]; then
      if observe_endpoint_receipt "$receipt" "$dispatch_dir/$receipt_name"; then
        break
      else
        receipt_observation_status=$?
      fi
      [ "$receipt_observation_status" -eq 1 ] \
        || fail_contract "endpoint receipt path became unsafe" 73
      fail_contract "endpoint receipt timeout for $step" 75
    fi
    ticks=$((ticks + 1))
    if [ $((ticks % 10)) -eq 0 ]; then
      if CB_RUNS_DIR=$runs_dir \
        sh -c '. "$1/cb-tmux.sh"; cb_tmux_resolve_agent "$2" "$3" "$4" >/dev/null' \
        sh "$script_dir" "$run" "$role" "$runs_dir" </dev/null; then
        :
      else
        if observe_endpoint_receipt \
          "$receipt" "$dispatch_dir/$receipt_name"; then
          break
        else
          receipt_observation_status=$?
        fi
        [ "$receipt_observation_status" -eq 1 ] \
          || fail_contract "endpoint receipt path became unsafe" 73
        fail_contract "$role endpoint died before receipt" 75
      fi
    fi
    sleep 0.5
  done
  [ -f "$receipt" ] && [ ! -L "$receipt" ] \
    || fail_contract "endpoint receipt is unsafe" 73
  [ "$(realpath "$receipt" 2>/dev/null)" = "$receipt" ] \
    || fail_contract "endpoint receipt path must be canonical" 73
  receipt_json=$(jq -c '.' "$receipt" 2>/dev/null) \
    || fail_contract "invalid endpoint receipt" 73
  if ! printf '%s\n' "$receipt_json" | jq -e \
    --arg run "$run" --arg role "$role" --arg step "$step" \
    --argjson attempt "$attempt" --arg job "$job" '
      .schema=="combo.endpoint-receipt/v1" and
      .run_id==$run and .role==$role and .step_id==$step and
      .attempt==$attempt and .job_path==$job and
      (.status|type=="number" and floor==. and .>=0) and
      (.window_id|type=="string" and startswith("@")) and
      (.pane_id|type=="string" and startswith("%")) and
      (.result_path|type=="string")
    ' >/dev/null 2>&1; then
    fail_contract "endpoint receipt disagrees with dispatch" 73
  fi
  status=$(printf '%s\n' "$receipt_json" | jq -r '.status')
  [ "$status" -eq 0 ] || return "$status"
  result=$(printf '%s\n' "$receipt_json" | jq -r '.result_path')
  [ -n "$result" ] || fail_contract "successful endpoint omitted result" 73
  printf '%s\n' "$result"
}
# -/ 2/4

if [ "${1:-}" = --endpoint-job ]; then
  [ "$#" -eq 3 ] || usage
  run_endpoint_job "$2" "$3"
fi
if [ "${1:-}" = --dispatch ]; then
  shift
  dispatch_step "$@"
  exit $?
fi

# -- 3/4 CORE · mount_endpoints --
mount_endpoints() {
  local run=$1 role mode target
  for role in launcher coder reviewer gate cleaner; do
    case "$role" in coder|reviewer) mode=tui ;; *) mode=shell ;; esac
    if target=$(
      CB_RUNS_DIR=$runs_dir \
        sh -c '. "$1/cb-tmux.sh"; cb_tmux_resolve_agent "$2" "$3" "$4"' \
        sh "$script_dir" "$run" "$role" "$runs_dir" </dev/null 2>/dev/null
    ); then
      [ -n "$target" ] \
        || fail_contract "resolved $role endpoint has no target" 73
      continue
    fi
    CB_RUNS_DIR=$runs_dir sh "$script_dir/cb-agent-spawn.sh" \
      "$run" "$role" --mode "$mode" --cwd "$run_root" \
      </dev/null >/dev/null \
      || fail_contract "cannot create $role endpoint" 75
  done
  for role in launcher coder reviewer gate cleaner; do
    CB_RUNS_DIR=$runs_dir \
      sh -c '. "$1/cb-tmux.sh"; cb_tmux_resolve_agent "$2" "$3" "$4" >/dev/null' \
      sh "$script_dir" "$run" "$role" "$runs_dir" </dev/null \
      || fail_contract "$role endpoint is not live" 75
  done
}
# -/ 3/4

# -- 4/4 CORE · Mount, drive or replay, and print one terminal truth --
result_exit_status() {
  local result=$1 cleanup_exit terminal_exit cleanup_code terminal_code
  cleanup_exit=$(jq -r '.cleanup.exit_class' "$result")
  terminal_exit=$(jq -r '.exit_class' "$result")
  cleanup_code=$(jq -r '.cleanup.code // empty' "$result")
  terminal_code=$(jq -r '.terminal.code // empty' "$result")
  case "$cleanup_exit" in completed|cancelled|technical_error) ;;
    *) return 70 ;;
  esac
  case "$terminal_exit" in completed|cancelled|technical_error) ;;
    *) return 70 ;;
  esac
  if [ "$cleanup_exit" = cancelled ]; then
    return 130
  elif [ "$cleanup_exit" = technical_error ]; then
    return 70
  elif [ "$terminal_exit" = cancelled ]; then
    return 130
  elif [ "$terminal_exit" = technical_error ]; then
    return 70
  elif [ "$cleanup_code" = 1 ] || [ "$terminal_code" = 1 ]; then
    return 1
  fi
  return 0
}

trusted_gate_terminal_outcome() {
  local result=$1 terminal_rel terminal mode identity fd_inode
  local terminal_json identity_after normalized candidate
  terminal_rel=$(jq -r '
    [(.artifacts // [])[] | select(.id=="gate-terminal") | .path] |
    if length==1 then .[0] else "" end
  ' "$result" 2>/dev/null) || return 1
  [ "$terminal_rel" = artifacts/gate/terminal.json ] || return 1
  terminal=$run_root/$terminal_rel
  [ "$terminal" = "$run_root/artifacts/gate/terminal.json" ] || return 1
  [ -f "$terminal" ] && [ ! -L "$terminal" ] || return 1
  [ "$(realpath "$terminal" 2>/dev/null)" = "$terminal" ] || return 1
  mode=$(stat -c '%a' "$terminal" 2>/dev/null \
    || stat -f '%Lp' "$terminal" 2>/dev/null || true)
  [ "$mode" = 444 ] || return 1
  identity=$(file_identity "$terminal") || return 1
  exec 7<"$terminal" || return 1
  fd_inode=$(file_inode /dev/fd/7) || {
    exec 7>&-
    return 1
  }
  [ "$fd_inode" = "${identity#*:}" ] || {
    exec 7>&-
    return 1
  }
  if terminal_json=$(jq -cS '.' /dev/fd/7 2>/dev/null); then
    :
  else
    exec 7>&-
    return 1
  fi
  exec 7>&- || return 1
  identity_after=$(file_identity "$terminal") || return 1
  [ "$identity_after" = "$identity" ] || return 1
  [ ! -L "$terminal" ] \
    && [ "$(realpath "$terminal" 2>/dev/null)" = "$terminal" ] \
    || return 1
  candidate=$(jq -r '.candidate_sha // empty' "$result" 2>/dev/null) \
    || return 1
  if ! jq -e --arg run "$run" --arg candidate "$candidate" '
    def text:
      type=="string" and length>0 and
      (explode | all(.[]; .>=32 and .!=127));
    . as $terminal |
    type=="object" and
    keys==[
      "branch","candidate_sha","invocation","lease","merge",
      "no_mistakes","normalized_outcome","result","run_id","schema","worktree"
    ] and
    .schema=="combo.gate-terminal/v3" and .run_id==$run and
    .candidate_sha==$candidate and (.branch|text) and
    (.worktree|text and startswith("/")) and
    .invocation=="artifacts/gate/invocation.json" and
    (.lease |
      type=="string" and
      test("^artifacts/gate/no-mistakes-lease-attempt-[1-9][0-9]*\\.json$")) and
    (.normalized_outcome=="validated" or .normalized_outcome=="merged") and
    (.merge |
      type=="object" and keys==["arm","mode","outcome"] and
      ((.mode=="manual" and $terminal.normalized_outcome=="validated" and
        .arm=="" and .outcome=="") or
       (.mode=="auto" and $terminal.normalized_outcome=="merged" and
        (.arm|text) and (.outcome|text)))) and
    (.no_mistakes |
      type=="object" and keys==["outcome","pr","receipt","run_id"] and
      (.run_id|text) and
      (.outcome=="passed" or .outcome=="checks-passed") and
      (.pr|text) and
      (.receipt |
        type=="string" and
        test("^artifacts/gate/no-mistakes-attempt-[1-9][0-9]*\\.toon$"))) and
    (.result |
      type=="object" and
      keys==["errors","events","exit_class","reasons"] and
      .exit_class=="completed" and .reasons==[] and .errors==[] and
      (.events|type=="array" and length==1) and
      (.events[0] |
        type=="object" and keys==["code","event","payload"] and
        .code==0 and .event=="gate_ok" and
        (.payload |
          type=="object" and
          (keys==["outcome","pr","sha"] or keys==["outcome","sha"]) and
          .outcome==$terminal.normalized_outcome and .sha==$candidate and
          ((has("pr") | not) or .pr==$terminal.no_mistakes.pr))))
  ' <<<"$terminal_json" >/dev/null 2>&1; then
    return 1
  fi
  normalized=$(jq -r '.normalized_outcome' <<<"$terminal_json") || return 1
  printf '%s\n' "$normalized"
}

print_terminal_outcome() {
  local result=$1 normalized
  if normalized=$(trusted_gate_terminal_outcome "$result"); then
    case "$normalized" in
      merged|validated)
        printf '%s\n' "$normalized"
        return 0
        ;;
    esac
  fi
  printf 'failed\n'
  return 1
}

[ "$#" -eq 1 ] || usage
run=$1
validate_run_root "$run" || fail_contract "run directory is missing or unsafe" 73
plan=$run_root/plan.json
[ -f "$plan" ] && [ ! -L "$plan" ] \
  || fail_contract "compiled plan is missing or unsafe" 73
[ "$(realpath "$plan" 2>/dev/null)" = "$run_root/plan.json" ] \
  || fail_contract "compiled plan path must be canonical" 73
jq -e --arg run "$run" '.schema=="combo.run-plan/v1" and .run_id==$run' \
  "$plan" >/dev/null 2>&1 \
  || fail_contract "compiled plan is invalid"

dispatch_dir=$run_root/dispatch
jobs_dir=$dispatch_dir/jobs
if [ ! -e "$dispatch_dir" ] && [ ! -L "$dispatch_dir" ]; then
  mkdir "$dispatch_dir" || fail_contract "cannot create dispatch directory" 73
fi
[ -d "$dispatch_dir" ] && [ ! -L "$dispatch_dir" ] \
  || fail_contract "dispatch directory is unsafe" 73
if [ ! -e "$jobs_dir" ] && [ ! -L "$jobs_dir" ]; then
  mkdir "$jobs_dir" || fail_contract "cannot create jobs directory" 73
fi
[ -d "$jobs_dir" ] && [ ! -L "$jobs_dir" ] \
  || fail_contract "jobs directory is unsafe" 73

mount_endpoints "$run"
chain_result=$run_root/chain-result.json
if [ ! -e "$chain_result" ] && [ ! -L "$chain_result" ]; then
  set +e
  chain_output=$(
    CB_CHAIN_DISPATCHER="$script_path" \
      bash "$script_dir/cb-chain.sh" "$run" </dev/null
  )
  chain_status=$?
  set -e
  if [ "$chain_status" -eq 130 ] \
    && [ ! -e "$chain_result" ] && [ ! -L "$chain_result" ]; then
    exit 130
  fi
  [ "$chain_output" = "$chain_result" ] \
    || fail_contract "chain did not publish the canonical result" 73
else
  chain_status=0
fi

[ -f "$chain_result" ] && [ ! -L "$chain_result" ] \
  || fail_contract "chain result is missing or unsafe" 73
if ! jq -e --arg run "$run" '
  .schema=="combo.chain-result/v1" and .run_id==$run and
  (.terminal|type=="object") and (.cleanup|type=="object")
' "$chain_result" >/dev/null 2>&1; then
  fail_contract "invalid chain result" 73
fi
set +e
print_terminal_outcome "$chain_result"
outcome_status=$?
result_exit_status "$chain_result"
chain_status=$?
set -e
if [ "$chain_status" -eq 0 ] && [ "$outcome_status" -ne 0 ]; then
  chain_status=70
fi
exit "$chain_status"
# -/ 4/4
