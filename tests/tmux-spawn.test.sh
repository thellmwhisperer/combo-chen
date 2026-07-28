#!/usr/bin/env bash
# tests/tmux-spawn.test.sh
#
# Contract: proves the P2 tmux spawn/meta/status contracts — five pinned
# windows with canonical role modes and atomic meta, exact-session target
# resolution and isolation, spawn-lock liveness/deletion guards, symlink
# containment, live endpoint send/peek/status with verified Enter, idempotent
# teardown, and stale-id reuse safety. tmux is real (isolated socket per test);
# Python fakes simulate TUI composers for the verified-Enter path.
#
# This entire suite is skipped when tmux is not available.
set -u

if ! command -v tmux >/dev/null 2>&1; then
  printf 'skip - tmux not available\n' >&2
  exit 0
fi

# shellcheck source=tests/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

BIN="$ROOT/bin"
REAL_MKDIR=$(command -v mkdir)
REAL_CAT=$(command -v cat)
REAL_STAT=$(command -v stat)
AGENTS=(launcher coder reviewer gate cleaner)
HAVE_PYTHON3=0
command -v python3 >/dev/null 2>&1 && HAVE_PYTHON3=1

CMD_STATUS=
CMD_STDOUT=
CMD_STDERR=

TMUX_HOME=
TMUX_RUNS=
TMUX_SOCKET=
TMUX_SOCKETS=()

cleanup_tmux() {
  local s
  for s in "${TMUX_SOCKETS[@]:-}"; do
    [ -n "$s" ] && tmux -L "$s" -f /dev/null kill-server 2>/dev/null || true
  done
  TMUX_SOCKETS=()
}
trap 'cleanup_tmux; cb_cleanup' EXIT

# setup_home: create an isolated tmux home with runs dir and unique socket.
# Kills the previous test's server first so only one is live at a time.
setup_home() {
  cleanup_tmux
  cb_tmproot TMUX_HOME cb-tmux
  TMUX_RUNS="$TMUX_HOME/runs"
  mkdir -p "$TMUX_RUNS"
  TMUX_SOCKET="cbtest-$$-$(date +%s 2>/dev/null || echo 0)-$RANDOM"
  TMUX_SOCKETS+=("$TMUX_SOCKET")
}

# run_sh <script> <args...>: run bin/<script> with tmux env, capture CMD_*.
run_sh() {
  local script=$1; shift
  local errfile="$TMUX_HOME/.cmd.err"
  CMD_STDOUT=$(CB_RUNS_DIR="$TMUX_RUNS" CB_TMUX_SOCKET="$TMUX_SOCKET" CB_TMUX_CONF=/dev/null \
    CB_SEND_SLEEP=0.35 CB_SEND_SETTLE=0.1 CB_SEND_RETRIES=3 \
    sh "$BIN/$script" "$@" 2>"$errfile") && CMD_STATUS=0 || CMD_STATUS=$?
  CMD_STDERR=$(cat "$errfile" 2>/dev/null || true)
}

# tc <args...>: raw tmux on the isolated socket.
tc() { tmux -L "$TMUX_SOCKET" -f /dev/null "$@"; }

ensure_run() { mkdir -p "$TMUX_RUNS/$1/agents"; }

# meta_val <run> <agent> <key>: echo value from the meta file.
meta_val() {
  local file="$TMUX_RUNS/$1/agents/$2.meta" line
  while IFS= read -r line; do
    case "$line" in "$3="*) printf '%s' "${line#*=}"; return 0 ;; esac
  done <"$file"
  return 1
}

write_fake() { cat >"$1"; chmod +x "$1"; }

# This suite must allocate every scratch directory through the shared
# project-local helper.
test_no_system_temp_allocations() {
  local forbidden; forbidden=$(printf '%s%s' 'mktemp -d "${TMPDIR:-/' 'tmp}')
  assert_no_grep "$forbidden" "$0" "tmux tests must stay under project .tmp"
  pass "tmux harness: no system temp allocations"
}

# spawn_five <run>: spawn all five agents, assert each gets a @N window id.
spawn_five() {
  local run=$1 a
  ensure_run "$run"
  for a in "${AGENTS[@]}"; do
    run_sh cb-agent-spawn.sh "$run" "$a"
    expect_code 0 "$CMD_STATUS" "spawn $a in $run"
    printf '%s' "$CMD_STDOUT" | grep -qE '^@[0-9]+$' || fail "spawn $a: invalid window id '$CMD_STDOUT'"
  done
}

FAKE_SWALLOW='#!/usr/bin/env python3
import sys,time,tty,termios
fd=sys.stdin.fileno(); old=termios.tcgetattr(fd)
try:
  tty.setraw(fd); buf=[]; n=0
  sys.stdout.write("> "); sys.stdout.flush()
  while True:
    ch=sys.stdin.read(1)
    if ch in ("\r","\n"):
      n+=1
      if n==1: continue
      sys.stdout.write("\r\nGOT:"+"".join(buf)+"\r\n"); sys.stdout.flush()
      while True: time.sleep(3600)
    elif ch=="\x03": break
    else:
      buf.append(ch); sys.stdout.write(ch); sys.stdout.flush()
