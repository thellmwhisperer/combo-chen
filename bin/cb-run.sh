#!/usr/bin/env bash
# @overview Top-level Combo v1 Bash dispatcher. It mounts five canonical tmux
#   endpoints, dispatches each cb-step invocation through the owning visible
#   window, resumes collision-free attempts, and prints one truthful terminal
#   outcome while cb-chain.sh remains the sole product state machine.
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
#   usage, fail_contract, validate_run_root, publish_text, shell_quote,
#   run_endpoint_job, dispatch_step, mount_endpoints, result_exit_status,
#   print_terminal_outcome
#
# @exports none
# @deps bash, jq, realpath, tmux, bin/cb-agent-spawn.sh, bin/cb-send.sh,
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

script_dir=$(CDPATH='' cd -- "$(dirname "${BASH_SOURCE[0]}")" && pwd)
script_path=$script_dir/cb-run.sh
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

publish_text() {
  local text=$1 staging=$2 target=$3 label=$4
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
  local job=$1 run role step attempt candidate prior receipt receipt_tmp
  local meta expected_window actual_window pane_id result_path status
  local completed event log log_line

  [ -n "${TMUX_PANE:-}" ] \
    || fail_contract "endpoint job is not running inside tmux" 73
  [ -f "$job" ] && [ ! -L "$job" ] \
    || fail_contract "endpoint job is missing or unsafe" 73
  [ "$(realpath "$job" 2>/dev/null)" = "$job" ] \
    || fail_contract "endpoint job path must be canonical" 73
  run=$(jq -r '.run_id' "$job" 2>/dev/null || true)
  validate_run_root "$run" \
    || fail_contract "endpoint job run directory is unsafe" 73
  case "$job" in "$run_root"/dispatch/jobs/*.json) ;;
    *) fail_contract "endpoint job escapes dispatch directory" 73 ;;
  esac
  if ! jq -e --arg run "$run" --arg job "$job" '
    def sha:
      type=="string" and test("^[0-9a-f]{40}([0-9a-f]{24})?$");
    type=="object" and
    keys==[
      "attempt","candidate_sha","job_path","prior_artifacts","receipt_path",
      "role","run_id","schema","step_id"
    ] and
    .schema=="combo.endpoint-job/v1" and .run_id==$run and .job_path==$job and
    (.role=="launcher" or .role=="coder" or .role=="reviewer" or
      .role=="gate" or .role=="cleaner") and
    (.step_id|type=="string" and length>0) and
    (.attempt|type=="number" and floor==. and .>0) and
    (.candidate_sha==null or (.candidate_sha|sha)) and
    (.prior_artifacts|type=="array") and
    (.receipt_path|type=="string" and length>0)
  ' "$job" >/dev/null 2>&1; then
    fail_contract "invalid endpoint job" 73
  fi

  role=$(jq -r '.role' "$job")
  step=$(jq -r '.step_id' "$job")
  attempt=$(jq -r '.attempt' "$job")
  candidate=$(jq -c '.candidate_sha' "$job")
  prior=$(jq -c '.prior_artifacts' "$job")
  receipt=$(jq -r '.receipt_path' "$job")
  case "$receipt" in "$run_root"/dispatch/*.receipt.json) ;;
    *) fail_contract "endpoint receipt escapes dispatch directory" 73 ;;
  esac
  [ ! -e "$receipt" ] && [ ! -L "$receipt" ] \
    || fail_contract "endpoint receipt already exists" 73

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
    step_args+=(--candidate-sha "$(jq -r '.candidate_sha' "$job")")
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
  receipt_tmp=$run_root/dispatch/.receipt.tmp.$$
  publish_text "$event" "$receipt_tmp" "$receipt" "endpoint receipt" \
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
  local safe_step dispatch_dir job receipt job_tmp command deadline status
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
  [ -d "$dispatch_dir" ] && [ ! -L "$dispatch_dir" ] \
    || fail_contract "dispatch directory is missing or unsafe" 73
  [ "$(realpath "$dispatch_dir" 2>/dev/null)" = "$run_root/dispatch" ] \
    || fail_contract "dispatch directory escapes run" 73
  safe_step=${step//\//-}
  case "$safe_step" in ''|*[!A-Za-z0-9._-]*)
    fail_contract "invalid dispatch step" ;;
  esac
  job=$dispatch_dir/jobs/$safe_step-attempt-$attempt.json
  receipt=$dispatch_dir/$safe_step-attempt-$attempt.receipt.json
  job_tmp=$dispatch_dir/jobs/.job.tmp.$$
  [ ! -e "$job" ] && [ ! -L "$job" ] \
    || fail_contract "endpoint job already exists" 73
  [ ! -e "$receipt" ] && [ ! -L "$receipt" ] \
    || fail_contract "endpoint receipt already exists" 73

  job_json=$(jq -cn \
    --arg run "$run" --arg role "$role" --arg step "$step" \
    --argjson attempt "$attempt" --argjson candidate "$candidate" \
    --argjson prior "$prior" --arg job "$job" --arg receipt "$receipt" '
      {
        schema:"combo.endpoint-job/v1",
        run_id:$run,role:$role,step_id:$step,attempt:$attempt,
        candidate_sha:$candidate,prior_artifacts:$prior,
        job_path:$job,receipt_path:$receipt
      }
    ')
  publish_text "$job_json" "$job_tmp" "$job" "endpoint job" \
    || fail_contract "endpoint job publication collision" 73

  command="bash $(shell_quote "$script_path") --endpoint-job $(shell_quote "$job")"
  CB_RUNS_DIR=$runs_dir sh "$script_dir/cb-send.sh" \
    "$run" "$role" "$command" </dev/null >/dev/null \
    || fail_contract "cannot steer $role endpoint" 75

  wait_seconds=${CB_DISPATCH_WAIT_SECONDS:-3660}
  case "$wait_seconds" in ''|*[!0-9]*)
    fail_contract "invalid CB_DISPATCH_WAIT_SECONDS" ;;
  esac
  deadline=$((SECONDS + wait_seconds))
  ticks=0
  while [ ! -e "$receipt" ]; do
    [ ! -L "$receipt" ] \
      || fail_contract "endpoint receipt path became unsafe" 73
    [ "$SECONDS" -lt "$deadline" ] \
      || fail_contract "endpoint receipt timeout for $step" 75
    ticks=$((ticks + 1))
    if [ $((ticks % 10)) -eq 0 ]; then
      CB_RUNS_DIR=$runs_dir \
        sh -c '. "$1/cb-tmux.sh"; cb_tmux_resolve_agent "$2" "$3" "$4" >/dev/null' \
        sh "$script_dir" "$run" "$role" "$runs_dir" \
        || fail_contract "$role endpoint died before receipt" 75
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
  [ "$#" -eq 2 ] || usage
  run_endpoint_job "$2"
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
        sh "$script_dir" "$run" "$role" "$runs_dir" 2>/dev/null
    ); then
      [ -n "$target" ] \
        || fail_contract "resolved $role endpoint has no target" 73
      continue
    fi
    CB_RUNS_DIR=$runs_dir sh "$script_dir/cb-agent-spawn.sh" \
      "$run" "$role" --mode "$mode" --cwd "$run_root" >/dev/null \
      || fail_contract "cannot create $role endpoint" 75
  done
  for role in launcher coder reviewer gate cleaner; do
    CB_RUNS_DIR=$runs_dir \
      sh -c '. "$1/cb-tmux.sh"; cb_tmux_resolve_agent "$2" "$3" "$4" >/dev/null' \
      sh "$script_dir" "$run" "$role" "$runs_dir" \
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

print_terminal_outcome() {
  local result=$1 terminal_rel terminal normalized
  terminal_rel=$(jq -r '
    [(.artifacts // [])[] | select(.id=="gate-terminal") | .path] |
    if length==1 then .[0] else "" end
  ' "$result" 2>/dev/null || true)
  if [ -n "$terminal_rel" ]; then
    terminal=$run_root/$terminal_rel
    if [ -f "$terminal" ] && [ ! -L "$terminal" ]; then
      normalized=$(jq -r '.normalized_outcome // empty' \
        "$terminal" 2>/dev/null || true)
      case "$normalized" in
        merged|validated)
          printf '%s\n' "$normalized"
          return 0
          ;;
      esac
    fi
  fi
  printf 'failed\n'
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
print_terminal_outcome "$chain_result"
set +e
result_exit_status "$chain_result"
chain_status=$?
set -e
exit "$chain_status"
# -/ 4/4
