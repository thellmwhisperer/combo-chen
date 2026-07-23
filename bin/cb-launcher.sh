#!/bin/sh
# @overview Mechanical Combo v1 Launcher. Acquires one declared runway, records
#   exact custody, verifies generic seat readiness, and emits one 0/1 event.
#
#   READING GUIDE
#   -------------
#   1. Readiness checks          <- all failures aggregate before acquisition.
#   2. acquire_treehouse         <- authoritative normal runway.
#   3. acquire_explicit_git      <- separately requested fallback attempt.
#   4. Finalization              <- tracked policy copy, optional setup, event.
#
#   MAIN FLOW
#   ---------
#   config -> readiness -> exact ownership record -> branch -> launch_ready
#
#   PUBLIC API
#   ----------
#   cb-launcher.sh <runId>  Launch one mechanical run bubble; no LLM calls.
#
#   INTERNALS
#   ---------
#   add_reason, emit_not_ready, publish_ownership, rollback_acquisition
#
# @exports none
# @deps sh, git, jq, tmux, treehouse (normal runway), cb-emit.sh
set -eu

usage() {
  echo "usage: cb-launcher <runId>" >&2
  exit 64
}

[ "$#" -eq 1 ] || usage
run=$1
case "$run" in ''|-*|*[!a-z0-9-]*) usage ;; esac

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname "$0")" && pwd)
runs_dir=${CB_RUNS_DIR:-"$HOME/.combo-chen/runs"}
run_dir=$runs_dir/$run
[ -d "$run_dir" ] && [ ! -L "$run_dir" ] || { echo "cb-launcher: invalid run directory" >&2; exit 73; }
runs_root=$(realpath "$runs_dir" 2>/dev/null) || { echo "cb-launcher: cannot resolve runs directory" >&2; exit 73; }
run_root=$(realpath "$run_dir" 2>/dev/null) || { echo "cb-launcher: cannot resolve run directory" >&2; exit 73; }
case "$run_root" in "$runs_root"/"$run") ;; *) echo "cb-launcher: run directory escapes runs root" >&2; exit 73 ;; esac

config=$run_dir/config.env
[ -f "$config" ] && [ ! -L "$config" ] || { echo "cb-launcher: config.env missing or unsafe" >&2; exit 73; }
[ "$(realpath "$config" 2>/dev/null)" = "$run_root/config.env" ] \
  || { echo "cb-launcher: config.env escapes run directory" >&2; exit 73; }
# shellcheck disable=SC1090
. "$config"

agents_dir=$run_dir/agents
[ ! -L "$agents_dir" ] || { echo "cb-launcher: agents directory is a symlink" >&2; exit 73; }
mkdir -p "$agents_dir"
[ "$(realpath "$agents_dir" 2>/dev/null)" = "$run_root/agents" ] \
  || { echo "cb-launcher: agents directory escapes run directory" >&2; exit 73; }

reasons_file=$run_dir/.launcher-reasons.$$
seats_file=$run_dir/.launcher-seats.$$
treehouse_out=$run_dir/.launcher-treehouse-out.$$
treehouse_err=$run_dir/.launcher-treehouse-err.$$
ownership_file=$agents_dir/launcher.ownership.json
ownership_tmp=$agents_dir/.launcher.ownership.tmp.$$
config_tmp=$run_dir/.config.env.tmp.$$
: >"$reasons_file"
acquired=0
cleanup() {
  rm -f "$reasons_file" "$seats_file" "$treehouse_out" "$treehouse_err" "$ownership_tmp" "$config_tmp"
}
trap cleanup 0
trap 'exit 130' 1 2 15

