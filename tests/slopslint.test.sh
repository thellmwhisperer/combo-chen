#!/usr/bin/env bash
#
# @overview Contract tests for the native Bash duplication gate. ~410 lines,
#   no public symbols; proves exact normalized function-body detection,
#   zero-tolerance enforcement, safe scratch allocation, exact Treehouse field
#   parsing, durable non-suppressing tombstones, and CI invocation.
#
#   READING GUIDE
#   -------------
#   1. Start at test_duplicate_blocks     <- core detector/gate contract
#   2. Read malformed policy tests        <- fail-closed configuration
#   3. Read test_real_tree_is_clean       <- repository integration proof
#
#   MAIN FLOW
#   ---------
#   make_fixture -> write Bash samples -> run_slopslint -> assert exit/report
#
#   PUBLIC API
#   ----------
#   none
#
#   INTERNALS
#   ---------
#   make_fixture, write_config, write_tombstone, run_slopslint, sample writers,
#   detector/policy/integration tests, scratch-race regression, exact shared
#   helper parsing regression, workflow invocation regression
#
# @exports none
# @deps bash, tests/lib.sh, bin/cb-slopslint.sh
set -u

# shellcheck source=tests/lib.sh disable=SC1091
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

SLOPSLINT="$ROOT/bin/cb-slopslint.sh"
FIXTURE=
CMD_STATUS=
CMD_STDOUT=
CMD_STDERR=

# -- 1/4 HELPER · fixture builders --
write_config() {
  mkdir -p "$FIXTURE/.slop/tombstones"
  cat >"$FIXTURE/.slop/config.yml" <<'YAML'
schema: 1
detector: bash-function-body
min_lines: 5
min_tokens: 10
paths:
  - bin
  - tests
YAML
  cat >"$FIXTURE/.slop/ceilings.yml" <<'YAML'
schema: 1
active_duplicates_ceiling: 0
YAML
}

write_tombstone() {
  local id=${1:-T-HISTORICAL-DUPLICATE}
  cat >"$FIXTURE/.slop/tombstones/$id.yml" <<YAML
schema: 1
id: $id
status: resolved
category: duplication
title: "Historical duplicate helper"
created_at: 2026-07-27
incident:
  commit: 0000000000000000000000000000000000000000
  pattern: >
    A helper was implemented twice.
  what_went_wrong: >
    Review found duplicated behavior.
  root_cause: >
    No shared helper was searched for first.
  rule_established: >
    Search and centralize before adding helpers.
YAML
}

make_fixture() {
  cb_tmproot FIXTURE cb-slopslint
  mkdir -p "$FIXTURE/bin" "$FIXTURE/tests"
  write_config
  write_tombstone
}

run_slopslint() {
  local err_dir err
  cb_tmproot err_dir cb-slopslint-output
  err="$err_dir/stderr"
  CMD_STDOUT=$("$SLOPSLINT" --root "$FIXTURE" 2>"$err") \
    && CMD_STATUS=0 || CMD_STATUS=$?
  CMD_STDERR=$(cat "$err")
}

write_duplicate_samples() {
  cat >"$FIXTURE/bin/alpha.sh" <<'SH'
#!/bin/sh
alpha_digest() {
  local input=$1
  local output
  output=$(cksum "$input")
  output=${output%% *}
  [ -n "$output" ] || return 1
  printf '%s\n' "$output"
}
SH
  cat >"$FIXTURE/tests/beta.sh" <<'SH'
#!/bin/sh
function beta_digest() {
    # Formatting and comments do not make a new implementation.
    local input=$1
    local output
    output=$(cksum "$input")
    output=${output%% *}
    [ -n "$output" ] || return 1
    printf '%s\n' "$output"
}
SH
}
# -/ 1/4