finally: termios.tcsetattr(fd, termios.TCSADRAIN, old)
'

FAKE_STUCK='#!/usr/bin/env python3
import sys,tty,termios
fd=sys.stdin.fileno(); old=termios.tcgetattr(fd)
try:
  tty.setraw(fd); buf=[]
  sys.stdout.write("> "); sys.stdout.flush()
  while True:
    ch=sys.stdin.read(1)
    if ch in ("\r","\n"): continue
    elif ch=="\x03": break
    else:
      buf.append(ch); sys.stdout.write(ch); sys.stdout.flush()
finally: termios.tcsetattr(fd, termios.TCSADRAIN, old)
'

# ============ Windows + meta + pinning =====================================

test_creates_five_pinned_windows() {
  setup_home
  local run=issue-312-a1f2
  spawn_five "$run"
  tc has-session -t "=combo-$run" >/dev/null 2>&1 || fail "session combo-$run should exist"
  local names
  names=$(tc list-windows -t "=combo-$run" -F '#{window_name}' | sort)
  local expected a exp_lines="" expected_mode
  for a in "${AGENTS[@]}"; do exp_lines="${exp_lines}cb-$run-$a"$'\n'; done
  expected=$(printf '%s' "$exp_lines" | sort)
  [ "$names" = "$expected" ] || fail "window names mismatch: got [$names] expected [$expected]"
  local a
  for a in "${AGENTS[@]}"; do
    local wid; wid=$(meta_val "$run" "$a" window_id)
    [ "$wid" != "combo-$run" ] || fail "meta window_id not set for $a"
    printf '%s' "$wid" | grep -qE '^@[0-9]+$' || fail "$a: window_id should be @N, got '$wid'"
    [ "$(meta_val "$run" "$a" run)" = "$run" ] || fail "$a: run mismatch"
    [ "$(meta_val "$run" "$a" agent)" = "$a" ] || fail "$a: agent mismatch"
    [ "$(meta_val "$run" "$a" window)" = "combo-$run:cb-$run-$a" ] || fail "$a: window mismatch"
    case "$a" in coder|reviewer) expected_mode=tui ;; *) expected_mode=shell ;; esac
    [ "$(meta_val "$run" "$a" mode)" = "$expected_mode" ] \
      || fail "$a: canonical endpoint mode mismatch"
    [ "$(tc display-message -p -t "$wid" '#{pane_dead}')" = 0 ] \
      || fail "$a: canonical endpoint is not occupied"
    tc show-window-options -t "$wid" automatic-rename 2>/dev/null | grep -q off || fail "$a: automatic-rename should be off"
    tc show-window-options -t "$wid" allow-rename 2>/dev/null | grep -q off || fail "$a: allow-rename should be off"
  done
  pass "cb-tmux+spawn: creates five pinned windows with atomic meta"
}

test_refuses_sequential_duplicate() {
  setup_home
  ensure_run dup
  run_sh cb-agent-spawn.sh dup launcher; expect_code 0 "$CMD_STATUS" "first launcher"
  run_sh cb-agent-spawn.sh dup launcher
  [ "$CMD_STATUS" -ne 0 ] || fail "duplicate launcher should be refused"
  assert_match 'already exists|endpoint already exists' "$CMD_STDERR" "duplicate spawn error"
  pass "cb-agent-spawn: refuses sequential duplicate agent windows"
}

test_isolates_alpha_from_alphabet() {
  setup_home
  local long=alphabet short=alpha
  ensure_run "$long"; ensure_run "$short"
  run_sh cb-agent-spawn.sh "$long" launcher; expect_code 0 "$CMD_STATUS" "spawn alphabet launcher"
  run_sh cb-agent-spawn.sh "$short" launcher; expect_code 0 "$CMD_STATUS" "spawn alpha launcher"
  local sessions; sessions=$(tc list-sessions -F '#{session_name}' | sort)
  local expected; expected=$(printf 'combo-%s\ncombo-%s\n' "$long" "$short" | sort)
  [ "$sessions" = "$expected" ] || fail "sessions mismatch"
  assert_contains "$(tc list-windows -t "=combo-$long" -F '#{window_name}')" "cb-$long-launcher" "long session window"
  assert_contains "$(tc list-windows -t "=combo-$short" -F '#{window_name}')" "cb-$short-launcher" "short session window"
  run_sh cb-status.sh "$short" launcher
  assert_contains "$CMD_STDOUT" "session_live=1" "short status live"
  assert_contains "$CMD_STDOUT" "cb-$short-launcher" "short status window"
  assert_not_contains "$CMD_STDOUT" "cb-$long-launcher" "short status should not mention long"
  local marker="ALPHA-$$"
  run_sh cb-send.sh "$short" launcher "echo $marker"; expect_code 0 "$CMD_STATUS" "send to alpha"
  sleep 0.25
  run_sh cb-peek.sh "$short" launcher 40
  assert_contains "$CMD_STDOUT" "$marker" "alpha peek should show marker"
  run_sh cb-peek.sh "$long" launcher 40
  assert_not_contains "$CMD_STDOUT" "$marker" "alphabet peek should not show alpha marker"
  CB_RUNS_DIR="$TMUX_RUNS" CB_TMUX_SOCKET="$TMUX_SOCKET" CB_TMUX_CONF=/dev/null \
    sh -c ". \"$BIN/cb-tmux.sh\"; cb_tmux_kill_session \"combo-$short\"" 2>/dev/null
  expect_code 0 $? "cb_tmux_kill_session combo-$short should exit 0"
  tc has-session -t "=combo-$short" >/dev/null 2>&1 && fail "alpha session should be gone" || true
  tc has-session -t "=combo-$long" >/dev/null 2>&1 || fail "alphabet session should survive"
  pass "cb-tmux+spawn: isolates alpha from alphabet on create/resolve/status/send/teardown"
}

