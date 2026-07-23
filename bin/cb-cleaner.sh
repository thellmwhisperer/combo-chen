#!/bin/sh
# @overview Mechanical Combo v1 Cleaner. Verifies Launcher custody and releases
#   only the exact recorded Treehouse lease path or explicit Git worktree.
#
#   READING GUIDE
#   -------------
#   1. Ownership validation      <- rejects copied, guessed, or mismatched facts.
#   2. Custody refusal           <- generic P7 boundary; no Gate integration here.
#   3. Exact release dispatch    <- runway_kind selects one non-forcing backend.
#
#   MAIN FLOW
#   ---------
#   launcher ownership -> custody check -> matching release -> cleaned
#
#   PUBLIC API
#   ----------
#   cb-cleaner.sh <runId>  Release one mechanically owned run bubble.
#
#   INTERNALS
#   ---------
#   add_reason, emit_clean_failed, publish_cleaner_meta, treehouse_lease_owned
#
# @exports none
# @deps sh, git, jq, treehouse (Treehouse-owned runways), cb-emit.sh
set -eu

usage() {
  echo "usage: cb-cleaner <runId>" >&2
  exit 64
}

[ "$#" -eq 1 ] || usage
run=$1
case "$run" in ''|-*|*[!a-z0-9-]*) usage ;; esac

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname "$0")" && pwd)
runs_dir=${CB_RUNS_DIR:-"$HOME/.combo-chen/runs"}
run_dir=$runs_dir/$run
[ -d "$run_dir" ] && [ ! -L "$run_dir" ] || { echo "cb-cleaner: invalid run directory" >&2; exit 73; }
runs_root=$(realpath "$runs_dir" 2>/dev/null) || { echo "cb-cleaner: cannot resolve runs directory" >&2; exit 73; }
run_root=$(realpath "$run_dir" 2>/dev/null) || { echo "cb-cleaner: cannot resolve run directory" >&2; exit 73; }
case "$run_root" in "$runs_root"/"$run") ;; *) echo "cb-cleaner: run directory escapes runs root" >&2; exit 73 ;; esac

config=$run_dir/config.env
[ -f "$config" ] && [ ! -L "$config" ] || { echo "cb-cleaner: config.env missing or unsafe" >&2; exit 73; }
[ "$(realpath "$config" 2>/dev/null)" = "$run_root/config.env" ] \
  || { echo "cb-cleaner: config.env escapes run directory" >&2; exit 73; }
# shellcheck disable=SC1090
. "$config"

agents_dir=$run_dir/agents
[ -d "$agents_dir" ] && [ ! -L "$agents_dir" ] \
  || { echo "cb-cleaner: agents directory missing or unsafe" >&2; exit 73; }
[ "$(realpath "$agents_dir" 2>/dev/null)" = "$run_root/agents" ] \
  || { echo "cb-cleaner: agents directory escapes run directory" >&2; exit 73; }

ownership_file=$agents_dir/launcher.ownership.json
cleaner_file=$agents_dir/cleaner.ownership.json
cleaner_tmp=$agents_dir/.cleaner.ownership.tmp.$$
reasons_file=$run_dir/.cleaner-reasons.$$
: >"$reasons_file"
cleanup() {
  rm -f "$reasons_file" "$cleaner_tmp"
}
trap cleanup 0
trap 'exit 130' 1 2 15

add_reason() { printf '%s\n' "$1" >>"$reasons_file"; }
has_reasons() { [ -s "$reasons_file" ]; }
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
publish_cleaner_meta() {
  released=$1
  reasons=$(jq -Rsc '[split("\n")[] | select(length>0)]' "$reasons_file")
  jq -cn \
    --arg run "$run" --arg kind "$kind" --arg repo "$repo_dir" --arg worktree "$worktree" \
    --arg branch "$branch" --arg base "$base_sha" --argjson released "$released" --argjson reasons "$reasons" \
    '{run:$run,runway_kind:$kind,repo_dir:$repo,worktree:$worktree,branch:$branch,base_sha:$base,released:$released,reasons:$reasons}' \
    >"$cleaner_tmp"
  mv "$cleaner_tmp" "$cleaner_file"
}
emit_clean_failed() {
  publish_cleaner_meta false
  reasons=$(jq -Rsc '[split("\n")[] | select(length>0)]' "$reasons_file")
  payload=$(jq -cn --argjson reasons "$reasons" '{reasons:$reasons}')
  CB_RUNS_DIR=$runs_dir sh "$SCRIPT_DIR/cb-emit.sh" \
    --run "$run" --agent cleaner --code 1 --event clean_failed --payload "$payload"
  exit 1
}

# Safe defaults let malformed metadata be journaled without dereferencing it.
kind=''
repo_dir=''
worktree=''
branch=''
base_sha=''
lease_id=''
ownership_id=''

# -- 1/3 CORE · Validate exact Launcher ownership -- <- START HERE
if [ ! -f "$ownership_file" ] || [ -L "$ownership_file" ]; then
  add_reason "ownership:missing_or_unsafe"
elif [ "$(realpath "$ownership_file" 2>/dev/null)" != "$run_root/agents/launcher.ownership.json" ]; then
  add_reason "ownership:outside_run"