# -- 2/4 CORE · detector and zero-tolerance enforcement -- <- START HERE
test_duplicate_blocks() {
  make_fixture
  write_duplicate_samples

  run_slopslint

  expect_code 1 "$CMD_STATUS" "duplicate function bodies must block"
  assert_contains "$CMD_STDERR" "duplicate function body" "finding should be explicit"
  assert_contains "$CMD_STDERR" "bin/alpha.sh:2" "first endpoint should be repo-relative"
  assert_contains "$CMD_STDERR" "tests/beta.sh:2" "second endpoint should be repo-relative"
  assert_contains "$CMD_STDERR" "1 active duplicate" "summary should count findings"
  [ -z "$(find "$FIXTURE" -type f -name '*.body' -print)" ] \
    || fail "normalized detector bodies must be cleaned from the scanned tree"
  pass "slopslint: exact normalized Bash function duplication blocks"
}

test_tombstones_never_suppress_findings() {
  make_fixture
  write_duplicate_samples
  # A tombstone is durable incident memory, not an acceptance matcher.
  sed -i.bak 's/Historical duplicate helper/alpha_digest and beta_digest/' \
    "$FIXTURE/.slop/tombstones/T-HISTORICAL-DUPLICATE.yml"
  rm "$FIXTURE/.slop/tombstones/T-HISTORICAL-DUPLICATE.yml.bak"

  run_slopslint

  expect_code 1 "$CMD_STATUS" "tombstones must not suppress a current finding"
  assert_contains "$CMD_STDERR" "1 active duplicate" "finding must remain active"
  pass "slopslint: tombstones record history without becoming allowlists"
}

test_small_duplicate_is_below_explicit_threshold() {
  make_fixture
  cat >"$FIXTURE/bin/small-a.sh" <<'SH'
#!/bin/sh
small_a() {
  printf '%s\n' one
  printf '%s\n' two
}
SH
  cat >"$FIXTURE/tests/small-b.sh" <<'SH'
#!/bin/sh
small_b() {
  printf '%s\n' one
  printf '%s\n' two
}
SH

  run_slopslint

  expect_code 0 "$CMD_STATUS" "below-threshold boilerplate should pass"
  assert_contains "$CMD_STDOUT" "0 active duplicates" "clean summary should be stable"
  pass "slopslint: explicit line/token thresholds ignore tiny boilerplate"
}

test_heredoc_braces_do_not_truncate_functions() {
  make_fixture
  cat >"$FIXTURE/bin/heredoc-a.sh" <<'OUTER'
#!/bin/sh
heredoc_a() {
  cat <<'INNER'
}
INNER
  printf '%s\n' one
  printf '%s\n' two
  printf '%s\n' three
  printf '%s\n' four
  printf '%s\n' five
}
OUTER
  cat >"$FIXTURE/tests/heredoc-b.sh" <<'OUTER'
#!/bin/sh
heredoc_b() {
  cat <<'INNER'
}
INNER
  printf '%s\n' one
  printf '%s\n' two
  printf '%s\n' three
  printf '%s\n' four
  printf '%s\n' five
}
OUTER

  run_slopslint

  expect_code 1 "$CMD_STATUS" "heredoc braces must not hide duplicate outer functions"
  assert_contains "$CMD_STDERR" "heredoc_a" "first outer function should be reported"
  assert_contains "$CMD_STDERR" "heredoc_b" "second outer function should be reported"
  pass "slopslint: heredoc braces cannot truncate function extraction"
}

test_nested_brace_group_does_not_close_function() {
  make_fixture
  cat >"$FIXTURE/bin/brace-a.sh" <<'SH'
#!/bin/sh
brace_a() {
{
  printf '%s\n' one
}
  printf '%s\n' two
  printf '%s\n' three
  printf '%s\n' four
  printf '%s\n' five
  printf '%s\n' six
}
SH
  cat >"$FIXTURE/tests/brace-b.sh" <<'SH'
#!/bin/sh
brace_b() {
{
  printf '%s\n' one
}
  printf '%s\n' two
  printf '%s\n' three
  printf '%s\n' four
  printf '%s\n' five
  printf '%s\n' six
}
SH

  run_slopslint

  expect_code 1 "$CMD_STATUS" "nested brace groups must not close the outer function"
  assert_contains "$CMD_STDERR" "brace_a" "first complete outer function should be reported"
  assert_contains "$CMD_STDERR" "brace_b" "second complete outer function should be reported"
  pass "slopslint: nested brace-group closers cannot truncate function extraction"
}