test_serializes_concurrent_same_agent_spawn() {
  setup_home
  ensure_run race
  run_sh cb-agent-spawn.sh race launcher; expect_code 0 "$CMD_STATUS" "initial launcher"
  local entries=() winners=0 losers=0 i
  for i in $(seq 1 20); do
    CB_RUNS_DIR="$TMUX_RUNS" CB_TMUX_SOCKET="$TMUX_SOCKET" CB_TMUX_CONF=/dev/null \
      CB_SPAWN_LOCK_TIMEOUT_SECONDS=60 CB_SPAWN_LOCK_STALE_SECONDS=120 \
      sh "$BIN/cb-agent-spawn.sh" race coder >"$TMUX_HOME/racer-$i.out" 2>/dev/null &
    entries+=("$i:$!")
  done
  local winner_stdout=""
  for entry in "${entries[@]}"; do
    local idx=${entry%%:*} pid=${entry##*:}
    if wait "$pid" 2>/dev/null; then
      winners=$((winners + 1))
      winner_stdout=$(cat "$TMUX_HOME/racer-$idx.out")
    else
      losers=$((losers + 1))
    fi
  done
  [ "$winners" = "1" ] || fail "expected 1 winner, got $winners"
  [ "$losers" = "19" ] || fail "expected 19 losers, got $losers"
  local coders
  coders=$(tc list-windows -t "=combo-race" -F '#{window_name}' | grep -c '^cb-race-coder$' || true)
  [ "$coders" = "1" ] || fail "expected 1 coder window, got $coders"
  local meta_wid; meta_wid=$(meta_val race coder window_id)
  [ "$meta_wid" = "$winner_stdout" ] || fail "meta window_id ($meta_wid) should match winner stdout ($winner_stdout)"
  pass "cb-agent-spawn: serializes concurrent same-run same-agent spawn to one winner"
}

# ============ Spawn lock reclamation =======================================

test_reclaims_stale_spawn_lock() {
  setup_home
  # ownerless
  local run=stale-ownerless
  ensure_run "$run"; local rd="$TMUX_RUNS/$run"; local lock="$rd/.spawn.lock"
  mkdir -p "$lock"
  CB_SPAWN_LOCK_STALE_SECONDS=0 CB_SPAWN_LOCK_TIMEOUT_SECONDS=2 run_sh cb-agent-spawn.sh "$run" coder
  expect_code 0 "$CMD_STATUS" "ownerless spawn lock${CMD_STDERR:+: $CMD_STDERR}"
  assert_not_match 'No such file or directory' "$CMD_STDERR" "no redirect noise"
  assert_absent "$lock" "ownerless lock should be removed"
  # malformed
  run=stale-malformed; ensure_run "$run"; rd="$TMUX_RUNS/$run"; lock="$rd/.spawn.lock"
  mkdir -p "$lock"
  printf 'not-a-valid-owner\n' >"$lock/owner"
  CB_SPAWN_LOCK_STALE_SECONDS=0 CB_SPAWN_LOCK_TIMEOUT_SECONDS=2 run_sh cb-agent-spawn.sh "$run" coder
  expect_code 0 "$CMD_STATUS" "malformed spawn lock${CMD_STDERR:+: $CMD_STDERR}"
  assert_not_match 'No such file or directory' "$CMD_STDERR" "no redirect noise (malformed)"
  assert_absent "$lock" "malformed lock should be removed"
  pass "cb-agent-spawn: reclaims stale ownerless and malformed spawn lock without redirect noise"
}

test_preserves_dead_owner_recovery() {
  setup_home
  local run=stale-dead-owner; ensure_run "$run"; local rd="$TMUX_RUNS/$run"
  local lock="$rd/.spawn.lock"
  mkdir -p "$lock"
  printf '99999999 abandoned-owner-token\n' >"$lock/owner"
  CB_SPAWN_LOCK_STALE_SECONDS=0 CB_SPAWN_LOCK_TIMEOUT_SECONDS=2 run_sh cb-agent-spawn.sh "$run" coder
  expect_code 0 "$CMD_STATUS" "dead-owner spawn lock${CMD_STDERR:+: $CMD_STDERR}"
  assert_absent "$lock" "dead-owner lock should be removed"
  pass "cb-agent-spawn: preserves well-formed dead-owner spawn lock recovery"
}

test_reclaims_aged_dead_spawn_lock_with_gnu_stat() {
  setup_home
  local run=aged-dead-owner
  ensure_run "$run"; local rd="$TMUX_RUNS/$run"; local lock="$rd/.spawn.lock"
  local fakebin; fakebin=$(cb_fakebin "$TMUX_HOME")
  mkdir -p "$lock"
  printf '99999999 abandoned-owner-token\n' >"$lock/owner"
  touch -t 202001010000 "$lock"
  cb_write_gnu_stat_fake "$fakebin/stat"
  PATH="$fakebin:$PATH" CB_TEST_REAL_STAT="$REAL_STAT" \
    CB_SPAWN_LOCK_STALE_SECONDS=30 CB_SPAWN_LOCK_TIMEOUT_SECONDS=1 \
    run_sh cb-agent-spawn.sh "$run" coder
  expect_code 0 "$CMD_STATUS" "aged dead-owner spawn lock should be reclaimed with GNU stat${CMD_STDERR:+: $CMD_STDERR}"
  assert_absent "$lock" "aged dead-owner spawn lock should be removed"
  pass "cb-agent-spawn: reclaims an aged dead-owner lock with a non-zero threshold under GNU stat"
}

test_no_steal_ownerless_gains_live_owner() {
  setup_home
  local run=stale-live-race; ensure_run "$run"; local rd="$TMUX_RUNS/$run"
  local lock="$rd/.spawn.lock"; local owner="$lock/owner"
  local fakebin; fakebin=$(cb_fakebin "$TMUX_HOME")
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
  CB_RUNS_DIR="$TMUX_RUNS" CB_TMUX_SOCKET="$TMUX_SOCKET" CB_TMUX_CONF=/dev/null \
    PATH="$fakebin:$PATH" \
    CB_TEST_REAP="$lock/.reap" CB_TEST_OWNER="$owner" CB_TEST_LIVE_OWNER="$$ replacement-token" \
    CB_SPAWN_LOCK_STALE_SECONDS=0 CB_SPAWN_LOCK_TIMEOUT_SECONDS=1 \
    sh "$BIN/cb-agent-spawn.sh" "$run" coder 2>"$TMUX_HOME/.cmd.err" && CMD_STATUS=0 || CMD_STATUS=$?
  CMD_STDERR=$(cat "$TMUX_HOME/.cmd.err")
  expect_code 75 "$CMD_STATUS" "should exit 75 (owner gained live owner during reap)"
  local content; content=$(cat "$owner")
  [ "$content" = "$$ replacement-token" ] || fail "owner should show replacement token"
  assert_present "$lock" "lock should still exist"
  pass "cb-agent-spawn: does not steal ownerless stale lock that gains live owner during reap"
}

test_one_owner_snapshot_liveness_and_deletion() {
  setup_home
  local run=stale-snapshot-race; ensure_run "$run"; local rd="$TMUX_RUNS/$run"
  local lock="$rd/.spawn.lock"; local owner="$lock/owner"
  local fakebin; fakebin=$(cb_fakebin "$TMUX_HOME"); local cat_count="$TMUX_HOME/cat-count"
  local injected="$TMUX_HOME/owner-injected"
  local live_owner="$$ stable-live-token"
  mkdir -p "$lock" "$fakebin"
  printf '%s\n' "$live_owner" >"$owner"
  write_fake "$fakebin/cat" <<EOF
#!/bin/sh
if [ "\$1" != "\$CB_TEST_OWNER" ]; then
  exec $REAL_CAT "\$@"
fi
count=\$($REAL_CAT "\$CB_TEST_CAT_COUNT" 2>/dev/null || printf 0)
count=\$((count + 1))
printf '%s' "\$count" >"\$CB_TEST_CAT_COUNT"
if [ "\$count" -eq 1 ]; then
  $REAL_CAT "\$@"
  printf '%s\n' "\$CB_TEST_TRANSIENT_OWNER" >"\$CB_TEST_OWNER"
  printf injected >"\$CB_TEST_INJECTED"
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
  CB_RUNS_DIR="$TMUX_RUNS" CB_TMUX_SOCKET="$TMUX_SOCKET" CB_TMUX_CONF=/dev/null \
    PATH="$fakebin:$PATH" \
    CB_TEST_CAT_COUNT="$cat_count" CB_TEST_OWNER="$owner" CB_TEST_REAP="$lock/.reap" \
    CB_TEST_INJECTED="$injected" CB_TEST_NON_OWNER="$TMUX_HOME/not-owner" \
    CB_TEST_LIVE_OWNER="$live_owner" CB_TEST_TRANSIENT_OWNER="99999999 transient-dead-token" \
    CB_SPAWN_LOCK_STALE_SECONDS=0 CB_SPAWN_LOCK_TIMEOUT_SECONDS=1 \
    sh -c 'cat "$CB_TEST_NON_OWNER" >/dev/null 2>&1 || true; exec "$@"' sh \
    "$BIN/cb-agent-spawn.sh" "$run" coder 2>"$TMUX_HOME/.cmd.err" && CMD_STATUS=0 || CMD_STATUS=$?
  CMD_STDERR=$(cat "$TMUX_HOME/.cmd.err")
  expect_code 75 "$CMD_STATUS" "snapshot liveness guard should exit 75"
  assert_present "$injected" "owner-read race injection must execute"
  assert_present "$owner" "owner file should still exist"
  assert_present "$lock" "lock should still exist"
  pass "cb-agent-spawn: uses one spawn owner snapshot for liveness and the deletion guard"
}

# ============ Meta staging path safety =====================================

test_meta_staging_path_safety() {
  for kind in existing dangling regular; do
    setup_home
    local run="meta-link-$kind"; ensure_run "$run"; local rd="$TMUX_RUNS/$run"
    local lock="$rd/.spawn.lock"; local owner="$lock/owner"
    mkdir -p "$lock"
    printf '%s test-barrier\n' "$$" >"$owner"
    CB_RUNS_DIR="$TMUX_RUNS" CB_TMUX_SOCKET="$TMUX_SOCKET" CB_TMUX_CONF=/dev/null \
      CB_SPAWN_LOCK_STALE_SECONDS=120 CB_SPAWN_LOCK_TIMEOUT_SECONDS=5 \
      sh "$BIN/cb-agent-spawn.sh" "$run" coder 2>/dev/null &
    local pid=$!
    local victim="$TMUX_HOME/${kind}-meta-victim"
    local tmp="$rd/agents/.coder.meta.tmp.$pid"
    case "$kind" in
      regular) printf 'STAGING OWNER\n' >"$tmp" ;;
      existing) printf 'PRECIOUS\n' >"$victim"; ln -s "$victim" "$tmp" ;;
      dangling) ln -s "$victim" "$tmp" ;;
    esac
    # Barrier: prove the spawn is still blocked on the lock before we release it,
    # so a failure is diagnosable rather than a mystery race.
    sleep 0.2
    kill -0 "$pid" 2>/dev/null || fail "meta staging $kind: spawn exited before barrier release"
    assert_absent "$rd/agents/coder.meta" "spawn should still be blocked on lock ($kind)"
    rm -f "$owner"; rmdir "$lock" 2>/dev/null || true
    wait "$pid" 2>/dev/null && CMD_STATUS=0 || CMD_STATUS=$?
    [ "$CMD_STATUS" -ne 0 ] || fail "meta staging $kind: should refuse to overwrite"
    if [ "$kind" = regular ]; then
      [ "$(cat "$tmp")" = "STAGING OWNER" ] || fail "regular file unchanged ($kind)"
    else
      [ "$(readlink "$tmp")" = "$victim" ] || fail "symlink intact ($kind)"
      if [ "$kind" = existing ]; then
        [ "$(cat "$victim")" = "PRECIOUS" ] || fail "existing victim unchanged ($kind)"
      else
        assert_absent "$victim" "dangling victim should not exist ($kind)"
      fi
    fi
  done
  pass "cb-agent-spawn: does not replace predictable meta staging path (3 cases)"
}

