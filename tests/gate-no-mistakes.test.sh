#!/usr/bin/env bash
# @overview Contract tests for the P7 No-Mistakes Gate adapter. Proves the
#   universal P4 envelope reaches a Gate that seals the Launcher-owned exact
#   branch/head, builds documented axi argv, normalizes terminal outcomes, and
#   replays a durable terminal seal without starting a duplicate delivery.
#
#   READING GUIDE
#   -------------
#   1. test_validates_exact_sha     <- canonical validated-mode invocation.
#   2. test_rejects_candidate_drift <- no Gate call after the reviewed SHA moves.
#   3. test_maps_terminal_outcomes  <- passed, failed, and cancelled normalization.
#   4. test_guards_argument_edges   <- Bash 3.2 empty arrays and skip policy.
#   5. test_replays_terminal_seal   <- idempotent terminal recovery.
#
#   MAIN FLOW
#   ---------
#   fixture plan -> cb-step gate -> cb-gate -> fake axi -> normalized result
#
#   PUBLIC API
#   ----------
#   none
#
#   INTERNALS
#   ---------
#   write_config, make_run, run_gate, invocation_args
#
# @exports none
# @deps bash, git, jq, tests/lib.sh, bin/cb-plan.sh, bin/cb-step.sh, bin/cb-gate.sh
set -u

# shellcheck source=tests/lib.sh disable=SC1091
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

BIN="$ROOT/bin"
TMP_ROOT=
cb_tmproot TMP_ROOT cb-gate-no-mistakes
RUNS_DIR="$TMP_ROOT/runs"
FAKE_ROLE="$TMP_ROOT/fake-role-adapter"
FAKE_NM="$TMP_ROOT/fake-no-mistakes"
NM_ARGV="$TMP_ROOT/no-mistakes.argv"
NM_CWD="$TMP_ROOT/no-mistakes.cwd"
NM_CALLED="$TMP_ROOT/no-mistakes.called"
NM_CALLS="$TMP_ROOT/no-mistakes.calls"
mkdir -p "$RUNS_DIR"
export CB_RUNS_DIR="$RUNS_DIR"
export CB_GATE_TEST_ARGV="$NM_ARGV"
export CB_GATE_TEST_CWD="$NM_CWD"
export CB_GATE_TEST_CALLED="$NM_CALLED"
export CB_GATE_TEST_CALLS="$NM_CALLS"

CMD_STATUS=
CMD_STDOUT=
CMD_STDERR=
RUN_HEAD=
RUN_BRANCH=
RUN_REPO=

cb_write_fake "$FAKE_ROLE" '#!/usr/bin/env bash
exit 99
'

cb_write_fake "$FAKE_NM" '#!/usr/bin/env bash
set -u
: >"$CB_GATE_TEST_ARGV"
for argument in "$@"; do
  printf "%s\n" "$argument" >>"$CB_GATE_TEST_ARGV"
done
pwd -P >"$CB_GATE_TEST_CWD"
printf "called\n" >"$CB_GATE_TEST_CALLED"
printf "called\n" >>"$CB_GATE_TEST_CALLS"