test_tmp_swap_cannot_redirect_workspace() {
  make_fixture
  local fake_bin victim created_path err_dir err
  cb_tmproot fake_bin cb-slopslint-mktemp
  cb_tmproot victim cb-slopslint-victim
  cb_tmproot err_dir cb-slopslint-race-output
  created_path="$victim/created-path"
  err="$err_dir/stderr"
  cat >"$fake_bin/mktemp" <<SH
#!/bin/sh
[ "\${1:-}" = -d ] && shift
template=\$1
mv "$FIXTURE/.tmp" "$FIXTURE/.tmp-pinned"
ln -s "$victim" "$FIXTURE/.tmp"
workspace=\${template%XXXXXX}owned
mkdir "\$workspace" || exit 1
(CDPATH='' cd -- "\$workspace" && pwd -P) >"$created_path"
printf '%s\\n' "\$workspace"
SH
  chmod +x "$fake_bin/mktemp"

  CMD_STDOUT=$(PATH="$fake_bin:$PATH" "$SLOPSLINT" --root "$FIXTURE" 2>"$err") \
    && CMD_STATUS=0 || CMD_STATUS=$?
  CMD_STDERR=$(cat "$err")

  expect_code 0 "$CMD_STATUS" "a parent-name swap must not redirect pinned scratch${CMD_STDERR:+: $CMD_STDERR}"
  assert_present "$created_path" "fake mktemp should record its physical workspace"
  case "$(cat "$created_path")" in
    "$victim"/*) fail "workspace followed a raced .tmp symlink into $victim" ;;
  esac
  pass "slopslint: raced .tmp replacement cannot redirect the detector workspace"
}
# -/ 2/4

# -- 3/4 CORE · fail-closed policy and tombstone validation --
test_malformed_config_fails_closed() {
  make_fixture
  sed -i.bak '/^min_tokens:/d' "$FIXTURE/.slop/config.yml"
  rm "$FIXTURE/.slop/config.yml.bak"

  run_slopslint

  expect_code 2 "$CMD_STATUS" "missing detector policy must fail closed"
  assert_contains "$CMD_STDERR" "min_tokens" "config diagnostic should name the field"
  pass "slopslint: malformed detector config fails closed"
}

test_malformed_tombstone_fails_closed() {
  make_fixture
  sed -i.bak 's/^id: .*/id: T-WRONG-ID/' \
    "$FIXTURE/.slop/tombstones/T-HISTORICAL-DUPLICATE.yml"
  rm "$FIXTURE/.slop/tombstones/T-HISTORICAL-DUPLICATE.yml.bak"

  run_slopslint

  expect_code 2 "$CMD_STATUS" "mismatched tombstone id must fail closed"
  assert_contains "$CMD_STDERR" "must match filename" "tombstone diagnostic should be explicit"
  pass "slopslint: malformed tombstones fail closed"
}

test_nonzero_ceiling_is_rejected() {
  make_fixture
  sed -i.bak 's/active_duplicates_ceiling: 0/active_duplicates_ceiling: 1/' \
    "$FIXTURE/.slop/ceilings.yml"
  rm "$FIXTURE/.slop/ceilings.yml.bak"

  run_slopslint

  expect_code 2 "$CMD_STATUS" "nonzero ceiling would weaken the blocking contract"
  assert_contains "$CMD_STDERR" "must be 0" "ceiling diagnostic should state zero tolerance"
  pass "slopslint: committed ceiling cannot permit findings"
}
# -/ 3/4

