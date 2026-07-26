#!/usr/bin/env bash
# @overview Adapt one configured Reviewer process to the universal P4 step
#   envelope. The direct-agent mode passes the immutable step input through
#   unchanged, then normalizes one typed, exact-SHA 0/1 member result without
#   binding a provider, model, harness, or agent binary in product code.
#
#   READING GUIDE
#   -------------
#   1. Input and path validation       <- establish the trusted run boundary.
#   2. Output publication helpers      <- produce one immutable P4 result.
#   3. Direct-agent config/execution   <- invoke configured argv without eval.
#   4. Member-result normalization     <- exact-SHA LGTM or findings artifact.
#
#   MAIN FLOW
#   ---------
#   universal input -> configured argv -> typed member result -> P4 step output
#
#   PUBLIC API
#   ----------
#   cb-reviewer-adapter.sh direct-agent --input <path> --output <path>
#
#   INTERNALS
#   ---------
#   usage, publish_json, write_technical, write_cancelled,
#   write_lgtm, write_needs_change
#
# @exports none
# @deps bash, jq, realpath, ln
set -euo pipefail

usage() {
  echo "usage: cb-reviewer-adapter direct-agent --input <path> --output <path>" >&2
  exit 64
}

[ "$#" -ge 1 ] || usage
mode=$1
shift
[ "$mode" = direct-agent ] || usage

input=
output=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --input)
      [ "$#" -ge 2 ] && [ -z "$input" ] || usage
      input=$2
      shift 2
      ;;
    --output)
      [ "$#" -ge 2 ] && [ -z "$output" ] || usage
      output=$2
      shift 2
      ;;
    *) usage ;;
  esac
done
[ -n "$input" ] && [ -n "$output" ] || usage
command -v jq >/dev/null 2>&1 || exit 73
command -v realpath >/dev/null 2>&1 || exit 73

# -- 1/4 CORE · Validate universal Reviewer input and contained paths -- <- START HERE
[ -f "$input" ] && [ ! -L "$input" ] || exit 64
if ! jq -e --arg input "$input" --arg output "$output" '
  type=="object" and
  keys==[
    "adapter_id","attempt","candidate_sha","config","paths",
    "prior_artifacts","role","run_id","schema","step_id"
  ] and
  .schema=="combo.step-input/v1" and
  (.run_id|type=="string" and length>0) and
  (.step_id|type=="string" and test("^reviewer/[a-z][a-z0-9._-]*$")) and
  .role=="reviewer" and
  (.attempt|type=="number" and floor==. and .>0) and
  (.candidate_sha|
    type=="string" and test("^[0-9a-f]{40}([0-9a-f]{24})?$")) and
  (.config|type=="object") and
  (.prior_artifacts|type=="array") and
  (.paths|type=="object" and
    keys==[
      "artifacts_dir","input_path","invocation_dir",
      "output_path","run_dir","steps_dir"
    ] and
    .input_path==$input and .output_path==$output)
' "$input" >/dev/null 2>&1; then
  exit 64
fi

run=$(jq -r '.run_id' "$input")
step=$(jq -r '.step_id' "$input")
attempt=$(jq -r '.attempt' "$input")
candidate=$(jq -r '.candidate_sha' "$input")
member=${step#reviewer/}
run_dir=$(jq -r '.paths.run_dir' "$input")
artifacts_dir=$(jq -r '.paths.artifacts_dir' "$input")
invocation_dir=$(jq -r '.paths.invocation_dir' "$input")

[ -d "$run_dir" ] && [ ! -L "$run_dir" ] || exit 73
[ -d "$artifacts_dir" ] && [ ! -L "$artifacts_dir" ] || exit 73
[ -d "$invocation_dir" ] && [ ! -L "$invocation_dir" ] || exit 73
[ "$(realpath "$input" 2>/dev/null)" = "$input" ] || exit 73
[ "$(realpath "$run_dir" 2>/dev/null)" = "$run_dir" ] || exit 73
[ "$(realpath "$artifacts_dir" 2>/dev/null)" = "$artifacts_dir" ] || exit 73
[ "$(realpath "$invocation_dir" 2>/dev/null)" = "$invocation_dir" ] || exit 73
[ "$(dirname "$output")" = "$invocation_dir" ] || exit 73
case "$artifacts_dir" in "$run_dir"/artifacts) ;; *) exit 73 ;; esac

output_tmp=$invocation_dir/.reviewer-adapter-output.json.tmp.$$
artifact_tmp=
output_tmp_owned=0
artifact_tmp_owned=0
cleanup() {
  [ "$output_tmp_owned" -eq 0 ] || rm -f "$output_tmp"
  [ "$artifact_tmp_owned" -eq 0 ] || rm -f "$artifact_tmp"
}
trap cleanup 0
trap 'exit 130' 1 2 15
# -/ 1/4

# -- 2/4 HELPER · Publish one immutable universal output --
publish_json() {
  local document=$1
  if ! (set -C; printf '%s\n' "$document" >"$output_tmp") 2>/dev/null; then
    exit 73
  fi
  output_tmp_owned=1
  chmod 0444 "$output_tmp" || exit 73
  if ! ln "$output_tmp" "$output" 2>/dev/null; then
    exit 73
  fi
  rm -f "$output_tmp"
  output_tmp_owned=0
}

