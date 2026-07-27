#!/bin/sh
#
# @overview Shared, source-only runway identity helpers. ~55 lines, two public
#   functions; keeps Launcher and Cleaner on one Git/Treehouse custody check.
#
#   READING GUIDE
#   -------------
#   1. canonical_git_common      <- canonical repository identity
#   2. treehouse_lease_owned     <- exact path + holder lease proof
#
#   MAIN FLOW
#   ---------
#   caller globals/arguments -> read-only identity probe -> success or failure
#
#   PUBLIC API
#   ----------
#   canonical_git_common DIR             Print canonical Git common directory
#   treehouse_lease_owned PATH HOLDER     Verify exactly one Treehouse lease
#
#   INTERNALS
#   ---------
#   none
#
# @exports canonical_git_common, treehouse_lease_owned
# @deps sh, git, realpath, treehouse, awk; caller provides repo_dir and HOME

# -- 1/2 CORE · canonical_git_common -- <- START HERE
canonical_git_common() {
  cwd=$1
  common=$(git -C "$cwd" rev-parse --git-common-dir 2>/dev/null) || return 1
  case "$common" in
    /*) realpath "$common" 2>/dev/null ;;
    *) realpath "$cwd/$common" 2>/dev/null ;;
  esac
}
# -/ 1/2

# -- 2/2 CORE · treehouse_lease_owned --
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
# -/ 2/2
