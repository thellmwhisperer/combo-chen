#!/usr/bin/env bash
# @overview Adapt one configured direct-agent or CodeRabbit Reviewer to the
#   universal P4 step envelope. Direct agents consume the immutable input and
#   emit one typed member result; CodeRabbit consumes a generated exact-SHA
#   context and its agent JSONL is normalized through the same 0/1 contract.
#
#   READING GUIDE
#   -------------
#   1. Input and path validation       <- establish the trusted run boundary.
#   2. Output publication helpers      <- produce one immutable P4 result.
#   3. CodeRabbit config/execution     <- direct committed-review CLI boundary.
#   4. CodeRabbit JSONL normalization  <- configured severities become findings.
#   5. Direct-agent execution/result   <- typed exact-SHA member normalization.
#
#   MAIN FLOW
#   ---------
#   universal input -> selected Reviewer process -> exact-SHA P4 step output
#
#   PUBLIC API
#   ----------
#   cb-reviewer-adapter.sh direct-agent --input <path> --output <path>
#   cb-reviewer-adapter.sh coderabbit --input <path> --output <path>
#
#   INTERNALS
#   ---------
#   usage, publish_json, write_technical, write_cancelled,
#   write_lgtm, write_needs_change
#
# @exports none
# @deps bash, git, jq, realpath, ln
set -euo pipefail

usage() {
  echo "usage: cb-reviewer-adapter <direct-agent|coderabbit> --input <path> --output <path>" >&2
  exit 64
}

[ "$#" -ge 1 ] || usage
mode=$1
shift
case "$mode" in direct-agent|coderabbit) ;; *) usage ;; esac

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

# -- 1/5 CORE · Validate universal Reviewer input and contained paths -- <- START HERE
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
context_tmp=
rabbit_output_tmp=
rabbit_stderr_tmp=
output_tmp_owned=0
artifact_tmp_owned=0
context_tmp_owned=0
rabbit_output_tmp_owned=0
rabbit_stderr_tmp_owned=0
cleanup() {
  [ "$output_tmp_owned" -eq 0 ] || rm -f "$output_tmp"
  [ "$artifact_tmp_owned" -eq 0 ] || rm -f "$artifact_tmp"
  [ "$context_tmp_owned" -eq 0 ] || rm -f "$context_tmp"
  [ "$rabbit_output_tmp_owned" -eq 0 ] || rm -f "$rabbit_output_tmp"
  [ "$rabbit_stderr_tmp_owned" -eq 0 ] || rm -f "$rabbit_stderr_tmp"
}
trap cleanup 0
trap 'exit 130' 1 2 15
# -/ 1/5

# -- 2/5 HELPER · Publish one immutable universal output --
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
# -/ 2/5

