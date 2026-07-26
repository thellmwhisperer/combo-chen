#!/usr/bin/env bash
# @overview Shared primitives for the Combo v1 Bash contract tests.
#   Provides reporting, project-local temp cleanup, tool/file helpers,
#   deterministic Git fixtures, and common assertions.
#
#   READING GUIDE
#   -------------
#   1. cb_tmproot             <- shared lifecycle and cleanup contract.
#   2. cb_fakebin             <- tool shims and stable file digests.
#   3. cb_candidate_repo      <- deterministic Git fixtures.
#   4. assert_contains        <- common contract assertions.
#
#   MAIN FLOW
#   ---------
#   source library -> allocate fixture state -> drive product -> assert contract
#
#   PUBLIC API
#   ----------
#   fail, pass                         Test result reporters.
#   cb_tmproot                         Allocate a self-cleaning project temp root.
#   cb_fakebin, cb_write_fake          Build deterministic PATH shims.
#   cb_file_sha256                     Compute a fail-closed SHA-256 file digest.
#   cb_git_identity, cb_candidate_repo Build deterministic Git fixtures.
#   assert_*, expect_code              Assert strings, files, and exit codes.
#
#   INTERNALS
#   ---------
#   cb_cleanup
#
# @exports fail, pass, cb_tmproot, cb_fakebin, cb_write_fake, cb_file_sha256,
#   cb_git_identity, cb_candidate_repo, assert_contains, assert_not_contains,
#   expect_code, assert_grep, assert_no_grep, assert_match, assert_not_match,
#   assert_absent, assert_present, assert_symlink
# @deps bash, git, mktemp, sha256sum/shasum

# Idempotent guard: a test file may source this library plus its own helpers.
if [ -n "${CB_TEST_LIB_SOURCED:-}" ]; then
  return 0
fi
CB_TEST_LIB_SOURCED=1

# Resolve the repo root from this library's own location.
# shellcheck disable=SC2034
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# -- 1/5 HELPER · fail and pass --

fail() {
  printf 'not ok - %s\n' "$1" >&2
  exit 1
}

pass() {
  printf 'ok - %s\n' "$1"
}
# -/ 1/5

# -- 2/5 CORE · cb_tmproot -- <- START HERE
#
# cb_tmproot <variable> [prefix]: assign a project-local temp dir to <variable>
# and register it for removal on EXIT. The first call installs the cleanup trap.

CB_CLEANUP_DIRS=()

cb_cleanup() {
  local d
  for d in "${CB_CLEANUP_DIRS[@]:-}"; do
    [ -n "$d" ] && rm -rf "$d"
  done
}

cb_tmproot() {
  local __cb_tmp_out=${1:-} __cb_tmp_prefix=${2:-cb-test} __cb_tmp_allocated
  case "$__cb_tmp_out" in
    [a-zA-Z_][a-zA-Z0-9_]*) ;;
    *) fail "cb_tmproot requires a valid destination variable" ;;
  esac
  mkdir -p "$ROOT/.tmp" || fail "cb_tmproot could not create $ROOT/.tmp"
  __cb_tmp_allocated=$(mktemp -d "$ROOT/.tmp/${__cb_tmp_prefix}.XXXXXX") \
    || fail "cb_tmproot could not allocate $__cb_tmp_prefix under $ROOT/.tmp"
  if [ "${#CB_CLEANUP_DIRS[@]}" -eq 0 ] && [ -z "$(trap -p EXIT)" ]; then
    trap cb_cleanup EXIT
  fi
  CB_CLEANUP_DIRS+=("$__cb_tmp_allocated")
  printf -v "$__cb_tmp_out" '%s' "$__cb_tmp_allocated"
}
# -/ 2/5

# -- 3/5 HELPER · cb_fakebin, cb_write_fake, and cb_file_sha256 --
#
# cb_fakebin <dir> creates <dir>/fakebin and echoes it; prepend it to PATH to
# shadow real tools with stubs.

cb_fakebin() {
  local fakebin="$1/fakebin"
  mkdir -p "$fakebin"
  printf '%s\n' "$fakebin"
}

# cb_write_fake <path> <body>: write an executable script body to <path>.
cb_write_fake() {
  printf '%s' "$2" >"$1"
  chmod +x "$1"
}

