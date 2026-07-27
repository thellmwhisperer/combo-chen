#!/usr/bin/env bash
# @overview P7 No-Mistakes Gate adapter for the universal P4 envelope. It
#   verifies the Launcher-owned exact candidate before and after one documented
#   axi invocation, verifies configured runtime/model against the effective
#   No-Mistakes config and doctor surface, seals that identity with the observed
#   version/help plus effective binary/argv before launch, serializes the
#   invocation through a host-global lease with run-local evidence, adopts the
#   same invocation after interruption, and seals/replays the typed terminal
#   outcome plus one GitHub-verified exact PR. Explicit auto authority arms that
#   PR once with GitHub auto-rebase, while manual authority remains mutation-free;
#   authenticated state and the target branch's strict required-check policy
#   recover an interrupted arm without replaying the effect, keep an armed OPEN
#   PR inside Gate, and seal exact-candidate check evidence with the later merged
#   observation before publishing the final Gate outcome.
#
#   READING GUIDE
#   -------------
#   1. Universal input validation <- contain paths and freeze adapter config.
#   2. Launcher custody preflight <- prove worktree, branch, clean exact HEAD.
#   3. Invocation/terminal replay <- freeze identity and one documented axi run.
#   4. Global lease and invocation <- exclude sibling runs; recover stale owner.
#   5. Terminal normalization     <- exact PR, merge arm, final fact, typed outcome.
#
#   MAIN FLOW
#   ---------
#   input -> exact custody -> replay | identity + sealed axi -> lease -> result
#
#   PUBLIC API
#   ----------
#   cb-gate.sh --input <path> --output <path>  Run one validated-mode Gate.
#
#   INTERNALS
#   ---------
#   usage, fail_contract, publish_result, publish_gate_failed,
#   verify_candidate, toon_scalar, publish_terminal_result,
#   capture_no_mistakes_config_identity, capture_no_mistakes_probe,
#   validate_no_mistakes_preflight, validate_invocation, validate_lease_owner,
#   reclaim_stale_lease, validate_github_pr_object, resolve_exact_github_pr,
#   resolve_github_binary, validate_required_checks,
#   required_checks_satisfied, validate_merge_arm,
#   validate_merge_observation, validate_merge_outcome,
#   resolve_github_repository, capture_github_requirements,
#   capture_github_check_evidence, observe_exact_merge_state,
#   merge_observation_is_armed, publish_merge_arm, publish_merge_outcome,
#   ensure_auto_merge_armed, wait_for_auto_merge_outcome
#
# @exports none
# @deps bash, date, gh, git, jq, od, realpath, sleep, stat, touch, tr,
#   no-mistakes-compatible configured binary
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
lease_tmp=
lease_tmp_owned=0
merge_arm_tmp=
merge_arm_tmp_owned=0
merge_outcome_tmp=
merge_outcome_tmp_owned=0
gate_lease_lock=
gate_lease_owner=
gate_lease_owner_json=
gate_lease_owned=0
gate_lease_heartbeat_pid=
cleanup() {
  local current_owner
  [ "$output_tmp_owned" -eq 0 ] || rm -f -- "$output_tmp"
  [ "$receipt_tmp_owned" -eq 0 ] || rm -f -- "$receipt_tmp"
  [ "$terminal_tmp_owned" -eq 0 ] || rm -f -- "$terminal_tmp"
  [ "$invocation_tmp_owned" -eq 0 ] || rm -f -- "$invocation_tmp"
  [ "$lease_tmp_owned" -eq 0 ] || rm -f -- "$lease_tmp"
  [ "$merge_arm_tmp_owned" -eq 0 ] || rm -f -- "$merge_arm_tmp"
  [ "$merge_outcome_tmp_owned" -eq 0 ] || rm -f -- "$merge_outcome_tmp"
  if [ -n "$gate_lease_heartbeat_pid" ]; then
    kill "$gate_lease_heartbeat_pid" 2>/dev/null || true
    wait "$gate_lease_heartbeat_pid" 2>/dev/null || true
    gate_lease_heartbeat_pid=
  fi
  if [ "$gate_lease_owned" -eq 1 ]; then
    current_owner=$(cat "$gate_lease_owner" 2>/dev/null || true)
    if [ "$current_owner" = "$gate_lease_owner_json" ]; then
      rm -f -- "$gate_lease_owner"
      rmdir "$gate_lease_lock" 2>/dev/null || true
    fi
  fi
}
trap cleanup 0
trap 'exit 130' 1 2 15

# -- 1/5 CORE · Validate universal input and contained output -- <- START HERE
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
      "approval","arguments","binary","intent","merge","model","review",
      "runtime","schema"
    ] and
    .schema=="combo.gate.no-mistakes/v1" and
    (.binary|clean_string) and
    (.runtime|clean_string) and
    (.model|clean_string) and
    (.arguments|clean_strings) and
    (.intent|clean_string) and
    (.approval=="auto" or .approval=="manual") and
    (.review|type=="boolean") and
    (.merge=="manual" or .merge=="auto"))
' "$input" >/dev/null 2>&1; then
  fail_contract "invalid universal Gate input or No-Mistakes config"
fi