add_reason() { printf '%s\n' "$1" >>"$reasons_file"; }
has_reasons() { [ -s "$reasons_file" ]; }
emit_not_ready() {
  [ "$acquired" -eq 0 ] || rollback_acquisition
  reasons=$(jq -Rsc '[split("\n")[] | select(length>0)]' "$reasons_file")
  payload=$(jq -cn --argjson reasons "$reasons" '{reasons:$reasons}')
  CB_RUNS_DIR=$runs_dir sh "$SCRIPT_DIR/cb-emit.sh" \
    --run "$run" --agent launcher --code 1 --event launch_not_ready --payload "$payload"
  exit 1
}
safe_label() {
  label=$(basename -- "$1" 2>/dev/null | tr -cd 'A-Za-z0-9._-' || true)
  [ -n "$label" ] || label=harness
  printf '%s\n' "$label"
}
canonical_git_common() {
  cwd=$1
  common=$(git -C "$cwd" rev-parse --git-common-dir 2>/dev/null) || return 1
  case "$common" in
    /*) realpath "$common" 2>/dev/null ;;
    *) realpath "$cwd/$common" 2>/dev/null ;;
  esac
}
treehouse_lease_owned() {
  lease_path=$1 lease_holder=$2
  status=$(cd "$repo_dir" && treehouse status 2>/dev/null) || return 1
  display_path=$lease_path
  case "$lease_path" in
    "$HOME"/*)
      home_prefix=$HOME/
      tilde=$(printf '\176')
      display_path=$tilde/${lease_path#"$home_prefix"}
      ;;
  esac
  printf '%s\n' "$status" | awk -v path="$display_path" -v holder="(held by $lease_holder)" '
    index($0,path)>0 && index($0,holder)>0 { matches++ }
    END { exit !(matches==1) }
  '
}
treehouse_path_for_holder() {
  display=$(cd "$repo_dir" && treehouse status 2>/dev/null | awk -v holder="(held by $run)" '
    index($0,holder)>0 { matches++; path=$3 }
    END { if (matches==1) print path }
  ') || return 1
  tilde=$(printf '\176')
  case "$display" in
    "$tilde"/*) printf '%s/%s\n' "$HOME" "${display#"$tilde"/}" ;;
    /*) printf '%s\n' "$display" ;;
    *) return 1 ;;
  esac
}
shell_quote() {
  printf "'"
  printf '%s' "$1" | sed "s/'/'\\\\''/g"
  printf "'"
}
publish_ownership() {
  kind=$1 worktree=$2 branch=$3 base_sha=$4
  if [ "$kind" = treehouse ]; then
    jq -cn \
      --arg run "$run" --arg kind "$kind" --arg repo "$repo_dir" --arg worktree "$worktree" \
      --arg branch "$branch" --arg base "$base_sha" --arg lease "$run" \
      '{run:$run,runway_kind:$kind,repo_dir:$repo,worktree:$worktree,branch:$branch,base_sha:$base,lease_id:$lease}' \
      >"$ownership_tmp"
  else
    jq -cn \
      --arg run "$run" --arg kind "$kind" --arg repo "$repo_dir" --arg worktree "$worktree" \
      --arg branch "$branch" --arg base "$base_sha" --arg owner "git-worktree:$run" \
      '{run:$run,runway_kind:$kind,repo_dir:$repo,worktree:$worktree,branch:$branch,base_sha:$base,ownership_id:$owner}' \
      >"$ownership_tmp"
  fi
  mv "$ownership_tmp" "$ownership_file"
}
rollback_acquisition() {
  if [ "$mode" = treehouse ]; then
    if treehouse_lease_owned "$worktree" "$run" \
      && (cd "$repo_dir" && treehouse return "$worktree") </dev/null >/dev/null 2>&1; then
      rm -f "$ownership_file"
      acquired=0
    else
      add_reason "treehouse:rollback_refused"
    fi
  elif [ ! -e "$worktree" ] \
    || git -C "$repo_dir" worktree remove "$worktree" >/dev/null 2>&1; then
    if git -C "$repo_dir" show-ref --verify --quiet "refs/heads/$branch" \
      && ! git -C "$repo_dir" branch -D "$branch" >/dev/null 2>&1; then
      add_reason "git-worktree:rollback_refused"
      return
    fi
    rm -f "$ownership_file"
    acquired=0
  else
    add_reason "git-worktree:rollback_refused"
  fi
}

# -- 1/4 CORE · Aggregate tool and generic seat readiness -- <- START HERE
repo_dir=${CB_REPO_DIR:-}
mode=${CB_RUNWAY_MODE:-treehouse}
# P4 supplies run-local JSON:
# {"required_seats":["id"],"seats":[{"id":"id","harness":"bin-or-path","auth_cmd":"non-interactive shell check"}]}
readiness_file=${CB_READINESS_FILE:-}
base_ref=${CB_BASE_REF:-HEAD}
setup_cmd=${CB_SETUP_CMD:-}

for tool in git jq tmux; do
  command -v "$tool" >/dev/null 2>&1 || add_reason "tool:$tool:missing"
done
case "$mode" in
  treehouse) command -v treehouse >/dev/null 2>&1 || add_reason "tool:treehouse:missing" ;;
  git-worktree-explicit) ;;
  *) add_reason "runway:unsupported_mode" ;;
esac

if [ -z "$repo_dir" ] || [ ! -d "$repo_dir" ] || [ -L "$repo_dir" ]; then
  add_reason "repo:missing_or_unsafe"
else
  repo_dir=$(realpath "$repo_dir" 2>/dev/null || printf '')
  [ -n "$repo_dir" ] && git -C "$repo_dir" rev-parse --git-dir >/dev/null 2>&1 \
    || add_reason "repo:not_git"
fi

readiness_ok=1
if [ -z "$readiness_file" ] || [ ! -f "$readiness_file" ] || [ -L "$readiness_file" ]; then
  add_reason "readiness:missing_or_unsafe"
  readiness_ok=0
else
  readiness_real=$(realpath "$readiness_file" 2>/dev/null || printf '')
  case "$readiness_real" in "$run_root"/*) ;; *) add_reason "readiness:outside_run"; readiness_ok=0 ;; esac
fi
if [ "$readiness_ok" -eq 1 ] && ! jq -e '
  type=="object" and
  (.required_seats|type=="array") and
  (.seats|type=="array") and
  all(.required_seats[]; type=="string" and test("^[A-Za-z0-9][A-Za-z0-9._-]*$")) and
  all(.seats[]; type=="object" and (.id|type=="string"))
' "$readiness_file" >/dev/null 2>&1; then
  add_reason "readiness:invalid"
  readiness_ok=0
fi

if [ "$readiness_ok" -eq 1 ]; then
  jq -r '.required_seats[]' "$readiness_file" >"$seats_file"
  while IFS= read -r seat_id; do
    count=$(jq --arg id "$seat_id" '[.seats[] | select(.id==$id)] | length' "$readiness_file")
    if [ "$count" -eq 0 ]; then
      add_reason "seat:$seat_id:missing"
      continue
    fi
    if [ "$count" -ne 1 ]; then
      add_reason "seat:$seat_id:ambiguous"
      continue
    fi
    seat=$(jq -c --arg id "$seat_id" '.seats[] | select(.id==$id)' "$readiness_file")
    harness=$(printf '%s' "$seat" | jq -r '.harness // empty')
    auth_cmd=$(printf '%s' "$seat" | jq -r '.auth_cmd // empty')
    label=$(safe_label "$harness")
    if [ -z "$harness" ]; then
      add_reason "seat:$seat_id:harness:missing"
    else
      case "$harness" in
        */*)
          if [ ! -e "$harness" ]; then
            add_reason "seat:$seat_id:harness:$label:missing"
          elif [ ! -x "$harness" ]; then
            add_reason "seat:$seat_id:harness:$label:not_runnable"
          fi
          ;;
        *)
          command -v "$harness" >/dev/null 2>&1 \
            || add_reason "seat:$seat_id:harness:$label:missing"
          ;;
      esac
    fi
    if [ -z "$auth_cmd" ]; then
      add_reason "seat:$seat_id:auth:$label:missing"
    elif [ -n "$harness" ] && {
      case "$harness" in */*) [ -x "$harness" ] ;; *) command -v "$harness" >/dev/null 2>&1 ;; esac
    }; then
      auth_cwd=$run_dir
      [ -n "$repo_dir" ] && [ -d "$repo_dir" ] && auth_cwd=$repo_dir
      (cd "$auth_cwd" && sh -c "$auth_cmd") </dev/null >/dev/null 2>&1 \
        || add_reason "seat:$seat_id:auth:$label:not_ready"
    fi
  done <"$seats_file"
fi

branch=combo/$run
base_sha=''
if [ -n "$repo_dir" ] && git -C "$repo_dir" rev-parse --git-dir >/dev/null 2>&1; then
  base_sha=$(git -C "$repo_dir" rev-parse --verify "$base_ref^{commit}" 2>/dev/null || printf '')
  [ -n "$base_sha" ] || add_reason "base:unresolved"
  git -C "$repo_dir" show-ref --verify --quiet "refs/heads/$branch" \
    && add_reason "branch:collision" || true
fi
[ ! -e "$ownership_file" ] && [ ! -L "$ownership_file" ] || add_reason "ownership:already_recorded"

has_reasons && emit_not_ready
# -/ 1/4

# -- 2/4 CORE · acquire_treehouse --
worktree=''
if [ "$mode" = treehouse ]; then
  if ! (cd "$repo_dir" && treehouse get --lease --lease-holder "$run" >"$treehouse_out" 2>"$treehouse_err"); then
    add_reason "treehouse:acquire_refused"
    emit_not_ready
  fi
  path_lines=$(awk 'NF {n++} END {print n+0}' "$treehouse_out")
  [ "$path_lines" -eq 1 ] || add_reason "treehouse:invalid_response"
  worktree=$(awk 'NF && /^\// {matches++; path=$0} END {if(matches==1) print path}' "$treehouse_out")
  [ -n "$worktree" ] || worktree=$(treehouse_path_for_holder || printf '')
  case "$worktree" in /*) ;; *) add_reason "treehouse:invalid_path"; emit_not_ready ;; esac
  publish_ownership treehouse "$worktree" "$branch" "$base_sha"
  acquired=1

  treehouse_lease_owned "$worktree" "$run" || add_reason "treehouse:lease_identity_unverified"
  [ -d "$worktree" ] || add_reason "treehouse:path_missing"
  if [ -d "$worktree" ]; then
    repo_common=$(canonical_git_common "$repo_dir" || printf '')
    worktree_common=$(canonical_git_common "$worktree" || printf '')
    [ -n "$repo_common" ] && [ "$worktree_common" = "$repo_common" ] \
      || add_reason "treehouse:repo_mismatch"
    [ -z "$(git -C "$worktree" status --porcelain 2>/dev/null || printf invalid)" ] \
      || add_reason "treehouse:worktree_not_clean"
  fi
  has_reasons && emit_not_ready
  git -C "$worktree" switch -c "$branch" "$base_sha" >/dev/null 2>&1 \
    || add_reason "branch:create_failed"
fi
# -/ 2/4

# -- 3/4 CORE · acquire_explicit_git --
if [ "$mode" = git-worktree-explicit ]; then
  worktree=${CB_GIT_WORKTREE_PATH:-}
  case "$worktree" in
    "$repo_dir"/.worktrees/*) ;;
    *) add_reason "git-worktree:explicit_path_required" ;;
  esac
  [ -n "$worktree" ] && [ ! -e "$worktree" ] || add_reason "git-worktree:path_collision"
  has_reasons && emit_not_ready
  mkdir -p "$repo_dir/.worktrees"
  publish_ownership git-worktree-explicit "$worktree" "$branch" "$base_sha"
  acquired=1
  git -C "$repo_dir" worktree add -b "$branch" "$worktree" "$base_sha" >/dev/null 2>&1 \
    || add_reason "git-worktree:acquire_refused"
fi
# -/ 3/4

# -- 4/4 CORE · Finalize runway and emit launch_ready --
has_reasons && emit_not_ready
if git -C "$repo_dir" ls-files --error-unmatch -- .no-mistakes.yaml >/dev/null 2>&1 \
  && [ ! -e "$worktree/.no-mistakes.yaml" ]; then
  cp -p "$repo_dir/.no-mistakes.yaml" "$worktree/.no-mistakes.yaml" \
    || add_reason "no-mistakes:copy_failed"
fi
if [ -n "$setup_cmd" ]; then
  (cd "$worktree" && sh -c "$setup_cmd") </dev/null >/dev/null 2>&1 \
    || add_reason "setup:failed"
fi
has_reasons && emit_not_ready

sed '/^CB_WORKTREE=/d;/^CB_BASE_SHA=/d' "$config" >"$config_tmp"
{
  printf 'CB_WORKTREE='
  shell_quote "$worktree"
  printf '\nCB_BASE_SHA='
  shell_quote "$base_sha"
  printf '\n'
} >>"$config_tmp"
mv "$config_tmp" "$config"

if [ "$mode" = treehouse ]; then
  payload=$(jq -cn \
    --arg worktree "$worktree" --arg branch "$branch" --arg base "$base_sha" --arg kind "$mode" --arg lease "$run" \
    '{worktree:$worktree,branch:$branch,base_sha:$base,runway_kind:$kind,lease_id:$lease}')
else
  payload=$(jq -cn \
    --arg worktree "$worktree" --arg branch "$branch" --arg base "$base_sha" --arg kind "$mode" \
    --arg owner "git-worktree:$run" \
    '{worktree:$worktree,branch:$branch,base_sha:$base,runway_kind:$kind,lease_id:"not-applicable",ownership_id:$owner}')
fi
CB_RUNS_DIR=$runs_dir sh "$SCRIPT_DIR/cb-emit.sh" \
  --run "$run" --agent launcher --code 0 --event launch_ready --payload "$payload"
# -/ 4/4
