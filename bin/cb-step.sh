#!/usr/bin/env bash
# @overview Invoke one configured Combo adapter through the universal step
#   envelope, then publish only a validated normalized result. The boundary
#   never interprets adapter stdout/stderr and binds no tool or provider.
#
#   READING GUIDE
#   -------------
#   1. Plan and argument validation <- select one immutable configured step.
#   2. Artifact/path validation     <- contain every caller-controlled path.
#   3. Input and argv execution     <- publish input, execute array without eval.
#   4. Output normalization         <- enforce exit class and role outcome.
#
#   MAIN FLOW
#   ---------
#   run plan -> immutable input.json -> configured argv -> immutable result.json
#
#   PUBLIC API
#   ----------
#   cb-step.sh <runId> <stepId> <attempt> [options]  Print result artifact path.
#
#   INTERNALS
#   ---------
#   usage, fail_contract, ensure_dir, validate_artifact_refs,
#   validate_adapter_output, write_normalized_failure
#
# @exports none
# @deps bash, jq, realpath, timeout
set -euo pipefail

usage() {
  echo "usage: cb-step <runId> <stepId> <attempt> [--candidate-sha <sha>] [--prior-artifacts <json>]" >&2
  exit 64
}

fail_contract() {
  echo "cb-step: $1" >&2
  exit "${2:-64}"
}

[ "$#" -ge 3 ] || usage
run=$1
step_id=$2
attempt=$3
shift 3
candidate_sha=null
prior_artifacts='[]'
while [ "$#" -gt 0 ]; do
  case "$1" in
    --candidate-sha)
      [ "$#" -ge 2 ] || usage
      candidate_sha=$(jq -cn --arg value "$2" '$value')
      shift 2
      ;;
    --prior-artifacts)
      [ "$#" -ge 2 ] || usage
      prior_artifacts=$2
      shift 2
      ;;
    *) usage ;;
  esac
done

case "$run" in ''|-*|*[!a-z0-9-]*) usage ;; esac
case "$attempt" in ''|0|0*|*[!0-9]*) usage ;; esac
[ "$attempt" -gt 0 ] || usage
command -v jq >/dev/null 2>&1 || fail_contract "jq is required" 73
command -v realpath >/dev/null 2>&1 || fail_contract "realpath is required" 73
command -v timeout >/dev/null 2>&1 || fail_contract "timeout is required" 73
step_timeout=${CB_STEP_TIMEOUT_SECONDS:-3600}
kill_after=${CB_STEP_TIMEOUT_KILL_AFTER_SECONDS:-10}
case "$step_timeout" in ''|0|0*|*[!0-9]*) fail_contract "invalid step timeout" ;; esac
case "$kill_after" in ''|0|0*|*[!0-9]*) fail_contract "invalid timeout kill delay" ;; esac

# -- 1/4 CORE · Validate immutable plan and select one step -- <- START HERE
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

artifacts_dir=$run_root/artifacts
steps_dir=$run_root/steps
if ! jq -e \
  --arg run "$run" --arg root "$run_root" \
  --arg artifacts "$artifacts_dir" --arg steps "$steps_dir" '
    type=="object" and
    .schema=="combo.run-plan/v1" and .run_id==$run and
    .paths=={run_dir:$root,artifacts_dir:$artifacts,steps_dir:$steps} and
    (.steps|type=="array")
  ' "$plan" >/dev/null 2>&1; then
  fail_contract "invalid or escaped run plan"
fi

