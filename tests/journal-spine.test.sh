#!/usr/bin/env bash
# tests/journal-spine.test.sh
#
# Contract: proves the Bash v1 journal spine — cb-emit.sh validation + dedup,
# cb-run-state.sh golden folds, cb-wait.sh torn-line tolerance, and the
# append-lock liveness/deletion guards. jq and git are real; mkdir/cat are
# PATH-first fakes only in the snapshot-race tests.
set -u

# shellcheck source=tests/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

BIN="$ROOT/bin"
FIXTURES="$ROOT/test/fixtures/journal-v1"
REAL_MKDIR=$(command -v mkdir)
REAL_CAT=$(command -v cat)

TMP_ROOT=$(cb_tmproot cb-journal)
RUNS_DIR="$TMP_ROOT/runs"
mkdir -p "$RUNS_DIR"
export CB_RUNS_DIR="$RUNS_DIR"

SHA_A="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
SHA_B="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
SHA_F="ffffffffffffffffffffffffffffffffffffffff"
SHA_0="0000000000000000000000000000000000000000"

CMD_STATUS=
CMD_STDOUT=
CMD_STDERR=

# run_cmd <script> <args...>: run bin/<script>, capture output into CMD_*.
run_cmd() {
  local script=$1; shift
  local errfile=$TMP_ROOT/.cmd.err
  CMD_STDOUT=$(sh "$BIN/$script" "$@" 2>"$errfile") && CMD_STATUS=0 || CMD_STATUS=$?
  CMD_STDERR=$(cat "$errfile" 2>/dev/null || true)
}

# make_run <run-id>: create runs/<run-id>, echo its dir path.
make_run() {
  mkdir -p "$RUNS_DIR/$1"
  printf '%s/%s\n' "$RUNS_DIR" "$1"
}

# write_fake <path>: read script body from stdin, write executable.
write_fake() {
  cat >"$1"
  chmod +x "$1"
}

# journal_is_empty <path>: succeed if file is absent or zero-length.
journal_is_empty() {
  { [ ! -f "$1" ] || [ ! -s "$1" ]; }
}

# ============ cb-emit: validation + dedup ==================================

test_rejects_invalid_enum_code_event_payload() {
  local run_dir journal agent code event payload
  # Case 1: bogus agent
  run_dir=$(make_run rej-bogus-agent); journal="$run_dir/journal.jsonl"
  run_cmd cb-emit.sh --run rej-bogus-agent --agent bogus --code 0 --event run_created --payload '{"work_item":"#311","repo":"/repo"}'
  [ "$CMD_STATUS" -ne 0 ] || fail "bogus agent should be rejected"
  journal_is_empty "$journal" || fail "journal should be empty (bogus agent)"
  # Case 2: invalid code
  run_dir=$(make_run rej-bad-code); journal="$run_dir/journal.jsonl"
  run_cmd cb-emit.sh --run rej-bad-code --agent chain --code 7 --event run_created --payload '{"work_item":"#311","repo":"/repo"}'
  [ "$CMD_STATUS" -ne 0 ] || fail "code 7 should be rejected"
  journal_is_empty "$journal" || fail "journal should be empty (bad code)"
  # Case 3: unknown event
  run_dir=$(make_run rej-bad-event); journal="$run_dir/journal.jsonl"
  run_cmd cb-emit.sh --run rej-bad-event --agent chain --code 0 --event event_zoo --payload '{}'
  [ "$CMD_STATUS" -ne 0 ] || fail "unknown event should be rejected"
  journal_is_empty "$journal" || fail "journal should be empty (bad event)"
  # Case 4: missing required payload field (repo)
  run_dir=$(make_run rej-missing-field); journal="$run_dir/journal.jsonl"
  run_cmd cb-emit.sh --run rej-missing-field --agent chain --code 0 --event run_created --payload '{"work_item":"#311"}'
  [ "$CMD_STATUS" -ne 0 ] || fail "missing payload field should be rejected"
  journal_is_empty "$journal" || fail "journal should be empty (missing field)"
  pass "cb-emit: rejects invalid enum, code, event, or required payload"
}

test_deduplicates_by_identity_key() {
  local run_dir journal
  run_dir=$(make_run dedup); journal="$run_dir/journal.jsonl"
  local payload="{\"member\":\"model\",\"round\":1,\"sha\":\"$SHA_A\"}"
  run_cmd cb-emit.sh --run dedup --agent reviewer --code 0 --event member_result --payload "$payload"
  expect_code 0 "$CMD_STATUS" "first member_result should succeed"
  local first_out=$CMD_STDOUT
  run_cmd cb-emit.sh --run dedup --agent reviewer --code 0 --event member_result --payload "$payload"
  expect_code 0 "$CMD_STATUS" "duplicate member_result should succeed"
  [ "$CMD_STDOUT" = "$first_out" ] || fail "dedup stdout should match first emission"
  local count
  count=$(grep -c '' "$journal" 2>/dev/null || echo 0)
  [ "$count" = "1" ] || fail "dedup should leave 1 journal line, got $count"
  pass "cb-emit: deduplicates repeated emissions by the specified identity key"
}