write_technical() {
  local detail=$1 document
  document=$(jq -cn \
    --arg run "$run" --arg step "$step" --argjson attempt "$attempt" \
    --arg detail "$detail" '{
      schema:"combo.step-output/v1",
      run_id:$run,step_id:$step,role:"reviewer",attempt:$attempt,
      exit_class:"technical_error",events:[],artifacts:[],
      reasons:[],errors:[$detail]
    }')
  publish_json "$document"
}

write_cancelled() {
  local detail=$1 document
  document=$(jq -cn \
    --arg run "$run" --arg step "$step" --argjson attempt "$attempt" \
    --arg detail "$detail" '{
      schema:"combo.step-output/v1",
      run_id:$run,step_id:$step,role:"reviewer",attempt:$attempt,
      exit_class:"cancelled",events:[],artifacts:[],
      reasons:[$detail],errors:[]
    }')
  publish_json "$document"
}

write_lgtm() {
  local document
  document=$(jq -cn \
    --arg run "$run" --arg step "$step" --argjson attempt "$attempt" \
    --arg sha "$candidate" '{
      schema:"combo.step-output/v1",
      run_id:$run,step_id:$step,role:"reviewer",attempt:$attempt,
      exit_class:"completed",
      events:[{code:0,event:"lgtm",payload:{sha:$sha}}],
      artifacts:[],reasons:[],errors:[]
    }')
  publish_json "$document"
}

write_needs_change() {
  local artifact=$1 artifact_id=$2 document
  document=$(jq -cn \
    --arg run "$run" --arg step "$step" --argjson attempt "$attempt" \
    --arg sha "$candidate" --arg artifact "$artifact" \
    --arg artifact_id "$artifact_id" '{
      schema:"combo.step-output/v1",
      run_id:$run,step_id:$step,role:"reviewer",attempt:$attempt,
      exit_class:"completed",
      events:[{code:1,event:"needs_change",payload:{
        sha:$sha,artifact:$artifact
      }}],
      artifacts:[{id:$artifact_id,path:$artifact}],
      reasons:[],errors:[]
    }')
  publish_json "$document"
}
# -/ 2/4

# -- 3/4 CORE · Validate and execute configured direct-agent argv --
if ! jq -e '
  .config |
  type=="object" and
  keys==["argv","contract","output_schema","schema"] and
  .schema=="combo.reviewer/direct-agent/v1" and
  (.argv|type=="array" and length>0 and
    all(.[]; type=="string" and length>0 and index("\u0000")==null)) and
  (.contract|type=="string" and test("\\S")) and
  .output_schema=="combo.reviewer-member-output/v1"
' "$input" >/dev/null 2>&1; then
  write_technical "config:invalid_direct_agent"
  exit 0
fi

agent_argv=()
while IFS= read -r -d '' argument; do
  agent_argv+=("$argument")
done < <(jq -j '.config.argv[] | . + "\u0000"' "$input")
argv_expected=$(jq -r '.config.argv | length' "$input")
if [ "${#agent_argv[@]}" -ne "$argv_expected" ]; then
  write_technical "config:invalid_direct_agent"
  exit 0
fi

member_output=$invocation_dir/reviewer-member-output.json
if [ -e "$member_output" ] || [ -L "$member_output" ]; then
  write_technical "agent_output:collision"
  exit 0
fi

set +e
"${agent_argv[@]}" --input "$input" --output "$member_output" </dev/null
agent_status=$?
set -e
if [ "$agent_status" -ne 0 ]; then
  if [ "$agent_status" -eq 124 ] || [ "$agent_status" -eq 130 ] \
    || [ "$agent_status" -eq 137 ] || [ "$agent_status" -eq 143 ]; then
    write_cancelled "agent_exit:$agent_status"
  else
    write_technical "agent_exit:$agent_status"
  fi
  exit 0
fi
# -/ 3/4

# -- 4/4 CORE · Normalize exact-SHA 0/1 result and findings artifact --
if [ ! -f "$member_output" ] || [ -L "$member_output" ] \
  || [ "$(realpath "$member_output" 2>/dev/null || true)" != "$member_output" ] \
  || ! jq -e --arg sha "$candidate" '
    type=="object" and
    keys==["code","findings","schema","sha"] and
    .schema=="combo.reviewer-member-output/v1" and
    .sha==$sha and
    (.code==0 or .code==1) and
    (.findings|type=="string") and
    if .code==0 then .findings==""
    else (.findings|test("\\S")) end
  ' "$member_output" >/dev/null 2>&1; then
  write_technical "agent_output:invalid"
  exit 0
fi

member_code=$(jq -r '.code' "$member_output")
if [ "$member_code" -eq 0 ]; then
  write_lgtm
  exit 0
fi

artifact="artifacts/findings-r$attempt-$member.md"
artifact_path=$run_dir/$artifact
artifact_id=review-"$member"-round-"$attempt"
artifact_tmp=$artifacts_dir/.findings-r"$attempt"-"$member".md.tmp.$$
if ! (set -C; jq -r '.findings' "$member_output" >"$artifact_tmp") 2>/dev/null; then
  write_technical "artifact:staging_failed"
  exit 0
fi
artifact_tmp_owned=1
chmod 0444 "$artifact_tmp" || exit 73
if ! ln "$artifact_tmp" "$artifact_path" 2>/dev/null; then
  write_technical "artifact:publication_collision"
  exit 0
fi
rm -f "$artifact_tmp"
artifact_tmp_owned=0
write_needs_change "$artifact" "$artifact_id"
# -/ 4/4