# ============ Symlink containment ==========================================

test_rejects_agents_symlink_escape() {
  setup_home
  ensure_run arun; ensure_run brun
  rm -rf "$TMUX_RUNS/arun/agents"
  ln -s "$TMUX_RUNS/brun/agents" "$TMUX_RUNS/arun/agents"
  run_sh cb-agent-spawn.sh brun coder; expect_code 0 "$CMD_STATUS" "spawn brun coder"
  local before; before=$(cat "$TMUX_RUNS/brun/agents/coder.meta")
  run_sh cb-agent-spawn.sh arun coder
  [ "$CMD_STATUS" -ne 0 ] || fail "agents symlink escape should be rejected"
  assert_match 'symlink|escapes' "$CMD_STDERR" "escape error message"
  local after; after=$(cat "$TMUX_RUNS/brun/agents/coder.meta")
  [ "$after" = "$before" ] || fail "peer run meta should be intact"
  assert_symlink "$TMUX_RUNS/arun/agents" "symlink should remain"
  pass "cb-agent-spawn: rejects agents symlink escape so peer run meta stays intact"
}

test_rejects_symlinked_run_dir_before_config() {
  setup_home
  local marker="$TMUX_HOME/config-side-effect"
  local outside="$TMUX_HOME/outside-run"
  mkdir -p "$outside/agents"
  printf "touch '%s'\nexport CB_WORKTREE='%s'\n" "$marker" "$outside" >"$outside/config.env"
  ln -s "$outside" "$TMUX_RUNS/evilrun"
  run_sh cb-agent-spawn.sh evilrun launcher
  [ "$CMD_STATUS" -ne 0 ] || fail "symlinked run dir should be rejected"
  assert_match 'symlink|escapes' "$CMD_STDERR" "symlink error"
  assert_absent "$marker" "config.env side-effect should not fire"
  pass "cb-agent-spawn: rejects symlinked run dir before sourcing side-effecting config.env"
}

