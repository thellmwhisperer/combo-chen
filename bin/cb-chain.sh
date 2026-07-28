#!/usr/bin/env bash
# @overview Execute one immutable Combo run plan as a provider-neutral state
#   machine. Decisions use only validated step exit classes and product events;
#   adapter stdout/stderr and tool-specific behavior never enter routing.
#
#   READING GUIDE
#   -------------
#   1. Plan validation and publication guard <- freeze the traversal boundary.
#   2. invoke_step and fold helpers           <- endpoint-backed adapter interaction.
#   3. Coder/Reviewer loop                    <- same-input full-round fold.
#   4. Gate, Cleaner, and result publication  <- preserve terminal + cleanup.
#
#   MAIN FLOW
#   ---------
#   plan -> role endpoints -> Launcher -> Coder <-> Reviewer* -> Gate -> Cleaner
#
#   PUBLIC API
#   ----------
#   cb-chain.sh <runId>  Execute the plan and print immutable result path.
#
#   INTERNALS
#   ---------
#   usage, fail_contract, resolve_effective_attempt, invoke_step,
#   merge_result_artifacts,
#   add_findings_artifact, record_reviewer_failure, set_terminal_from_result,
#   set_invocation_failure, cleanup
#
# @exports none
# @deps bash, jq, realpath, bin/cb-step.sh, optional bin/cb-run.sh dispatcher
set -euo pipefail

usage() {
  echo "usage: cb-chain <runId>" >&2
  exit 64
}

fail_contract() {
  echo "cb-chain: $1" >&2
  exit "${2:-64}"
}

[ "$#" -eq 1 ] || usage
run=$1
case "$run" in ''|-*|*[!a-z0-9-]*) usage ;; esac
command -v jq >/dev/null 2>&1 || fail_contract "jq is required" 73
command -v realpath >/dev/null 2>&1 || fail_contract "realpath is required" 73

# -- 1/4 CORE · Validate plan shape and reserve one chain result -- <- START HERE
runs_dir=${CB_RUNS_DIR:-"$HOME/.combo-chen/runs"}
run_dir=$runs_dir/$run
plan=$run_dir/plan.json
[ -d "$runs_dir" ] && [ ! -L "$runs_dir" ] \
  || fail_contract "runs directory is missing or unsafe" 73
[ -d "$run_dir" ] && [ ! -L "$run_dir" ] \
  || fail_contract "run directory is missing or unsafe" 73
runs_root=$(realpath "$runs_dir" 2>/dev/null) \
  || fail_contract "cannot resolve runs directory" 73
run_root=$(realpath "$run_dir" 2>/dev/null) \
  || fail_contract "cannot resolve run directory" 73
case "$run_root" in "$runs_root"/"$run") ;; *) fail_contract "run directory escapes runs root" 73 ;; esac
[ -f "$plan" ] && [ ! -L "$plan" ] \
  || fail_contract "plan is missing or unsafe" 73
[ "$(realpath "$plan" 2>/dev/null)" = "$run_root/plan.json" ] \
  || fail_contract "plan escapes run directory" 73

if ! jq -e --arg run "$run" --arg root "$run_root" '
  type=="object" and
  keys==["paths","reviewer","reviewer_count","run_id","schema","steps"] and
  .schema=="combo.run-plan/v1" and .run_id==$run and
  .paths=={
    run_dir:$root,
    artifacts_dir:($root+"/artifacts"),
    steps_dir:($root+"/steps")
  } and
  (.reviewer|type=="object" and keys==["degraded"] and
    (.degraded=="fail" or .degraded=="skip")) and
  (.reviewer_count|type=="number" and floor==. and .>=0) and
  (.steps|type=="array") and
  ([.steps[] | select(.role=="reviewer")] | length)==.reviewer_count and
  ([.steps[].role] ==
    (["launcher","coder"] +
     ([range(0;.reviewer_count)] | map("reviewer")) +
     ["gate","cleaner"])) and
  .steps[0].id=="launcher" and .steps[1].id=="coder" and
  .steps[-2].id=="gate" and .steps[-1].id=="cleaner" and
  all(.steps[2:-2][]; .id|startswith("reviewer/"))