run=$(jq -r '.run_id' "$input")
attempt=$(jq -r '.attempt' "$input")
candidate_sha=$(jq -r '.candidate_sha' "$input")
nm_runtime=$(jq -r '.config.runtime' "$input")
nm_model=$(jq -r '.config.model' "$input")
merge_mode=$(jq -r '.config.merge' "$input")
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
# -/ 1/5

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
  local terminal_json=$1 terminal_lease terminal_receipt terminal_result
  local terminal_arm terminal_merge_outcome terminal_artifacts
  terminal_lease=$(printf '%s\n' "$terminal_json" | jq -r '.lease')
  terminal_receipt=$(printf '%s\n' "$terminal_json" |
    jq -r '.no_mistakes.receipt')
  terminal_arm=$(printf '%s\n' "$terminal_json" | jq -r '.merge.arm')
  terminal_merge_outcome=$(printf '%s\n' "$terminal_json" |
    jq -r '.merge.outcome')
  terminal_result=$(printf '%s\n' "$terminal_json" | jq -c '.result')
  terminal_artifacts=$(jq -cn \
    --arg invocation "$invocation_rel" --arg lease "$terminal_lease" \
    --arg receipt "$terminal_receipt" --arg arm "$terminal_arm" \
    --arg merge_outcome "$terminal_merge_outcome" \
    --arg terminal "$terminal_rel" '
      [
        {id:"gate-invocation",path:$invocation},
        {id:"gate-lease",path:$lease},
        {id:"no-mistakes-outcome",path:$receipt}
      ] +
      if $arm=="" then [] else [
        {id:"gate-merge-arm",path:$arm}
      ] end +
      if $merge_outcome=="" then [] else [
        {id:"gate-merge-outcome",path:$merge_outcome}
      ] end + [
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

# -- 2/5 CORE · Verify Launcher custody and the exact reviewed candidate --
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
# -/ 2/5

# -- 3/5 CORE · Replay terminal state or seal one No-Mistakes invocation --
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

validate_lease_owner() {
  local json=$1
  printf '%s\n' "$json" | jq -e '
    def sha:
      type=="string" and test("^[0-9a-f]{40}([0-9a-f]{24})?$");
    def clean:
      type=="string" and length>0 and
      (explode | all(.[]; .>=32 and .!=127));
    type=="object" and
    keys==[
      "acquired_at","adapter","attempt","branch","candidate_sha","pid",
      "run_id","schema","scope","token","worktree"
    ] and
    .schema=="combo.gate-lease-owner/v1" and
    .scope=="host-global" and .adapter=="no-mistakes" and
    (.run_id|type=="string" and test("^[a-z0-9-]+$")) and
    (.branch|clean) and (.worktree|clean) and (.candidate_sha|sha) and
    (.attempt|type=="number" and floor==. and .>0) and
    (.pid|type=="number" and floor==. and .>0) and
    (.token|type=="string" and test("^[A-Za-z0-9_-]+$")) and
    (.acquired_at|type=="number" and floor==. and .>=0)
  ' >/dev/null 2>&1
}

validate_lease_evidence() {
  local path=$1 maximum_attempt=$2
  jq -e \
    --arg run "$run" --arg branch "$branch" --arg worktree "$worktree" \
    --arg sha "$candidate_sha" --argjson maximum "$maximum_attempt" '
      def sha:
        type=="string" and test("^[0-9a-f]{40}([0-9a-f]{24})?$");
      def clean:
        type=="string" and length>0 and
        (explode | all(.[]; .>=32 and .!=127));
      def owner:
        type=="object" and
        keys==[
          "acquired_at","adapter","attempt","branch","candidate_sha","pid",
          "run_id","schema","scope","token","worktree"
        ] and
        .schema=="combo.gate-lease-owner/v1" and
        .scope=="host-global" and .adapter=="no-mistakes" and
        (.run_id|type=="string" and test("^[a-z0-9-]+$")) and
        (.branch|clean) and (.worktree|clean) and (.candidate_sha|sha) and
        (.attempt|type=="number" and floor==. and .>0) and
        (.pid|type=="number" and floor==. and .>0) and
        (.token|type=="string" and test("^[A-Za-z0-9_-]+$")) and
        (.acquired_at|type=="number" and floor==. and .>=0);
      type=="object" and
      keys==[
        "acquired_at","adapter","attempt","branch","candidate_sha","pid",
        "recovered_from","run_id","schema","scope","state","token","worktree"
      ] and
      .schema=="combo.gate-lease/v1" and
      .scope=="host-global" and .adapter=="no-mistakes" and
      .run_id==$run and .branch==$branch and .worktree==$worktree and
      .candidate_sha==$sha and
      (.attempt |
        type=="number" and floor==. and .>0 and .<=$maximum) and
      (.pid|type=="number" and floor==. and .>0) and
      (.token|type=="string" and test("^[A-Za-z0-9_-]+$")) and
      (.acquired_at|type=="number" and floor==. and .>=0) and
      if .state=="acquired" then
        .recovered_from==null
      elif .state=="recovered" then
        (.recovered_from|owner) or
        (.recovered_from |
          type=="object" and keys==["state"] and
          (.state=="ownerless" or .state=="malformed"))
      else false end
    ' "$path" >/dev/null 2>&1
}

validate_no_mistakes_preflight() {
  local json=$1
  printf '%s\n' "$json" | jq -e \
    --arg runtime "$nm_runtime" --arg model "$nm_model" '
      def clean:
        type=="string" and length>0 and
        (explode | all(.[]; .>=32 and .!=127));
      def clean_multiline:
        type=="string" and length>0 and
        (explode | all(.[]; .==9 or .==10 or (.>=32 and .!=127)));
      type=="object" and
      keys==[
        "axi_respond_help","axi_run_help","axi_status_help","config_path",
        "doctor","model","runtime","version"
      ] and
      .runtime==$runtime and .model==$model and
      (.runtime|clean) and (.model|clean) and
      (.config_path|clean and startswith("/")) and
      (.version|clean_multiline) and
      (.doctor|clean_multiline) and
      (.axi_run_help|clean_multiline) and
      (.axi_status_help|clean_multiline) and
      (.axi_respond_help|clean_multiline) and
      (.version|contains("no-mistakes version")) and
      (.axi_run_help|contains("no-mistakes axi run")) and
      (.axi_run_help|contains("--intent")) and
      (.axi_run_help|contains("--skip")) and
      (.axi_run_help|contains("--yes")) and
      ((.axi_run_help|contains("--auto-merge"))|not) and
      (.axi_status_help|contains("no-mistakes axi status")) and
      (.axi_status_help|contains("--run")) and
      (.axi_respond_help|contains("no-mistakes axi respond")) and
      (.axi_respond_help|contains("--action")) and
      (.axi_respond_help|contains("--yes")) and
      (.doctor|contains("gate validation")) and
      (.doctor|contains($runtime + " is runnable"))
    ' >/dev/null 2>&1
}

invocation_rel=artifacts/gate/invocation.json
invocation=$run_root/$invocation_rel
invocation_tmp=$gate_artifacts/.invocation.json.tmp.$$
terminal_rel=artifacts/gate/terminal.json
terminal=$run_root/$terminal_rel
terminal_tmp=$gate_artifacts/.terminal.json.tmp.$$
merge_arm_rel=artifacts/gate/merge-arm.json
merge_arm=$run_root/$merge_arm_rel
merge_arm_tmp=$gate_artifacts/.merge-arm.json.tmp.$$
merge_outcome_rel=artifacts/gate/merge-outcome.json
merge_outcome=$run_root/$merge_outcome_rel
merge_outcome_tmp=$gate_artifacts/.merge-outcome.json.tmp.$$

validate_required_checks() {
  local json=$1
  printf '%s\n' "$json" | jq -e '
    def clean:
      type=="string" and length>0 and
      (explode | all(.[]; .>=32 and .!=127));
    type=="object" and
    keys==["checks","repository","strict","target_branch"] and
    .strict==true and (.target_branch|clean) and
    (.repository |
      type=="object" and keys==["name_with_owner","url"] and
      (.name_with_owner |
        type=="string" and test("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")) and
      (.url|clean and startswith("https://"))) and
    (.checks |
      type=="array" and length>0 and
      all(.[];
        type=="object" and keys==["app_id","context"] and
        (.context|clean) and
        (.app_id==null or
          (.app_id |
            type=="number" and floor==. and
            (.==-1 or .>0)))) and
      (map([.context,.app_id]) | unique | length)==length)
  ' >/dev/null 2>&1
}

validate_merge_observation() {
  local json=$1
  printf '%s\n' "$json" | jq -e '
    def sha:
      type=="string" and test("^[0-9a-f]{40}([0-9a-f]{24})?$");
    def clean:
      type=="string" and length>0 and
      (explode | all(.[]; .>=32 and .!=127));
    type=="object" and
    keys==[
      "autoMergeRequest","baseRefName","baseRefOid","checks",
      "headRefName","headRefOid","mergeCommit","mergeStateStatus",
      "mergeable","mergedAt","state","url"
    ] and
    (.url|clean and startswith("https://")) and
    (.headRefName|clean) and (.headRefOid|sha) and
    (.baseRefName|clean) and (.baseRefOid|sha) and
    (.mergeStateStatus|clean) and (.mergeable|clean) and
    (.state=="OPEN" or .state=="CLOSED" or .state=="MERGED") and
    (.autoMergeRequest==null or
      (.autoMergeRequest |
        type=="object" and (.mergeMethod|clean))) and
    (.checks |
      . as $checks |
      type=="object" and keys==["check_runs","sha","statuses"] and
      (.sha|sha) and
      (.check_runs |
        type=="array" and all(.[];
          type=="object" and
          keys==["app_id","conclusion","head_sha","name","status"] and
          (.app_id|type=="number" and floor==. and .>0) and
          (.head_sha|sha) and
          (.name|clean) and (.status|clean) and
          (.conclusion==null or (.conclusion|clean))) and
        (map([.name,.app_id]) | unique | length)==length) and
      (.statuses |
        type=="array" and all(.[];
          type=="object" and keys==["context","state"] and
          (.context|clean) and (.state|clean)) and
        (map(.context) | unique | length)==length) and
      all(.check_runs[]; .head_sha==$checks.sha)) and
    if .state=="MERGED" then
      (.mergedAt|clean) and
      (.mergeCommit|type=="object" and (.oid|sha))
    else
      .mergedAt==null and .mergeCommit==null
    end
  ' >/dev/null 2>&1
}

required_checks_satisfied() {
  local requirements=$1 observation=$2
  jq -en \
    --argjson requirements "$requirements" \
    --argjson observation "$observation" '
      def successful_run($run):
        $run.status=="COMPLETED" and
        ($run.conclusion=="SUCCESS" or
          $run.conclusion=="NEUTRAL" or
          $run.conclusion=="SKIPPED");
      def successful_status($status):
        $status.state=="SUCCESS";
      all($requirements.checks[];
        . as $required |
        if ($required.app_id==null or $required.app_id==-1) then
          ([
            $observation.checks.check_runs[] |
            select(.name==$required.context) |
            successful_run(.)
          ] + [
            $observation.checks.statuses[] |
            select(.context==$required.context) |
            successful_status(.)
          ]) as $matches |
          ($matches|length)>0 and ($matches|all)
        else
          [
            $observation.checks.check_runs[] |
            select(
              .name==$required.context and
              .app_id==$required.app_id
            ) |
            successful_run(.)
          ] as $matches |
          ($matches|length)==1 and ($matches|all)
        end)
    ' >/dev/null 2>&1
}

validate_merge_arm() {
  local json=$1 requirements observation
  if ! printf '%s\n' "$json" | jq -e \
    --arg run "$run" --arg branch "$branch" --arg worktree "$worktree" \
    --arg sha "$candidate_sha" '
      def clean:
        type=="string" and length>0 and
        (explode | all(.[]; .>=32 and .!=127));
      . as $arm |
      type=="object" and
      keys==[
        "branch","candidate_sha","command","mode","observation","pr",
        "requirements","run_id","schema","source","state","worktree"
      ] and
      .schema=="combo.gate-merge-arm/v2" and
      .run_id==$run and .branch==$branch and .worktree==$worktree and
      .candidate_sha==$sha and .mode=="auto" and .state=="armed" and
      (.source=="command" or .source=="observed") and
      (.pr|clean and startswith("https://")) and
      (.command |
        type=="object" and keys==["argv","binary"] and
        (.binary|clean and startswith("/")) and
        .argv==["pr","merge",$arm.pr,"--auto","--rebase"]) and
      (.requirements|type=="object") and
      (.observation|type=="object")
    ' >/dev/null 2>&1; then
    return 1
  fi
  requirements=$(printf '%s\n' "$json" | jq -c '.requirements') \
    || return 1
  observation=$(printf '%s\n' "$json" | jq -c '.observation') \
    || return 1
  validate_required_checks "$requirements" || return 1
  validate_merge_observation "$observation" || return 1
  printf '%s\n' "$json" | jq -e \
    --arg branch "$branch" --arg sha "$candidate_sha" '
      . as $arm |
      (.requirements.repository.url + "/pull/") as $prefix |
      .observation.url==$arm.pr and
      .observation.headRefName==$branch and
      .observation.headRefOid==$sha and
      .observation.checks.sha==$sha and
      .observation.baseRefName==.requirements.target_branch and
      (.pr|startswith($prefix)) and
      (.pr|ltrimstr($prefix)|test("^[1-9][0-9]*$")) and
      if .observation.state=="OPEN" then
        (.observation.autoMergeRequest |
          type=="object" and .mergeMethod=="REBASE")
      elif .observation.state=="MERGED" then
        true
      else false end
    ' >/dev/null 2>&1
}

validate_merge_outcome() {
  local json=$1 requirements observation
  if ! printf '%s\n' "$json" | jq -e \
    --arg run "$run" --arg branch "$branch" --arg worktree "$worktree" \
    --arg sha "$candidate_sha" '
      def clean:
        type=="string" and length>0 and
        (explode | all(.[]; .>=32 and .!=127));
      . as $outcome |
      type=="object" and
      keys==[
        "branch","candidate_sha","observation","outcome","pr",
        "requirements","run_id","schema","worktree"
      ] and
      .schema=="combo.gate-merge-outcome/v2" and
      .run_id==$run and .branch==$branch and .worktree==$worktree and
      .candidate_sha==$sha and .outcome=="merged" and
      (.pr|clean and startswith("https://")) and
      (.requirements|type=="object") and
      (.observation|type=="object")
    ' >/dev/null 2>&1; then
    return 1
  fi
  requirements=$(printf '%s\n' "$json" | jq -c '.requirements') \
    || return 1
  observation=$(printf '%s\n' "$json" | jq -c '.observation') \
    || return 1
  validate_required_checks "$requirements" || return 1
  validate_merge_observation "$observation" || return 1
  required_checks_satisfied "$requirements" "$observation" || return 1
  printf '%s\n' "$json" | jq -e \
    --arg branch "$branch" --arg sha "$candidate_sha" '
      . as $outcome |
      (.requirements.repository.url + "/pull/") as $prefix |
      .observation.url==$outcome.pr and
      .observation.headRefName==$branch and
      .observation.headRefOid==$sha and
      .observation.checks.sha==$sha and
      .observation.baseRefName==.requirements.target_branch and
      (.pr|startswith($prefix)) and
      (.pr|ltrimstr($prefix)|test("^[1-9][0-9]*$")) and
      .observation.state=="MERGED" and
      .observation.autoMergeRequest==null
    ' >/dev/null 2>&1
}

if [ -e "$terminal" ] || [ -L "$terminal" ]; then
  [ -f "$terminal" ] && [ ! -L "$terminal" ] \
    || fail_contract "Gate terminal seal is unsafe" 73
  [ "$(realpath "$terminal" 2>/dev/null)" = "$terminal" ] \
    || fail_contract "Gate terminal seal path must be canonical" 73
  terminal_json=$(jq -c '.' "$terminal" 2>/dev/null) \
    || fail_contract "invalid Gate terminal seal" 73
  if ! printf '%s\n' "$terminal_json" | jq -e \
    --arg run "$run" --arg branch "$branch" --arg worktree "$worktree" \
    --arg sha "$candidate_sha" --arg invocation "$invocation_rel" \
    --arg merge "$merge_mode" --arg arm "$merge_arm_rel" \
    --arg merge_outcome "$merge_outcome_rel" '
      def clean:
        type=="string" and length>0 and
        (explode | all(.[]; .>=32 and .!=127));
      def clean_or_empty:
        type=="string" and
        (length==0 or (explode | all(.[]; .>=32 and .!=127)));
      . as $terminal |
      type=="object" and
      keys==[
        "branch","candidate_sha","invocation","lease","merge",
        "no_mistakes","normalized_outcome","result","run_id","schema","worktree"
      ] and
      .schema=="combo.gate-terminal/v3" and
      .run_id==$run and .branch==$branch and .worktree==$worktree and
      .candidate_sha==$sha and .invocation==$invocation and
      (.lease |
        type=="string" and
        test("^artifacts/gate/no-mistakes-lease-attempt-[1-9][0-9]*\\.json$")) and
      (.normalized_outcome |
        .=="validated" or .=="merged" or .=="failed" or .=="cancelled") and
      ($terminal.normalized_outcome!="validated" or $merge=="manual") and
      ($terminal.normalized_outcome!="merged" or $merge=="auto") and
      (.merge |
        type=="object" and keys==["arm","mode","outcome"] and
        .mode==$merge and
        if $terminal.normalized_outcome=="merged" then
          .arm==$arm and .outcome==$merge_outcome
        else
          .arm=="" and .outcome==""
        end) and
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
      if (.normalized_outcome=="validated" or
          .normalized_outcome=="merged") then
        (.no_mistakes.outcome=="passed" or
          .no_mistakes.outcome=="checks-passed") and
        ($terminal.no_mistakes.pr|clean) and
        .result=={
          exit_class:"completed",
          events:[{
            code:0,
            event:"gate_ok",
            payload:(
              {outcome:$terminal.normalized_outcome,sha:$sha} +
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
  terminal_invocation_json=$(jq -c '.' "$invocation" 2>/dev/null) \
    || fail_contract "invalid Gate invocation seal" 73
  if ! printf '%s\n' "$terminal_invocation_json" | jq -e \
    --arg run "$run" --arg branch "$branch" --arg worktree "$worktree" \
    --arg sha "$candidate_sha" --arg merge "$merge_mode" \
    --argjson attempt "$attempt" '
      def clean:
        type=="string" and length>0 and
        (explode | all(.[]; .>=32 and .!=127));
      type=="object" and
      keys==[
        "argv","binary","branch","candidate_sha","initial_attempt","merge",
        "preflight","run_id","schema","worktree"
      ] and
      .schema=="combo.gate-invocation/v3" and
      .run_id==$run and .branch==$branch and .worktree==$worktree and
      .candidate_sha==$sha and .merge==$merge and
      (.initial_attempt |
        type=="number" and floor==. and .>0 and .<=$attempt) and
      (.binary|clean) and
      (.argv|type=="array" and length>0 and all(.[]; clean)) and
      (.preflight|type=="object")
    ' >/dev/null 2>&1; then
    fail_contract "invalid Gate invocation seal" 73
  fi
  terminal_preflight_json=$(printf '%s\n' "$terminal_invocation_json" |
    jq -c '.preflight') \
    || fail_contract "invalid Gate invocation preflight" 73
  validate_no_mistakes_preflight "$terminal_preflight_json" \
    || fail_contract "invalid Gate invocation preflight" 73
  terminal_lease_rel=$(printf '%s\n' "$terminal_json" | jq -r '.lease')
  terminal_lease=$run_root/$terminal_lease_rel
  [ -f "$terminal_lease" ] && [ ! -L "$terminal_lease" ] \
    || fail_contract "Gate terminal lease evidence is missing or unsafe" 73
  [ "$(realpath "$terminal_lease" 2>/dev/null)" = "$terminal_lease" ] \
    || fail_contract "Gate terminal lease evidence path must be canonical" 73
  validate_lease_evidence "$terminal_lease" "$attempt" \
    || fail_contract "invalid Gate terminal lease evidence" 73
  terminal_receipt_rel=$(printf '%s\n' "$terminal_json" |
    jq -r '.no_mistakes.receipt')
  terminal_receipt=$run_root/$terminal_receipt_rel
  [ -f "$terminal_receipt" ] && [ ! -L "$terminal_receipt" ] \
    || fail_contract "Gate terminal receipt is missing or unsafe" 73
  [ "$(realpath "$terminal_receipt" 2>/dev/null)" = "$terminal_receipt" ] \
    || fail_contract "Gate terminal receipt path must be canonical" 73
  terminal_arm_rel=$(printf '%s\n' "$terminal_json" | jq -r '.merge.arm')
  if [ -n "$terminal_arm_rel" ]; then
    terminal_arm=$run_root/$terminal_arm_rel
    [ -f "$terminal_arm" ] && [ ! -L "$terminal_arm" ] \
      || fail_contract "Gate terminal merge arm is missing or unsafe" 73
    [ "$(realpath "$terminal_arm" 2>/dev/null)" = "$terminal_arm" ] \
      || fail_contract "Gate terminal merge arm path must be canonical" 73
    terminal_arm_json=$(jq -c '.' "$terminal_arm" 2>/dev/null) \
      || fail_contract "invalid Gate terminal merge arm" 73
    validate_merge_arm "$terminal_arm_json" \
      || fail_contract "invalid Gate terminal merge arm" 73
  fi
  terminal_merge_outcome_rel=$(printf '%s\n' "$terminal_json" |
    jq -r '.merge.outcome')
  if [ -n "$terminal_merge_outcome_rel" ]; then
    terminal_merge_outcome=$run_root/$terminal_merge_outcome_rel
    [ -f "$terminal_merge_outcome" ] && [ ! -L "$terminal_merge_outcome" ] \
      || fail_contract "Gate terminal merge outcome is missing or unsafe" 73
    [ "$(realpath "$terminal_merge_outcome" 2>/dev/null)" = \
      "$terminal_merge_outcome" ] \
      || fail_contract "Gate terminal merge outcome path must be canonical" 73
    terminal_merge_outcome_json=$(jq -c '.' "$terminal_merge_outcome" 2>/dev/null) \
      || fail_contract "invalid Gate terminal merge outcome" 73
    validate_merge_outcome "$terminal_merge_outcome_json" \
      || fail_contract "invalid Gate terminal merge outcome" 73
    printf '%s\n' "$terminal_merge_outcome_json" |
      jq -e --arg pr "$(printf '%s\n' "$terminal_json" |
        jq -r '.no_mistakes.pr')" '.pr==$pr' >/dev/null 2>&1 \
      || fail_contract "Gate terminal merge outcome disagrees with PR" 73
    jq -en \
      --argjson arm "$terminal_arm_json" \
      --argjson outcome "$terminal_merge_outcome_json" '
        $arm.pr==$outcome.pr and
        $arm.requirements==$outcome.requirements
      ' >/dev/null 2>&1 \
      || fail_contract "Gate terminal merge evidence disagrees" 73
  fi
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

capture_no_mistakes_config_identity() {
  local argument config_path content in_override=0 in_runtime=0 line
  local model_flag_seen=0 model_pending=0 observed_model=''
  local observed_runtime='' override_seen=0

  [ -n "${HOME:-}" ] \
    || fail_contract "HOME is required to verify No-Mistakes identity" 73
  case "$HOME" in
    /*) ;;
    *) fail_contract "HOME must be absolute to verify No-Mistakes identity" 73 ;;
  esac
  config_path=$HOME/.no-mistakes/config.yaml
  [ -f "$config_path" ] && [ ! -L "$config_path" ] \
    || fail_contract "No-Mistakes effective config is missing or unsafe" 73
  nm_config_path=$(realpath "$config_path" 2>/dev/null) \
    || fail_contract "cannot resolve No-Mistakes effective config" 73
  [ "$nm_config_path" = "$config_path" ] \
    || fail_contract "No-Mistakes effective config path must be canonical" 73

  while IFS= read -r line || [ -n "$line" ]; do
    content=${line%%#*}
    if [[ "$content" =~ ^[[:space:]]*$ ]]; then
      continue
    fi
    if [[ "$content" =~ ^agent:[[:space:]]+([^[:space:]]+)[[:space:]]*$ ]]; then
      [ -z "$observed_runtime" ] \
        || fail_contract "No-Mistakes effective config repeats agent" 73
      observed_runtime=${BASH_REMATCH[1]}
      in_override=0
      in_runtime=0
      continue
    fi
    if [[ "$content" =~ ^agent_args_override:[[:space:]]*$ ]]; then
      [ "$override_seen" -eq 0 ] \
        || fail_contract "No-Mistakes effective config repeats agent_args_override" 73
      override_seen=1
      in_override=1
      in_runtime=0
      continue
    fi
    if [[ "$content" =~ ^[^[:space:]] ]]; then
      [ "$model_pending" -eq 0 ] \
        || fail_contract "No-Mistakes effective model argument is incomplete" 73
      in_override=0
      in_runtime=0
      continue
    fi
    if [ "$in_override" -eq 1 ] &&
      [[ "$content" =~ ^[[:space:]][[:space:]]([^[:space:]:]+):[[:space:]]*$ ]]; then
      [ "$model_pending" -eq 0 ] \
        || fail_contract "No-Mistakes effective model argument is incomplete" 73
      if [ "${BASH_REMATCH[1]}" = "$nm_runtime" ]; then
        in_runtime=1
      else
        in_runtime=0
      fi
      continue
    fi
    if [ "$in_runtime" -eq 1 ] &&
      [[ "$content" =~ ^[[:space:]][[:space:]][[:space:]][[:space:]]-[[:space:]]+([^[:space:]]+)[[:space:]]*$ ]]; then
      argument=${BASH_REMATCH[1]}
      if [ "$model_pending" -eq 1 ]; then
        [ "$model_flag_seen" -eq 0 ] && [ -z "$observed_model" ] \
          || fail_contract "No-Mistakes effective config repeats model" 73
        observed_model=$argument
        model_flag_seen=1
        model_pending=0
      else
        case "$argument" in
          --model)
            [ "$model_flag_seen" -eq 0 ] \
              || fail_contract "No-Mistakes effective config repeats model" 73
            model_pending=1
            ;;
          --model=*)
            [ "$model_flag_seen" -eq 0 ] \
              || fail_contract "No-Mistakes effective config repeats model" 73
            observed_model=${argument#*=}
            [ -n "$observed_model" ] \
              || fail_contract "No-Mistakes effective model is empty" 73
            model_flag_seen=1
            ;;
        esac
      fi
    fi
  done <"$nm_config_path"

  [ "$model_pending" -eq 0 ] \
    || fail_contract "No-Mistakes effective model argument is incomplete" 73
  [ "$observed_runtime" = "$nm_runtime" ] \
    || fail_contract "No-Mistakes effective runtime disagrees with Gate config" 73
  [ "$observed_model" = "$nm_model" ] \
    || fail_contract "No-Mistakes effective model disagrees with Gate config" 73
  nm_effective_runtime=$observed_runtime
  nm_effective_model=$observed_model
}

capture_no_mistakes_probe() {
  local label=$1 value status
  shift
  set +e
  value=$("$binary_path" "$@")
  status=$?
  set -e
  [ "$status" -eq 0 ] \
    || fail_contract "No-Mistakes $label probe failed" 73
  [ -n "$value" ] \
    || fail_contract "No-Mistakes $label probe returned no evidence" 73
  printf '%s' "$value"
}

capture_no_mistakes_config_identity
nm_version=$(capture_no_mistakes_probe version --version)
nm_doctor=$(capture_no_mistakes_probe doctor doctor)
nm_axi_run_help=$(capture_no_mistakes_probe "axi run help" axi run --help)
nm_axi_status_help=$(capture_no_mistakes_probe "axi status help" axi status --help)
nm_axi_respond_help=$(capture_no_mistakes_probe \
  "axi respond help" axi respond --help)
case "$nm_version" in
  *"no-mistakes version"*) ;;
  *) fail_contract "No-Mistakes version evidence is unrecognized" 73 ;;
esac
case "$nm_doctor" in
  *"gate validation"*"$nm_effective_runtime is runnable"*) ;;
  *) fail_contract "No-Mistakes doctor does not confirm configured runtime" 73 ;;
esac
case "$nm_axi_run_help" in
  *"no-mistakes axi run"*"--intent"*"--skip"*"--yes"*) ;;
  *) fail_contract "No-Mistakes axi run surface is unsupported" 73 ;;
esac
case "$nm_axi_run_help" in
  *"--auto-merge"*)
    fail_contract "No-Mistakes axi run unexpectedly exposes --auto-merge" 73
    ;;
esac
case "$nm_axi_status_help" in
  *"no-mistakes axi status"*"--run"*) ;;
  *) fail_contract "No-Mistakes axi status surface is unsupported" 73 ;;
esac
case "$nm_axi_respond_help" in
  *"no-mistakes axi respond"*"--action"*"--yes"*) ;;
  *) fail_contract "No-Mistakes axi respond surface is unsupported" 73 ;;
esac

preflight_json=$(jq -cn \
  --arg runtime "$nm_effective_runtime" --arg model "$nm_effective_model" \
  --arg config_path "$nm_config_path" --arg version "$nm_version" \
  --arg doctor "$nm_doctor" --arg run_help "$nm_axi_run_help" \
  --arg status_help "$nm_axi_status_help" \
  --arg respond_help "$nm_axi_respond_help" '
    {
      runtime:$runtime,
      model:$model,
      config_path:$config_path,
      version:$version,
      doctor:$doctor,
      axi_run_help:$run_help,
      axi_status_help:$status_help,
      axi_respond_help:$respond_help
    }
  ') || fail_contract "cannot freeze No-Mistakes preflight" 73
validate_no_mistakes_preflight "$preflight_json" \
  || fail_contract "invalid No-Mistakes preflight evidence" 73

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
    --arg merge "$merge_mode" \
    --argjson attempt "$attempt" --argjson argv "$nm_args_json" \
    --argjson preflight "$preflight_json" '
      def clean:
        type=="string" and length>0 and
        (explode | all(.[]; .>=32 and .!=127));
      type=="object" and
      keys==[
        "argv","binary","branch","candidate_sha","initial_attempt","merge",
        "preflight","run_id","schema","worktree"
      ] and
      .schema=="combo.gate-invocation/v3" and
      .run_id==$run and .branch==$branch and .worktree==$worktree and
      .candidate_sha==$sha and .binary==$binary and .argv==$argv and
      .merge==$merge and .preflight==$preflight and
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
    --arg merge "$merge_mode" \
    --argjson attempt "$attempt" --argjson argv "$nm_args_json" \
    --argjson preflight "$preflight_json" '
      {
        schema:"combo.gate-invocation/v3",
        run_id:$run,
        branch:$branch,
        worktree:$worktree,
        candidate_sha:$sha,
        initial_attempt:$attempt,
        merge:$merge,
        binary:$binary,
        argv:$argv,
        preflight:$preflight
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

# -/ 3/5

# -- 4/5 CORE · Serialize the shared No-Mistakes runtime and invoke it --
gate_leases_dir=${CB_GATE_LEASES_DIR:-"$HOME/.combo-chen/gate-v1-leases"}
case "$gate_leases_dir" in
  /*) ;;
  *) fail_contract "Gate leases directory must be absolute" ;;
esac
if ! mkdir -p "$gate_leases_dir" 2>/dev/null; then
  fail_contract "cannot create Gate leases directory" 73
fi
[ -d "$gate_leases_dir" ] && [ ! -L "$gate_leases_dir" ] \
  || fail_contract "Gate leases directory is unsafe" 73
[ "$(realpath "$gate_leases_dir" 2>/dev/null)" = "$gate_leases_dir" ] \
  || fail_contract "Gate leases directory path must be canonical" 73

lease_wait_seconds=${CB_GATE_LEASE_WAIT_SECONDS:-300}
lease_stale_seconds=${CB_GATE_LEASE_STALE_SECONDS:-1800}
lease_heartbeat_seconds=${CB_GATE_LEASE_HEARTBEAT_SECONDS:-30}
case "$lease_wait_seconds" in
  ''|*[!0-9]*) fail_contract "invalid Gate lease wait duration" ;;
esac
case "$lease_stale_seconds" in
  ''|*[!0-9]*) fail_contract "invalid Gate lease stale duration" ;;
esac
case "$lease_heartbeat_seconds" in
  ''|*[!0-9]*) fail_contract "invalid Gate lease heartbeat duration" ;;
esac
[ "$lease_wait_seconds" -gt 0 ] \
  || fail_contract "Gate lease wait duration must be positive"
[ "$lease_stale_seconds" -gt 0 ] \
  || fail_contract "Gate lease stale duration must be positive"
[ "$lease_heartbeat_seconds" -gt 0 ] \
  || fail_contract "Gate lease heartbeat duration must be positive"

gate_lease_lock=$gate_leases_dir/no-mistakes.lock
gate_lease_owner=$gate_lease_lock/owner.json
lease_token=$$-$(od -An -N8 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n')
[ -n "$lease_token" ] || lease_token=$$-$(date +%s)
lease_started=$(date +%s)
recovered_from=null

reclaim_stale_lease() {
  local owner_state=$1 owner_snapshot=$2 owner_pid=${3:-}
  local current_snapshot='' removed=0
  mkdir "$gate_lease_lock/.reap" 2>/dev/null || return 1
  case "$owner_state" in
    valid)
      if [ -f "$gate_lease_owner" ] && [ ! -L "$gate_lease_owner" ]; then
        current_snapshot=$(jq -c '.' "$gate_lease_owner" 2>/dev/null || true)
      fi
      if [ "$current_snapshot" = "$owner_snapshot" ] \
        && ! kill -0 "$owner_pid" 2>/dev/null; then
        rm -f -- "$gate_lease_owner"
        removed=1
      fi
      ;;
    malformed)
      current_snapshot=$(cat "$gate_lease_owner" 2>/dev/null || true)
      if [ "$current_snapshot" = "$owner_snapshot" ]; then
        rm -f -- "$gate_lease_owner" 2>/dev/null || true
        [ ! -e "$gate_lease_owner" ] && [ ! -L "$gate_lease_owner" ] \
          && removed=1
      fi
      ;;
    absent)
      if [ ! -e "$gate_lease_owner" ] && [ ! -L "$gate_lease_owner" ]; then
        removed=1
      fi
      ;;
  esac
  rmdir "$gate_lease_lock/.reap" 2>/dev/null || true
  if [ "$removed" -eq 1 ] && rmdir "$gate_lease_lock" 2>/dev/null; then
    return 0
  fi
  return 1
}

while ! mkdir "$gate_lease_lock" 2>/dev/null; do
  recovered_from=null
  [ -d "$gate_lease_lock" ] && [ ! -L "$gate_lease_lock" ] \
    || fail_contract "global Gate lease path is unsafe" 73
  owner_state=absent
  owner_snapshot=
  owner_pid=
  if [ -f "$gate_lease_owner" ] && [ ! -L "$gate_lease_owner" ]; then
    owner_snapshot=$(jq -c '.' "$gate_lease_owner" 2>/dev/null || true)
    if [ -n "$owner_snapshot" ] && validate_lease_owner "$owner_snapshot"; then
      owner_state=valid
      owner_pid=$(printf '%s\n' "$owner_snapshot" | jq -r '.pid')
    else
      owner_state=malformed
      owner_snapshot=$(cat "$gate_lease_owner" 2>/dev/null || true)
    fi
  elif [ -e "$gate_lease_owner" ] || [ -L "$gate_lease_owner" ]; then
    owner_state=malformed
  fi

  now=$(date +%s)
  should_reclaim=0
  recovery_evidence=null
  case "$owner_state" in
    valid)
      owner_same_identity=0
      if printf '%s\n' "$owner_snapshot" | jq -e \
        --arg run "$run" --arg branch "$branch" --arg worktree "$worktree" \
        --arg sha "$candidate_sha" '
          .run_id==$run and .branch==$branch and .worktree==$worktree and
          .candidate_sha==$sha
        ' >/dev/null 2>&1; then
        owner_same_identity=1
      fi
      lock_mtime=$(stat -c %Y "$gate_lease_lock" 2>/dev/null \
        || stat -f %m "$gate_lease_lock" 2>/dev/null \
        || printf '%s' "$now")
      case "$lock_mtime" in *[!0-9]*) lock_mtime=$now ;; esac
      if ! kill -0 "$owner_pid" 2>/dev/null \
        && { [ "$owner_same_identity" -eq 1 ] \
          || [ $((now - lock_mtime)) -ge "$lease_stale_seconds" ]; }; then
        should_reclaim=1
        recovery_evidence=$owner_snapshot
      fi
      ;;
    absent|malformed)
      lock_mtime=$(stat -c %Y "$gate_lease_lock" 2>/dev/null \
        || stat -f %m "$gate_lease_lock" 2>/dev/null \
        || printf '%s' "$now")
      case "$lock_mtime" in *[!0-9]*) lock_mtime=$now ;; esac
      if [ $((now - lock_mtime)) -ge "$lease_stale_seconds" ]; then
        should_reclaim=1
        recovery_evidence=$(jq -cn --arg state "$owner_state" '{state:$state}')
      fi
      ;;
  esac
  if [ "$should_reclaim" -eq 1 ] \
    && reclaim_stale_lease "$owner_state" "$owner_snapshot" "$owner_pid"; then
    recovered_from=$recovery_evidence
    continue
  fi
  [ $((now - lease_started)) -lt "$lease_wait_seconds" ] \
    || fail_contract "global No-Mistakes Gate lease timeout" 75
  sleep 0.05
done

[ "$(realpath "$gate_lease_lock" 2>/dev/null)" = "$gate_lease_lock" ] \
  || fail_contract "global Gate lease path must be canonical" 73
lease_acquired=$(date +%s)
gate_lease_owner_json=$(jq -cn \
  --arg run "$run" --arg branch "$branch" --arg worktree "$worktree" \
  --arg sha "$candidate_sha" --arg token "$lease_token" \
  --argjson attempt "$attempt" --argjson pid "$$" \
  --argjson acquired "$lease_acquired" '
    {
      schema:"combo.gate-lease-owner/v1",
      scope:"host-global",
      adapter:"no-mistakes",
      run_id:$run,
      branch:$branch,
      worktree:$worktree,
      candidate_sha:$sha,
      attempt:$attempt,
      pid:$pid,
      token:$token,
      acquired_at:$acquired
    }
  ')
validate_lease_owner "$gate_lease_owner_json" \
  || fail_contract "cannot build global Gate lease owner" 73
set -C
if exec 7>"$gate_lease_owner"; then
  :
else
  set +C
  rmdir "$gate_lease_lock" 2>/dev/null || true
  fail_contract "cannot reserve global Gate lease owner" 73
fi
set +C
if ! printf '%s\n' "$gate_lease_owner_json" >&7; then
  exec 7>&-
  rm -f -- "$gate_lease_owner"
  rmdir "$gate_lease_lock" 2>/dev/null || true
  fail_contract "cannot record global Gate lease owner" 73
fi
exec 7>&-
gate_lease_owned=1
chmod 0444 "$gate_lease_owner" \
  || fail_contract "cannot make global Gate lease owner read-only" 73

lease_rel=artifacts/gate/no-mistakes-lease-attempt-$attempt.json
lease=$run_root/$lease_rel
lease_tmp=$gate_artifacts/.no-mistakes-lease-attempt-$attempt.json.tmp.$$
[ ! -e "$lease" ] && [ ! -L "$lease" ] \
  || fail_contract "Gate lease evidence already exists" 73
[ ! -e "$lease_tmp" ] && [ ! -L "$lease_tmp" ] \
  || fail_contract "Gate lease evidence staging path already exists" 73
if [ "$recovered_from" = null ]; then
  lease_state=acquired
else
  lease_state=recovered
fi
lease_json=$(printf '%s\n' "$gate_lease_owner_json" | jq -c \
  --arg state "$lease_state" --argjson recovered "$recovered_from" '
    .schema="combo.gate-lease/v1" |
    .state=$state |
    .recovered_from=$recovered
  ')
set -C
if exec 8>"$lease_tmp"; then
  lease_tmp_owned=1
else
  set +C
  fail_contract "cannot reserve Gate lease evidence staging path" 73
fi
set +C
printf '%s\n' "$lease_json" >&8
exec 8>&-
chmod 0444 "$lease_tmp" \
  || fail_contract "cannot make Gate lease evidence read-only" 73
if ! ln "$lease_tmp" "$lease" 2>/dev/null; then
  fail_contract "Gate lease evidence publication collision" 73
fi
rm -f -- "$lease_tmp"
lease_tmp_owned=0
validate_lease_evidence "$lease" "$attempt" \
  || fail_contract "invalid published Gate lease evidence" 73

gate_lease_parent_pid=$$
(
  trap - 0 1 2 15
  while :; do
    sleep "$lease_heartbeat_seconds" || exit 0
    kill -0 "$gate_lease_parent_pid" 2>/dev/null || exit 0
    current_owner=$(cat "$gate_lease_owner" 2>/dev/null || true)
    [ "$current_owner" = "$gate_lease_owner_json" ] || exit 0
    touch "$gate_lease_lock" 2>/dev/null || exit 0
  done
) &
gate_lease_heartbeat_pid=$!

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
  --arg invocation "$invocation_rel" --arg lease "$lease_rel" \
  --arg receipt "$receipt_rel" '
    [
      {id:"gate-invocation",path:$invocation},
      {id:"gate-lease",path:$lease},
      {id:"no-mistakes-outcome",path:$receipt}
    ]
  ')
# -/ 4/5

# -- 5/5 CORE · Validate typed identity and normalize terminal outcome --
nm_outcome=$(toon_scalar "outcome:" "$receipt" 2>/dev/null || true)
nm_run_id=$(toon_scalar "  id:" "$receipt" 2>/dev/null || true)
nm_branch=$(toon_scalar "  branch:" "$receipt" 2>/dev/null || true)
nm_head=$(toon_scalar "  head:" "$receipt" 2>/dev/null || true)
nm_pr=$(toon_scalar "  pr:" "$receipt" 2>/dev/null || true)

validate_github_pr_object() {
  local json=$1
  printf '%s\n' "$json" | jq -e '
    def sha:
      type=="string" and test("^[0-9a-f]{40}([0-9a-f]{24})?$");
    def clean:
      type=="string" and length>0 and
      (explode | all(.[]; .>=32 and .!=127));
    type=="object" and
    keys==["headRefName","headRefOid","url"] and
    (.url|clean and startswith("https://")) and
    (.headRefName|clean) and (.headRefOid|sha)
  ' >/dev/null 2>&1
}

github_binary=
github_pr=
github_pr_json=
github_merge_observation=
github_repository=
github_requirements=
github_check_evidence=

resolve_github_binary() {
  local discovered
  [ -z "$github_binary" ] || return 0
  discovered=$(command -v gh 2>/dev/null) \
    || fail_contract "gh is required to verify the Gate PR" 73
  case "$discovered" in
    /*) ;;
    *) fail_contract "gh path must be absolute" 73 ;;
  esac
  [ -f "$discovered" ] && [ -x "$discovered" ] \
    || fail_contract "gh is missing or unsafe" 73
  github_binary=$(realpath "$discovered" 2>/dev/null) \
    || fail_contract "cannot resolve gh binary" 73
}

resolve_exact_github_pr() {
  local returned_url=$1 github_evidence github_status match_count
  resolve_github_binary

  if [ -n "$returned_url" ] && ! jq -en --arg url "$returned_url" '
    $url |
    type=="string" and length>0 and startswith("https://") and
    (explode | all(.[]; .>=32 and .!=127))
  ' >/dev/null 2>&1; then
    publish_gate_failed github_pr_url_invalid "$artifacts"
    exit 0
  fi

  set +e
  if [ -n "$returned_url" ]; then
    github_evidence=$(
      cd "$worktree" || exit 73
      "$github_binary" pr view "$returned_url" \
        --json url,headRefName,headRefOid </dev/null
    )
    github_status=$?
  else
    github_evidence=$(
      cd "$worktree" || exit 73
      "$github_binary" pr list --head "$branch" --state open --limit 2 \
        --json url,headRefName,headRefOid </dev/null
    )
    github_status=$?
  fi
  set -e
  [ "$github_status" -eq 0 ] \
    || fail_contract "GitHub PR lookup failed" 73

  if [ -n "$returned_url" ]; then
    validate_github_pr_object "$github_evidence" \
      || fail_contract "invalid GitHub PR evidence" 73
    github_pr_json=$(printf '%s\n' "$github_evidence" | jq -c '.') \
      || fail_contract "cannot normalize GitHub PR evidence" 73
    if ! printf '%s\n' "$github_pr_json" | jq -e \
      --arg url "$returned_url" --arg branch "$branch" \
      --arg sha "$candidate_sha" '
        .url==$url and .headRefName==$branch and .headRefOid==$sha
      ' >/dev/null 2>&1; then
      publish_gate_failed github_pr_identity_mismatch "$artifacts"
      exit 0
    fi
  else
    if ! printf '%s\n' "$github_evidence" |
      jq -e 'type=="array"' >/dev/null 2>&1; then
      fail_contract "invalid GitHub PR recovery evidence" 73
    fi
    match_count=$(printf '%s\n' "$github_evidence" | jq -r 'length') \
      || fail_contract "cannot count GitHub PR recovery evidence" 73
    case "$match_count" in
      0)
        publish_gate_failed github_pr_not_found "$artifacts"
        exit 0
        ;;
      1) ;;
      *)
        publish_gate_failed github_pr_ambiguous "$artifacts"
        exit 0
        ;;
    esac
    github_pr_json=$(printf '%s\n' "$github_evidence" | jq -c '.[0]') \
      || fail_contract "cannot normalize recovered GitHub PR" 73
    validate_github_pr_object "$github_pr_json" \
      || fail_contract "invalid recovered GitHub PR evidence" 73
    if ! printf '%s\n' "$github_pr_json" | jq -e \
      --arg branch "$branch" --arg sha "$candidate_sha" '
        .headRefName==$branch and .headRefOid==$sha
      ' >/dev/null 2>&1; then
      publish_gate_failed github_pr_identity_mismatch "$artifacts"
      exit 0
    fi
  fi

  github_pr=$(printf '%s\n' "$github_pr_json" | jq -r '.url') \
    || fail_contract "cannot read exact GitHub PR URL" 73
}

validate_merge_state_object() {
  local json=$1
  printf '%s\n' "$json" | jq -e '
    def sha:
      type=="string" and test("^[0-9a-f]{40}([0-9a-f]{24})?$");
    def clean:
      type=="string" and length>0 and
      (explode | all(.[]; .>=32 and .!=127));
    type=="object" and
    keys==[
      "autoMergeRequest","baseRefName","baseRefOid","headRefName",
      "headRefOid","mergeCommit","mergeStateStatus","mergeable",
      "mergedAt","state","url"
    ] and
    (.url|clean and startswith("https://")) and
    (.headRefName|clean) and (.headRefOid|sha) and
    (.baseRefName|clean) and (.baseRefOid|sha) and
    (.mergeStateStatus|clean) and (.mergeable|clean) and
    (.state=="OPEN" or .state=="CLOSED" or .state=="MERGED") and
    (.autoMergeRequest==null or
      (.autoMergeRequest |
        type=="object" and (.mergeMethod|clean))) and
    if .state=="MERGED" then
      (.mergedAt|clean) and
      (.mergeCommit|type=="object" and (.oid|sha))
    else
      .mergedAt==null and .mergeCommit==null
    end
  ' >/dev/null 2>&1
}

resolve_github_repository() {
  local evidence status
  [ -z "$github_repository" ] || return 0
  resolve_github_binary
  set +e
  evidence=$(
    cd "$worktree" || exit 73
    "$github_binary" repo view --json nameWithOwner,url </dev/null
  )
  status=$?
  set -e
  [ "$status" -eq 0 ] \
    || fail_contract "GitHub repository lookup failed" 73
  if ! printf '%s\n' "$evidence" | jq -e '
    def clean:
      type=="string" and length>0 and
      (explode | all(.[]; .>=32 and .!=127));
    type=="object" and keys==["nameWithOwner","url"] and
    (.nameWithOwner |
      type=="string" and test("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")) and
    (.url|clean and startswith("https://") and (endswith("/")|not))
  ' >/dev/null 2>&1; then
    fail_contract "invalid GitHub repository evidence" 73
  fi
  github_repository=$(printf '%s\n' "$evidence" | jq -c '
    {name_with_owner:.nameWithOwner,url:.url}
  ') || fail_contract "cannot normalize GitHub repository evidence" 73
}

capture_github_requirements() {
  local pr=$1 target_branch=$2 repository_name repository_url
  local encoded_branch endpoint evidence status checks
  resolve_github_repository
  repository_name=$(printf '%s\n' "$github_repository" |
    jq -r '.name_with_owner') \
    || fail_contract "cannot read GitHub repository identity" 73
  repository_url=$(printf '%s\n' "$github_repository" | jq -r '.url') \
    || fail_contract "cannot read GitHub repository URL" 73
  if ! jq -en --arg pr "$pr" --arg repository "$repository_url" '
    ($repository + "/pull/") as $prefix |
    ($pr|startswith($prefix)) and
    ($pr|ltrimstr($prefix)|test("^[1-9][0-9]*$"))
  ' >/dev/null 2>&1; then
    publish_gate_failed github_pr_repository_mismatch "$artifacts"
    exit 0
  fi
  encoded_branch=$(jq -rn --arg branch "$target_branch" '$branch|@uri') \
    || fail_contract "cannot encode GitHub target branch" 73
  endpoint="repos/$repository_name/branches/$encoded_branch/protection/required_status_checks"
  set +e
  evidence=$(
    cd "$worktree" || exit 73
    "$github_binary" api "$endpoint" </dev/null
  )
  status=$?
  set -e
  [ "$status" -eq 0 ] \
    || fail_contract "GitHub required-check policy lookup failed" 73
  if ! printf '%s\n' "$evidence" | jq -e '
    def clean:
      type=="string" and length>0 and
      (explode | all(.[]; .>=32 and .!=127));
    type=="object" and (.strict|type=="boolean") and
    (.contexts |
      type=="array" and all(.[]; clean) and
      (unique|length)==length) and
    ((has("checks")|not) or
      (.checks |
        type=="array" and all(.[];
          type=="object" and
          (.context|clean) and
          (.app_id==null or
            (.app_id |
              type=="number" and floor==. and
              (.==-1 or .>0)))))) and
    if ((.checks // [])|length)>0 then
      ((.contexts|sort|unique)==
        ([.checks[].context]|sort|unique))
    else true end
  ' >/dev/null 2>&1; then
    fail_contract "invalid GitHub required-check policy evidence" 73
  fi
  if ! printf '%s\n' "$evidence" |
    jq -e '.strict==true' >/dev/null 2>&1; then
    publish_gate_failed github_required_checks_not_strict "$artifacts"
    exit 0
  fi
  checks=$(printf '%s\n' "$evidence" | jq -c '
    if ((.checks // [])|length)>0 then
      [.checks[] | {context:.context,app_id:(.app_id // -1)}]
    else
      [.contexts[] | {context:.,app_id:-1}]
    end |
    sort_by(.context,.app_id)
  ') || fail_contract "cannot normalize GitHub required checks" 73
  if ! printf '%s\n' "$checks" |
    jq -e 'type=="array" and length>0' >/dev/null 2>&1; then
    publish_gate_failed github_required_checks_missing "$artifacts"
    exit 0
  fi
  github_requirements=$(jq -cn \
    --argjson repository "$github_repository" \
    --arg target "$target_branch" --argjson checks "$checks" '
      {
        repository:$repository,
        target_branch:$target,
        strict:true,
        checks:$checks
      }
    ') || fail_contract "cannot build GitHub required-check evidence" 73
  validate_required_checks "$github_requirements" \
    || fail_contract "invalid normalized GitHub required checks" 73
}

capture_github_check_evidence() {
  local repository_name checks_endpoint statuses_endpoint
  local checks_json statuses_json checks_status statuses_status
  resolve_github_repository
  repository_name=$(printf '%s\n' "$github_repository" |
    jq -r '.name_with_owner') \
    || fail_contract "cannot read GitHub repository identity" 73
  checks_endpoint="repos/$repository_name/commits/$candidate_sha/check-runs?filter=latest&per_page=100"
  statuses_endpoint="repos/$repository_name/commits/$candidate_sha/status?per_page=100"
  set +e
  checks_json=$(
    cd "$worktree" || exit 73
    "$github_binary" api "$checks_endpoint" </dev/null
  )
  checks_status=$?
  statuses_json=$(
    cd "$worktree" || exit 73
    "$github_binary" api "$statuses_endpoint" </dev/null
  )
  statuses_status=$?
  set -e
  [ "$checks_status" -eq 0 ] && [ "$statuses_status" -eq 0 ] \
    || fail_contract "GitHub exact-SHA check lookup failed" 73
  if ! printf '%s\n' "$checks_json" | jq -e \
    --arg sha "$candidate_sha" '
    def clean:
      type=="string" and length>0 and
      (explode | all(.[]; .>=32 and .!=127));
    def commit:
      type=="string" and test("^[0-9a-f]{40}([0-9a-f]{24})?$");
    . as $root |
    type=="object" and
    (.total_count |
      type=="number" and floor==. and .>=0 and .<=100) and
    (.check_runs |
      type=="array" and length==$root.total_count and
      all(.[];
        type=="object" and .head_sha==$sha and (.head_sha|commit) and
        (.name|clean) and (.status|clean) and
        (.conclusion==null or (.conclusion|clean)) and
        (.app |
          type=="object" and
          (.id|type=="number" and floor==. and .>0))))
  ' >/dev/null 2>&1; then
    fail_contract "invalid GitHub exact-SHA check-run evidence" 73
  fi
  if ! printf '%s\n' "$statuses_json" | jq -e \
    --arg sha "$candidate_sha" '
    def clean:
      type=="string" and length>0 and
      (explode | all(.[]; .>=32 and .!=127));
    . as $root |
    type=="object" and
    .sha==$sha and
    (.total_count |
      type=="number" and floor==. and .>=0 and .<100) and
    (.statuses |
      type=="array" and length==$root.total_count and
      all(.[];
        type=="object" and (.context|clean) and (.state|clean)))
  ' >/dev/null 2>&1; then
    fail_contract "invalid GitHub exact-SHA status evidence" 73
  fi
  github_check_evidence=$(jq -cn \
    --arg sha "$candidate_sha" \
    --argjson checks "$checks_json" --argjson statuses "$statuses_json" '
      {
        sha:$sha,
        check_runs:(
          [$checks.check_runs[] | {
            name:.name,
            app_id:.app.id,
            head_sha:.head_sha,
            status:(.status|ascii_upcase),
            conclusion:(
              if .conclusion==null then null
              else (.conclusion|ascii_upcase)
              end
            )
          }] | sort_by(.name,.app_id,.status,.conclusion)
        ),
        statuses:(
          [$statuses.statuses[] | {
            context:.context,
            state:(.state|ascii_upcase)
          }] | sort_by(.context,.state)
        )
      }
    ') || fail_contract "cannot normalize GitHub exact-SHA checks" 73
}

observe_exact_merge_state() {
  local pr=$1 evidence status target_branch
  resolve_github_binary
  set +e
  evidence=$(
    cd "$worktree" || exit 73
    "$github_binary" pr view "$pr" \
      --json url,headRefName,headRefOid,baseRefName,baseRefOid,state,autoMergeRequest,mergeStateStatus,mergeable,mergedAt,mergeCommit \
      </dev/null
  )
  status=$?
  set -e
  [ "$status" -eq 0 ] \
    || fail_contract "GitHub merge-state lookup failed" 73
  validate_merge_state_object "$evidence" \
    || fail_contract "invalid GitHub merge-state evidence" 73
  github_merge_observation=$(printf '%s\n' "$evidence" | jq -c '.') \
    || fail_contract "cannot normalize GitHub merge-state evidence" 73
  if ! printf '%s\n' "$github_merge_observation" | jq -e \
    --arg pr "$pr" --arg branch "$branch" --arg sha "$candidate_sha" '
      .url==$pr and .headRefName==$branch and .headRefOid==$sha
    ' >/dev/null 2>&1; then
    publish_gate_failed github_pr_identity_mismatch "$artifacts"
    exit 0
  fi
  target_branch=$(printf '%s\n' "$github_merge_observation" |
    jq -r '.baseRefName') \
    || fail_contract "cannot read GitHub target branch" 73
  capture_github_requirements "$pr" "$target_branch"
  capture_github_check_evidence
  github_merge_observation=$(jq -cn \
    --argjson observation "$github_merge_observation" \
    --argjson checks "$github_check_evidence" '
      $observation + {checks:$checks}
    ') || fail_contract "cannot attach exact-SHA checks to merge evidence" 73
  validate_merge_observation "$github_merge_observation" \
    || fail_contract "invalid normalized GitHub merge-state evidence" 73
}

merge_observation_is_armed() {
  local json=$1
  printf '%s\n' "$json" | jq -e '
    .state=="MERGED" or
    (.state=="OPEN" and
      (.autoMergeRequest |
        type=="object" and .mergeMethod=="REBASE"))
  ' >/dev/null 2>&1
}

publish_merge_arm() {
  local pr=$1 source=$2 observation=$3 arm_json existing
  arm_json=$(jq -cn \
    --arg run "$run" --arg branch "$branch" --arg worktree "$worktree" \
    --arg sha "$candidate_sha" --arg pr "$pr" \
    --arg gh "$github_binary" --arg source "$source" \
    --argjson requirements "$github_requirements" \
    --argjson observation "$observation" '
      {
        schema:"combo.gate-merge-arm/v2",
        run_id:$run,
        branch:$branch,
        worktree:$worktree,
        candidate_sha:$sha,
        pr:$pr,
        mode:"auto",
        state:"armed",
        source:$source,
        command:{
          binary:$gh,
          argv:["pr","merge",$pr,"--auto","--rebase"]
        },
        requirements:$requirements,
        observation:$observation
      }
    ') || fail_contract "cannot build Gate merge-arm evidence" 73
  validate_merge_arm "$arm_json" \
    || fail_contract "invalid Gate merge-arm evidence" 73

  [ ! -e "$merge_arm_tmp" ] && [ ! -L "$merge_arm_tmp" ] \
    || fail_contract "Gate merge-arm staging path already exists" 73
  set -C
  if exec 8>"$merge_arm_tmp"; then
    merge_arm_tmp_owned=1
  else
    set +C
    fail_contract "cannot reserve Gate merge-arm staging path" 73
  fi
  set +C
  printf '%s\n' "$arm_json" >&8
  exec 8>&-
  chmod 0444 "$merge_arm_tmp" \
    || fail_contract "cannot make Gate merge-arm evidence read-only" 73
  if ln "$merge_arm_tmp" "$merge_arm" 2>/dev/null; then
    rm -f -- "$merge_arm_tmp"
    merge_arm_tmp_owned=0
    return 0
  fi

  rm -f -- "$merge_arm_tmp"
  merge_arm_tmp_owned=0
  [ -f "$merge_arm" ] && [ ! -L "$merge_arm" ] \
    || fail_contract "Gate merge-arm publication collision" 73
  existing=$(jq -c '.' "$merge_arm" 2>/dev/null) \
    || fail_contract "invalid colliding Gate merge arm" 73
  validate_merge_arm "$existing" \
    || fail_contract "invalid colliding Gate merge arm" 73
}

publish_merge_outcome() {
  local pr=$1 observation=$2 requirements=$3 outcome_json existing
  outcome_json=$(jq -cn \
    --arg run "$run" --arg branch "$branch" --arg worktree "$worktree" \
    --arg sha "$candidate_sha" --arg pr "$pr" \
    --argjson requirements "$requirements" \
    --argjson observation "$observation" '
      {
        schema:"combo.gate-merge-outcome/v2",
        run_id:$run,
        branch:$branch,
        worktree:$worktree,
        candidate_sha:$sha,
        pr:$pr,
        outcome:"merged",
        requirements:$requirements,
        observation:$observation
      }
    ') || fail_contract "cannot build Gate merge-outcome evidence" 73
  validate_merge_outcome "$outcome_json" \
    || fail_contract "invalid Gate merge-outcome evidence" 73

  [ ! -e "$merge_outcome_tmp" ] && [ ! -L "$merge_outcome_tmp" ] \
    || fail_contract "Gate merge-outcome staging path already exists" 73
  set -C
  if exec 9>"$merge_outcome_tmp"; then
    merge_outcome_tmp_owned=1
  else
    set +C
    fail_contract "cannot reserve Gate merge-outcome staging path" 73
  fi
  set +C
  printf '%s\n' "$outcome_json" >&9
  exec 9>&-
  chmod 0444 "$merge_outcome_tmp" \
    || fail_contract "cannot make Gate merge-outcome evidence read-only" 73
  if ln "$merge_outcome_tmp" "$merge_outcome" 2>/dev/null; then
    rm -f -- "$merge_outcome_tmp"
    merge_outcome_tmp_owned=0
    return 0
  fi

  rm -f -- "$merge_outcome_tmp"
  merge_outcome_tmp_owned=0
  [ -f "$merge_outcome" ] && [ ! -L "$merge_outcome" ] \
    || fail_contract "Gate merge-outcome publication collision" 73
  existing=$(jq -c '.' "$merge_outcome" 2>/dev/null) \
    || fail_contract "invalid colliding Gate merge outcome" 73
  validate_merge_outcome "$existing" \
    || fail_contract "invalid colliding Gate merge outcome" 73
  printf '%s\n' "$existing" |
    jq -e --arg pr "$pr" '.pr==$pr' >/dev/null 2>&1 \
    || fail_contract "colliding Gate merge outcome disagrees with PR" 73
}

ensure_auto_merge_armed() {
  local pr=$1 existing state source command_status
  resolve_github_binary
  if [ -e "$merge_arm" ] || [ -L "$merge_arm" ]; then
    [ -f "$merge_arm" ] && [ ! -L "$merge_arm" ] \
      || fail_contract "Gate merge-arm evidence is unsafe" 73
    [ "$(realpath "$merge_arm" 2>/dev/null)" = "$merge_arm" ] \
      || fail_contract "Gate merge-arm path must be canonical" 73
    existing=$(jq -c '.' "$merge_arm" 2>/dev/null) \
      || fail_contract "invalid Gate merge-arm evidence" 73
    validate_merge_arm "$existing" \
      || fail_contract "invalid Gate merge-arm evidence" 73
    if ! printf '%s\n' "$existing" | jq -e \
      --arg pr "$pr" --arg gh "$github_binary" '
        .pr==$pr and .command.binary==$gh
      ' >/dev/null 2>&1; then
      fail_contract "Gate merge-arm evidence disagrees with this retry" 73
    fi
    return 0
  fi

  observe_exact_merge_state "$pr"
  verify_candidate \
    || { publish_gate_failed candidate_head_changed "$artifacts"; exit 0; }
  if merge_observation_is_armed "$github_merge_observation"; then
    source=observed
  else
    state=$(printf '%s\n' "$github_merge_observation" | jq -r '.state')
    if [ "$state" != OPEN ]; then
      publish_gate_failed github_pr_not_open "$artifacts"
      exit 0
    fi
    if ! printf '%s\n' "$github_merge_observation" |
      jq -e '.autoMergeRequest==null' >/dev/null 2>&1; then
      publish_gate_failed github_auto_merge_method_mismatch "$artifacts"
      exit 0
    fi
    verify_candidate \
      || { publish_gate_failed candidate_head_changed "$artifacts"; exit 0; }
    set +e
    (
      cd "$worktree" || exit 73
      "$github_binary" pr merge "$pr" --auto --rebase </dev/null
    ) >/dev/null 2>&1
    command_status=$?
    set -e
    verify_candidate \
      || { publish_gate_failed candidate_head_changed "$artifacts"; exit 0; }
    observe_exact_merge_state "$pr"
    verify_candidate \
      || { publish_gate_failed candidate_head_changed "$artifacts"; exit 0; }
    if ! merge_observation_is_armed "$github_merge_observation"; then
      if [ "$command_status" -eq 0 ]; then
        publish_gate_failed github_auto_merge_not_armed "$artifacts"
      else
        publish_gate_failed github_auto_merge_arm_failed "$artifacts"
      fi
      exit 0
    fi
    source='command'
  fi

  publish_merge_arm "$pr" "$source" "$github_merge_observation"
}

wait_for_auto_merge_outcome() {
  local pr=$1 poll_seconds arm_json state existing requirements
  poll_seconds=${CB_GATE_MERGE_POLL_SECONDS:-5}
  case "$poll_seconds" in
    ''|*[!0-9]*) fail_contract "invalid Gate merge poll interval" ;;
  esac

  if [ -e "$merge_outcome" ] || [ -L "$merge_outcome" ]; then
    [ -f "$merge_outcome" ] && [ ! -L "$merge_outcome" ] \
      || fail_contract "Gate merge-outcome evidence is unsafe" 73
    [ "$(realpath "$merge_outcome" 2>/dev/null)" = "$merge_outcome" ] \
      || fail_contract "Gate merge-outcome path must be canonical" 73
    existing=$(jq -c '.' "$merge_outcome" 2>/dev/null) \
      || fail_contract "invalid Gate merge-outcome evidence" 73
    validate_merge_outcome "$existing" \
      || fail_contract "invalid Gate merge-outcome evidence" 73
    printf '%s\n' "$existing" |
      jq -e --arg pr "$pr" '.pr==$pr' >/dev/null 2>&1 \
      || fail_contract "Gate merge-outcome evidence disagrees with this retry" 73
    return 0
  fi

  arm_json=$(jq -c '.' "$merge_arm" 2>/dev/null) \
    || fail_contract "invalid Gate merge-arm evidence" 73
  validate_merge_arm "$arm_json" \
    || fail_contract "invalid Gate merge-arm evidence" 73
  requirements=$(printf '%s\n' "$arm_json" | jq -c '.requirements') \
    || fail_contract "cannot read Gate merge-arm requirements" 73
  if printf '%s\n' "$arm_json" |
    jq -e '.observation.state=="MERGED"' >/dev/null 2>&1; then
    if ! required_checks_satisfied "$requirements" \
      "$(printf '%s\n' "$arm_json" | jq -c '.observation')"; then
      publish_gate_failed github_required_checks_incomplete "$artifacts"
      exit 0
    fi
    publish_merge_outcome "$pr" \
      "$(printf '%s\n' "$arm_json" | jq -c '.observation')" \
      "$requirements"
    return 0
  fi

  while :; do
    [ "$poll_seconds" -eq 0 ] || sleep "$poll_seconds"
    verify_candidate \
      || { publish_gate_failed candidate_head_changed "$artifacts"; exit 0; }
    observe_exact_merge_state "$pr"
    verify_candidate \
      || { publish_gate_failed candidate_head_changed "$artifacts"; exit 0; }
    if ! jq -en \
      --argjson sealed "$requirements" \
      --argjson current "$github_requirements" \
      '$sealed==$current' >/dev/null 2>&1; then
      publish_gate_failed github_required_checks_changed "$artifacts"
      exit 0
    fi
    state=$(printf '%s\n' "$github_merge_observation" | jq -r '.state')
    if [ "$state" = MERGED ]; then
      if ! required_checks_satisfied "$requirements" \
        "$github_merge_observation"; then
        publish_gate_failed github_required_checks_incomplete "$artifacts"
        exit 0
      fi
      publish_merge_outcome \
        "$pr" "$github_merge_observation" "$requirements"
      return 0
    fi
    if [ "$state" = CLOSED ]; then
      publish_gate_failed github_pr_closed "$artifacts"
      exit 0
    fi
    if ! merge_observation_is_armed "$github_merge_observation"; then
      publish_gate_failed github_auto_merge_cancelled "$artifacts"
      exit 0
    fi
  done
}

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

terminal_merge_arm=
terminal_merge_outcome=
case "$nm_outcome" in
  passed|checks-passed)
    [ "$nm_status" -eq 0 ] \
      || { publish_gate_failed no_mistakes_exit_mismatch "$artifacts"; exit 0; }
    github_pr=
    resolve_exact_github_pr "$nm_pr"
    nm_pr=$github_pr
    if ! verify_candidate; then
      publish_gate_failed candidate_head_changed "$artifacts"
      exit 0
    fi
    if [ "$merge_mode" = auto ]; then
      ensure_auto_merge_armed "$nm_pr"
      wait_for_auto_merge_outcome "$nm_pr"
      verify_candidate \
        || { publish_gate_failed candidate_head_changed "$artifacts"; exit 0; }
      terminal_merge_arm=$merge_arm_rel
      terminal_merge_outcome=$merge_outcome_rel
      gate_outcome=merged
    else
      gate_outcome=validated
    fi
    payload=$(jq -cn \
      --arg outcome "$gate_outcome" --arg sha "$candidate_sha" \
      --arg pr "$nm_pr" '
      {outcome:$outcome,sha:$sha,pr:$pr}
    ')
    normalized_outcome=$gate_outcome
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
  --arg invocation "$invocation_rel" --arg lease "$lease_rel" \
  --arg receipt "$receipt_rel" \
  --arg merge "$merge_mode" --arg arm "$terminal_merge_arm" \
  --arg merge_outcome "$terminal_merge_outcome" \
  --arg normalized "$normalized_outcome" \
  --argjson result "$normalized_result" '
    {
      schema:"combo.gate-terminal/v3",
      run_id:$run,
      branch:$branch,
      worktree:$worktree,
      candidate_sha:$sha,
      invocation:$invocation,
      lease:$lease,
      merge:{
        mode:$merge,
        arm:$arm,
        outcome:$merge_outcome
      },
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
# -/ 5/5
