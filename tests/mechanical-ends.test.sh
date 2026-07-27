#!/usr/bin/env bash
# tests/mechanical-ends.test.sh
#
# Contract: proves the P3 mechanical Launcher/Cleaner contracts — Treehouse
# runway acquisition/release with exact lease identity, explicit Git worktree
# ownership with distinct custody, immutable Launcher publication, the generic
# seat/harness/auth readiness boundary, and predictable-temp-path
# symlink/replace safety. tmux is not used here; treehouse and git are real
# where the contract demands them, and PATH-first fakes isolate refusal and
# identity-race branches.
set -u

# shellcheck source=tests/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

BIN="$ROOT/bin"
REAL_GIT=$(command -v git)
REAL_REALPATH=$(command -v realpath)
HAS_TREEHOUSE=0
command -v treehouse >/dev/null 2>&1 && HAS_TREEHOUSE=1

CMD_STATUS=
CMD_STDOUT=
CMD_STDERR=

# Prevent cb_tmproot from overriding our EXIT trap; we chain cb_cleanup ourselves.
CB_CLEANUP_DIRS=(_TRAP_GUARD)

# release_all_fixtures: release tracked treehouse leases and git worktrees on
# any exit (including mid-test fail), then remove temp dirs.
release_all_fixtures() {
  local entry repo p
  for entry in "${FIX_GW_PATHS[@]:-}"; do
    [ -n "$entry" ] || continue
    repo=${entry%%|*}; p=${entry#*|}
    git -C "$repo" worktree remove --force "$p" 2>/dev/null || true
  done
  for entry in "${FIX_TH_PATHS[@]:-}"; do
    [ -n "$entry" ] || continue
    repo=${entry%%|*}; p=${entry#*|}
    release_treehouse "$repo" "$p"
  done
  cb_cleanup
}
trap release_all_fixtures EXIT

# run_cb <script> <run>: run bin/<script> with CB_RUNS_DIR; captures CMD_*.
run_cb() {
  local script=$1 run=$2 errfile
  errfile="$FIX_OUTER/.cb.err"
  CMD_STDOUT=$(CB_RUNS_DIR="$FIX_RUNS" sh "$BIN/$script" "$run" 2>"$errfile") && CMD_STATUS=0 || CMD_STATUS=$?
  CMD_STDERR=$(cat "$errfile" 2>/dev/null || true)
}

# make_fixture [treehouse] [no-mistakes]: set up isolated repo + runs dir.
FIX_OUTER=
FIX_REPO=
FIX_RUNS=
FIX_TH_PATHS=()
FIX_GW_PATHS=()

track_treehouse_fixture() {
  FIX_TH_PATHS+=("$1|$2")
}

track_git_fixture() {
  FIX_GW_PATHS+=("$1|$2")
}

forget_fixture() {
  local kind=$1 target="$2|$3" entry kept=()
  if [ "$kind" = treehouse ]; then
    for entry in "${FIX_TH_PATHS[@]:-}"; do
      [ "$entry" = "$target" ] || kept+=("$entry")
    done
    FIX_TH_PATHS=()
    for entry in "${kept[@]:-}"; do
      [ -n "$entry" ] && FIX_TH_PATHS+=("$entry")
    done
  else
    for entry in "${FIX_GW_PATHS[@]:-}"; do
      [ "$entry" = "$target" ] || kept+=("$entry")
    done
    FIX_GW_PATHS=()
    for entry in "${kept[@]:-}"; do
      [ -n "$entry" ] && FIX_GW_PATHS+=("$entry")
    done
  fi
}

remove_git_fixture() {
  local repo=$1 path=$2
  if git -C "$repo" worktree remove --force "$path" 2>/dev/null; then
    forget_fixture git "$repo" "$path"
  fi
}

make_fixture() {
  cb_tmproot FIX_OUTER cb-p3
  mkdir -p "$FIX_OUTER/repo" "$FIX_OUTER/runs"
  FIX_REPO=$(cd "$FIX_OUTER/repo" && pwd -P)
  FIX_RUNS=$(cd "$FIX_OUTER/runs" && pwd -P)
  git -C "$FIX_REPO" init -q -b main
  git -C "$FIX_REPO" config user.name "Combo P3 Test"
  git -C "$FIX_REPO" config user.email "combo-p3@example.test"
  printf 'fixture\n' >"$FIX_REPO/README.md"
  [ -z "${1:-}" ] || (cd "$FIX_REPO" && treehouse init) >/dev/null 2>&1
  [ -z "${2:-}" ] || printf 'checks:\n  test: true\n' >"$FIX_REPO/.no-mistakes.yaml"
  git -C "$FIX_REPO" add .
  git -C "$FIX_REPO" commit -qm "fixture base"
}

# Fixture ownership must survive later fixture setup so the EXIT trap can
# release resources that an earlier test deliberately leaves held.
test_fixture_registry_survives_fixture_reset() {
  make_fixture
  local first_repo=$FIX_REPO first_path="$FIX_REPO/.worktrees/held"
  local first_treehouse_path="$FIX_REPO/.worktrees/treehouse-held"
  track_git_fixture "$first_repo" "$first_path"
  track_treehouse_fixture "$first_repo" "$first_treehouse_path"
  make_fixture
  local found=0 treehouse_found=0 entry
  for entry in "${FIX_GW_PATHS[@]:-}"; do
    [ "$entry" = "$first_repo|$first_path" ] && found=1
  done
  for entry in "${FIX_TH_PATHS[@]:-}"; do
    [ "$entry" = "$first_repo|$first_treehouse_path" ] && treehouse_found=1
  done
  [ "$found" = "1" ] || fail "make_fixture orphaned an earlier owned worktree"
  [ "$treehouse_found" = "1" ] || fail "make_fixture orphaned an earlier Treehouse lease"
  forget_fixture git "$first_repo" "$first_path"
  forget_fixture treehouse "$first_repo" "$first_treehouse_path"
  pass "mechanical fixtures: ownership registry survives fixture reset"
}

# make_run <run> [mode] [setup] [custody] [readiness_file]
make_run() {
  local run=$1 mode=${2:-treehouse} setup=${3:-} custody=${4:-exit 0} readiness=${5:-}
  local run_dir="$FIX_RUNS/$run"
  mkdir -p "$run_dir/agents"
  if [ -n "$readiness" ]; then
    cp "$readiness" "$run_dir/readiness.json"
  else
    cat >"$run_dir/readiness.json" <<'JSON'
{"required_seats":["coder","reviewer","gate"],"seats":[{"id":"coder","harness":"/bin/sh","auth_cmd":"exit 0"},{"id":"reviewer","harness":"/bin/sh","auth_cmd":"exit 0"},{"id":"gate","harness":"/bin/sh","auth_cmd":"exit 0"}]}
JSON
  fi
  cat >"$run_dir/config.env" <<EOF
CB_REPO_DIR='$FIX_REPO'
CB_RUNWAY_MODE='$mode'
CB_READINESS_FILE='$run_dir/readiness.json'
CB_GIT_WORKTREE_PATH='$FIX_REPO/.worktrees/$run'
CB_SETUP_CMD='$setup'
CB_CLEAN_CUSTODY_CMD='$custody'
EOF
}

# assert_last_event <run> <agent> <code> <event> <reason>: check the last journal
# event has the exact agent/code/event triple AND that payload.reasons contains
# <reason>. Fails (does NOT false-green) if the journal is missing.
assert_last_event() {
  local run=$1 agent=$2 code=$3 event=$4 reason=$5
  local journal="$FIX_RUNS/$run/journal.jsonl"
  [ -f "$journal" ] || fail "assert_last_event: journal missing for $run"
  local last; last=$(tail -1 "$journal")
  printf '%s' "$last" | jq -e --arg a "$agent" --argjson c "$code" --arg e "$event" \
    --arg r "$reason" \
    '.agent==$a and .code==$c and .event==$e and (.payload.reasons | index($r) >= 0)' >/dev/null \
    || fail "last event mismatch for $run: expected agent=$agent code=$code event=$event reason=$reason, got: $last"
}

# last_event_field <run> <jq-path>: echo value from last journal event.
last_field() {
  local journal="$FIX_RUNS/$1/journal.jsonl"
  [ -f "$journal" ] || return 1
  tail -1 "$journal" | jq -r "$2"
}

# release_treehouse <repo> <path>: return and destroy a treehouse lease.
release_treehouse() {
  [ "$HAS_TREEHOUSE" = "1" ] || return 0
  local repo=$1 p=$2
  (cd "$repo" && treehouse return "$p") >/dev/null 2>&1 \
    || (cd "$repo" && treehouse return --force "$p") >/dev/null 2>&1 || true
  (cd "$repo" && treehouse destroy "$p" --include-unlanded --yes) >/dev/null 2>&1 || true
}

# write_fake <path>: read body from stdin, write executable.
write_fake() { cat >"$1"; chmod +x "$1"; }

# th <args...>: run treehouse inside the fixture repo (cwd matters for init/status).
th() { (cd "$FIX_REPO" && treehouse "$@"); }

# fake_th <body...>: create fake treehouse in $FIX_OUTER/fake-bin, echo its dir.
fake_th() {
  local fb; fb=$(cb_fakebin "$FIX_OUTER")
  write_fake "$fb/treehouse" <<EOF
$1
EOF
  printf '%s\n' "$fb"
}

# ============ Treehouse runway (gated on treehouse availability) ============
if [ "$HAS_TREEHOUSE" = "1" ]; then

test_th_persists_exact_lease_and_releases() {
  make_fixture 1 1
  local run=p3-th-real
  make_run "$run" treehouse "test -f .no-mistakes.yaml"
  local base_sha; base_sha=$(git -C "$FIX_REPO" rev-parse HEAD)

  run_cb cb-launcher.sh "$run"
  expect_code 0 "$CMD_STATUS" "launcher should succeed${CMD_STDERR:+: $CMD_STDERR}"
  local meta; meta=$(cat "$FIX_RUNS/$run/agents/launcher.ownership.json")
  local wt; wt=$(printf '%s' "$meta" | jq -r '.worktree')
  [ "$(cb_file_mode "$FIX_RUNS/$run/agents/launcher.ownership.json")" = 444 ] \
    || fail "Launcher ownership should be published read-only"
  for kv in "run:$run" "runway_kind:treehouse" "repo_dir:$FIX_REPO" "branch:combo/$run" "base_sha:$base_sha" "lease_id:$run"; do
    local k=${kv%%:*} v=${kv#*:}
    [ "$(printf '%s' "$meta" | jq -r ".$k")" = "$v" ] || fail "ownership $k mismatch"
  done
  [ "${wt:0:1}" = "/" ] || fail "worktree should be absolute"
  [ "$(git -C "$wt" branch --show-current)" = "combo/$run" ] || fail "worktree branch mismatch"
  assert_contains "$(cat "$wt/.no-mistakes.yaml")" "test: true" "no-mistakes not propagated"
  track_treehouse_fixture "$FIX_REPO" "$wt"
  local last; last=$(tail -1 "$FIX_RUNS/$run/journal.jsonl")
  printf '%s' "$last" | jq -e '.agent=="launcher" and .code==0 and .event=="launch_ready"' >/dev/null || fail "launch_ready event mismatch"
  printf '%s' "$last" | jq -e --arg wt "$wt" --arg b "$base_sha" --arg r "$run" \
    '.payload.worktree==$wt and .payload.branch=="combo/'"$run"'" and .payload.base_sha==$b and .payload.runway_kind=="treehouse" and .payload.lease_id==$r' >/dev/null || fail "launch_ready payload mismatch"
  assert_contains "$(th status)" "held by $run" "lease should be held"
  assert_contains "$(th status)" "$(basename "$wt")" "status should show worktree basename"

  run_cb cb-cleaner.sh "$run"
  expect_code 0 "$CMD_STATUS" "cleaner should succeed${CMD_STDERR:+: $CMD_STDERR}"
  local last2; last2=$(tail -1 "$FIX_RUNS/$run/journal.jsonl")
  printf '%s' "$last2" | jq -e '.agent=="cleaner" and .code==0 and .event=="cleaned"' >/dev/null || fail "cleaned event mismatch"
  assert_contains "$(th status)" "available" "lease should be available"
  assert_not_contains "$(th status)" "held by $run" "lease should not be held"
  local cm; cm=$(cat "$FIX_RUNS/$run/agents/cleaner.ownership.json")
  printf '%s' "$cm" | jq -e --arg wt "$wt" '.run=="'"$run"'" and .runway_kind=="treehouse" and .worktree==$wt and .released==true' >/dev/null || fail "cleaner meta mismatch"
  forget_fixture treehouse "$FIX_REPO" "$wt"
  pass "cb-launcher/cleaner: persists exact real lease and releases same path"
}

test_th_journals_refused_return_and_leaves_held() {
  make_fixture 1
  local run=p3-th-refusal
  make_run "$run"
  run_cb cb-launcher.sh "$run"; expect_code 0 "$CMD_STATUS" "launcher"
  local wt; wt=$(jq -r '.worktree' "$FIX_RUNS/$run/agents/launcher.ownership.json")
  track_treehouse_fixture "$FIX_REPO" "$wt"
  local fb; fb=$(fake_th "#!/bin/sh
if [ \"\$1\" = status ]; then exec $(command -v treehouse) \"\$@\"; fi
exit 42
")
  CB_RUNS_DIR="$FIX_RUNS" PATH="$fb:$PATH" sh "$BIN/cb-cleaner.sh" "$run" 2>/dev/null && CMD_STATUS=0 || CMD_STATUS=$?
  [ "$CMD_STATUS" -ne 0 ] || fail "refused return should fail"
  assert_last_event "$run" cleaner 1 clean_failed "treehouse:release_refused"
  assert_contains "$(th status)" "held by $run" "lease should remain held"
  pass "cb-cleaner: journals refused Treehouse return and leaves lease held"
}

test_th_rechecks_identity_before_return() {
  make_fixture 1
  local run=p3-th-id-race
  make_run "$run"
  run_cb cb-launcher.sh "$run"; expect_code 0 "$CMD_STATUS" "launcher"
  local wt; wt=$(jq -r '.worktree' "$FIX_RUNS/$run/agents/launcher.ownership.json")
  track_treehouse_fixture "$FIX_REPO" "$wt"
  local marker="$FIX_OUTER/th-count"
  local fb; fb=$(fake_th "#!/bin/sh
if [ \"\$1\" = status ]; then
  count=\$(cat \"$marker\" 2>/dev/null || printf 0); count=\$((count + 1)); printf '%s' \"\$count\" >\"$marker\"
  [ \"\$count\" -eq 1 ] && exec $(command -v treehouse) \"\$@\"
  exit 42
fi
if [ \"\$1\" = return ]; then printf called >\"$marker.return\"; exit 99; fi
exec $(command -v treehouse) \"\$@\"
")
  CB_RUNS_DIR="$FIX_RUNS" PATH="$fb:$PATH" sh "$BIN/cb-cleaner.sh" "$run" 2>/dev/null && CMD_STATUS=0 || CMD_STATUS=$?
  [ "$CMD_STATUS" -ne 0 ] || fail "identity race should fail"
  assert_last_event "$run" cleaner 1 clean_failed "treehouse:lease_identity_changed"
  [ ! -f "$marker.return" ] || fail "should not have called return"
  assert_contains "$(th status)" "held by $run" "lease should remain held"
  pass "cb-cleaner: rechecks exact live identity before Treehouse return"
}

test_th_recovers_wrong_absolute_output() {
  for shape in single dual; do
    make_fixture 1
    local run="p3-th-${shape}-absolute"
    make_run "$run"
    local fb; fb=$(fake_th "#!/bin/sh
if [ \"\$1\" = get ]; then
  actual=\$($(command -v treehouse) \"\$@\")
  code=\$?
  [ \"\$code\" -ne 0 ] || { printf '/wrong-treehouse-path\n'; [ \"$shape\" = dual ] && printf '%s\n' \"\$actual\"; }
  exit \"\$code\"
fi
exec $(command -v treehouse) \"\$@\"
")
    CB_RUNS_DIR="$FIX_RUNS" PATH="$fb:$PATH" sh "$BIN/cb-launcher.sh" "$run" 2>/dev/null && CMD_STATUS=0 || CMD_STATUS=$?
    [ "$CMD_STATUS" -ne 0 ] || fail "$shape: wrong absolute should fail"
    assert_last_event "$run" launcher 1 launch_not_ready "treehouse:invalid_response"
    assert_absent "$FIX_RUNS/$run/agents/launcher.ownership.json" "$shape: no ownership should be written"
    assert_not_contains "$(th status)" "held by $run" "$shape: no lease should be held"
  done
  pass "cb-launcher: recovers holder after single/dual wrong absolute output"
}

test_th_exact_cleanup_after_branch_fail() {
  make_fixture 1
  local run=p3-th-branch-fail
  make_run "$run"
  local fb; fb=$(cb_fakebin "$FIX_OUTER")
  write_fake "$fb/git" <<EOF
#!/bin/sh
if [ "\$3" = switch ] && [ "\$4" = -c ] && [ "\$5" = "combo/$run" ]; then exit 42; fi
exec $REAL_GIT "\$@"
EOF
  CB_RUNS_DIR="$FIX_RUNS" PATH="$fb:$PATH" sh "$BIN/cb-launcher.sh" "$run" 2>/dev/null && CMD_STATUS=0 || CMD_STATUS=$?
  [ "$CMD_STATUS" -ne 0 ] || fail "branch fail should fail"
  assert_last_event "$run" launcher 1 launch_not_ready "branch:create_failed"
  run_cb cb-cleaner.sh "$run"
  expect_code 0 "$CMD_STATUS" "cleanup after branch fail"
  assert_not_contains "$(th status)" "held by $run" "lease should be released"
  pass "cb-launcher: allows exact cleanup after branch creation fails in a real lease"
}

fi # HAS_TREEHOUSE

# ============ Treehouse refusal (fake treehouse — runs unconditionally) =====

test_th_refusal_never_creates_git_worktree() {
  make_fixture
  local run=p3-th-refused
  make_run "$run"
  local fb; fb=$(fake_th "#!/bin/sh
printf called >\"$FIX_OUTER/th-called\"
exit 42
")
  local git_path="$FIX_REPO/.worktrees/$run"
  CB_RUNS_DIR="$FIX_RUNS" PATH="$fb:$PATH" sh "$BIN/cb-launcher.sh" "$run" 2>/dev/null && CMD_STATUS=0 || CMD_STATUS=$?
  [ "$CMD_STATUS" -ne 0 ] || fail "treehouse refusal should fail"
  assert_present "$FIX_OUTER/th-called" "treehouse should have been called"
  assert_absent "$git_path" "no git worktree should be created"
  git -C "$FIX_REPO" show-ref --verify "refs/heads/combo/$run" 2>/dev/null && fail "branch should not exist" || true
  assert_last_event "$run" launcher 1 launch_not_ready "treehouse:acquire_refused"
  pass "cb-launcher: journals Treehouse refusal and never creates an automatic Git worktree"
}

test_th_rollback_refusal_unrecoverable() {
  make_fixture
  local run=p3-th-unrecoverable
  make_run "$run"
  local fb; fb=$(fake_th "#!/bin/sh
if [ \"\$1\" = get ]; then printf called >\"$FIX_OUTER/th-called\"; printf 'unusable\n'; exit 0; fi
exit 42
")
  local git_path="$FIX_REPO/.worktrees/$run"
  CB_RUNS_DIR="$FIX_RUNS" PATH="$fb:$PATH" sh "$BIN/cb-launcher.sh" "$run" 2>/dev/null && CMD_STATUS=0 || CMD_STATUS=$?
  [ "$CMD_STATUS" -ne 0 ] || fail "unrecoverable should fail"
  assert_last_event "$run" launcher 1 launch_not_ready "treehouse:invalid_response"
  assert_last_event "$run" launcher 1 launch_not_ready "treehouse:rollback_refused"
  assert_absent "$git_path" "no git worktree"
  pass "cb-launcher: journals rollback refusal when no unique holder path can be recovered"
}

# ============ Explicit Git runway and Cleaner custody ======================

test_git_records_distinct_owner_never_calls_treehouse() {
  make_fixture
  local run=p3-git-explicit
  make_run "$run" git-worktree-explicit
  local fb; fb=$(fake_th "#!/bin/sh
printf called >\"$FIX_OUTER/th-called\"
exit 99
")
  local git_path="$FIX_REPO/.worktrees/$run"
  CB_RUNS_DIR="$FIX_RUNS" PATH="$fb:$PATH" sh "$BIN/cb-launcher.sh" "$run" 2>/dev/null && CMD_STATUS=0 || CMD_STATUS=$?
  expect_code 0 "$CMD_STATUS" "git launcher should succeed${CMD_STDERR:+: $CMD_STDERR}"
  local meta; meta=$(cat "$FIX_RUNS/$run/agents/launcher.ownership.json")
  printf '%s' "$meta" | jq -e --arg r "$run" --arg gp "$git_path" \
    '.run==$r and .runway_kind=="git-worktree-explicit" and .worktree==$gp and .branch=="combo/'"$run"'" and .ownership_id=="git-worktree:'"$run"'" and (.lease_id|not)' >/dev/null || fail "git ownership meta mismatch"
  local last; last=$(tail -1 "$FIX_RUNS/$run/journal.jsonl")
  printf '%s' "$last" | jq -e '.payload.runway_kind=="git-worktree-explicit" and .payload.ownership_id=="git-worktree:'"$run"'" and .payload.lease_id=="not-applicable"' >/dev/null || fail "launch_ready payload mismatch"
  assert_absent "$FIX_OUTER/th-called" "treehouse should never be called"
  track_git_fixture "$FIX_REPO" "$git_path"

  CB_RUNS_DIR="$FIX_RUNS" PATH="$fb:$PATH" sh "$BIN/cb-cleaner.sh" "$run" 2>/dev/null && CMD_STATUS=0 || CMD_STATUS=$?
  expect_code 0 "$CMD_STATUS" "git cleaner should succeed${CMD_STDERR:+: $CMD_STDERR}"
  assert_absent "$git_path" "git worktree should be removed"
  assert_absent "$FIX_OUTER/th-called" "treehouse should still not be called"
  forget_fixture git "$FIX_REPO" "$git_path"
  pass "cb-launcher/cleaner: records distinct Git owner, never calls Treehouse, removes exact path"
}

test_git_refuses_copied_ownership_metadata() {
  make_fixture
  local run=p3-owner-mismatch
  make_run "$run" git-worktree-explicit
  local git_path="$FIX_REPO/.worktrees/$run"
  run_cb cb-launcher.sh "$run"; expect_code 0 "$CMD_STATUS" "launcher"
  track_git_fixture "$FIX_REPO" "$git_path"
  local meta; meta=$(cat "$FIX_RUNS/$run/agents/launcher.ownership.json")
  chmod u+w "$FIX_RUNS/$run/agents/launcher.ownership.json"
  printf '%s' "$meta" | jq -c '.run="another-run" | .ownership_id="git-worktree:another-run"' >"$FIX_RUNS/$run/agents/launcher.ownership.json"
  chmod 0444 "$FIX_RUNS/$run/agents/launcher.ownership.json"

  run_cb cb-cleaner.sh "$run"
  [ "$CMD_STATUS" -ne 0 ] || fail "mismatched ownership should fail"
  assert_present "$git_path" "worktree should still exist"
  assert_last_event "$run" cleaner 1 clean_failed "ownership:run_mismatch"
  remove_git_fixture "$FIX_REPO" "$git_path"
  pass "cb-cleaner: refuses copied ownership metadata from another run"
}

test_git_fails_on_custody_active_and_release_refused() {
  make_fixture
  # custody active
  local run1=p3-custody-active
  make_run "$run1" git-worktree-explicit "" "exit 1"
  run_cb cb-launcher.sh "$run1"; expect_code 0 "$CMD_STATUS" "launcher custody"
  local git_path1="$FIX_REPO/.worktrees/$run1"
  track_git_fixture "$FIX_REPO" "$git_path1"
  run_cb cb-cleaner.sh "$run1"
  [ "$CMD_STATUS" -ne 0 ] || fail "custody active should fail"
  assert_present "$FIX_REPO/.worktrees/$run1" "worktree should exist (custody)"
  assert_last_event "$run1" cleaner 1 clean_failed "custody:active_or_unverified"

  # release refused (dirty)
  local run2=p3-release-refused
  make_run "$run2" git-worktree-explicit
  run_cb cb-launcher.sh "$run2"; expect_code 0 "$CMD_STATUS" "launcher dirty"
  local git_path2="$FIX_REPO/.worktrees/$run2"
  track_git_fixture "$FIX_REPO" "$git_path2"
  printf 'do not force\n' >"$FIX_REPO/.worktrees/$run2/dirty.txt"
  run_cb cb-cleaner.sh "$run2"
  [ "$CMD_STATUS" -ne 0 ] || fail "dirty release should fail"
  assert_present "$FIX_REPO/.worktrees/$run2" "worktree should exist (dirty)"
  assert_last_event "$run2" cleaner 1 clean_failed "git-worktree:release_refused"
  remove_git_fixture "$FIX_REPO" "$git_path1"
  remove_git_fixture "$FIX_REPO" "$git_path2"
  pass "cb-cleaner: fails safely while Gate custody active or exact Git release refused"
}

test_git_refuses_collisions_and_setup_only_when_configured() {
  make_fixture
  # branch collision
  local run1=p3-branch-collision
  make_run "$run1" git-worktree-explicit
  git -C "$FIX_REPO" branch "combo/$run1"
  run_cb cb-launcher.sh "$run1"
  [ "$CMD_STATUS" -ne 0 ] || fail "branch collision should fail"
  assert_last_event "$run1" launcher 1 launch_not_ready "branch:collision"
  assert_absent "$FIX_REPO/.worktrees/$run1" "no worktree (collision)"

  # setup explicit
  local run2=p3-setup-explicit
  make_run "$run2" git-worktree-explicit "exit 7"
  run_cb cb-launcher.sh "$run2"
  [ "$CMD_STATUS" -ne 0 ] || fail "setup failure should fail"
  assert_last_event "$run2" launcher 1 launch_not_ready "setup:failed"
  run_cb cb-cleaner.sh "$run2"; expect_code 0 "$CMD_STATUS" "cleanup after setup fail"
  pass "cb-launcher: refuses branch collisions and runs setup only when configured"
}

test_git_clears_failed_ownership_for_retry() {
  make_fixture
  local run=p3-git-retry
  make_run "$run" git-worktree-explicit
  local fb; fb=$(cb_fakebin "$FIX_OUTER")
  write_fake "$fb/git" <<EOF
#!/bin/sh
if [ "\$3" = worktree ] && [ "\$4" = add ]; then exit 42; fi
exec $REAL_GIT "\$@"
EOF
  CB_RUNS_DIR="$FIX_RUNS" PATH="$fb:$PATH" sh "$BIN/cb-launcher.sh" "$run" 2>/dev/null && CMD_STATUS=0 || CMD_STATUS=$?
  [ "$CMD_STATUS" -ne 0 ] || fail "first attempt (fake git add fail) should fail"
  assert_absent "$FIX_RUNS/$run/agents/launcher.ownership.json" "no ownership after failed attempt"
  run_cb cb-launcher.sh "$run"; expect_code 0 "$CMD_STATUS" "retry should succeed"
  local git_path="$FIX_REPO/.worktrees/$run"
  track_git_fixture "$FIX_REPO" "$git_path"
  run_cb cb-cleaner.sh "$run"; expect_code 0 "$CMD_STATUS" "cleanup"
  forget_fixture git "$FIX_REPO" "$git_path"
  pass "cb-launcher: clears failed explicit Git ownership so the same attempt can retry"
}

# ============ Predictable temp path safety (symlink/replace) ===============
#
# The launcher/cleaner refuse to overwrite a predictable temp path that already
# exists (symlink or regular file) planted by an attacker who knows the PID.
# We use a fake realpath to pause the script at a known point, plant the attack
# using the background PID, then release and verify the script refuses.

# do_temp_attack <script> <run> <location(run|agents)> <prefix> <kind> <prelaunch?>
do_temp_attack() {
  local script=$1 run=$2 location=$3 prefix=$4 kind=$5 prelaunch=${6:-}
  local marker="$FIX_OUTER/rp-marker"
  local fb; fb=$(cb_fakebin "$FIX_OUTER")
  rm -f "$marker"
  write_fake "$fb/realpath" <<EOF
#!/bin/sh
while [ ! -e "$marker" ]; do sleep 0.01; done
exec $REAL_REALPATH "\$@"
EOF
  local run_dir="$FIX_RUNS/$run"
  local parent; [ "$location" = agents ] && parent="$run_dir/agents" || parent="$run_dir"
  local pid

  # pre-launch for cleaner temp tests
  [ -z "$prelaunch" ] || { CB_RUNS_DIR="$FIX_RUNS" sh "$BIN/cb-launcher.sh" "$run" 2>/dev/null || true; }

  CB_RUNS_DIR="$FIX_RUNS" PATH="$fb:$PATH" sh "$BIN/$script" "$run" >"$FIX_OUTER/paused.out" 2>"$FIX_OUTER/paused.err" &
  pid=$!
  local attack_path="$parent/${prefix}${pid}"
  local victim="$FIX_OUTER/victim-$kind-$run"

  case "$kind" in
    regular) printf 'STAGING OWNER\n' >"$attack_path" ;;
    existing) printf 'PRECIOUS\n' >"$victim"; ln -s "$victim" "$attack_path" ;;
    dangling) ln -s "$victim" "$attack_path" ;;
  esac

  printf 'continue\n' >"$marker"
  wait "$pid" && CMD_STATUS=0 || CMD_STATUS=$?
  CMD_STDOUT=$(cat "$FIX_OUTER/paused.out"); CMD_STDERR=$(cat "$FIX_OUTER/paused.err")

  [ "$CMD_STATUS" -ne 0 ] || fail "$script temp $prefix ($kind): should refuse to overwrite"
  if [ "$kind" = regular ]; then
    [ "$(cat "$attack_path")" = "STAGING OWNER" ] || fail "regular file should be unchanged ($prefix $kind)"
  else
    [ "$(readlink "$attack_path")" = "$victim" ] || fail "symlink should be intact ($prefix $kind)"
    if [ "$kind" = existing ]; then
      [ "$(cat "$victim")" = "PRECIOUS" ] || fail "existing victim should be unchanged ($prefix $kind)"
    else
      assert_absent "$victim" "dangling victim should not exist ($prefix $kind)"
    fi
  fi
}

test_launcher_temp_safety() {
  local temps=(
    "run:.launcher-reasons."
    "run:.launcher-seats."
    "run:.launcher-treehouse-out."
    "run:.launcher-treehouse-err."
    "agents:.launcher.ownership.tmp."
    "run:.config.env.tmp."
  )
  for spec in "${temps[@]}"; do
    local loc=${spec%%:*} prefix=${spec#*:}
    for kind in existing dangling regular; do
      make_fixture
      local run; run="p3-lt-$(printf '%s' "$prefix" | tr -dc 'a-z')-$kind"
      make_run "$run" git-worktree-explicit
      do_temp_attack cb-launcher.sh "$run" "$loc" "$prefix" "$kind"
    done
  done
  pass "cb-launcher: does not replace predictable temp paths (18 cases)"
}

test_cleaner_temp_safety() {
  local temps=("run:.cleaner-reasons." "agents:.cleaner.ownership.tmp.")
  for spec in "${temps[@]}"; do
    local loc=${spec%%:*} prefix=${spec#*:}
    for kind in existing dangling regular; do
      make_fixture
      local run; run="p3-ct-$(printf '%s' "$prefix" | tr -dc 'a-z')-$kind"
      make_run "$run" git-worktree-explicit
      do_temp_attack cb-cleaner.sh "$run" "$loc" "$prefix" "$kind" 1
    done
  done
  pass "cb-cleaner: does not replace predictable temp paths (6 cases)"
}

# ============ Readiness boundary ===========================================

test_readiness_aggregates_failures() {
  make_fixture
  local run=p3-readiness-failures
  local not_runnable="$FIX_OUTER/not-runnable"
  printf '#!/bin/sh\nexit 0\n' >"$not_runnable"; chmod 644 "$not_runnable"
  local readiness="$FIX_OUTER/readiness.json"
  cat >"$readiness" <<JSON
{"required_seats":["missing","no-bin","not-runnable","auth"],"seats":[
{"id":"no-bin","harness":"$FIX_OUTER/absent-harness","auth_cmd":"exit 0"},
{"id":"not-runnable","harness":"$not_runnable","auth_cmd":"exit 0"},
{"id":"auth","harness":"/bin/sh","auth_cmd":"printf 'SUPER_SECRET_P3_TOKEN' >&2; exit 9"}
]}
JSON
  make_run "$run" treehouse "" "exit 0" "$readiness"
  local fb; fb=$(fake_th "#!/bin/sh
printf called >\"$FIX_OUTER/th-called\"
exit 99
")
  CB_RUNS_DIR="$FIX_RUNS" PATH="$fb:$PATH" sh "$BIN/cb-launcher.sh" "$run" >"$FIX_OUTER/rd.out" 2>"$FIX_OUTER/rd.err" && CMD_STATUS=0 || CMD_STATUS=$?
  CMD_STDOUT=$(cat "$FIX_OUTER/rd.out"); CMD_STDERR=$(cat "$FIX_OUTER/rd.err")
  [ "$CMD_STATUS" -ne 0 ] || fail "readiness failures should fail"
  assert_absent "$FIX_OUTER/th-called" "treehouse should not be called on readiness failure"
  local journal="$FIX_RUNS/$run/journal.jsonl"
  local last; last=$(tail -1 "$journal")
  printf '%s' "$last" | jq -e '.agent=="launcher" and .code==1 and .event=="launch_not_ready"' >/dev/null || fail "launch_not_ready event"
  for r in "seat:missing:missing" "seat:no-bin:harness:absent-harness:missing" "seat:not-runnable:harness:not-runnable:not_runnable" "seat:auth:auth:sh:not_ready"; do
    printf '%s' "$last" | jq -e --arg r "$r" '.payload.reasons | index($r) >= 0' >/dev/null || fail "missing reason: $r"
  done
  local all_output; all_output="$CMD_STDOUT$CMD_STDERR$(cat "$journal")"
  assert_not_contains "$all_output" "SUPER_SECRET_P3_TOKEN" "auth output should not leak"
  run_cb cb-cleaner.sh "$run"; expect_code 0 "$CMD_STATUS" "cleanup after readiness failure"
  assert_absent "$FIX_OUTER/th-called" "treehouse should still not be called"
  local last2; last2=$(tail -1 "$journal")
  printf '%s' "$last2" | jq -e '.agent=="cleaner" and .code==0 and .event=="cleaned"' >/dev/null || fail "cleaned event"
  pass "cb-launcher: aggregates missing seat, harness, and auth failures without leaking output"
}

# ============ run all tests ================================================
test_fixture_registry_survives_fixture_reset
if [ "$HAS_TREEHOUSE" = "1" ]; then
  test_th_persists_exact_lease_and_releases
  test_th_journals_refused_return_and_leaves_held
  test_th_rechecks_identity_before_return
  test_th_recovers_wrong_absolute_output
  test_th_exact_cleanup_after_branch_fail
fi
test_th_refusal_never_creates_git_worktree
test_th_rollback_refusal_unrecoverable
test_git_records_distinct_owner_never_calls_treehouse
test_git_refuses_copied_ownership_metadata
test_git_fails_on_custody_active_and_release_refused
test_git_refuses_collisions_and_setup_only_when_configured
test_git_clears_failed_ownership_for_retry
test_launcher_temp_safety
test_cleaner_temp_safety
test_readiness_aggregates_failures

printf '\nmechanical-ends: all tests passed\n'