test_keeps_distinct_payloads_while_deduplicating_retry() {
  local run_dir journal
  run_dir=$(make_run dedup-keep); journal="$run_dir/journal.jsonl"
  local p1='{"errors":["exit=1"]}'
  local p2='{"errors":["exit=1, retry"]}'
  run_cmd cb-emit.sh --run dedup-keep --agent coder --code 1 --event coder_not_ready --payload "$p1"
  expect_code 0 "$CMD_STATUS" "first coder_not_ready"
  local first_out=$CMD_STDOUT
  run_cmd cb-emit.sh --run dedup-keep --agent coder --code 1 --event coder_not_ready --payload "$p2"
  expect_code 0 "$CMD_STATUS" "second coder_not_ready (distinct payload)"
  run_cmd cb-emit.sh --run dedup-keep --agent coder --code 1 --event coder_not_ready --payload "$p1"
  expect_code 0 "$CMD_STATUS" "exact retry of first should be deduped"
  [ "$CMD_STDOUT" = "$first_out" ] || fail "exact retry stdout should match first"
  local errors
  errors=$(jq -s -c '[.[] | .payload.errors]' "$journal")
  [ "$errors" = '[["exit=1"],["exit=1, retry"]]' ] || fail "errors sequence mismatch: $errors"
  pass "cb-emit: keeps distinct payloads while deduplicating an exact retry"
}

test_keeps_member_result_same_scope_different_codes() {
  local run_dir journal
  run_dir=$(make_run dedup-codes); journal="$run_dir/journal.jsonl"
  local scope="{\"member\":\"model\",\"round\":1,\"sha\":\"$SHA_A\"}"
  run_cmd cb-emit.sh --run dedup-codes --agent reviewer --code 0 --event member_result --payload "$scope"
  expect_code 0 "$CMD_STATUS" "passed member_result"
  run_cmd cb-emit.sh --run dedup-codes --agent reviewer --code 1 --event member_result --payload "{\"member\":\"model\",\"round\":1,\"sha\":\"$SHA_A\",\"artifact\":\"findings.md\"}"
  expect_code 0 "$CMD_STATUS" "failed member_result (different code)"
  local codes
  codes=$(jq -s -c '[.[] | .code]' "$journal")
  [ "$codes" = '[0,1]' ] || fail "code sequence mismatch: $codes"
  pass "cb-emit: keeps member_result records with the same scope but different codes"
}

# ============ cb-emit: coder facts + reviewer claim verification ===========

test_derives_coder_facts_and_verifies_claims() {
  local run_dir worktree base head
  run_dir=$(make_run derives); worktree="$run_dir/worktree"
  mkdir -p "$worktree"
  git -C "$worktree" init -q -b main
  git -C "$worktree" config user.name "Combo Test"
  git -C "$worktree" config user.email "combo@example.test"
  printf 'base\n' >"$worktree/file.txt"
  git -C "$worktree" add .; git -C "$worktree" commit -qm base
  base=$(git -C "$worktree" rev-parse HEAD)
  run_cmd cb-emit.sh --run derives --agent launcher --code 0 --event launch_ready \
    --payload "{\"worktree\":\"$worktree\",\"branch\":\"combo/test\",\"base_sha\":\"$base\",\"runway_kind\":\"treehouse\",\"lease_id\":\"lease-test\"}"
  expect_code 0 "$CMD_STATUS" "launch_ready"
  printf 'candidate\n' >"$worktree/file.txt"
  git -C "$worktree" add .; git -C "$worktree" commit -qm candidate
  head=$(git -C "$worktree" rev-parse HEAD)

  run_cmd cb-emit.sh --run derives --agent coder --code 0 --event coder_ready --payload '{}'
  expect_code 0 "$CMD_STATUS" "coder_ready"
  local payload expected
  payload=$(printf '%s' "$CMD_STDOUT" | jq -c '.payload')
  expected=$(jq -nc --arg sha "$head" --arg branch main '{sha:$sha, branch:$branch}')
  [ "$payload" = "$expected" ] || fail "coder_ready payload mismatch: got $payload, expected $expected"

  run_cmd cb-emit.sh --run derives --agent reviewer --code 0 --event lgtm \
    --payload "{\"sha\":\"$head\",\"round\":1,\"members\":[\"model\"]}"
  expect_code 0 "$CMD_STATUS" "lgtm with correct sha"

  run_cmd cb-emit.sh --run derives --agent reviewer --code 0 --event lgtm \
    --payload "{\"sha\":\"$SHA_F\",\"round\":2,\"members\":[\"model\"]}"
  [ "$CMD_STATUS" -ne 0 ] || fail "lgtm with wrong sha should fail"

  run_cmd cb-emit.sh --run derives --agent reviewer --code 1 --event needs_change \
    --payload "{\"sha\":\"$head\",\"round\":1,\"member\":\"model\",\"artifact\":\"artifacts/missing.md\"}"
  [ "$CMD_STATUS" -ne 0 ] || fail "needs_change with missing artifact should fail"
  pass "cb-emit: derives coder facts and verifies Reviewer claims mechanically"
}