test_no_meta_for_invalid_shell_or_missing_cwd() {
  setup_home
  local run=deadend; ensure_run "$run"; local rd="$TMUX_RUNS/$run"
  run_sh cb-agent-spawn.sh "$run" launcher --cwd "$rd/nope"
  [ "$CMD_STATUS" -ne 0 ] || fail "missing cwd should fail"
  assert_absent "$rd/agents/launcher.meta" "no meta for missing cwd"
  CB_RUNS_DIR="$TMUX_RUNS" CB_TMUX_SOCKET="$TMUX_SOCKET" CB_TMUX_CONF=/dev/null \
    SHELL="$TMUX_HOME/no-such-shell" \
    sh "$BIN/cb-agent-spawn.sh" "$run" launcher 2>/dev/null && CMD_STATUS=0 || CMD_STATUS=$?
  [ "$CMD_STATUS" -ne 0 ] || fail "invalid shell should fail"
  assert_absent "$rd/agents/launcher.meta" "no meta for invalid shell"
  pass "cb-agent-spawn: does not publish meta for invalid shell or missing cwd"
}

# ============ Live endpoints + verified Enter ==============================

test_send_peek_status_and_verified_enter() {
  setup_home
  local run=send1; ensure_run "$run"
  local marker="M-$$"
  run_sh cb-agent-spawn.sh "$run" coder; expect_code 0 "$CMD_STATUS" "spawn coder"
  sleep 0.25
  run_sh cb-send.sh "$run" coder "echo $marker"; expect_code 0 "$CMD_STATUS" "send to coder"
  sleep 0.2
  run_sh cb-peek.sh "$run" coder 40
  assert_contains "$CMD_STDOUT" "$marker" "coder peek should show marker"
  run_sh cb-status.sh "$run" coder
  assert_contains "$CMD_STDOUT" "session_live=1" "coder status live"

  # swallow composer
  local sw=sw1; ensure_run "$sw"
  local fd; cb_tmproot fd cb-fake-composer
  printf '%s' "$FAKE_SWALLOW" >"$fd/fc.py"; chmod +x "$fd/fc.py"
  run_sh cb-agent-spawn.sh "$sw" reviewer --mode shell --cwd "$fd" --cmd "exec python3 ./fc.py"
  expect_code 0 "$CMD_STATUS" "spawn swallow reviewer"
  sleep 0.35
  run_sh cb-status.sh "$sw" reviewer
  assert_match 'command=Python' "$CMD_STDOUT" "reviewer status should show Python"
  local payload="S-$$"
  run_sh cb-send.sh "$sw" reviewer "$payload"; expect_code 0 "$CMD_STATUS" "send payload to swallow"
  sleep 0.25
  run_sh cb-peek.sh "$sw" reviewer 40
  assert_contains "$CMD_STDOUT" "GOT:$payload" "swallow should echo GOT:payload"

  # stuck composer
  local st=st1; ensure_run "$st"
  local nd; cb_tmproot nd cb-stuck-composer
  printf '%s' "$FAKE_STUCK" >"$nd/ns.py"; chmod +x "$nd/ns.py"
  run_sh cb-agent-spawn.sh "$st" gate --mode shell --cwd "$nd" --cmd "exec python3 ./ns.py"
  expect_code 0 "$CMD_STATUS" "spawn stuck gate"
  sleep 0.35
  CB_RUNS_DIR="$TMUX_RUNS" CB_TMUX_SOCKET="$TMUX_SOCKET" CB_TMUX_CONF=/dev/null \
    CB_SEND_RETRIES=2 CB_SEND_SLEEP=0.25 CB_SEND_SETTLE=0.1 \
    sh "$BIN/cb-send.sh" "$st" gate "NEVERLAND" 2>"$TMUX_HOME/.cmd.err" && CMD_STATUS=0 || CMD_STATUS=$?
  CMD_STDERR=$(cat "$TMUX_HOME/.cmd.err")
  [ "$CMD_STATUS" -ne 0 ] || fail "stuck composer send should fail"
  assert_match 'swallowed|still holds payload' "$CMD_STDERR" "stuck error message"
  pass "cb-send/peek/status: verified Enter swallow/stuck composers"
}