# cb_file_sha256 <path>: print a SHA-256 digest or fail when no digest tool works.
cb_file_sha256() {
  local digest output
  digest=
  if command -v sha256sum >/dev/null 2>&1 \
    && output=$(sha256sum "$1" 2>/dev/null); then
    digest=${output%% *}
  fi
  if [ -z "$digest" ] && command -v shasum >/dev/null 2>&1 \
    && output=$(shasum -a 256 "$1" 2>/dev/null); then
    digest=${output%% *}
  fi
  [ -n "$digest" ] || fail "no working SHA-256 digest tool"
  printf '%s\n' "$digest"
}
# -/ 3/5

# -- 4/5 HELPER · cb_git_identity and cb_candidate_repo --

# cb_git_identity: export a fixed author/committer identity so fixture commits
# never depend on the host git config.
cb_git_identity() {
  export GIT_AUTHOR_NAME=${GIT_AUTHOR_NAME:-cbtest}
  export GIT_AUTHOR_EMAIL=${GIT_AUTHOR_EMAIL:-cbtest@example.invalid}
  export GIT_COMMITTER_NAME=$GIT_AUTHOR_NAME
  export GIT_COMMITTER_EMAIL=$GIT_AUTHOR_EMAIL
}

# cb_candidate_repo <path> <label>: create a git repo with a base commit and a
# candidate commit; echoes "base head" (two SHAs separated by a space).
cb_candidate_repo() {
  local path=$1 label=$2
  mkdir -p "$path"
  git -C "$path" init -q -b main
  git -C "$path" config user.name "Combo Test"
  git -C "$path" config user.email "combo@example.test"
  printf '%s base\n' "$label" >"$path/file.txt"
  git -C "$path" add .
  git -C "$path" commit -qm "${label} base"
  local base
  base=$(git -C "$path" rev-parse HEAD)
  printf '%s candidate\n' "$label" >"$path/file.txt"
  git -C "$path" add .
  git -C "$path" commit -qm "${label} candidate"
  printf '%s %s\n' "$base" "$(git -C "$path" rev-parse HEAD)"
}
# -/ 4/5

# -- 5/5 HELPER · assert_* and expect_code --

# assert_contains <haystack> <needle> [msg]
assert_contains() {
  case "$1" in
    *"$2"*) : ;;
    *) fail "${3:-assertion failed} (missing: '$2')"$'\n'"--- output ---"$'\n'"$1" ;;
  esac
}

# assert_not_contains <haystack> <needle> [msg]
assert_not_contains() {
  case "$1" in
    *"$2"*) fail "${3:-assertion failed} (unexpected: '$2')"$'\n'"--- output ---"$'\n'"$1" ;;
    *) : ;;
  esac
}

# expect_code <expected> <actual> <label>
expect_code() {
  [ "$2" = "$1" ] || fail "$3: expected exit $1, got $2"
}

# assert_grep <pattern> <file> <msg>: fixed-string grep must match in <file>.
assert_grep() {
  grep -F -- "$1" "$2" >/dev/null || fail "$3"
}

# assert_no_grep <pattern> <file> <msg>: fixed-string grep must NOT match.
assert_no_grep() {
  ! grep -F -- "$1" "$2" >/dev/null || fail "$3"
}

# assert_match <regex> <string> <msg>: ERE must match (case-insensitive).
assert_match() {
  printf '%s' "$2" | grep -Eqi -- "$1" || fail "$3 (no match for /$1/)${4:+$'\n'--- output ---$'\n'$4}"
}

# assert_not_match <regex> <string> <msg>: ERE must NOT match (case-insensitive).
assert_not_match() {
  ! printf '%s' "$2" | grep -Eqi -- "$1" || fail "$3 (unexpected match for /$1/)${4:+$'\n'--- output ---$'\n'$4}"
}

# assert_absent <path> <msg>: path must not exist.
assert_absent() {
  [ ! -e "$1" ] || fail "$2"
}

# assert_present <path> <msg>: path must exist.
assert_present() {
  [ -e "$1" ] || fail "$2"
}

# assert_symlink <path> <msg>: path must be a symlink.
assert_symlink() {
  [ -L "$1" ] || fail "$2"
}
# -/ 5/5
