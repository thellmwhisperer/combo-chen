#!/usr/bin/env bash
# @overview Normalize one configured direct-agent or GNHF Coder invocation
#   through combo.step-output/v1. The adapter validates its opaque config,
#   executes in an allowlisted environment with ordinary git pushes blocked,
#   and derives candidate readiness only from local Git facts.
#
#   READING GUIDE
#   -------------
#   1. Universal input validation   <- contain paths and identify the adapter.
#   2. Custody/config/Git preflight <- consume the Launcher handoff exactly once.
#   3. Isolated tool invocation     <- direct prompt or bounded GNHF loop.
#   4. Candidate normalization      <- publish exact local SHA or stable error.
#
#   MAIN FLOW
#   ---------
#   step input -> Launcher custody -> config/Git preflight -> tool -> output
#
#   PUBLIC API
#   ----------
#   cb-agent-run.sh <direct-agent|gnhf> --input <path> --output <path>
#
#   INTERNALS
#   ---------
#   usage, fail_contract, publish_outcome, reject, valid_config,
#   build_environment, install_git_guard, canonical_git_common
#
# @exports none
# @deps bash, env, git, jq, realpath, stat
set -euo pipefail

usage() {
  echo "usage: cb-agent-run <direct-agent|gnhf> --input <path> --output <path>" >&2
  exit 64
}

fail_contract() {
  echo "cb-agent-run: $1" >&2
  exit "${2:-64}"
}

[ "$#" -eq 5 ] || usage
adapter=$1
[ "$2" = --input ] || usage
input=$3
[ "$4" = --output ] || usage
output=$5
case "$adapter" in direct-agent|gnhf) ;; *) usage ;; esac
command -v env >/dev/null 2>&1 || fail_contract "env is required" 73
command -v git >/dev/null 2>&1 || fail_contract "git is required" 73
command -v jq >/dev/null 2>&1 || fail_contract "jq is required" 73
command -v realpath >/dev/null 2>&1 || fail_contract "realpath is required" 73

# -- 1/4 CORE · Validate the universal input and contained output -- <- START HERE
[ -f "$input" ] && [ ! -L "$input" ] \
  || fail_contract "input is missing or unsafe" 73
input_real=$(realpath "$input" 2>/dev/null) \
  || fail_contract "cannot resolve input" 73
[ "$input_real" = "$input" ] || fail_contract "input path is not canonical" 73

if ! jq -e --arg adapter "$adapter" --arg input "$input" --arg output "$output" '
  def valid_run: type=="string" and test("^[a-z0-9][a-z0-9-]*$");
  type=="object" and
  .schema=="combo.step-input/v1" and
  (.run_id|valid_run) and .step_id=="coder" and .role=="coder" and
  .adapter_id==$adapter and
  (.attempt|type=="number" and floor==. and .>0) and
  (.candidate_sha==null or
    (.candidate_sha|type=="string" and test("^[0-9a-f]{40}([0-9a-f]{24})?$"))) and
  (.config|type=="object") and (.prior_artifacts|type=="array") and
  (.paths|type=="object") and
  .paths.input_path==$input and .paths.output_path==$output and
  (.paths.run_dir|type=="string" and length>0) and
  (.paths.invocation_dir|type=="string" and length>0)
' "$input" >/dev/null 2>&1; then
  fail_contract "input does not satisfy the Coder adapter contract"
fi

run_id=$(jq -r '.run_id' "$input")
step_id=$(jq -r '.step_id' "$input")
attempt=$(jq -r '.attempt' "$input")
candidate_sha=$(jq -r '.candidate_sha // empty' "$input")
invocation_dir=$(jq -r '.paths.invocation_dir' "$input")

[ -d "$invocation_dir" ] && [ ! -L "$invocation_dir" ] \
  || fail_contract "invocation directory is unsafe" 73
invocation_root=$(realpath "$invocation_dir" 2>/dev/null) \
  || fail_contract "cannot resolve invocation directory" 73
[ "$invocation_root" = "$invocation_dir" ] \
  || fail_contract "invocation directory is not canonical" 73
[ "$input" = "$invocation_root/input.json" ] \
  || fail_contract "input escapes invocation directory" 73
[ "$output" = "$invocation_root/adapter-output.json" ] \
  || fail_contract "output escapes invocation directory" 73
[ ! -e "$output" ] && [ ! -L "$output" ] \
  || fail_contract "output already exists or is unsafe" 73

output_tmp=$invocation_root/.coder-output.$$
output_tmp_owned=0
git_guard=
cleanup() {
  [ "$output_tmp_owned" -eq 0 ] || rm -f -- "$output_tmp"
  if [ -n "$git_guard" ] && [ -d "$git_guard" ]; then
    chmod 0755 "$git_guard" 2>/dev/null || true
    rm -f -- "$git_guard/git" 2>/dev/null || true
    rmdir "$git_guard" 2>/dev/null || true
  fi
}
trap cleanup 0
trap 'exit 130' 1 2 15