elif ! jq -e 'type=="object"' "$ownership_file" >/dev/null 2>&1; then
  add_reason "ownership:invalid"
else
  meta_run=$(jq -r '.run // empty' "$ownership_file")
  kind=$(jq -r '.runway_kind // empty' "$ownership_file")
  repo_dir=$(jq -r '.repo_dir // empty' "$ownership_file")
  worktree=$(jq -r '.worktree // empty' "$ownership_file")
  branch=$(jq -r '.branch // empty' "$ownership_file")
  base_sha=$(jq -r '.base_sha // empty' "$ownership_file")
  lease_id=$(jq -r '.lease_id // empty' "$ownership_file")
  ownership_id=$(jq -r '.ownership_id // empty' "$ownership_file")

  [ "$meta_run" = "$run" ] || add_reason "ownership:run_mismatch"
  [ "$branch" = "combo/$run" ] || add_reason "ownership:branch_mismatch"
  case "$base_sha" in
    [0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]*) ;;
    *) add_reason "ownership:base_invalid" ;;
  esac

  configured_repo=${CB_REPO_DIR:-}
  configured_repo_real=''
  if [ -n "$configured_repo" ] && [ -d "$configured_repo" ] && [ ! -L "$configured_repo" ]; then
    configured_repo_real=$(realpath "$configured_repo" 2>/dev/null || printf '')
  fi
  [ -n "$configured_repo_real" ] && [ "$repo_dir" = "$configured_repo_real" ] \
    || add_reason "ownership:repo_mismatch"
  case "$worktree" in /*) ;; *) add_reason "ownership:path_invalid" ;; esac
  [ -d "$worktree" ] || add_reason "ownership:path_missing"

  case "$kind" in
    treehouse)
      [ "$lease_id" = "$run" ] && [ -z "$ownership_id" ] \
        || add_reason "ownership:treehouse_identity_mismatch"
      treehouse_lease_owned "$worktree" "$run" \
        || add_reason "ownership:treehouse_lease_unverified"
      ;;
    git-worktree-explicit)
      [ "$ownership_id" = "git-worktree:$run" ] && [ -z "$lease_id" ] \
        || add_reason "ownership:git_identity_mismatch"
      [ "${CB_GIT_WORKTREE_PATH:-}" = "$worktree" ] \
        || add_reason "ownership:git_path_mismatch"
      case "$worktree" in "$repo_dir"/.worktrees/*) ;; *) add_reason "ownership:git_path_outside_repo" ;; esac
      ;;
    *) add_reason "ownership:runway_kind_invalid" ;;
  esac

  if [ -n "${CB_WORKTREE:-}" ] && [ "$CB_WORKTREE" != "$worktree" ]; then
    add_reason "ownership:runtime_path_mismatch"
  fi
  if [ -n "${CB_BASE_SHA:-}" ] && [ "$CB_BASE_SHA" != "$base_sha" ]; then
    add_reason "ownership:runtime_base_mismatch"
  fi

  if [ -d "$repo_dir" ] && [ -d "$worktree" ]; then
    repo_common=$(canonical_git_common "$repo_dir" || printf '')
    worktree_common=$(canonical_git_common "$worktree" || printf '')
    [ -n "$repo_common" ] && [ "$worktree_common" = "$repo_common" ] \
      || add_reason "ownership:git_repo_mismatch"
    observed_branch=$(git -C "$worktree" branch --show-current 2>/dev/null || printf '')
    [ "$observed_branch" = "$branch" ] || add_reason "ownership:checked_out_branch_mismatch"
    git -C "$repo_dir" cat-file -e "$base_sha^{commit}" 2>/dev/null \
      || add_reason "ownership:base_unresolved"
  fi
fi
has_reasons && emit_clean_failed
# -/ 1/3

# -- 2/3 CORE · Refuse active or unverifiable Gate custody --
# P7 may supply a non-interactive command whose zero exit means custody is idle.
custody_cmd=${CB_CLEAN_CUSTODY_CMD:-}
if [ -n "$custody_cmd" ]; then
  (cd "$worktree" && sh -c "$custody_cmd") </dev/null >/dev/null 2>&1 \
    || add_reason "custody:active_or_unverified"
fi
has_reasons && emit_clean_failed
# -/ 2/3

# -- 3/3 CORE · Dispatch exactly one matching release implementation --
case "$kind" in
  treehouse)
    if ! (cd "$repo_dir" && treehouse return "$worktree") </dev/null >/dev/null 2>&1; then
      add_reason "treehouse:release_refused"
    fi
    ;;
  git-worktree-explicit)
    git -C "$repo_dir" worktree remove "$worktree" >/dev/null 2>&1 \
      || add_reason "git-worktree:release_refused"
    ;;
esac
has_reasons && emit_clean_failed

publish_cleaner_meta true
payload=$(jq -cn --arg kind "$kind" --arg worktree "$worktree" '{runway_kind:$kind,worktree:$worktree}')
CB_RUNS_DIR=$runs_dir sh "$SCRIPT_DIR/cb-emit.sh" \
  --run "$run" --agent cleaner --code 0 --event cleaned --payload "$payload"
# -/ 3/3