# Helper: set up trusted + decoy candidate repos for launch-facts tests.
setup_launch_facts() {
  # echoes: <trusted_base> <trusted_head> <decoy_base> <decoy_head>
  local out
  out=$(cb_candidate_repo "$1/trusted" trusted)
  TRUSTED_BASE=${out%% *}; TRUSTED_HEAD=${out##* }
  out=$(cb_candidate_repo "$1/decoy" decoy)
  DECOY_BASE=${out%% *}; DECOY_HEAD=${out##* }
}

test_prefers_config_env_launch_facts() {
  local run_dir trusted decoy
  run_dir=$(make_run config-env-facts)
  trusted="$run_dir/trusted"; decoy="$run_dir/decoy"
  setup_launch_facts "$run_dir"
  run_cmd cb-emit.sh --run config-env-facts --agent launcher --code 0 --event launch_ready \
    --payload "{\"worktree\":\"$decoy\",\"branch\":\"combo/decoy\",\"base_sha\":\"$DECOY_BASE\",\"runway_kind\":\"treehouse\",\"lease_id\":\"decoy\"}"
  expect_code 0 "$CMD_STATUS" "launch_ready (decoy)"
  printf "CB_WORKTREE='%s'\nCB_BASE_SHA='%s'\n" "$trusted" "$TRUSTED_BASE" >"$run_dir/config.env"
  CB_WORKTREE="$decoy" CB_BASE_SHA="$DECOY_BASE" \
    run_cmd cb-emit.sh --run config-env-facts --agent coder --code 0 --event coder_ready --payload '{}'
  expect_code 0 "$CMD_STATUS" "coder_ready (config.env preferred)${CMD_STDERR:+: $CMD_STDERR}"
  local sha
  sha=$(printf '%s' "$CMD_STDOUT" | jq -r '.payload.sha')
  [ "$sha" = "$TRUSTED_HEAD" ] || fail "config.env sha: got $sha, expected $TRUSTED_HEAD"
  pass "cb-emit: prefers config.env launch facts over journal and hostile caller environment"
}

test_prefers_journal_launch_facts_without_config_env() {
  local run_dir trusted decoy
  run_dir=$(make_run journal-facts)
  trusted="$run_dir/trusted"; decoy="$run_dir/decoy"
  setup_launch_facts "$run_dir"
  run_cmd cb-emit.sh --run journal-facts --agent launcher --code 0 --event launch_ready \
    --payload "{\"worktree\":\"$trusted\",\"branch\":\"combo/trusted\",\"base_sha\":\"$TRUSTED_BASE\",\"runway_kind\":\"treehouse\",\"lease_id\":\"trusted\"}"
  expect_code 0 "$CMD_STATUS" "launch_ready (trusted)"
  CB_WORKTREE="$decoy" CB_BASE_SHA="$DECOY_BASE" \
    run_cmd cb-emit.sh --run journal-facts --agent coder --code 0 --event coder_ready --payload '{}'
  expect_code 0 "$CMD_STATUS" "coder_ready (journal preferred)${CMD_STDERR:+: $CMD_STDERR}"
  local sha
  sha=$(printf '%s' "$CMD_STDOUT" | jq -r '.payload.sha')
  [ "$sha" = "$TRUSTED_HEAD" ] || fail "journal sha: got $sha, expected $TRUSTED_HEAD"
  pass "cb-emit: prefers journaled launch facts over hostile caller environment without config.env"
}

test_backfills_partial_config_env_from_journal() {
  local run_dir trusted decoy
  run_dir=$(make_run partial-config)
  trusted="$run_dir/trusted"; decoy="$run_dir/decoy"
  setup_launch_facts "$run_dir"
  run_cmd cb-emit.sh --run partial-config --agent launcher --code 0 --event launch_ready \
    --payload "{\"worktree\":\"$trusted\",\"branch\":\"combo/trusted\",\"base_sha\":\"$TRUSTED_BASE\",\"runway_kind\":\"treehouse\",\"lease_id\":\"trusted\"}"
  expect_code 0 "$CMD_STATUS" "launch_ready (trusted)"
  printf "CB_WORKTREE='%s'\n" "$trusted" >"$run_dir/config.env"
  CB_WORKTREE="$decoy" CB_BASE_SHA="$DECOY_BASE" \
    run_cmd cb-emit.sh --run partial-config --agent coder --code 0 --event coder_ready --payload '{}'
  expect_code 0 "$CMD_STATUS" "coder_ready (backfilled)${CMD_STDERR:+: $CMD_STDERR}"
  local sha
  sha=$(printf '%s' "$CMD_STDOUT" | jq -r '.payload.sha')
  [ "$sha" = "$TRUSTED_HEAD" ] || fail "backfilled sha: got $sha, expected $TRUSTED_HEAD"
  pass "cb-emit: backfills a partial config.env from journal facts"
}

# ============ cb-emit: needs_change artifact safety =======================

test_accepts_nonempty_artifact_in_run_dir() {
  local run_dir
  run_dir=$(make_run artifact-ok)
  mkdir -p "$run_dir/artifacts"
  printf 'fix this\n' >"$run_dir/artifacts/findings.md"
  run_cmd cb-emit.sh --run artifact-ok --agent reviewer --code 1 --event needs_change \
    --payload "{\"sha\":\"$SHA_A\",\"round\":1,\"member\":\"model\",\"artifact\":\"artifacts/findings.md\"}"
  expect_code 0 "$CMD_STATUS" "needs_change with valid in-run artifact"
  pass "cb-emit: accepts a non-empty needs_change artifact inside the run directory"
}

test_rejects_needs_change_escape() {
  local run_dir outside journal
  run_dir=$(make_run artifact-escape)
  outside="$RUNS_DIR/outside-absolute.md"
  printf 'outside\n' >"$outside"
  mkdir -p "$run_dir/artifacts"

  # absolute path
  run_cmd cb-emit.sh --run artifact-escape --agent reviewer --code 1 --event needs_change \
    --payload "{\"sha\":\"$SHA_A\",\"round\":1,\"member\":\"model\",\"artifact\":\"$outside\"}"
  expect_code 65 "$CMD_STATUS" "absolute artifact should exit 65"
  assert_match 'non-empty findings artifact' "$CMD_STDERR" "absolute escape"

  # traversal
  local trav_outside="$RUNS_DIR/outside-traversal.md"
  printf 'outside\n' >"$trav_outside"
  run_cmd cb-emit.sh --run artifact-escape --agent reviewer --code 1 --event needs_change \
    --payload "{\"sha\":\"$SHA_A\",\"round\":1,\"member\":\"model\",\"artifact\":\"../outside-traversal.md\"}"
  expect_code 65 "$CMD_STATUS" "traversal artifact should exit 65"
  assert_match 'non-empty findings artifact' "$CMD_STDERR" "traversal escape"

  # symlink
  local sym_outside="$RUNS_DIR/outside-symlink.md"
  printf 'outside\n' >"$sym_outside"
  ln -sf "$sym_outside" "$run_dir/artifacts/escape.md"
  run_cmd cb-emit.sh --run artifact-escape --agent reviewer --code 1 --event needs_change \
    --payload "{\"sha\":\"$SHA_A\",\"round\":1,\"member\":\"model\",\"artifact\":\"artifacts/escape.md\"}"
  expect_code 65 "$CMD_STATUS" "symlink artifact should exit 65"
  assert_match 'non-empty findings artifact' "$CMD_STDERR" "symlink escape"
  pass "cb-emit: rejects needs_change absolute, traversal, and symlink escapes"
}

# ============ cb-emit: journal lock liveness + deletion guards =============

test_never_reclaims_alive_owner() {
  local run_dir lock
  run_dir=$(make_run alive-owner); lock="$run_dir/.journal.lock"
  mkdir -p "$lock"
  printf '%s live-owner-token\n' "$$" >"$lock/owner"
  CB_JOURNAL_LOCK_STALE_SECONDS=0 CB_JOURNAL_LOCK_TIMEOUT_SECONDS=1 \
    run_cmd cb-emit.sh --run alive-owner --agent chain --code 0 --event run_created \
    --payload '{"work_item":"#311","repo":"/repo"}'
  expect_code 75 "$CMD_STATUS" "should exit 75 (lock timeout) with live owner"
  local content; content=$(cat "$lock/owner")
  [ "$content" = "$$ live-owner-token" ] || fail "owner file should be unchanged"
  pass "cb-emit: never reclaims a stale lock while its recorded owner is alive"
}

test_reclaims_stale_ownerless_and_malformed_lock() {
  local run_dir lock
  # ownerless
  run_dir=$(make_run stale-ownerless); lock="$run_dir/.journal.lock"
  mkdir -p "$lock"
  CB_JOURNAL_LOCK_STALE_SECONDS=0 CB_JOURNAL_LOCK_TIMEOUT_SECONDS=2 \
    run_cmd cb-emit.sh --run stale-ownerless --agent chain --code 0 --event run_created \
    --payload '{"work_item":"#325","repo":"/repo"}'
  expect_code 0 "$CMD_STATUS" "ownerless lock should be reclaimed${CMD_STDERR:+: $CMD_STDERR}"
  assert_not_match 'No such file or directory' "$CMD_STDERR" "no redirect noise"
  assert_absent "$lock" "ownerless lock dir should be removed"
  # malformed
  run_dir=$(make_run stale-malformed); lock="$run_dir/.journal.lock"
  mkdir -p "$lock"
  printf 'not-a-valid-owner\n' >"$lock/owner"
  CB_JOURNAL_LOCK_STALE_SECONDS=0 CB_JOURNAL_LOCK_TIMEOUT_SECONDS=2 \
    run_cmd cb-emit.sh --run stale-malformed --agent chain --code 0 --event run_created \
    --payload '{"work_item":"#325","repo":"/repo"}'
  expect_code 0 "$CMD_STATUS" "malformed lock should be reclaimed${CMD_STDERR:+: $CMD_STDERR}"
  assert_not_match 'No such file or directory' "$CMD_STDERR" "no redirect noise"
  assert_absent "$lock" "malformed lock dir should be removed"
  pass "cb-emit: reclaims a stale ownerless and malformed lock without redirect noise"
}

test_no_steal_ownerless_gains_live_owner_during_reap() {
  local run_dir lock owner fakebin
  run_dir=$(make_run stale-live-race); lock="$run_dir/.journal.lock"; owner="$lock/owner"
  fakebin=$(cb_fakebin "$run_dir")
  mkdir -p "$lock"
  write_fake "$fakebin/mkdir" <<EOF
#!/bin/sh
if [ "\$1" = "\$CB_TEST_REAP" ]; then
  $REAL_MKDIR "\$@"
  printf '%s\n' "\$CB_TEST_LIVE_OWNER" >"\$CB_TEST_OWNER"
  exit 0
fi
exec $REAL_MKDIR "\$@"
EOF
  PATH="$fakebin:$PATH" \
  CB_TEST_REAP="$lock/.reap" CB_TEST_OWNER="$owner" CB_TEST_LIVE_OWNER="$$ replacement-token" \
  CB_JOURNAL_LOCK_STALE_SECONDS=0 CB_JOURNAL_LOCK_TIMEOUT_SECONDS=1 \
    run_cmd cb-emit.sh --run stale-live-race --agent chain --code 0 --event run_created \
    --payload '{"work_item":"#325","repo":"/repo"}'
  expect_code 75 "$CMD_STATUS" "should exit 75 (owner gained live owner during reap)"
  local content; content=$(cat "$owner")
  [ "$content" = "$$ replacement-token" ] || fail "owner should show replacement token"
  assert_present "$lock" "lock dir should still exist"
  pass "cb-emit: does not steal an ownerless stale lock that gains a live owner during reap"
}

test_one_owner_snapshot_for_liveness_and_deletion() {
  local run_dir lock owner fakebin cat_count live_owner
  run_dir=$(make_run stale-snapshot); lock="$run_dir/.journal.lock"; owner="$lock/owner"
  fakebin=$(cb_fakebin "$run_dir"); cat_count="$run_dir/cat-count"
  live_owner="$$ stable-live-token"
  mkdir -p "$lock" "$fakebin"
  printf '%s\n' "$live_owner" >"$owner"
  write_fake "$fakebin/cat" <<EOF
#!/bin/sh
count=\$($REAL_CAT "\$CB_TEST_CAT_COUNT" 2>/dev/null || printf 0)
count=\$((count + 1))
printf '%s' "\$count" >"\$CB_TEST_CAT_COUNT"
if [ "\$1" = "\$CB_TEST_OWNER" ] && [ "\$count" -eq 1 ]; then
  $REAL_CAT "\$@"
  printf '%s\n' "\$CB_TEST_TRANSIENT_OWNER" >"\$CB_TEST_OWNER"
  exit 0
fi
exec $REAL_CAT "\$@"
EOF
  write_fake "$fakebin/mkdir" <<EOF
#!/bin/sh
if [ "\$1" = "\$CB_TEST_REAP" ]; then
  $REAL_MKDIR "\$@"
  printf '%s\n' "\$CB_TEST_LIVE_OWNER" >"\$CB_TEST_OWNER"
  exit 0
fi
exec $REAL_MKDIR "\$@"
EOF
  PATH="$fakebin:$PATH" \
  CB_TEST_CAT_COUNT="$cat_count" CB_TEST_OWNER="$owner" CB_TEST_REAP="$lock/.reap" \
  CB_TEST_LIVE_OWNER="$live_owner" CB_TEST_TRANSIENT_OWNER="99999999 transient-dead-token" \
  CB_JOURNAL_LOCK_STALE_SECONDS=0 CB_JOURNAL_LOCK_TIMEOUT_SECONDS=1 \
    run_cmd cb-emit.sh --run stale-snapshot --agent chain --code 0 --event run_created \
    --payload '{"work_item":"#325","repo":"/repo"}'
  expect_code 75 "$CMD_STATUS" "should exit 75 (snapshot liveness guard)"
  assert_present "$cat_count" "owner-read fake must have run (snapshot guard exercised)"
  assert_present "$owner" "owner file should still exist"
  assert_present "$lock" "lock dir should still exist"
  pass "cb-emit: uses one journal owner snapshot for liveness and the deletion guard"
}

test_reclaims_stale_lock_when_owner_dead() {
  local run_dir lock
  run_dir=$(make_run dead-owner); lock="$run_dir/.journal.lock"
  mkdir -p "$lock"
  printf '99999999 abandoned-owner-token\n' >"$lock/owner"
  CB_JOURNAL_LOCK_STALE_SECONDS=0 CB_JOURNAL_LOCK_TIMEOUT_SECONDS=2 \
    run_cmd cb-emit.sh --run dead-owner --agent chain --code 0 --event run_created \
    --payload '{"work_item":"#311","repo":"/repo"}'
  expect_code 0 "$CMD_STATUS" "dead-owner lock should be reclaimed"
  assert_absent "$lock" "lock dir should be removed"
  pass "cb-emit: reclaims a stale lock only when its recorded owner is dead"
}

test_no_remove_replacement_lock_on_reread_mismatch() {
  local run_dir lock owner fakebin
  run_dir=$(make_run reread-mismatch); lock="$run_dir/.journal.lock"; owner="$lock/owner"
  fakebin=$(cb_fakebin "$run_dir")
  mkdir -p "$lock" "$fakebin"
  printf '99999999 abandoned-owner-token\n' >"$owner"
  write_fake "$fakebin/cat" <<'EOF'
#!/bin/sh
if [ "$1" = "$CB_TEST_OWNER" ]; then
  printf '%s\n' "$CB_TEST_LIVE_OWNER" >"$1"
  printf '%s\n' "$CB_TEST_LIVE_OWNER"
  exit 0
fi
exec /bin/cat "$@"
EOF
  PATH="$fakebin:$PATH" CB_TEST_OWNER="$owner" CB_TEST_LIVE_OWNER="$$ replacement-token" \
  CB_JOURNAL_LOCK_STALE_SECONDS=0 CB_JOURNAL_LOCK_TIMEOUT_SECONDS=1 \
    run_cmd cb-emit.sh --run reread-mismatch --agent chain --code 0 --event run_created \
    --payload '{"work_item":"#311","repo":"/repo"}'
  expect_code 75 "$CMD_STATUS" "should exit 75 (re-read mismatch)"
  local content; content=$(cat "$owner")
  [ "$content" = "$$ replacement-token" ] || fail "owner should show replacement token"
  assert_present "$lock" "lock dir should still exist"
  pass "cb-emit: does not remove a replacement lock when the re-read owner mismatches"
}

test_leaves_replacement_owner_untouched_during_cleanup() {
  local run_dir owner fakebin
  run_dir=$(make_run cleanup-owner); owner="$run_dir/.journal.lock/owner"
  fakebin=$(cb_fakebin "$run_dir")
  mkdir -p "$fakebin"
  write_fake "$fakebin/cat" <<'EOF'
#!/bin/sh
if [ "$1" = "$CB_TEST_OWNER" ]; then
  printf '1 replacement-token\n' > "$1"
  printf '1 replacement-token\n'
  exit 0
fi
exec /bin/cat "$@"
EOF
  PATH="$fakebin:$PATH" CB_TEST_OWNER="$owner" \
    run_cmd cb-emit.sh --run cleanup-owner --agent chain --code 0 --event run_created \
    --payload '{"work_item":"#311","repo":"/repo"}'
  expect_code 0 "$CMD_STATUS" "normal emit should succeed"
  local content; content=$(cat "$owner")
  [ "$content" = "1 replacement-token" ] || fail "owner should be untouched: got '$content'"
  pass "cb-emit: leaves a replacement owner untouched during cleanup"
}

# ============ cb-emit: concurrent serialization ============================

test_serializes_concurrent_appenders() {
  local run_dir journal pids=() i any_fail=0
  run_dir=$(make_run concurrent); journal="$run_dir/journal.jsonl"
  for i in $(seq 0 23); do
    CB_JOURNAL_LOCK_TIMEOUT_SECONDS=30 \
    sh "$BIN/cb-emit.sh" --run concurrent --agent reviewer --code 0 --event member_result \
      --payload "{\"member\":\"member-$i\",\"round\":1,\"sha\":\"$SHA_B\"}" >/dev/null 2>&1 &
    pids+=($!)
  done
  for pid in "${pids[@]}"; do wait "$pid" || any_fail=1; done
  [ "$any_fail" -eq 0 ] || fail "some concurrent appenders failed"
  local count seqs expected
  count=$(jq -s 'length' "$journal")
  [ "$count" = "24" ] || fail "expected 24 lines, got $count"
  seqs=$(jq -s '[.[] | .seq] | sort | join(",")' "$journal")
  expected=$(jq -nc '[range(1;25)] | join(",")')
  [ "$seqs" = "$expected" ] || fail "seq numbers should be 1-24: got $seqs"
  pass "cb-emit: serializes concurrent appenders without interleaving or duplicate seq"
}

# ============ torn final line tolerance ====================================

test_torn_line_tolerance() {
  local run_dir journal
  run_dir=$(make_run torn); journal="$run_dir/journal.jsonl"
  printf '%s\n%s' \
    '{"seq":1,"ts":"2026-07-23T10:00:00Z","run":"torn","agent":"chain","code":0,"event":"run_created","payload":{"work_item":"#311","repo":"/repo"}}' \
    '{"seq":2' >"$journal"

  run_cmd cb-emit.sh --run torn --agent launcher --code 0 --event launch_ready \
    --payload "{\"worktree\":\"/worktree\",\"branch\":\"combo/torn\",\"base_sha\":\"$SHA_0\",\"runway_kind\":\"treehouse\",\"lease_id\":\"lease-1\"}"
  expect_code 0 "$CMD_STATUS" "emit after torn line should succeed"
  assert_match 'warning.*malformed journal line' "$CMD_STDERR" "emit should warn about torn line"

  run_cmd cb-run-state.sh torn
  expect_code 0 "$CMD_STATUS" "cb-run-state after torn line"
  [ "$CMD_STDOUT" = "coding" ] || fail "cb-run-state should fold to coding, got: $CMD_STDOUT"
  assert_match 'warning.*malformed journal line' "$CMD_STDERR" "run-state should warn"

  CB_WAIT_POLL_SECONDS=0.01 run_cmd cb-wait.sh torn --agent launcher --events launch_ready --after-seq 1 --timeout 1
  expect_code 0 "$CMD_STATUS" "cb-wait should succeed"
  local seq; seq=$(printf '%s' "$CMD_STDOUT" | jq -r '.seq')
  [ "$seq" = "2" ] || fail "cb-wait seq should be 2, got $seq"
  assert_match 'warning.*malformed journal line' "$CMD_STDERR" "wait should warn"
  pass "torn final line: warns, ignores torn record, permits safe next append"
}

# ============ cb-run-state fixture folds ===================================

# fold_inline <run-name> <expected> <jsonl-line>...
fold_inline() {
  local run=$1 expected=$2; shift 2
  local run_dir journal
  run_dir=$(make_run "$run"); journal="$run_dir/journal.jsonl"
  : >"$journal"
  local line
  for line in "$@"; do printf '%s\n' "$line" >>"$journal"; done
  run_cmd cb-run-state.sh "$run"
  expect_code 0 "$CMD_STATUS" "cb-run-state for $run"
  [ -z "$CMD_STDERR" ] || fail "cb-run-state $run: unexpected stderr: $CMD_STDERR"
  [ "$CMD_STDOUT" = "$expected" ] || fail "fold $run: expected '$expected', got '$CMD_STDOUT'"
}

test_fold_launcher_recovery() {
  fold_inline fold-launcher "done" \
    '{"seq":1,"agent":"launcher","code":1,"event":"launch_not_ready","payload":{"reasons":["not ready"]}}' \
    '{"seq":2,"agent":"launcher","code":0,"event":"launch_ready","payload":{}}' \
    '{"seq":3,"agent":"cleaner","code":0,"event":"cleaned","payload":{}}'
  pass "cb-run-state: folds launcher recovery to done"
}

test_fold_gate_recovery() {
  fold_inline fold-gate "done" \
    '{"seq":1,"agent":"gate","code":1,"event":"gate_failed","payload":{"reason":"pipeline_failed"}}' \
    '{"seq":2,"agent":"gate","code":0,"event":"gate_ok","payload":{}}' \
    '{"seq":3,"agent":"cleaner","code":0,"event":"cleaned","payload":{}}'
  pass "cb-run-state: folds gate recovery to done"
}

test_fold_cleaner_recovery() {
  fold_inline fold-cleaner "done" \
    '{"seq":1,"agent":"cleaner","code":1,"event":"clean_failed","payload":{"reasons":["busy"]}}' \
    '{"seq":2,"agent":"cleaner","code":0,"event":"cleaned","payload":{}}'
  pass "cb-run-state: folds cleaner recovery to done"
}

test_fold_gate_failure_through_cleaner() {
  fold_inline fold-gate-cleaner "failed(gate, pipeline_failed)" \
    '{"seq":1,"agent":"gate","code":1,"event":"gate_failed","payload":{"reason":"pipeline_failed"}}' \
    '{"seq":2,"agent":"cleaner","code":1,"event":"clean_failed","payload":{"reasons":["busy"]}}' \
    '{"seq":3,"agent":"cleaner","code":0,"event":"cleaned","payload":{}}'
  pass "cb-run-state: folds gate failure through cleaner recovery"
}

test_fold_chain_failure_through_cleaner() {
  fold_inline fold-chain-cleaner "failed(chain, rounds_exhausted)" \
    '{"seq":1,"agent":"chain","code":1,"event":"chain_stopped","payload":{"reason":"rounds_exhausted"}}' \
    '{"seq":2,"agent":"cleaner","code":1,"event":"clean_failed","payload":{"reasons":["busy"]}}' \
    '{"seq":3,"agent":"cleaner","code":0,"event":"cleaned","payload":{}}'
  pass "cb-run-state: folds chain failure through cleaner recovery"
}

test_fold_chain_failure_through_gate() {
  fold_inline fold-chain-gate "failed(chain, rounds_exhausted)" \
    '{"seq":1,"agent":"chain","code":1,"event":"chain_stopped","payload":{"reason":"rounds_exhausted"}}' \
    '{"seq":2,"agent":"gate","code":1,"event":"gate_failed","payload":{"reason":"pipeline_failed"}}' \
    '{"seq":3,"agent":"gate","code":0,"event":"gate_ok","payload":{}}' \
    '{"seq":4,"agent":"cleaner","code":0,"event":"cleaned","payload":{}}'
  pass "cb-run-state: folds chain failure through gate recovery"
}

test_fold_chain_failure_through_launcher() {
  fold_inline fold-chain-launcher "failed(chain, rounds_exhausted)" \
    '{"seq":1,"agent":"chain","code":1,"event":"chain_stopped","payload":{"reason":"rounds_exhausted"}}' \
    '{"seq":2,"agent":"launcher","code":1,"event":"launch_not_ready","payload":{"reasons":["not ready"]}}' \
    '{"seq":3,"agent":"launcher","code":0,"event":"launch_ready","payload":{}}' \
    '{"seq":4,"agent":"cleaner","code":0,"event":"cleaned","payload":{}}'
  pass "cb-run-state: folds chain failure through launcher recovery"
}

test_fold_lowest_seq_surviving_failure() {
  fold_inline fold-lowest-seq "failed(gate, pipeline_failed)" \
    '{"seq":1,"agent":"gate","code":1,"event":"gate_failed","payload":{"reason":"pipeline_failed"}}' \
    '{"seq":2,"agent":"chain","code":1,"event":"chain_stopped","payload":{"reason":"rounds_exhausted"}}' \
    '{"seq":3,"agent":"cleaner","code":0,"event":"cleaned","payload":{}}'
  pass "cb-run-state: folds lowest-seq surviving failure"
}

test_replays_by_sequence_not_line_order() {
  local run_dir journal
  run_dir=$(make_run out-of-order); journal="$run_dir/journal.jsonl"
  awk '{a[NR]=$0} END {for(i=NR;i>=1;i--) print a[i]}' "$FIXTURES/happy-path.jsonl" >"$journal"
  run_cmd cb-run-state.sh out-of-order
  [ "$CMD_STDOUT" = "done" ] || fail "reversed happy-path should fold to done, got: $CMD_STDOUT"
  pass "cb-run-state: replays by sequence rather than physical line order"
}

test_forensic_events_do_not_route_phase() {
  local run_dir journal product
  run_dir=$(make_run forensic-only); journal="$run_dir/journal.jsonl"
  product=$(cat "$FIXTURES/gate-failure.jsonl")
  printf '%s\n%s\n' "$product" \
    '{"seq":8,"ts":"2026-07-23T10:03:08Z","run":"forensic-only","agent":"gate","code":1,"event":"gate_progress","payload":{"state":"late-forensic-record"}}' >"$journal"
  run_cmd cb-run-state.sh forensic-only
  [ "$CMD_STDOUT" = "failed(gate, pipeline_failed)" ] || fail "forensic+gate-failure should fold to failed(gate), got: $CMD_STDOUT"
  pass "cb-run-state: never lets forensic events route the phase"
}

# fold_fixture <fixture-file> <expected>
fold_fixture() {
  local fixture=$1 expected=$2 run=${1%.jsonl}
  local run_dir journal
  run_dir=$(make_run "$run"); journal="$run_dir/journal.jsonl"
  cp "$FIXTURES/$fixture" "$journal"
  run_cmd cb-run-state.sh "$run"
  expect_code 0 "$CMD_STATUS" "cb-run-state for $fixture"
  [ -z "$CMD_STDERR" ] || fail "$fixture: unexpected stderr: $CMD_STDERR"
  [ "$CMD_STDOUT" = "$expected" ] || fail "$fixture: expected '$expected', got '$CMD_STDOUT'"
}

test_fold_fixtures() {
  fold_fixture happy-path.jsonl "done"
  fold_fixture needs-change-loop.jsonl "done"
  fold_fixture launcher-failure.jsonl "failed(launcher, launch_not_ready)"
  fold_fixture gate-failure.jsonl "failed(gate, pipeline_failed)"
  fold_fixture cleaner-failure.jsonl "failed(cleaner, clean_failed)"
  pass "cb-run-state: folds all journal-v1 fixtures correctly"
}

# ============ run all tests ================================================

test_rejects_invalid_enum_code_event_payload
test_deduplicates_by_identity_key
test_keeps_distinct_payloads_while_deduplicating_retry
test_keeps_member_result_same_scope_different_codes
test_derives_coder_facts_and_verifies_claims
test_prefers_config_env_launch_facts
test_prefers_journal_launch_facts_without_config_env
test_backfills_partial_config_env_from_journal
test_accepts_nonempty_artifact_in_run_dir
test_rejects_needs_change_escape
test_never_reclaims_alive_owner
test_reclaims_stale_ownerless_and_malformed_lock
test_no_steal_ownerless_gains_live_owner_during_reap
test_one_owner_snapshot_for_liveness_and_deletion
test_reclaims_stale_lock_when_owner_dead
test_no_remove_replacement_lock_on_reread_mismatch
test_leaves_replacement_owner_untouched_during_cleanup
test_serializes_concurrent_appenders
test_torn_line_tolerance
test_fold_launcher_recovery
test_fold_gate_recovery
test_fold_cleaner_recovery
test_fold_gate_failure_through_cleaner
test_fold_chain_failure_through_cleaner
test_fold_chain_failure_through_gate
test_fold_chain_failure_through_launcher
test_fold_lowest_seq_surviving_failure
test_replays_by_sequence_not_line_order
test_forensic_events_do_not_route_phase
test_fold_fixtures

printf '\njournal-spine: all tests passed\n'