outcome=
for argument in "$@"; do
  case "$argument" in
    --fake-outcome=*) outcome=${argument#*=} ;;
  esac
done
[ -n "$outcome" ] || outcome=passed
status=completed
[ "$outcome" != failed ] || status=failed
[ "$outcome" != cancelled ] || status=cancelled

cat <<EOF
run:
  id: "fake-gate-run"
  branch: $CB_GATE_TEST_BRANCH
  status: $status
  head: ${CB_GATE_TEST_HEAD:0:8}
  pr: "https://example.test/pull/7"
  findings: none
outcome: $outcome
EOF
[ "$outcome" = passed ] || [ "$outcome" = checks-passed ]
'

write_config() {
  local path=$1 outcome=$2 arguments=${3:-}
  if [ -z "$arguments" ]; then
    arguments=$(jq -cn --arg outcome "$outcome" '[("--fake-outcome=" + $outcome)]')
  fi
  jq -n \
    --arg role "$FAKE_ROLE" \
    --arg gate "$BIN/cb-gate.sh" \
    --arg nm "$FAKE_NM" \
    --argjson arguments "$arguments" '
      {
        schema:"combo.config/v1",
        adapters:{
          launcher:{argv:[$role],roles:["launcher"]},
          coder:{argv:[$role],roles:["coder"]},
          reviewer:{argv:[$role],roles:["reviewer"]},
          gate:{argv:[$gate],roles:["gate"]},
          cleaner:{argv:[$role],roles:["cleaner"]}
        },
        roles:{
          launcher:{adapter:"launcher",config:{}},
          coder:{adapter:"coder",config:{}},
          reviewers:[{id:"review-a",adapter:"reviewer",config:{}}],
          gate:{
            adapter:"gate",
            config:{
              schema:"combo.gate.no-mistakes/v0",
              binary:$nm,
              arguments:$arguments,
              intent:"validate exact candidate",
              approval:"auto",
              review:true,
              merge:"manual"
            }
          },
          cleaner:{adapter:"cleaner",config:{}}
        }
      }
    ' >"$path"
}

make_run() {
  local run=$1 outcome=$2 config base
  config="$TMP_ROOT/$run.config.json"
  RUN_REPO="$TMP_ROOT/$run-repo"
  read -r base RUN_HEAD < <(cb_candidate_repo "$RUN_REPO" "$run")
  RUN_BRANCH="combo/$run"
  git -C "$RUN_REPO" switch -qc "$RUN_BRANCH"

  mkdir -p "$RUNS_DIR/$run/agents"
  jq -n \
    --arg run "$run" \
    --arg repo "$RUN_REPO" \
    --arg worktree "$RUN_REPO" \
    --arg branch "$RUN_BRANCH" \
    --arg base "$base" '
      {
        run:$run,
        runway_kind:"git-worktree-explicit",
        repo_dir:$repo,
        worktree:$worktree,
        branch:$branch,
        base_sha:$base,
        ownership_id:("git-worktree:" + $run)
      }
    ' >"$RUNS_DIR/$run/agents/launcher.ownership.json"
  write_config "$config" "$outcome"
  sh "$BIN/cb-plan.sh" "$run" --config "$config" >/dev/null \
    || fail "could not compile Gate fixture plan for $run"
}

run_gate() {
  local run=$1 candidate=$2 attempt=${3:-1} errfile
  errfile="$TMP_ROOT/$run.err"
  rm -f "$NM_ARGV" "$NM_CWD" "$NM_CALLED"
  export CB_GATE_TEST_BRANCH="$RUN_BRANCH"
  export CB_GATE_TEST_HEAD="$RUN_HEAD"
  CMD_STDOUT=$(bash "$BIN/cb-step.sh" \
    "$run" gate "$attempt" --candidate-sha "$candidate" 2>"$errfile") \
    && CMD_STATUS=0 || CMD_STATUS=$?
  CMD_STDERR=$(cat "$errfile" 2>/dev/null || true)
}

invocation_args() {
  jq -Rsc 'split("\n") | map(select(length>0))' "$NM_ARGV"
}

# -- 1/5 CORE · test_validates_exact_sha -- <- START HERE
test_validates_exact_sha() {
  local run=gate-exact result receipt
  make_run "$run" passed
  run_gate "$run" "$RUN_HEAD"
  expect_code 0 "$CMD_STATUS" "exact Gate invocation${CMD_STDERR:+: $CMD_STDERR}"
  result=$CMD_STDOUT

  jq -e --arg sha "$RUN_HEAD" '
    .exit_class=="completed" and
    .events==[{
      code:0,
      event:"gate_ok",
      payload:{
        outcome:"validated",
        sha:$sha,
        pr:"https://example.test/pull/7"
      }
    }] and
    .artifacts==[
      {
        id:"no-mistakes-outcome",
        path:"artifacts/gate/no-mistakes-attempt-1.toon"
      },
      {
        id:"gate-terminal",
        path:"artifacts/gate/terminal.json"
      }
    ]
  ' "$result" >/dev/null || fail "exact passed outcome should become gate_ok(validated)"

  assert_present "$NM_CALLED" "Gate should invoke No-Mistakes after exact-SHA preflight"
  [ "$(cat "$NM_CWD")" = "$RUN_REPO" ] \
    || fail "No-Mistakes should run in the Launcher-owned worktree"
  [ "$(invocation_args)" = \
    '["axi","run","--intent","validate exact candidate","--fake-outcome=passed","--yes"]' ] \
    || fail "Gate should build the documented axi run argv from config"
  assert_no_grep "--auto-merge" "$NM_ARGV" "Gate must never invent a No-Mistakes auto-merge flag"

  receipt="$RUNS_DIR/$run/artifacts/gate/no-mistakes-attempt-1.toon"
  assert_present "$receipt" "Gate should preserve the machine-readable No-Mistakes outcome"
  assert_grep "outcome: passed" "$receipt" "Gate outcome receipt should contain the trusted terminal fact"
  pass "Gate validates the exact candidate and builds documented No-Mistakes argv"
}
# -/ 1/5

# -- 2/5 CORE · test_rejects_candidate_drift --
test_rejects_candidate_drift() {
  local run=gate-drift result
  make_run "$run" passed
  printf 'drift\n' >>"$RUN_REPO/file.txt"
  git -C "$RUN_REPO" add file.txt
  git -C "$RUN_REPO" commit -qm "test drift"

  run_gate "$run" "$RUN_HEAD"
  expect_code 0 "$CMD_STATUS" "candidate drift product failure${CMD_STDERR:+: $CMD_STDERR}"
  result=$CMD_STDOUT
  jq -e '
    .exit_class=="completed" and
    .events==[{
      code:1,
      event:"gate_failed",
      payload:{reason:"candidate_head_changed"}
    }]
  ' "$result" >/dev/null || fail "candidate drift should become a terminal gate_failed event"
  assert_absent "$NM_CALLED" "No-Mistakes must not run after the reviewed candidate moves"
  pass "Gate rejects candidate drift before invoking No-Mistakes"
}
# -/ 2/5

# -- 3/5 CORE · test_maps_terminal_outcomes --
test_maps_terminal_outcomes() {
  local run result

  run=gate-checks-passed
  make_run "$run" checks-passed
  run_gate "$run" "$RUN_HEAD"
  expect_code 0 "$CMD_STATUS" "checks-passed mapping${CMD_STDERR:+: $CMD_STDERR}"
  result=$CMD_STDOUT
  jq -e '.events[0].event=="gate_ok" and .events[0].payload.outcome=="validated"' \
    "$result" >/dev/null || fail "checks-passed should be a validated Gate outcome"

  run=gate-failed
  make_run "$run" failed
  run_gate "$run" "$RUN_HEAD"
  expect_code 0 "$CMD_STATUS" "failed mapping${CMD_STDERR:+: $CMD_STDERR}"
  result=$CMD_STDOUT
  jq -e '
    .exit_class=="completed" and
    .events==[{
      code:1,
      event:"gate_failed",
      payload:{reason:"no_mistakes_failed"}
    }]
  ' "$result" >/dev/null || fail "failed should become gate_failed"

  run=gate-cancelled
  make_run "$run" cancelled
  run_gate "$run" "$RUN_HEAD"
  expect_code 0 "$CMD_STATUS" "cancelled mapping${CMD_STDERR:+: $CMD_STDERR}"
  result=$CMD_STDOUT
  jq -e '
    .exit_class=="cancelled" and .events==[] and
    .reasons==["no_mistakes_cancelled"] and .errors==[]
  ' "$result" >/dev/null || fail "cancelled should remain a universal cancelled exit"
  pass "Gate maps documented passed, failed, and cancelled outcomes"
}
# -/ 3/5

# -- 4/5 CORE · test_guards_argument_edges --
test_guards_argument_edges() {
  local run result config

  run=gate-empty-arguments
  make_run "$run" passed
  config="$TMP_ROOT/$run.empty.config.json"
  write_config "$config" passed '[]'
  rm -f "$RUNS_DIR/$run/plan.json"
  sh "$BIN/cb-plan.sh" "$run" --config "$config" >/dev/null \
    || fail "could not compile empty-arguments Gate plan"
  run_gate "$run" "$RUN_HEAD"
  expect_code 0 "$CMD_STATUS" "empty argument array${CMD_STDERR:+: $CMD_STDERR}"
  result=$CMD_STDOUT
  jq -e '.events[0].event=="gate_ok"' "$result" >/dev/null \
    || fail "an empty argument array should work on Bash 3.2"

  run=gate-bare-skip
  make_run "$run" passed
  config="$TMP_ROOT/$run.skip.config.json"
  write_config "$config" passed '["--skip","review"]'
  rm -f "$RUNS_DIR/$run/plan.json"
  sh "$BIN/cb-plan.sh" "$run" --config "$config" >/dev/null \
    || fail "could not compile bare-skip Gate plan"
  run_gate "$run" "$RUN_HEAD"
  expect_code 0 "$CMD_STATUS" "bare skip policy rejection${CMD_STDERR:+: $CMD_STDERR}"
  result=$CMD_STDOUT
  jq -e '
    .exit_class=="technical_error" and .events==[] and
    .errors==["adapter_exit:64"]
  ' "$result" >/dev/null || fail "bare --skip review must not bypass review=true"
  assert_absent "$NM_CALLED" "invalid review skip must be rejected before No-Mistakes"
  pass "Gate handles empty argv on Bash 3.2 and rejects bare review skips"
}
# -/ 4/5

# -- 5/5 CORE · test_replays_terminal_seal --
test_replays_terminal_seal() {
  local run=gate-terminal-replay first_result second_result terminal poison
  rm -f "$NM_CALLS"
  make_run "$run" passed

  run_gate "$run" "$RUN_HEAD" 1
  expect_code 0 "$CMD_STATUS" "initial terminal Gate${CMD_STDERR:+: $CMD_STDERR}"
  first_result=$CMD_STDOUT
  jq -e '.events[0].event=="gate_ok"' "$first_result" >/dev/null \
    || fail "initial Gate attempt should seal a successful terminal result"
  terminal="$RUNS_DIR/$run/artifacts/gate/terminal.json"
  jq -e \
    --arg sha "$RUN_HEAD" --arg branch "$RUN_BRANCH" --arg worktree "$RUN_REPO" '
      .schema=="combo.gate-terminal/v1" and
      .run_id=="gate-terminal-replay" and
      .branch==$branch and .worktree==$worktree and .candidate_sha==$sha and
      .no_mistakes=={
        run_id:"fake-gate-run",
        outcome:"passed",
        pr:"https://example.test/pull/7",
        receipt:"artifacts/gate/no-mistakes-attempt-1.toon"
      } and
      .normalized_outcome=="validated"
    ' "$terminal" >/dev/null \
    || fail "terminal seal should retain exact run, branch, head, PR, and NM identity"

  run_gate "$run" "$RUN_HEAD" 2
  expect_code 0 "$CMD_STATUS" "terminal Gate replay${CMD_STDERR:+: $CMD_STDERR}"
  second_result=$CMD_STDOUT
  jq -e --arg sha "$RUN_HEAD" '
    .attempt==2 and
    .events==[{
      code:0,
      event:"gate_ok",
      payload:{
        outcome:"validated",
        sha:$sha,
        pr:"https://example.test/pull/7"
      }
    }] and
    any(.artifacts[];
      .id=="no-mistakes-outcome" and
      .path=="artifacts/gate/no-mistakes-attempt-1.toon")
  ' "$second_result" >/dev/null \
    || fail "recovery should replay the original exact-head terminal seal"
  [ "$(wc -l <"$NM_CALLS" | tr -d ' ')" = 1 ] \
    || fail "terminal recovery must not start a second No-Mistakes delivery"

  poison="$terminal.poison"
  jq '.candidate_sha="0000000000000000000000000000000000000000"' \
    "$terminal" >"$poison"
  chmod 0444 "$poison"
  mv -f "$poison" "$terminal"
  run_gate "$run" "$RUN_HEAD" 3
  expect_code 0 "$CMD_STATUS" "poisoned terminal normalization${CMD_STDERR:+: $CMD_STDERR}"
  jq -e '
    .exit_class=="technical_error" and .events==[] and
    .errors==["adapter_exit:73"]
  ' "$CMD_STDOUT" >/dev/null \
    || fail "a terminal seal for another head must fail closed"
  [ "$(wc -l <"$NM_CALLS" | tr -d ' ')" = 1 ] \
    || fail "a poisoned terminal seal must not trigger another delivery"
  pass "Gate replays a durable terminal seal without duplicating No-Mistakes"
}
# -/ 5/5

test_validates_exact_sha
test_rejects_candidate_drift
test_maps_terminal_outcomes
test_guards_argument_edges
test_replays_terminal_seal