# -- 4/4 CORE · checked-in repository integration --
test_worktree_helpers_have_one_owner() {
  local common="$ROOT/bin/cb-worktree-common.sh"
  assert_present "$common" "shared worktree helper library should exist"
  assert_grep "canonical_git_common() {" "$common" \
    "canonical Git helper should be owned by the common library"
  assert_grep "treehouse_lease_owned() {" "$common" \
    "Treehouse lease helper should be owned by the common library"
  assert_no_grep "canonical_git_common() {" "$ROOT/bin/cb-launcher.sh" \
    "Launcher must not fork the canonical Git helper"
  assert_no_grep "canonical_git_common() {" "$ROOT/bin/cb-cleaner.sh" \
    "Cleaner must not fork the canonical Git helper"
  assert_no_grep "treehouse_lease_owned() {" "$ROOT/bin/cb-launcher.sh" \
    "Launcher must not fork the Treehouse helper"
  assert_no_grep "treehouse_lease_owned() {" "$ROOT/bin/cb-cleaner.sh" \
    "Cleaner must not fork the Treehouse helper"
  pass "slopslint: shared worktree helpers have one implementation owner"
}

test_worktree_lease_parser_requires_exact_fields() {
  local fake_bin status_file old_path
  cb_tmproot fake_bin cb-worktree-status
  status_file="$fake_bin/status"
  cat >"$fake_bin/treehouse" <<SH
#!/bin/sh
[ "\${1:-}" = status ] || exit 64
cat "$status_file"
SH
  chmod +x "$fake_bin/treehouse"

  # shellcheck source=bin/cb-worktree-common.sh disable=SC1091
  . "$ROOT/bin/cb-worktree-common.sh"
  repo_dir=$ROOT
  cat >"$status_file" <<'STATUS'
1     leased       /safe/worktree-extra  (held by combo-run)
STATUS
  old_path=$PATH
  PATH="$fake_bin:$PATH"
  treehouse_lease_owned /safe/worktree combo-run \
    && fail "overlapping path/holder substrings must not prove lease custody"

  cat >"$status_file" <<'STATUS'
1     leased       /safe/worktree  (held by combo-run)extra
STATUS
  treehouse_lease_owned /safe/worktree combo-run \
    && fail "an overlapping holder field must not prove lease custody"

  cat >"$status_file" <<'STATUS'
1     leased       /safe/worktree  (held by combo-run)
STATUS
  treehouse_lease_owned /safe/worktree combo-run \
    || fail "one exact path/holder field tuple should prove lease custody"
  PATH=$old_path
  pass "worktree helper: Treehouse custody requires exact status fields"
}

test_workflow_invokes_slopslint_with_bash() {
  assert_grep "run: bash bin/cb-slopslint.sh" "$ROOT/.github/workflows/test.yml" \
    "GitHub Actions must invoke the blocking gate through Bash"
  pass "slopslint: GitHub Actions uses an explicit Bash interpreter"
}

test_real_tree_is_clean() {
  FIXTURE=$ROOT

  run_slopslint

  expect_code 0 "$CMD_STATUS" "checked-in tree must satisfy slopslint${CMD_STDERR:+: $CMD_STDERR}"
  assert_contains "$CMD_STDOUT" "0 active duplicates" "repository summary should be clean"
  pass "slopslint: checked-in Bash tree has no active duplicate bodies"
}
# -/ 4/4

test_duplicate_blocks
test_tombstones_never_suppress_findings
test_small_duplicate_is_below_explicit_threshold
test_heredoc_braces_do_not_truncate_functions
test_nested_brace_group_does_not_close_function
test_tmp_swap_cannot_redirect_workspace
test_malformed_config_fails_closed
test_malformed_tombstone_fails_closed
test_nonzero_ceiling_is_rejected
test_worktree_helpers_have_one_owner
test_worktree_lease_parser_requires_exact_fields
test_workflow_invokes_slopslint_with_bash
test_real_tree_is_clean

printf '\nslopslint: all tests passed\n'