test_kills_idempotently() {
  setup_home
  spawn_five kill1
  local id; id=$(meta_val kill1 gate window_id)
  CB_RUNS_DIR="$TMUX_RUNS" CB_TMUX_SOCKET="$TMUX_SOCKET" CB_TMUX_CONF=/dev/null \
    sh -c ". \"$BIN/cb-tmux.sh\"; cb_tmux_kill \"$id\"; cb_tmux_kill \"$id\"; cb_tmux_kill_session \"combo-kill1\"; cb_tmux_kill_session \"combo-kill1\"" 2>/dev/null
  expect_code 0 $? "idempotent kill"
  tc has-session -t "=combo-kill1" >/dev/null 2>&1 && fail "session should be gone" || true
  pass "cb-tmux: kills windows/sessions idempotently with exact targets"
}

test_two_concurrent_runs_isolated() {
  setup_home
  spawn_five aa01; spawn_five bb02
  local marker="B-$$"
  run_sh cb-send.sh bb02 reviewer "echo $marker"; expect_code 0 "$CMD_STATUS" "send to bb02"
  sleep 0.25
  run_sh cb-peek.sh bb02 reviewer 40
  assert_contains "$CMD_STDOUT" "$marker" "bb02 peek marker"
  run_sh cb-peek.sh aa01 reviewer 40
  assert_not_contains "$CMD_STDOUT" "$marker" "aa01 should not see bb02 marker"
  CB_RUNS_DIR="$TMUX_RUNS" CB_TMUX_SOCKET="$TMUX_SOCKET" CB_TMUX_CONF=/dev/null \
    sh -c ". \"$BIN/cb-tmux.sh\"; cb_tmux_kill_session \"combo-aa01\"" 2>/dev/null
  tc has-session -t "=combo-aa01" >/dev/null 2>&1 && fail "aa01 should be gone" || true
  tc has-session -t "=combo-bb02" >/dev/null 2>&1 || fail "bb02 should survive"
  run_sh cb-status.sh bb02
  assert_contains "$CMD_STDOUT" "session_live=1" "bb02 status live"
  run_sh cb-peek.sh aa01 coder 5
  [ "$CMD_STATUS" -ne 0 ] || fail "aa01 peek should fail (dead session)"
  pass "cb-tmux+spawn: keeps two concurrent runs isolated under send/status/teardown"
}