step_json=$(jq -c --arg id "$step_id" '
  [.steps[] | select(.id==$id)] |
  if length==1 then .[0] else empty end
' "$plan")
[ -n "$step_json" ] || fail_contract "step is not present in plan"
if ! jq -e '
  def valid_id: type=="string" and test("^[a-z][a-z0-9._-]*$");
  def valid_role:
    .=="launcher" or .=="coder" or .=="reviewer" or .=="gate" or .=="cleaner";
  type=="object" and
  (.id|type=="string" and length>0) and
  (.role|valid_role) and (.adapter_id|valid_id) and
  (.argv|type=="array" and length>0 and
    all(.[]; type=="string" and length>0 and index("\u0000")==null)) and
  (.config|type=="object")
' <<<"$step_json" >/dev/null 2>&1; then
  fail_contract "selected plan step is invalid"
fi

step_index=$(jq -r --arg id "$step_id" '
  [.steps | to_entries[] | select(.value.id==$id) | .key] |
  if length==1 then .[0] else empty end
' "$plan")
[ -n "$step_index" ] || fail_contract "cannot resolve step ordinal"
role=$(jq -r '.role' <<<"$step_json")
adapter_id=$(jq -r '.adapter_id' <<<"$step_json")
case "$step_id:$role" in
  launcher:launcher|coder:coder|gate:gate|cleaner:cleaner|reviewer/*:reviewer) ;;
  *) fail_contract "step id and role do not agree" ;;
esac

if ! jq -e '
  .==null or (type=="string" and test("^[0-9a-f]{40}([0-9a-f]{24})?$"))
' <<<"$candidate_sha" >/dev/null 2>&1; then
  fail_contract "candidate sha must be null or a full lowercase hash"
fi
# -/ 1/4

# -- 2/4 HELPER · Validate artifact references and contained directories --
ensure_dir() {
  local path=$1 expected=$2 label=$3
  if [ ! -e "$path" ] && [ ! -L "$path" ]; then
    mkdir "$path" 2>/dev/null || true
  fi
  [ -d "$path" ] && [ ! -L "$path" ] \
    || fail_contract "$label directory is unsafe" 73
  [ "$(realpath "$path" 2>/dev/null)" = "$expected" ] \
    || fail_contract "$label directory escapes run" 73
}

validate_artifact_path() {
  local relative=$1 absolute resolved
  case "$relative" in
    artifacts/*) ;;
    *) return 1 ;;
  esac
  case "/$relative/" in */../*|*/./*|*//*|*'
'*) return 1 ;; esac
  absolute=$run_root/$relative
  [ -f "$absolute" ] && [ ! -L "$absolute" ] || return 1
  resolved=$(realpath "$absolute" 2>/dev/null) || return 1
  case "$resolved" in "$artifacts_dir"/*) ;; *) return 1 ;; esac
}

validate_artifact_refs() {
  local refs=$1 count index path
  jq -e '
    def valid_id: type=="string" and test("^[a-z][a-z0-9._-]*$");
    def valid_path:
      type=="string" and startswith("artifacts/") and
      (explode | all(.[]; .>=32 and .!=127)) and
      (split("/") | all(.[]; length>0 and .!="." and .!=".."));
    type=="array" and
    all(.[]; type=="object" and keys==["id","path"] and
      (.id|valid_id) and (.path|valid_path)) and
    ([.[].id] | length==(unique|length))
  ' <<<"$refs" >/dev/null 2>&1 || return 1
  count=$(jq 'length' <<<"$refs")
  index=0
  while [ "$index" -lt "$count" ]; do
    path=$(jq -r --argjson index "$index" '.[$index].path' <<<"$refs")
    validate_artifact_path "$path" || return 1
    index=$((index + 1))
  done
}

if ! jq -e 'type=="array"' <<<"$prior_artifacts" >/dev/null 2>&1; then
  fail_contract "prior artifacts must be a JSON array"
fi
prior_artifacts=$(jq -c . <<<"$prior_artifacts")
if [ "$(jq 'length' <<<"$prior_artifacts")" -gt 0 ]; then
  [ -d "$artifacts_dir" ] && [ ! -L "$artifacts_dir" ] \
    || fail_contract "prior artifacts directory is missing or unsafe"
  [ "$(realpath "$artifacts_dir" 2>/dev/null)" = "$artifacts_dir" ] \
    || fail_contract "prior artifacts directory escapes run"
fi
validate_artifact_refs "$prior_artifacts" \
  || fail_contract "invalid or unsafe prior artifacts"

ensure_dir "$artifacts_dir" "$artifacts_dir" artifacts
ensure_dir "$steps_dir" "$steps_dir" steps
printf -v ordinal '%02d' "$((step_index + 1))"
safe_step=${step_id//\//-}
step_dir=$steps_dir/$ordinal-$safe_step
if [ ! -e "$step_dir" ] && [ ! -L "$step_dir" ]; then
  mkdir "$step_dir" 2>/dev/null || true
fi
[ -d "$step_dir" ] && [ ! -L "$step_dir" ] \
  || fail_contract "step directory is unsafe" 73
[ "$(realpath "$step_dir" 2>/dev/null)" = "$steps_dir/$ordinal-$safe_step" ] \
  || fail_contract "step directory escapes steps root" 73

invocation_dir=$step_dir/attempt-$attempt
if ! mkdir "$invocation_dir" 2>/dev/null; then
  fail_contract "attempt already exists or cannot be created" 73
fi
[ "$(realpath "$invocation_dir" 2>/dev/null)" = "$step_dir/attempt-$attempt" ] \
  || fail_contract "attempt directory escapes step" 73
# -/ 2/4

# -- 3/4 CORE · Publish universal input and execute configured argv --
input_path=$invocation_dir/input.json
input_tmp=$invocation_dir/.input.json.tmp
adapter_output=$invocation_dir/adapter-output.json
result_path=$invocation_dir/result.json
result_tmp=$invocation_dir/.result.json.tmp
stdout_log=$invocation_dir/stdout.log
stderr_log=$invocation_dir/stderr.log
config=$(jq -c '.config' <<<"$step_json")

jq -cn \
  --arg run "$run" --arg step "$step_id" --arg adapter "$adapter_id" \
  --arg role "$role" --argjson attempt "$attempt" \
  --arg run_dir "$run_root" --arg artifacts_dir "$artifacts_dir" \
  --arg steps_dir "$steps_dir" --arg invocation_dir "$invocation_dir" \
  --arg input_path "$input_path" --arg output_path "$adapter_output" \
  --argjson candidate "$candidate_sha" --argjson config "$config" \
  --argjson prior "$prior_artifacts" '
    {
      schema:"combo.step-input/v1",
      run_id:$run,
      step_id:$step,
      adapter_id:$adapter,
      role:$role,
      attempt:$attempt,
      paths:{
        run_dir:$run_dir,
        artifacts_dir:$artifacts_dir,
        steps_dir:$steps_dir,
        invocation_dir:$invocation_dir,
        input_path:$input_path,
        output_path:$output_path
      },
      candidate_sha:$candidate,
      config:$config,
      prior_artifacts:$prior
    }
  ' >"$input_tmp" || fail_contract "cannot build adapter input" 73
chmod 0444 "$input_tmp" || fail_contract "cannot make adapter input read-only" 73
mv "$input_tmp" "$input_path" || fail_contract "cannot publish adapter input" 73

adapter_argv=()
while IFS= read -r -d '' argument; do
  adapter_argv+=("$argument")
done < <(jq -j '.argv[] | . + "\u0000"' <<<"$step_json")
argv_expected=$(jq -r '.argv | length' <<<"$step_json") \
  || fail_contract "cannot resolve adapter argv" 73
[ "${#adapter_argv[@]}" -gt 0 ] || fail_contract "adapter argv is empty"
[ "${#adapter_argv[@]}" -eq "$argv_expected" ] \
  || fail_contract "adapter argv was truncated" 73

set +e
timeout -k "$kill_after" "$step_timeout" \
  "${adapter_argv[@]}" --input "$input_path" --output "$adapter_output" \
  >"$stdout_log" 2>"$stderr_log"
adapter_status=$?
set -e
chmod 0444 "$stdout_log" "$stderr_log" 2>/dev/null || true
# -/ 3/4

# -- 4/4 CORE · Validate normalized output or replace it with one failure --
write_normalized_failure() {
  local exit_class=$1 detail=$2 list_key=$3
  if [ "$list_key" = errors ]; then
    jq -cn \
      --arg run "$run" --arg step "$step_id" --arg role "$role" \
      --argjson attempt "$attempt" --arg detail "$detail" '
        {
          schema:"combo.step-output/v1",
          run_id:$run,step_id:$step,role:$role,attempt:$attempt,
          exit_class:"technical_error",events:[],artifacts:[],
          reasons:[],errors:[$detail]
        }
      ' >"$result_tmp"
  else
    jq -cn \
      --arg run "$run" --arg step "$step_id" --arg role "$role" \
      --argjson attempt "$attempt" --arg detail "$detail" '
        {
          schema:"combo.step-output/v1",
          run_id:$run,step_id:$step,role:$role,attempt:$attempt,
          exit_class:"cancelled",events:[],artifacts:[],
          reasons:[$detail],errors:[]
        }
      ' >"$result_tmp"
  fi
}

validate_adapter_output() {
  jq -e \
    --arg run "$run" --arg step "$step_id" --arg role "$role" \
    --argjson attempt "$attempt" --argjson candidate "$candidate_sha" '
      def strings:
        type=="array" and all(.[]; type=="string" and length>0);
      def sha:
        type=="string" and test("^[0-9a-f]{40}([0-9a-f]{24})?$");
      def artifact_path:
        type=="string" and startswith("artifacts/") and
        (explode | all(.[]; .>=32 and .!=127)) and
        (split("/") | all(.[]; length>0 and .!="." and .!=".."));
      def artifact_refs:
        type=="array" and all(.[];
          type=="object" and keys==["id","path"] and
          (.id|type=="string" and test("^[a-z][a-z0-9._-]*$")) and
          (.path|artifact_path));
      def product_event:
        type=="object" and keys==["code","event","payload"] and
        (.code==0 or .code==1) and (.event|type=="string") and
        (.payload|type=="object");
      def role_outcome:
        .events[0] as $event |
        if $role=="launcher" then
          (($event.code==0 and $event.event=="launch_ready" and
            ($event.payload.worktree|type=="string" and length>0) and
            ($event.payload.branch|type=="string" and length>0) and
            ($event.payload.base_sha|sha) and
            ($event.payload.runway_kind|type=="string" and length>0) and
            ($event.payload.lease_id|type=="string" and length>0)) or
           ($event.code==1 and $event.event=="launch_not_ready" and
            ($event.payload.reasons|strings and length>0)))
        elif $role=="coder" then
          (($event.code==0 and $event.event=="coder_ready" and
            ($event.payload.sha|sha) and
            ($event.payload.branch|type=="string" and length>0)) or
           ($event.code==1 and $event.event=="coder_not_ready" and
            ($event.payload.errors|strings and length>0)))
        elif $role=="reviewer" then
          (($event.code==0 and $event.event=="lgtm" and
            ($event.payload.sha|sha) and
            ($candidate!=null and $event.payload.sha==$candidate)) or
           ($event.code==1 and $event.event=="needs_change" and
            ($event.payload.sha|sha) and
            ($candidate!=null and $event.payload.sha==$candidate) and
            ($event.payload.artifact|artifact_path)))
        elif $role=="gate" then
          (($event.code==0 and $event.event=="gate_ok" and
            ($event.payload.outcome=="merged" or $event.payload.outcome=="validated") and
            ($event.payload.sha|sha) and
            ($candidate!=null and $event.payload.sha==$candidate)) or
           ($event.code==1 and $event.event=="gate_failed" and
            ($event.payload.reason|type=="string" and length>0)))
        elif $role=="cleaner" then
          (($event.code==0 and $event.event=="cleaned") or
           ($event.code==1 and $event.event=="clean_failed" and
            ($event.payload.reasons|strings and length>0)))
        else false end;
      type=="object" and
      keys==["artifacts","attempt","errors","events","exit_class","reasons","role","run_id","schema","step_id"] and
      .schema=="combo.step-output/v1" and
      .run_id==$run and .step_id==$step and .role==$role and .attempt==$attempt and
      (.artifacts|artifact_refs) and (.reasons|strings) and (.errors|strings) and
      if .exit_class=="completed" then
        (.events|type=="array" and length==1 and (.[]|product_event)) and
        .errors==[] and role_outcome
      elif .exit_class=="technical_error" then
        .events==[] and (.errors|length>0)
      elif .exit_class=="cancelled" then
        .events==[] and .errors==[] and (.reasons|length>0)
      else false end
    ' "$adapter_output" >/dev/null 2>&1
}

case "$result_tmp" in
  "$invocation_dir"/.result.json.tmp) ;;
  *) fail_contract "result staging path escapes invocation" 73 ;;
esac
rm -rf -- "$result_tmp" 2>/dev/null || true
if [ -e "$result_tmp" ] || [ -L "$result_tmp" ]; then
  fail_contract "adapter poisoned result staging path" 73
fi

if [ "$adapter_status" -ne 0 ]; then
  if [ "$adapter_status" -eq 124 ] || [ "$adapter_status" -eq 137 ]; then
    write_normalized_failure cancelled "adapter_timeout:$step_timeout" reasons
  elif [ "$adapter_status" -eq 130 ] || [ "$adapter_status" -eq 143 ]; then
    write_normalized_failure cancelled "adapter_exit:$adapter_status" reasons
  else
    write_normalized_failure technical_error "adapter_exit:$adapter_status" errors
  fi
elif [ ! -f "$adapter_output" ] || [ -L "$adapter_output" ] \
  || [ "$(realpath "$adapter_output" 2>/dev/null || true)" != "$adapter_output" ]; then
  write_normalized_failure technical_error "adapter_output:missing_or_unsafe" errors
elif ! validate_adapter_output; then
  write_normalized_failure technical_error "adapter_output:invalid" errors
else
  output_artifacts=$(jq -c '.artifacts' "$adapter_output")
  if ! validate_artifact_refs "$output_artifacts"; then
    write_normalized_failure technical_error "adapter_artifacts:invalid_or_unsafe" errors
  elif [ "$role" = reviewer ] \
    && [ "$(jq -r '.events[0].event // empty' "$adapter_output")" = needs_change ] \
    && ! validate_artifact_path "$(jq -r '.events[0].payload.artifact' "$adapter_output")"; then
    write_normalized_failure technical_error "adapter_artifact:missing_or_unsafe" errors
  else
    jq -c . "$adapter_output" >"$result_tmp"
  fi
fi

if [ -e "$result_path" ] || [ -L "$result_path" ]; then
  if [ -d "$result_path" ] && [ ! -L "$result_path" ]; then
    rmdir "$result_path" 2>/dev/null || fail_contract "adapter poisoned result path" 73
  else
    rm -f -- "$result_path" 2>/dev/null || fail_contract "adapter poisoned result path" 73
  fi
fi
chmod 0444 "$result_tmp" || fail_contract "cannot make result read-only" 73
if ! ln "$result_tmp" "$result_path" 2>/dev/null; then
  fail_contract "result publication collision" 73
fi
rm -f "$result_tmp"
printf '%s\n' "$result_path"
# -/ 4/4
