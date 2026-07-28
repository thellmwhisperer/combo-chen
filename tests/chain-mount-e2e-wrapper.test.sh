#!/usr/bin/env bash
# @overview Focused contract for the #339 unmocked E2E wrapper's authenticated
#   PR changed-path query and strict docs-only acceptance.
#
#   READING GUIDE
#   -------------
#   1. Fixture        <- fake GitHub CLI with exact argv recording.
#   2. Query contract <- URL normalization, pagination, and failure propagation.
#   3. Scope contract <- empty and non-docs path rejection.
#
#   MAIN FLOW
#   ---------
#   source wrapper helpers -> fake GitHub API -> assert lossless fail-closed paths
#
# @exports none
# @deps bash, tests/lib.sh, tests/chain-mount-e2e.test.sh
set -euo pipefail

# shellcheck source=tests/lib.sh disable=SC1091
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
# shellcheck source=tests/chain-mount-e2e.test.sh disable=SC1091
. "$ROOT/tests/chain-mount-e2e.test.sh"

cb_tmproot TMP_ROOT chain-mount-e2e-wrapper
FAKE_BIN=$(cb_fakebin "$TMP_ROOT")
GH_ARGS=$TMP_ROOT/gh.args

cb_write_fake "$FAKE_BIN/gh" '#!/bin/sh
printf "%s\n" "$@" >"$CB_TEST_GH_ARGS"
case "$CB_TEST_GH_MODE" in
  docs)
    printf "%s\n" "docs/bash-v1-chain.md" "docs/spec.md"
    ;;
  special)
    printf "%s\n" \
      "docs/operator guide, quoted path.md" \
      "docs/backslash\\and\"quote.md"
    ;;
  empty)
    ;;
  failure)
    printf "simulated GitHub API failure\n" >&2
    exit 42
    ;;
  *)
    exit 99
    ;;
esac
'

query_paths() {
  CB_TEST_GH_ARGS=$GH_ARGS CB_TEST_GH_MODE=$1 PATH="$FAKE_BIN:$PATH" \
    cb_e2e_pr_changed_paths "$2"
}

# -- 1/3 CORE · Query exact docs paths through the normalized PR number --
paths=$(query_paths docs \
  https://github.com/thellmwhisperer/combo-chen/pull/344)
[ "$paths" = $'docs/bash-v1-chain.md\ndocs/spec.md' ] \
  || fail "changed-path query did not preserve the exact two docs paths"
expected_args=$'api\n/repos/thellmwhisperer/combo-chen/pulls/344/files?per_page=100\n--paginate\n--jq\n.[].filename'
[ "$(cat "$GH_ARGS")" = "$expected_args" ] \
  || fail "changed-path query did not normalize the URL or request pagination"
cb_e2e_require_docs_only_paths "$paths" \
  || fail "exact docs-only paths were rejected"

special_paths=$(query_paths special \
  https://github.com/thellmwhisperer/combo-chen/pull/999)
[ "$special_paths" = \
  $'docs/operator guide, quoted path.md\ndocs/backslash\\and"quote.md' ] \
  || fail "changed-path query damaged spaces, commas, quotes, or backslashes"
cb_e2e_require_docs_only_paths "$special_paths" \
  || fail "valid special-character docs paths were rejected"
# -/ 1/3

# -- 2/3 CORE · Propagate query and URL failures --
set +e
query_paths failure \
  https://github.com/thellmwhisperer/combo-chen/pull/344 \
  >"$TMP_ROOT/failure.out" 2>"$TMP_ROOT/failure.err"
failure_status=$?
query_paths docs https://github.com/elsewhere/project/pull/344 \
  >"$TMP_ROOT/url.out" 2>"$TMP_ROOT/url.err"
url_status=$?
set -e
expect_code 42 "$failure_status" "GitHub API failure must propagate"
[ "$url_status" -ne 0 ] || fail "unauthorized PR URL was accepted"
# -/ 2/3

# -- 3/3 CORE · Reject empty, README, and any other off-scope paths --
empty_paths=$(query_paths empty \
  https://github.com/thellmwhisperer/combo-chen/pull/344)
set +e
cb_e2e_require_docs_only_paths "$empty_paths" >/dev/null 2>&1
empty_status=$?
cb_e2e_require_docs_only_paths README.md >/dev/null 2>&1
readme_status=$?
cb_e2e_require_docs_only_paths $'docs/spec.md\nbin/cb-run.sh' \
  >/dev/null 2>&1
off_scope_status=$?
set -e
[ "$empty_status" -ne 0 ] || fail "empty changed-path output was accepted"
[ "$readme_status" -ne 0 ] || fail "README.md was accepted"
[ "$off_scope_status" -ne 0 ] || fail "a non-docs path was accepted"
assert_no_grep 'gh-axi pr diff "$pr_url" --name-only' \
  "$ROOT/tests/chain-mount-e2e.test.sh" \
  "legacy URL plus unsupported --name-only invocation remains"
# -/ 3/3

pass "chain-mount E2E wrapper changed-path contract"