test_never_resolves_outside_combo() {
  setup_home
  local run=scope; ensure_run "$run"
  run_sh cb-agent-spawn.sh "$run" launcher; expect_code 0 "$CMD_STATUS" "spawn scope launcher"
  tc new-session -d -s foreign-other -n "cb-$run-launcher" >/dev/null 2>&1
  expect_code 0 $? "foreign session setup should succeed"
  tc kill-window -t "=combo-$run:cb-$run-launcher" >/dev/null 2>&1
  expect_code 0 $? "foreign window kill should succeed"
  local meta_file="$TMUX_RUNS/$run/agents/launcher.meta"
  sed -i.tmp 's/^window_id=.*/window_id=@99999/; s/^window=.*/window=foreign-other:cb-scope-launcher/' "$meta_file"
  rm -f "$meta_file.tmp"
  run_sh cb-peek.sh "$run" launcher 5
  [ "$CMD_STATUS" -ne 0 ] || fail "foreign peek should fail"
  run_sh cb-send.sh "$run" launcher "echo x"
  [ "$CMD_STATUS" -ne 0 ] || fail "foreign send should fail"
  pass "cb-tmux+spawn: never resolves targets outside combo-<runId>"
}

test_nonzero_when_pane_dies_after_enter() {
  setup_home
  local run=deadpane; ensure_run "$run"
  run_sh cb-agent-spawn.sh "$run" coder --mode tui --cmd "read line"
  expect_code 0 "$CMD_STATUS" "spawn deadpane coder"
  sleep 0.25
  run_sh cb-send.sh "$run" coder "BYE"
  [ "$CMD_STATUS" -ne 0 ] || fail "dead pane send should fail"
  assert_match 'dead or missing|failed to send Enter' "$CMD_STDERR" "dead pane error"
  pass "cb-send: returns nonzero when the pane dies after Enter"
}

test_nonzero_when_pane_exits_after_clear() {
  setup_home
  local run=delayexit; ensure_run "$run"
  run_sh cb-agent-spawn.sh "$run" reviewer --mode tui --cmd "sh -c 'read line; sleep 0.05; exit 0'"
  expect_code 0 "$CMD_STATUS" "spawn delayexit reviewer"
  sleep 0.25
  CB_RUNS_DIR="$TMUX_RUNS" CB_TMUX_SOCKET="$TMUX_SOCKET" CB_TMUX_CONF=/dev/null \
    CB_SEND_SLEEP=0.25 CB_SEND_SETTLE=0.05 CB_SEND_RETRIES=2 \
    sh "$BIN/cb-send.sh" "$run" reviewer "LATER" 2>"$TMUX_HOME/.cmd.err" && CMD_STATUS=0 || CMD_STATUS=$?
  CMD_STDERR=$(cat "$TMUX_HOME/.cmd.err")
  [ "$CMD_STATUS" -ne 0 ] || fail "delay-exit send should fail"
  assert_match 'dead or missing' "$CMD_STDERR" "delay-exit error"
  pass "cb-send: returns nonzero when the pane exits shortly after composer clear"
}