' "$plan" >/dev/null 2>&1; then
  fail_contract "plan does not satisfy the frozen state-machine order"
fi

chain_result=$run_root/chain-result.json
chain_tmp=$run_root/.chain-result.json.tmp.$$
if [ -e "$chain_result" ] || [ -L "$chain_result" ]; then
  fail_contract "chain result already exists: $chain_result" 73
fi
if [ -e "$chain_tmp" ] || [ -L "$chain_tmp" ]; then
  fail_contract "chain result staging path already exists" 73
fi
chain_tmp_owned=0
cleanup() {
  [ "$chain_tmp_owned" -eq 0 ] || rm -f "$chain_tmp"
}
trap cleanup 0
trap 'exit 130' 1 2 15

script_dir=$(CDPATH='' cd -- "$(dirname "${BASH_SOURCE[0]}")" && pwd)
step_runner=$script_dir/cb-step.sh
[ -f "$step_runner" ] && [ ! -L "$step_runner" ] \
  || fail_contract "step runner is missing or unsafe" 73
dispatcher=${CB_CHAIN_DISPATCHER:-}
if [ -n "$dispatcher" ]; then
  case "$dispatcher" in /*) ;; *)
    fail_contract "endpoint dispatcher path must be absolute" 73 ;;
  esac
  [ -f "$dispatcher" ] && [ ! -L "$dispatcher" ] && [ -x "$dispatcher" ] \
    || fail_contract "endpoint dispatcher is missing or unsafe" 73
  [ "$(realpath "$dispatcher" 2>/dev/null)" = "$dispatcher" ] \
    || fail_contract "endpoint dispatcher path must be canonical" 73
fi

max_rounds=${CB_CHAIN_MAX_REVIEW_ROUNDS:-20}
case "$max_rounds" in ''|0|0*|*[!0-9]*) fail_contract "invalid max review rounds" ;; esac
prior_artifacts='[]'
candidate_sha=null
last_result=
last_step_status=0
reviewer_degraded=$(jq -r '.reviewer.degraded' "$plan")
reviewer_member_failures='[]'
# -/ 1/4

# -- 2/4 HELPER · Invoke endpoint-backed steps and carry artifact references --
resolve_effective_attempt() {
  local step=$1 requested=$2 step_index ordinal safe_step step_dir effective
  if [ -z "$dispatcher" ]; then
    printf '%s\n' "$requested"
    return 0
  fi
  step_index=$(jq -r --arg id "$step" '
    [.steps | to_entries[] | select(.value.id==$id) | .key] |
    if length==1 then .[0] else empty end
  ' "$plan")
  [ -n "$step_index" ] || return 1
  printf -v ordinal '%02d' "$((step_index + 1))"
  safe_step=${step//\//-}
  step_dir=$run_root/steps/$ordinal-$safe_step
  effective=$requested
  while [ -e "$step_dir/attempt-$effective" ] \
    || [ -L "$step_dir/attempt-$effective" ] \
    || [ -e "$run_root/dispatch/jobs/$safe_step-attempt-$effective.job.json" ] \
    || [ -L "$run_root/dispatch/jobs/$safe_step-attempt-$effective.job.json" ] \
    || [ -e "$run_root/dispatch/$safe_step-attempt-$effective.receipt.json" ] \
    || [ -L "$run_root/dispatch/$safe_step-attempt-$effective.receipt.json" ]; do
    effective=$((effective + 1))
  done
  printf '%s\n' "$effective"
}

invoke_step() {
  local step=$1 attempt=$2 candidate=$3
  local output status expected_root effective_attempt endpoint_role
  effective_attempt=$(resolve_effective_attempt "$step" "$attempt") \
    || { last_step_status=65; return 1; }
  local -a args=("$run" "$step" "$effective_attempt")
  if [ "$candidate" != null ]; then
    args+=(--candidate-sha "$candidate")
  fi
  args+=(--prior-artifacts "$prior_artifacts")

  set +e
  if [ -n "$dispatcher" ]; then
    endpoint_role=$(jq -r --arg id "$step" '
      .steps[] | select(.id==$id) | .role
    ' "$plan")
    output=$(
      "$dispatcher" --dispatch "$run" "$endpoint_role" "$step" \
        "$effective_attempt" "$candidate" "$prior_artifacts" </dev/null
    )
  else
    output=$(bash "$step_runner" "${args[@]}" </dev/null)
  fi
  status=$?
  set -e
  last_step_status=$status
  last_result=
  [ "$status" -eq 0 ] || return 1
  case "$output" in *$'\n'*|'') last_step_status=65; return 1 ;; esac
  if [ ! -f "$output" ] || [ -L "$output" ]; then
    last_step_status=65
    return 1
  fi
  expected_root=$run_root/steps/
  case "$(realpath "$output" 2>/dev/null || true)" in
    "$expected_root"*/result.json) ;;
    *) last_step_status=65; return 1 ;;
  esac
  if ! jq -e \
    --arg run "$run" --arg step "$step" \
    --argjson attempt "$effective_attempt" '
      .schema=="combo.step-output/v1" and .run_id==$run and
      .step_id==$step and .attempt==$attempt
    ' "$output" >/dev/null 2>&1; then
    last_step_status=65
    return 1
  fi
  last_result=$output
}