# -- 3/5 CORE · Validate and execute the direct CodeRabbit CLI --
if [ "$mode" = coderabbit ]; then
  command -v git >/dev/null 2>&1 || {
    write_technical "runtime:git_missing"
    exit 0
  }
  if ! jq -e '
    .config |
    type=="object" and
    keys==[
      "argv","base_sha","blocking_severities","contract","schema","worktree"
    ] and
    .schema=="combo.reviewer/coderabbit/v1" and
    (.argv|type=="array" and length==1 and
      all(.[]; type=="string" and length>0 and index("\u0000")==null)) and
    (.worktree|type=="string" and startswith("/") and index("\u0000")==null) and
    (.base_sha|
      type=="string" and test("^[0-9a-f]{40}([0-9a-f]{24})?$")) and
    (.contract|type=="string" and test("\\S")) and
    (.blocking_severities|
      type=="array" and length>0 and length==(unique|length) and
      all(.[];
        .=="critical" or .=="major" or .=="minor" or
        .=="trivial" or .=="info"))
  ' "$input" >/dev/null 2>&1; then
    write_technical "config:invalid_coderabbit"
    exit 0
  fi

  rabbit_argv=()
  while IFS= read -r -d '' argument; do
    rabbit_argv+=("$argument")
  done < <(jq -j '.config.argv[] | . + "\u0000"' "$input")
  if [ "${#rabbit_argv[@]}" -ne 1 ]; then
    write_technical "config:invalid_coderabbit"
    exit 0
  fi
  rabbit_bin=${rabbit_argv[0]}
  case "${rabbit_bin##*/}" in
    coderabbit|cr) ;;
    *)
      write_technical "config:invalid_coderabbit"
      exit 0
      ;;
  esac
  case "$rabbit_bin" in
    */*)
      rabbit_real=$(realpath "$rabbit_bin" 2>/dev/null || true)
      if [ -z "$rabbit_real" ] || [ ! -f "$rabbit_real" ] || [ ! -x "$rabbit_real" ]; then
        write_technical "config:coderabbit_unavailable"
        exit 0
      fi
      ;;
    *)
      if ! command -v "$rabbit_bin" >/dev/null 2>&1; then
        write_technical "config:coderabbit_unavailable"
        exit 0
      fi
      ;;
  esac

  worktree=$(jq -r '.config.worktree' "$input")
  base_sha=$(jq -r '.config.base_sha' "$input")
  contract=$(jq -r '.config.contract' "$input")
  blocking_severities=$(jq -c '.config.blocking_severities' "$input")
  if [ ! -d "$worktree" ] || [ -L "$worktree" ] \
    || [ "$(realpath "$worktree" 2>/dev/null || true)" != "$worktree" ]; then
    write_technical "config:unsafe_worktree"
    exit 0
  fi
  if [ "$(git -C "$worktree" rev-parse --show-toplevel 2>/dev/null || true)" != "$worktree" ]; then
    write_technical "config:not_worktree_root"
    exit 0
  fi
  if ! git -C "$worktree" cat-file -e "$base_sha^{commit}" 2>/dev/null; then
    write_technical "config:base_commit_missing"
    exit 0
  fi
  pre_head=$(git -C "$worktree" rev-parse HEAD 2>/dev/null || true)
  if [ "$pre_head" != "$candidate" ]; then
    write_technical "candidate:head_mismatch"
    exit 0
  fi
  if ! git -C "$worktree" merge-base --is-ancestor "$base_sha" "$candidate" 2>/dev/null; then
    write_technical "candidate:base_not_ancestor"
    exit 0
  fi
  if [ -n "$(git -C "$worktree" status --porcelain=v1 2>/dev/null)" ]; then
    write_technical "candidate:dirty_worktree"
    exit 0
  fi

  context_path=$invocation_dir/coderabbit-context.md
  context_tmp=$invocation_dir/.coderabbit-context.md.tmp.$$
  if [ -e "$context_path" ] || [ -L "$context_path" ] \
    || [ -e "$context_tmp" ] || [ -L "$context_tmp" ]; then
    write_technical "coderabbit_context:collision"
    exit 0
  fi
  set -C
  if exec 6>"$context_tmp"; then
    context_tmp_owned=1
  else
    set +C
    write_technical "coderabbit_context:staging_failed"
    exit 0
  fi
  set +C
  {
    printf '# CodeRabbit reviewer context\n\n'
    printf 'Run: %s\n' "$run"
    printf 'Member: %s\n' "$member"
    printf 'Exact candidate SHA: %s\n' "$candidate"
    printf 'Base SHA: %s\n\n' "$base_sha"
    printf '## Review contract\n\n%s\n' "$contract"
    printf '\n## Prior artifacts\n'
  } >&6

  prior_count=$(jq '.prior_artifacts | length' "$input")
  prior_index=0
  while [ "$prior_index" -lt "$prior_count" ]; do
    prior_id=$(jq -r --argjson index "$prior_index" \
      '.prior_artifacts[$index].id' "$input")
    prior_relative=$(jq -r --argjson index "$prior_index" \
      '.prior_artifacts[$index].path' "$input")
    case "$prior_relative" in
      artifacts/*) ;;
      *)
        exec 6>&-
        write_technical "coderabbit_context:invalid_artifact"
        exit 0
        ;;
    esac
    prior_path=$run_dir/$prior_relative
    prior_real=$(realpath "$prior_path" 2>/dev/null || true)
    case "$prior_real" in
      "$artifacts_dir"/*) ;;
      *)
        exec 6>&-
        write_technical "coderabbit_context:invalid_artifact"
        exit 0
        ;;
    esac
    if [ ! -f "$prior_path" ] || [ -L "$prior_path" ]; then
      exec 6>&-
      write_technical "coderabbit_context:invalid_artifact"
      exit 0
    fi
    {
      printf '\n### %s\n\nPath: `%s`\n\n' "$prior_id" "$prior_relative"
      cat "$prior_path"
      printf '\n'
    } >&6
    prior_index=$((prior_index + 1))
  done
  exec 6>&-
  chmod 0444 "$context_tmp" || exit 73
  if ! ln "$context_tmp" "$context_path" 2>/dev/null; then
    write_technical "coderabbit_context:publication_failed"
    exit 0
  fi
  rm -f "$context_tmp"
  context_tmp_owned=0

  rabbit_output=$invocation_dir/coderabbit-output.jsonl
  rabbit_stderr=$invocation_dir/coderabbit-stderr.log
  rabbit_output_tmp=$invocation_dir/.coderabbit-output.jsonl.tmp.$$
  rabbit_stderr_tmp=$invocation_dir/.coderabbit-stderr.log.tmp.$$
  for reserved_path in \
    "$rabbit_output" "$rabbit_stderr" "$rabbit_output_tmp" "$rabbit_stderr_tmp"; do
    if [ -e "$reserved_path" ] || [ -L "$reserved_path" ]; then
      write_technical "coderabbit_output:collision"
      exit 0
    fi
  done

  set -C
  if exec 7>"$rabbit_output_tmp"; then
    rabbit_output_tmp_owned=1
  else
    set +C
    write_technical "coderabbit_output:staging_failed"
    exit 0
  fi
  if exec 8>"$rabbit_stderr_tmp"; then
    rabbit_stderr_tmp_owned=1
  else
    set +C
    exec 7>&-
    write_technical "coderabbit_output:staging_failed"
    exit 0
  fi
  set +C

  set +e
  (
    cd "$worktree"
    "${rabbit_argv[@]}" review --agent --committed \
      --base-commit "$base_sha" --dir "$worktree" --config "$context_path" \
      </dev/null >&7 2>&8
  )
  rabbit_status=$?
  set -e
  exec 7>&-
  exec 8>&-

  chmod 0444 "$rabbit_output_tmp" "$rabbit_stderr_tmp" || exit 73
  if ! ln "$rabbit_output_tmp" "$rabbit_output" 2>/dev/null \
    || ! ln "$rabbit_stderr_tmp" "$rabbit_stderr" 2>/dev/null; then
    write_technical "coderabbit_output:publication_failed"
    exit 0
  fi
  rm -f "$rabbit_output_tmp" "$rabbit_stderr_tmp"
  rabbit_output_tmp_owned=0
  rabbit_stderr_tmp_owned=0

  post_head=$(git -C "$worktree" rev-parse HEAD 2>/dev/null || true)
  if [ "$post_head" != "$candidate" ]; then
    write_technical "candidate:head_changed"
    exit 0
  fi
  if [ -n "$(git -C "$worktree" status --porcelain=v1 2>/dev/null)" ]; then
    write_technical "candidate:worktree_changed"
    exit 0
  fi
  if [ "$rabbit_status" -ne 0 ]; then
    if [ "$rabbit_status" -eq 124 ] || [ "$rabbit_status" -eq 130 ] \
      || [ "$rabbit_status" -eq 137 ] || [ "$rabbit_status" -eq 143 ]; then
      write_cancelled "coderabbit_exit:$rabbit_status"
    else
      write_technical "coderabbit_exit:$rabbit_status"
    fi
    exit 0
  fi
fi
# -/ 3/5

# -- 4/5 CORE · Normalize CodeRabbit JSONL and configured blocking findings --
if [ "$mode" = coderabbit ]; then
  if ! jq -s -e \
    --arg worktree "$worktree" --arg base "$base_sha" '
      type=="array" and length>=2 and
      all(.[];
        type=="object" and (.type|type=="string" and length>0)) and
      ([.[] | select(.type=="review_context")] | length)==1 and
      ([.[] | select(.type=="review_context")][0] |
        .reviewType=="committed" and
        .workingDirectory==$worktree and .baseCommit==$base) and
      all(.[]; .type!="error") and
      all(.[] | select(.type=="finding");
        (.severity=="critical" or .severity=="major" or
         .severity=="minor" or .severity=="trivial" or
         .severity=="info") and
        (.fileName|type=="string" and test("\\S")) and
        ((has("comment")|not) or (.comment|type=="string")) and
        ((has("codegenInstructions")|not) or
          (.codegenInstructions|type=="string")) and
        ((has("suggestions")|not) or
          (.suggestions|type=="array" and
            all(.[]; type=="string")))) and
      ([.[] | select(.type=="complete")] | length)==1 and
      .[-1].type=="complete" and .[-1].status=="review_completed" and
      (.[-1].findings|type=="number" and floor==. and .>=0) and
      .[-1].findings==([.[] | select(.type=="finding")] | length)
    ' "$rabbit_output" >/dev/null 2>&1; then
    write_technical "coderabbit_output:invalid"
    exit 0
  fi

  blocking_count=$(jq -s --argjson blocking "$blocking_severities" '
    [.[] | select(
      .type=="finding" and
      ((.severity as $severity | $blocking | index($severity)) != null)
    )] | length
  ' "$rabbit_output")
  if [ "$blocking_count" -eq 0 ]; then
    write_lgtm
    exit 0
  fi

  artifact="artifacts/findings-r$attempt-$member.md"
  artifact_path=$run_dir/$artifact
  artifact_id=review-"$member"-round-"$attempt"
  artifact_tmp=$artifacts_dir/.findings-r"$attempt"-"$member".md.tmp.$$
  if ! (set -C; jq -rs \
    --arg sha "$candidate" --argjson blocking "$blocking_severities" '
      def details:
        ([.comment // "", .codegenInstructions // ""] +
          (.suggestions // [])) |
        map(select(type=="string" and test("\\S"))) |
        if length==0 then "No details supplied." else join("\n\n") end;
      [.[] | select(
        .type=="finding" and
        ((.severity as $severity | $blocking | index($severity)) != null)
      )] |
      "# CodeRabbit blocking findings\n\nCandidate: `" + $sha + "`\n\n" +
      (map(
        "## [" + (.severity|ascii_upcase) + "] `" + .fileName + "`\n\n" +
        details
      ) | join("\n\n"))
    ' "$rabbit_output" >"$artifact_tmp") 2>/dev/null; then
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
  exit 0
fi
# -/ 4/5

# -- 5/5 CORE · Validate, execute, and normalize configured direct-agent argv --
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
# -/ 5/5