test_ignores_stale_window_ids_after_restart() {
  setup_home
  local run=reuse; ensure_run "$run"
  run_sh cb-agent-spawn.sh "$run" coder; expect_code 0 "$CMD_STATUS" "spawn coder"
  local stale_id=$CMD_STDOUT
  local coder_meta_id; coder_meta_id=$(meta_val "$run" coder window_id)
  [ "$coder_meta_id" = "$stale_id" ] || fail "meta window_id should match spawn output"
  tc kill-server 2>/dev/null || true
  sleep 0.1
  run_sh cb-agent-spawn.sh "$run" launcher; expect_code 0 "$CMD_STATUS" "spawn launcher after restart"
  local launcher_id=$CMD_STDOUT
  [ "$(meta_val "$run" launcher window_id)" = "$launcher_id" ] || fail "launcher meta should match"
  run_sh cb-status.sh "$run" coder
  assert_contains "$CMD_STDOUT" "agent.coder.resolved="
  assert_not_contains "$CMD_STDOUT" "agent.coder.resolved=$launcher_id"
  local found_empty=0
  while IFS= read -r line; do
    [ "$line" = "agent.coder.resolved=" ] && found_empty=1
  done <<<"$CMD_STDOUT"
  [ "$found_empty" = "1" ] || fail "coder should have empty resolved field"
  run_sh cb-send.sh "$run" coder "echo SHOULD-NOT-LAND"
  [ "$CMD_STATUS" -ne 0 ] || fail "stale coder send should fail"
  sleep 0.2
  run_sh cb-peek.sh "$run" launcher 40
  assert_not_contains "$CMD_STDOUT" "SHOULD-NOT-LAND" "marker should not land in launcher"
  run_sh cb-agent-spawn.sh "$run" coder; expect_code 0 "$CMD_STATUS" "respawn coder"
  local coder_id=$CMD_STDOUT
  printf '%s' "$coder_id" | grep -qE '^@[0-9]+$' || fail "respawned coder id should be @N"
  [ "$(meta_val "$run" coder window_id)" = "$coder_id" ] || fail "respawned coder meta id"
  [ "$(meta_val "$run" coder window)" = "combo-$run:cb-$run-coder" ] || fail "respawned coder window"
  run_sh cb-status.sh "$run" coder
  assert_contains "$CMD_STDOUT" "agent.coder.resolved=$coder_id"
  run_sh cb-status.sh "$run" launcher
  assert_contains "$CMD_STDOUT" "agent.launcher.resolved=$launcher_id"
  pass "cb-tmux+spawn: ignores stale window ids reused by another role after server restart"
}

test_guards_decision_paths_rejects_bin_without_cmd() {
  setup_home
  local run=meta1; ensure_run "$run"
  run_sh cb-agent-spawn.sh "$run" gate; expect_code 0 "$CMD_STATUS" "spawn gate"
  assert_present "$TMUX_RUNS/$run/agents/gate.meta" "gate meta should exist"
  for name in cb-emit.sh cb-wait.sh cb-run-state.sh cb-agent-spawn.sh cb-send.sh; do
    assert_not_contains "$(cat "$BIN/$name")" "capture-pane" "$name should not use capture-pane"
  done
  assert_contains "$(cat "$BIN/cb-peek.sh")" "cb_tmux_capture" "cb-peek.sh should use cb_tmux_capture"
  run_sh cb-agent-spawn.sh "$run" coder --mode bin --bin claude
  [ "$CMD_STATUS" -ne 0 ] || fail "mode=bin without --cmd should fail"
  assert_match 'mode=bin requires --cmd' "$CMD_STDERR" "bin mode error"
  pass "cb-agent-spawn: guards decision paths and rejects mode=bin without --cmd"
}

# ============ run all tests ================================================

test_no_system_temp_allocations
test_creates_five_pinned_windows
test_refuses_sequential_duplicate
test_isolates_alpha_from_alphabet
test_serializes_concurrent_same_agent_spawn
test_reclaims_stale_spawn_lock
test_preserves_dead_owner_recovery
test_reclaims_aged_dead_spawn_lock_with_gnu_stat
test_no_steal_ownerless_gains_live_owner
test_one_owner_snapshot_liveness_and_deletion
test_meta_staging_path_safety
test_rejects_agents_symlink_escape
test_rejects_symlinked_run_dir_before_config
test_no_meta_for_invalid_shell_or_missing_cwd
if [ "$HAVE_PYTHON3" = "1" ]; then
  test_send_peek_status_and_verified_enter
else
  printf 'skip - python3 not available (verified-Enter composers)\n' >&2
fi
test_kills_idempotently
test_two_concurrent_runs_isolated
test_never_resolves_outside_combo
test_nonzero_when_pane_dies_after_enter
test_nonzero_when_pane_exits_after_clear
test_ignores_stale_window_ids_after_restart
test_guards_decision_paths_rejects_bin_without_cmd

printf '\ntmux-spawn: all tests passed\n'