merge_result_artifacts() {
  local fresh
  fresh=$(jq -c '.artifacts' "$last_result")
  prior_artifacts=$(jq -cn \
    --argjson prior "$prior_artifacts" --argjson fresh "$fresh" '
      reduce ($prior + $fresh)[] as $artifact
        ({}; .[$artifact.id]=$artifact) |
      to_entries | sort_by(.key) | map(.value)
    ')
}

add_findings_artifact() {
  local member=$1 round=$2 path present id
  path=$(jq -r '.events[0].payload.artifact' "$last_result")
  present=$(jq -r --arg path "$path" \
    'any(.[]; .path==$path)' <<<"$prior_artifacts")
  [ "$present" = true ] && return 0
  id=review-"$member"-round-"$round"
  prior_artifacts=$(jq -cn \
    --argjson prior "$prior_artifacts" --arg id "$id" --arg path "$path" '
      ($prior + [{id:$id,path:$path}]) | sort_by(.id)
    ')
}

record_reviewer_failure() {
  local member=$1 round=$2 skipped errors
  errors=$(jq -c '.errors' "$last_result")
  if [ "$reviewer_degraded" = skip ]; then
    skipped=true
  else
    skipped=false
  fi
  reviewer_member_failures=$(jq -cn \
    --argjson failures "$reviewer_member_failures" \
    --arg member "$member" --argjson round "$round" \
    --arg sha "$candidate_sha" --argjson skipped "$skipped" \
    --argjson errors "$errors" '
      $failures + [{
        member:$member,
        round:$round,
        sha:$sha,
        skipped:$skipped,
        errors:$errors
      }]
    ')
}

terminal_exit_class=technical_error
terminal_role=chain
terminal_code=null
terminal_event=null
terminal_reasons='[]'
terminal_errors='[]'

set_terminal_from_result() {
  local role=$1 event
  terminal_role=$role
  terminal_exit_class=$(jq -r '.exit_class' "$last_result")
  terminal_reasons=$(jq -c '.reasons' "$last_result")
  terminal_errors=$(jq -c '.errors' "$last_result")
  terminal_code=null
  terminal_event=null
  if [ "$terminal_exit_class" = completed ]; then
    terminal_code=$(jq -r '.events[0].code' "$last_result")
    event=$(jq -r '.events[0].event' "$last_result")
    terminal_event=$(jq -cn --arg event "$event" '$event')
    case "$role:$event" in
      launcher:launch_not_ready)
        terminal_reasons=$(jq -c '.events[0].payload.reasons' "$last_result")
        ;;
      coder:coder_not_ready)
        terminal_errors=$(jq -c '.events[0].payload.errors' "$last_result")
        ;;
      gate:gate_failed)
        terminal_reasons=$(jq -c '[.events[0].payload.reason]' "$last_result")
        ;;
    esac
  fi
}