publish_outcome() {
  local code=$1 detail=${2:-} sha=${3:-} branch=${4:-}
  if [ "$code" -eq 0 ]; then
    (set -C; jq -cn \
      --arg run "$run_id" --arg step "$step_id" \
      --argjson attempt "$attempt" --arg sha "$sha" --arg branch "$branch" '
        {
          schema:"combo.step-output/v1",
          run_id:$run,step_id:$step,role:"coder",attempt:$attempt,
          exit_class:"completed",
          events:[{code:0,event:"coder_ready",payload:{
            sha:$sha,branch:$branch
          }}],
          artifacts:[],reasons:[],errors:[]
        }
      ' >"$output_tmp") 2>/dev/null \
      || fail_contract "cannot stage adapter output" 73
  else
    (set -C; jq -cn \
      --arg run "$run_id" --arg step "$step_id" \
      --argjson attempt "$attempt" --arg detail "$detail" '
        {
          schema:"combo.step-output/v1",
          run_id:$run,step_id:$step,role:"coder",attempt:$attempt,
          exit_class:"completed",
          events:[{code:1,event:"coder_not_ready",payload:{
            errors:[$detail]
          }}],
          artifacts:[],reasons:[],errors:[]
        }
      ' >"$output_tmp") 2>/dev/null \
      || fail_contract "cannot stage adapter output" 73
  fi
  output_tmp_owned=1
  chmod 0444 "$output_tmp" || fail_contract "cannot protect adapter output" 73
  ln "$output_tmp" "$output" 2>/dev/null \
    || fail_contract "adapter output publication collision" 73
  rm -f -- "$output_tmp"
  output_tmp_owned=0
  exit 0
}

reject() {
  publish_outcome 1 "$1"
}
# -/ 1/4

# -- 2/4 CORE · Validate adapter config and local Git preconditions --
valid_config() {
  if [ "$adapter" = direct-agent ]; then
    jq -e '
      def env_name: type=="string" and test("^[A-Za-z_][A-Za-z0-9_]*$");
      def reserved_env: startswith("COMBO_CODER_");
      def strings: type=="array" and length>0 and
        all(.[]; type=="string" and length>0 and
          (explode|all(.[]; .!=0)));
      .config |
      type=="object" and
      keys==["argv","environment","output_schema","prompt","schema"] and
      .schema=="combo.coder/direct-agent/v1" and
      (.argv|strings and
        all(.[]; ((.=="--push" or startswith("--push="))|not))) and
      (.prompt|type=="string" and length>0) and
      .output_schema=="combo.step-output/v1" and
      (.environment|type=="object" and keys==["inherit","set"]) and
      (.environment.inherit|
        type=="array" and length>0 and
        all(.[]; env_name and (reserved_env|not)) and
        length==(unique|length) and index("PATH")!=null) and
      (.environment.set|type=="object" and
        all(to_entries[]; (.key|env_name and (reserved_env|not)) and
          (.value|type=="string" and (explode|all(.[]; .!=0))))) and
      ((.environment.inherit + (.environment.set|keys)) |
        length==(unique|length))
    ' "$input" >/dev/null 2>&1
  else
    jq -e '
      def env_name: type=="string" and test("^[A-Za-z_][A-Za-z0-9_]*$");
      def reserved_env: startswith("COMBO_CODER_");
      def strings: type=="array" and length>0 and
        all(.[]; type=="string" and length>0 and
          (explode|all(.[]; .!=0)));
      .config |
      type=="object" and
      keys==["agent","argv","current_branch","environment","max_iterations",
        "meteor_frequency","output_schema","prevent_sleep","prompt","schema",
        "stop_when"] and
      .schema=="combo.coder/gnhf/v1" and
      (.argv|strings and
        all(.[]; ((.=="--push" or startswith("--push="))|not))) and
      (.prompt|type=="string" and length>0) and
      (.agent|type=="string" and length>0) and
      (.max_iterations|type=="number" and floor==. and .>0) and
      (.stop_when|type=="string" and length>0) and
      .prevent_sleep=="on" and .meteor_frequency==0 and
      .current_branch==true and
      .output_schema=="combo.step-output/v1" and
      (.environment|type=="object" and keys==["inherit","set"]) and
      (.environment.inherit|
        type=="array" and length>0 and
        all(.[]; env_name and (reserved_env|not)) and
        length==(unique|length) and index("PATH")!=null) and
      (.environment.set|type=="object" and
        all(to_entries[]; (.key|env_name and (reserved_env|not)) and
          (.value|type=="string" and (explode|all(.[]; .!=0))))) and
      ((.environment.inherit + (.environment.set|keys)) |
        length==(unique|length))
    ' "$input" >/dev/null 2>&1
  fi
}

if ! valid_config; then
  if [ "$adapter" = direct-agent ]; then
    reject "config:invalid_direct_agent"
  else
    reject "config:invalid_gnhf"
  fi
fi

run_dir=$(jq -r '.paths.run_dir' "$input")
[ -d "$run_dir" ] && [ ! -L "$run_dir" ] \
  || reject "custody:run_dir_invalid"
run_root=$(realpath "$run_dir" 2>/dev/null) \
  || reject "custody:run_dir_invalid"
[ "$run_root" = "$run_dir" ] || reject "custody:run_dir_invalid"
case "$invocation_root" in "$run_root"/steps/*/attempt-"$attempt") ;;
  *) reject "custody:run_dir_invalid" ;;
esac

ownership=$run_root/agents/launcher.ownership.json
if [ ! -e "$ownership" ] && [ ! -L "$ownership" ]; then
  reject "custody:missing"
fi
[ -f "$ownership" ] && [ ! -L "$ownership" ] \
  || reject "custody:invalid"
[ "$(realpath "$ownership" 2>/dev/null || true)" = "$ownership" ] \
  || reject "custody:invalid"
ownership_mode=$(stat -c '%a' "$ownership" 2>/dev/null \
  || stat -f '%Lp' "$ownership" 2>/dev/null || true)
[ "$ownership_mode" = 444 ] || reject "custody:not_read_only"
if ! jq -e --arg run "$run_id" '
  def sha:
    type=="string" and test("^[0-9a-f]{40}([0-9a-f]{24})?$");
  def text:
    type=="string" and length>0 and
    (explode | all(.[]; .>=32 and .!=127));
  type=="object" and
  .run==$run and
  (.runway_kind=="treehouse" or .runway_kind=="git-worktree-explicit") and
  (.repo_dir|text and startswith("/")) and
  (.worktree|text and startswith("/")) and
  (.branch|text) and (.base_sha|sha) and
  if .runway_kind=="treehouse" then
    keys==[
      "base_sha","branch","lease_id","repo_dir","run","runway_kind","worktree"
    ] and .lease_id==$run
  else
    keys==[
      "base_sha","branch","ownership_id","repo_dir","run","runway_kind",
      "worktree"
    ] and .ownership_id==("git-worktree:" + $run)
  end
' "$ownership" >/dev/null 2>&1; then
  reject "custody:invalid"
fi

repo_dir=$(jq -r '.repo_dir' "$ownership")
worktree=$(jq -r '.worktree' "$ownership")
base_sha=$(jq -r '.base_sha' "$ownership")
branch=$(jq -r '.branch' "$ownership")
[ -d "$repo_dir" ] && [ ! -L "$repo_dir" ] \
  || reject "custody:repo_mismatch"
[ "$(realpath "$repo_dir" 2>/dev/null || true)" = "$repo_dir" ] \
  || reject "custody:repo_mismatch"
[ -d "$worktree" ] && [ ! -L "$worktree" ] \
  || reject "custody:worktree_mismatch"
worktree_root=$(realpath "$worktree" 2>/dev/null) \
  || reject "custody:worktree_mismatch"
[ "$worktree_root" = "$worktree" ] || reject "custody:worktree_mismatch"
[ "$(git -C "$worktree" rev-parse --show-toplevel 2>/dev/null || true)" = "$worktree" ] \
  || reject "custody:worktree_mismatch"
canonical_git_common() {
  local directory=$1 common
  common=$(git -C "$directory" rev-parse --git-common-dir 2>/dev/null) \
    || return 1
  case "$common" in
    /*) realpath "$common" 2>/dev/null ;;
    *) realpath "$directory/$common" 2>/dev/null ;;
  esac
}
repo_common=$(canonical_git_common "$repo_dir" || true)
worktree_common=$(canonical_git_common "$worktree" || true)
[ -n "$repo_common" ] && [ "$worktree_common" = "$repo_common" ] \
  || reject "custody:repo_mismatch"
git check-ref-format --branch "$branch" >/dev/null 2>&1 \
  || reject "custody:invalid"
[ "$(git -C "$worktree" symbolic-ref --quiet --short HEAD 2>/dev/null || true)" = "$branch" ] \
  || reject "custody:branch_mismatch"
git -C "$worktree" cat-file -e "$base_sha^{commit}" 2>/dev/null \
  || reject "custody:base_mismatch"

pre_head=$(git -C "$worktree" rev-parse HEAD 2>/dev/null) \
  || reject "candidate:head_unreadable"
if [ -n "$candidate_sha" ] && [ "$pre_head" != "$candidate_sha" ]; then
  reject "candidate:head_mismatch"
fi
if [ -z "$candidate_sha" ] && [ "$pre_head" != "$base_sha" ]; then
  reject "candidate:base_mismatch"
fi
git -C "$worktree" merge-base --is-ancestor "$base_sha" "$pre_head" 2>/dev/null \
  || reject "candidate:base_not_ancestor"
[ -z "$(git -C "$worktree" status --porcelain=v1 2>/dev/null)" ] \
  || reject "candidate:dirty_worktree"
# -/ 2/4

# -- 3/4 CORE · Execute the configured tool in an isolated environment --
build_environment() {
  local name value
  tool_environment=()
  configured_path=
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    value=${!name-}
    if [ "$name" = PATH ]; then
      configured_path=$value
    else
      tool_environment+=("$name=$value")
    fi
  done < <(jq -r '.config.environment.inherit[]' "$input")
  while IFS= read -r -d '' name && IFS= read -r -d '' value; do
    tool_environment+=("$name=$value")
  done < <(jq -j '
    .config.environment.set | to_entries[] |
      .key + "\u0000" + .value + "\u0000"
  ' "$input")
}

install_git_guard() {
  local guard=$invocation_root/git-guard
  local real_git real_git_quoted
  real_git=$(command -v git)
  printf -v real_git_quoted '%q' "$real_git"
  mkdir "$guard" 2>/dev/null || fail_contract "cannot create git guard" 73
  git_guard=$guard
  (set -C; printf '%s\n' \
    '#!/usr/bin/env bash' \
    'for argument do' \
    '  [ "$argument" != push ] || exit 1' \
    'done' \
    "exec $real_git_quoted \"\$@\"" \
    >"$guard/git") 2>/dev/null \
    || fail_contract "cannot install git guard" 73
  # These modes deter accidental replacement; they are not an integrity
  # boundary against the same-UID tool, which can chmod/mv the guard or invoke
  # the embedded Git path directly. The gatekeeper remains the trusted
  # publisher; this wrapper only rejects ordinary PATH-routed pushes.
  chmod 0555 "$guard/git" "$guard" \
    || fail_contract "cannot set git guard modes" 73
}

tool_argv=()
while IFS= read -r -d '' argument; do
  tool_argv+=("$argument")
done < <(jq -j '.config.argv[] | . + "\u0000"' "$input")
prompt=$(jq -r '.config.prompt' "$input")
tool_argv+=("$prompt")
if [ "$adapter" = gnhf ]; then
  tool_argv+=(
    --agent "$(jq -r '.config.agent' "$input")"
    --max-iterations "$(jq -r '.config.max_iterations' "$input")"
    --stop-when "$(jq -r '.config.stop_when' "$input")"
    --prevent-sleep "$(jq -r '.config.prevent_sleep' "$input")"
    --meteor-frequency "$(jq -r '.config.meteor_frequency' "$input")"
    --current-branch
  )
fi

build_environment
install_git_guard
[ -n "$configured_path" ] || reject "config:path_unavailable"
tool_environment+=(
  "PATH=$git_guard:$configured_path"
  "COMBO_CODER_ADAPTER_ID=$adapter"
  "COMBO_CODER_STEP_INPUT=$input"
  "COMBO_CODER_WORKTREE=$worktree"
)

set +e
(
  cd "$worktree"
  env -i "${tool_environment[@]}" "${tool_argv[@]}" </dev/null
)
tool_status=$?
set -e
[ "$tool_status" -eq 0 ] || reject "agent:exit_$tool_status"
# -/ 3/4

# -- 4/4 CORE · Derive candidate readiness from local Git facts --
post_head=$(git -C "$worktree" rev-parse HEAD 2>/dev/null) \
  || reject "candidate:head_unreadable"
[ "$post_head" != "$pre_head" ] || reject "candidate:no_new_commit"
[ "$(git -C "$worktree" symbolic-ref --quiet --short HEAD 2>/dev/null || true)" = "$branch" ] \
  || reject "candidate:branch_changed"
git -C "$worktree" merge-base --is-ancestor "$pre_head" "$post_head" 2>/dev/null \
  || reject "candidate:history_rewritten"
git -C "$worktree" merge-base --is-ancestor "$base_sha" "$post_head" 2>/dev/null \
  || reject "candidate:base_not_ancestor"
if git -C "$worktree" diff --quiet "$pre_head" "$post_head" --; then
  reject "candidate:no_changeset"
fi
[ -z "$(git -C "$worktree" status --porcelain=v1 2>/dev/null)" ] \
  || reject "candidate:dirty_worktree"

publish_outcome 0 "" "$post_head" "$branch"
# -/ 4/4