set_invocation_failure() {
  terminal_exit_class=technical_error
  terminal_role=$1
  terminal_code=null
  terminal_event=null
  terminal_reasons='[]'
  terminal_errors=$(jq -cn --arg status "$last_step_status" \
    '["chain_step_exit:" + $status]')
}
# -/ 2/4

# -- 3/4 CORE · Traverse Launcher, Coder, and complete Reviewer rounds --
terminal_set=0
if invoke_step launcher 1 null; then
  merge_result_artifacts
  launcher_class=$(jq -r '.exit_class' "$last_result")
  launcher_code=$(jq -r '.events[0].code // empty' "$last_result")
  if [ "$launcher_class" != completed ] || [ "$launcher_code" != 0 ]; then
    set_terminal_from_result launcher
    terminal_set=1
  fi
else
  set_invocation_failure launcher
  terminal_set=1
fi
if [ "$terminal_set" -eq 0 ] \
  && [ "${CB_CHAIN_STOP_AFTER_ROLE:-}" = launcher ]; then
  exit 130
fi

coder_attempt=0
review_round=0
while [ "$terminal_set" -eq 0 ]; do
  coder_attempt=$((coder_attempt + 1))
  if invoke_step coder "$coder_attempt" "$candidate_sha"; then
    merge_result_artifacts
    coder_class=$(jq -r '.exit_class' "$last_result")
    coder_code=$(jq -r '.events[0].code // empty' "$last_result")
    if [ "$coder_class" != completed ] || [ "$coder_code" != 0 ]; then
      set_terminal_from_result coder
      terminal_set=1
      break
    fi
    candidate_sha=$(jq -r '.events[0].payload.sha' "$last_result")
  else
    set_invocation_failure coder
    terminal_set=1
    break
  fi

  review_round=$((review_round + 1))
  needs_change=0
  review_hard_failure=0
  review_input_artifacts=$prior_artifacts
  review_aggregate_artifacts=$prior_artifacts
  while IFS= read -r reviewer_step; do
    [ -n "$reviewer_step" ] || continue
    member=${reviewer_step#reviewer/}
    prior_artifacts=$review_input_artifacts
    if invoke_step "$reviewer_step" "$review_round" "$candidate_sha"; then
      prior_artifacts=$review_aggregate_artifacts
      merge_result_artifacts
      reviewer_class=$(jq -r '.exit_class' "$last_result")
      if [ "$reviewer_class" != completed ]; then
        review_aggregate_artifacts=$prior_artifacts
        if [ "$reviewer_class" = technical_error ]; then
          record_reviewer_failure "$member" "$review_round"
          if [ "$reviewer_degraded" = fail ]; then
            review_hard_failure=1
          fi
          continue
        fi
        set_terminal_from_result reviewer
        terminal_set=1
        break
      fi
      reviewer_event=$(jq -r '.events[0].event' "$last_result")
      case "$reviewer_event" in
        lgtm) ;;
        needs_change)
          needs_change=1
          add_findings_artifact "$member" "$review_round"
          ;;
      esac
      review_aggregate_artifacts=$prior_artifacts
    else
      prior_artifacts=$review_aggregate_artifacts
      set_invocation_failure reviewer
      terminal_set=1
      break
    fi
  done < <(jq -r '.steps[] | select(.role=="reviewer") | .id' "$plan")
  prior_artifacts=$review_aggregate_artifacts
  [ "$terminal_set" -eq 0 ] || break
  if [ "$review_hard_failure" -eq 1 ]; then
    terminal_exit_class=technical_error
    terminal_role=reviewer
    terminal_code=null
    terminal_event=null
    terminal_reasons='[]'
    terminal_errors=$(jq -c '
      [
        .[] |
        select(.skipped==false) |
        .member as $member |
        .errors[] |
        $member + ":" + .
      ]
    ' <<<"$reviewer_member_failures")
    terminal_set=1
    break
  fi
  [ "$needs_change" -eq 1 ] || break
  if [ "$review_round" -ge "$max_rounds" ]; then
    terminal_exit_class=technical_error
    terminal_role=reviewer
    terminal_code=null
    terminal_event=null
    terminal_reasons='[]'
    terminal_errors='["review_round_limit"]'
    terminal_set=1
    break
  fi
done
# -/ 3/4

# -- 4/4 CORE · Run Gate then Cleaner and publish both outcomes --
if [ "$terminal_set" -eq 0 ]; then
  if invoke_step gate 1 "$candidate_sha"; then
    merge_result_artifacts
    set_terminal_from_result gate
  else
    set_invocation_failure gate
  fi
  terminal_set=1
fi

cleanup_exit_class=technical_error
cleanup_code=null
cleanup_event=null
cleanup_reasons='[]'
cleanup_errors='[]'
if invoke_step cleaner 1 "$candidate_sha"; then
  merge_result_artifacts
  cleanup_exit_class=$(jq -r '.exit_class' "$last_result")
  cleanup_reasons=$(jq -c '.reasons' "$last_result")
  cleanup_errors=$(jq -c '.errors' "$last_result")
  if [ "$cleanup_exit_class" = completed ]; then
    cleanup_code=$(jq -r '.events[0].code' "$last_result")
    cleanup_event=$(jq -c '.events[0].event' "$last_result")
    if [ "$cleanup_code" -eq 1 ]; then
      cleanup_reasons=$(jq -c '.events[0].payload.reasons' "$last_result")
    fi
  fi
else
  cleanup_errors=$(jq -cn --arg status "$last_step_status" \
    '["chain_step_exit:" + $status]')
fi

set -C
if exec 3>"$chain_tmp"; then
  chain_tmp_owned=1
else
  set +C
  fail_contract "chain result staging path already exists" 73
fi
set +C
if ! jq -cn \
  --arg run "$run" \
  --arg exit_class "$terminal_exit_class" \
  --argjson candidate "$(
    if [ "$candidate_sha" = null ]; then printf 'null'; else jq -cn --arg sha "$candidate_sha" '$sha'; fi
  )" \
  --arg role "$terminal_role" \
  --argjson code "$terminal_code" \
  --argjson event "$terminal_event" \
  --argjson artifacts "$prior_artifacts" \
  --arg reviewer_degraded "$reviewer_degraded" \
  --argjson reviewer_failures "$reviewer_member_failures" \
  --argjson reasons "$terminal_reasons" \
  --argjson errors "$terminal_errors" \
  --arg cleanup_exit "$cleanup_exit_class" \
  --argjson cleanup_code "$cleanup_code" \
  --argjson cleanup_event "$cleanup_event" \
  --argjson cleanup_reasons "$cleanup_reasons" \
  --argjson cleanup_errors "$cleanup_errors" '
    {
      schema:"combo.chain-result/v1",
      run_id:$run,
      exit_class:$exit_class,
      candidate_sha:$candidate,
      terminal:{role:$role,code:$code,event:$event},
      artifacts:$artifacts,
      reviewer:{
        degraded:$reviewer_degraded,
        member_failures:$reviewer_failures
      },
      reasons:$reasons,
      errors:$errors,
      cleanup:{
        exit_class:$cleanup_exit,
        code:$cleanup_code,
        event:$cleanup_event,
        reasons:$cleanup_reasons,
        errors:$cleanup_errors
      }
    }
  ' >&3; then
  exec 3>&-
  fail_contract "cannot build chain result" 73
fi
exec 3>&-
chmod 0444 "$chain_tmp" || fail_contract "cannot make chain result read-only" 73
if ! ln "$chain_tmp" "$chain_result" 2>/dev/null; then
  fail_contract "chain result publication collision" 73
fi
rm -f "$chain_tmp"
chain_tmp_owned=0
printf '%s\n' "$chain_result"

if [ "$cleanup_exit_class" = cancelled ]; then
  exit 130
elif [ "$cleanup_exit_class" = technical_error ]; then
  exit 70
elif [ "$terminal_exit_class" = cancelled ]; then
  exit 130
elif [ "$terminal_exit_class" = technical_error ]; then
  exit 70
elif [ "$cleanup_code" = 1 ]; then
  exit 1
elif [ "$terminal_code" = 1 ]; then
  exit 1
fi
# -/ 4/4
