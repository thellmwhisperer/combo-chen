#!/usr/bin/env bash
# @overview Contract tests for the P7 No-Mistakes Gate adapter. Proves the
#   universal P4 envelope reaches a Gate that seals the Launcher-owned exact
#   branch/head, proves the configured Pi/DeepSeek identity against the effective
#   No-Mistakes config plus the observed version/AXI help contract, builds
#   documented axi argv, resolves one GitHub PR at that exact branch/head,
#   normalizes terminal outcomes, and replays durable invocation/terminal seals
#   without starting a duplicate delivery or PR lookup.
#
#   READING GUIDE
#   -------------
#   1. test_validates_exact_sha     <- canonical validated-mode invocation.
#   2. test_recovers_exact_pr       <- returned URL plus unique branch fallback.
#   3. test_seals_configured_identity <- immutable runtime/model + AXI surface.
#   4. test_rejects_candidate_drift <- no Gate call after the reviewed SHA moves.
#   5. test_maps_terminal_outcomes  <- passed, failed, and cancelled normalization.
#   6. test_guards_argument_edges   <- Bash 3.2 empty arrays and skip policy.
#   7. test_replays_terminal_seal   <- idempotent terminal recovery.
#   8. test_adopts_interrupted_run  <- retry one sealed in-progress invocation.
#   9. test_serializes_global_gate  <- cross-run exclusion and stale recovery.
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
#   write_config, write_no_mistakes_identity, make_run, run_gate,
#   invocation_args, wait_for_path
#
# @exports none
# @deps bash, cksum, date, git, gh-compatible fake, jq, ps, stat, touch,
#   tests/lib.sh, bin/cb-plan.sh, bin/cb-step.sh, bin/cb-gate.sh
set -u

# shellcheck source=tests/lib.sh disable=SC1091
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

BIN="$ROOT/bin"
TMP_ROOT=
cb_tmproot TMP_ROOT cb-gate-no-mistakes
RUNS_DIR="$TMP_ROOT/runs"
FAKE_ROLE="$TMP_ROOT/fake-role-adapter"
FAKE_NM="$TMP_ROOT/fake-no-mistakes"
FAKE_BIN_DIR="$TMP_ROOT/fake-bin"
FAKE_GH="$FAKE_BIN_DIR/gh"
FAKE_NM_HOME="$TMP_ROOT/no-mistakes-home"
FAKE_NM_CONFIG="$FAKE_NM_HOME/.no-mistakes/config.yaml"
NM_ARGV="$TMP_ROOT/no-mistakes.argv"
NM_CWD="$TMP_ROOT/no-mistakes.cwd"
NM_CALLED="$TMP_ROOT/no-mistakes.called"
NM_CALLS="$TMP_ROOT/no-mistakes.calls"
NM_ACTIVE="$TMP_ROOT/no-mistakes.active"
NM_STARTS="$TMP_ROOT/no-mistakes.starts"
NM_ATTACHES="$TMP_ROOT/no-mistakes.attaches"
NM_SERIAL_ACTIVE="$TMP_ROOT/no-mistakes.serial-active"
NM_SERIAL_ENTERED="$TMP_ROOT/no-mistakes.serial-entered"
NM_SERIAL_OVERLAP="$TMP_ROOT/no-mistakes.serial-overlap"
GH_CALLS="$TMP_ROOT/gh.calls"
GATE_LEASES_DIR="$TMP_ROOT/gate-leases"
mkdir -p "$RUNS_DIR"
mkdir -p "$FAKE_BIN_DIR"
mkdir -p "$FAKE_NM_HOME/.no-mistakes"
export CB_RUNS_DIR="$RUNS_DIR"
export CB_GATE_LEASES_DIR="$GATE_LEASES_DIR"
export CB_GATE_TEST_ARGV="$NM_ARGV"
export CB_GATE_TEST_CWD="$NM_CWD"
export CB_GATE_TEST_CALLED="$NM_CALLED"
export CB_GATE_TEST_CALLS="$NM_CALLS"
export CB_GATE_TEST_ACTIVE="$NM_ACTIVE"
export CB_GATE_TEST_STARTS="$NM_STARTS"
export CB_GATE_TEST_ATTACHES="$NM_ATTACHES"
export CB_GATE_TEST_SERIAL_ACTIVE="$NM_SERIAL_ACTIVE"
export CB_GATE_TEST_SERIAL_ENTERED="$NM_SERIAL_ENTERED"
export CB_GATE_TEST_SERIAL_OVERLAP="$NM_SERIAL_OVERLAP"
export CB_GATE_TEST_GH_CALLS="$GH_CALLS"
export CB_GATE_TEST_GH_MODE=exact
export PATH="$FAKE_BIN_DIR:$PATH"

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
if [ "$#" -eq 1 ] && [ "$1" = --version ]; then
  printf "%s\n" "no-mistakes version v-test (fake)"
  exit 0
fi
if [ "$#" -eq 1 ] && [ "$1" = doctor ]; then
  printf "%s\n" "  gate validation  pi is runnable"
  exit 0
fi
if [ "$#" -eq 3 ] && [ "$1" = axi ] && [ "$3" = --help ]; then
  case "$2" in
    run)
      cat <<EOF
Usage:
  no-mistakes axi run [flags]
      --intent string
      --skip string
  -y, --yes
EOF
      ;;
    status)
      cat <<EOF
Usage:
  no-mistakes axi status [flags]
      --run string
EOF
      ;;
    respond)
      cat <<EOF
Usage:
  no-mistakes axi respond [flags]
      --action string
  -y, --yes
EOF
      ;;
    *) exit 64 ;;
  esac
  exit 0
fi
: >"$CB_GATE_TEST_ARGV"
for argument in "$@"; do
  printf "%s\n" "$argument" >>"$CB_GATE_TEST_ARGV"
done
pwd -P >"$CB_GATE_TEST_CWD"
printf "called\n" >"$CB_GATE_TEST_CALLED"
printf "called\n" >>"$CB_GATE_TEST_CALLS"

serial_owned=0
if mkdir "$CB_GATE_TEST_SERIAL_ACTIVE" 2>/dev/null; then
  serial_owned=1
else
  : >"$CB_GATE_TEST_SERIAL_OVERLAP"
fi
cleanup_serial() {
  [ "$serial_owned" -eq 0 ] || rmdir "$CB_GATE_TEST_SERIAL_ACTIVE" 2>/dev/null || true
}
trap cleanup_serial EXIT
printf "%s\n" "$CB_GATE_TEST_BRANCH" >>"$CB_GATE_TEST_SERIAL_ENTERED"

outcome=
for argument in "$@"; do
  case "$argument" in
    --fake-outcome=*) outcome=${argument#*=} ;;
  esac
done
[ -n "$outcome" ] || outcome=passed
pr=https://example.test/pull/7
if [ "$outcome" = passed-no-pr ]; then
  outcome=passed
  pr=
fi
if [ "$outcome" = interrupt-once ]; then
  if [ ! -f "$CB_GATE_TEST_ACTIVE" ]; then
    printf "fake-gate-run\n" >"$CB_GATE_TEST_ACTIVE"
    printf "started\n" >>"$CB_GATE_TEST_STARTS"
    gate_pid=$(ps -o ppid= -p "$PPID" | tr -d " ")
    kill -TERM "$gate_pid"
    exit 75
  fi
  printf "attached\n" >>"$CB_GATE_TEST_ATTACHES"
  outcome=passed
fi
if [ "$outcome" = slow-passed ]; then
  sleep 0.4
  outcome=passed
fi
status=completed
[ "$outcome" != failed ] || status=failed
[ "$outcome" != cancelled ] || status=cancelled

cat <<EOF
run:
  id: "fake-gate-run"
  branch: $CB_GATE_TEST_BRANCH
  status: $status
  head: ${CB_GATE_TEST_HEAD:0:8}
  pr: "$pr"
  findings: none
outcome: $outcome
EOF
[ "$outcome" = passed ] || [ "$outcome" = checks-passed ]
'

cb_write_fake "$FAKE_GH" '#!/usr/bin/env bash
set -eu
{
  separator=
  for argument in "$@"; do
    printf "%s%s" "$separator" "$argument"
    separator="	"
  done
  printf "\n"
} >>"$CB_GATE_TEST_GH_CALLS"

[ "$#" -ge 3 ] && [ "$1" = pr ] || exit 64
mode=${CB_GATE_TEST_GH_MODE:-exact}
url=https://example.test/pull/7
branch=$CB_GATE_TEST_BRANCH
head=$CB_GATE_TEST_HEAD
case "$mode" in
  wrong-branch) branch=combo/wrong-branch ;;
  wrong-head) head=0000000000000000000000000000000000000000 ;;
esac

case "$2" in
  view)
    [ "$#" -eq 5 ] && [ "$3" = "$url" ] &&
      [ "$4" = --json ] &&
      [ "$5" = url,headRefName,headRefOid ] || exit 64
    jq -cn --arg url "$url" --arg branch "$branch" --arg head "$head" \
      "{url:\$url,headRefName:\$branch,headRefOid:\$head}"
    ;;
  list)
    [ "$#" -eq 10 ] && [ "$3" = --head ] &&
      [ "$4" = "$CB_GATE_TEST_BRANCH" ] &&
      [ "$5" = --state ] && [ "$6" = open ] &&
      [ "$7" = --limit ] && [ "$8" = 2 ] &&
      [ "$9" = --json ] &&
      [ "${10}" = url,headRefName,headRefOid ] || exit 64
    case "$mode" in
      zero)
        printf "[]\n"
        ;;
      multiple)
        jq -cn --arg branch "$branch" --arg head "$head" \
          "[
            {url:\"https://example.test/pull/7\",headRefName:\$branch,headRefOid:\$head},
            {url:\"https://example.test/pull/8\",headRefName:\$branch,headRefOid:\$head}
          ]"
        ;;
      *)
        jq -cn --arg url "$url" --arg branch "$branch" --arg head "$head" \
          "[{url:\$url,headRefName:\$branch,headRefOid:\$head}]"
        ;;
    esac
    ;;
  *) exit 64 ;;
esac
'

write_no_mistakes_identity() {
  local model=$1
  printf '%s\n' \
    'agent: pi' \
    'agent_args_override:' \
    '  pi:' \
    '    - --model' \
    "    - $model" >"$FAKE_NM_CONFIG"
}

write_no_mistakes_identity "deepseek/deepseek-v4-pro"

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
              schema:"combo.gate.no-mistakes/v1",
              binary:$nm,
              runtime:"pi",
              model:"deepseek/deepseek-v4-pro",
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
  CMD_STDOUT=$(HOME="$FAKE_NM_HOME" bash "$BIN/cb-step.sh" \
    "$run" gate "$attempt" --candidate-sha "$candidate" 2>"$errfile") \
    && CMD_STATUS=0 || CMD_STATUS=$?
  CMD_STDERR=$(cat "$errfile" 2>/dev/null || true)
}

invocation_args() {
  jq -Rsc 'split("\n") | map(select(length>0))' "$NM_ARGV"
}

wait_for_path() {
  local path=$1 deadline
  deadline=$(( $(date +%s) + 5 ))
  while [ ! -e "$path" ]; do
    [ "$(date +%s)" -lt "$deadline" ] || return 1
    sleep 0.01
  done
}

# -- 1/9 CORE · test_validates_exact_sha -- <- START HERE
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
        id:"gate-invocation",
        path:"artifacts/gate/invocation.json"
      },
      {
        id:"gate-lease",
        path:"artifacts/gate/no-mistakes-lease-attempt-1.json"
      },
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
# -/ 1/9

# -- 2/9 CORE · test_recovers_exact_pr --
test_recovers_exact_pr() {
  local run result terminal calls

  rm -f "$GH_CALLS" "$NM_CALLS"
  export CB_GATE_TEST_GH_MODE=exact
  run=gate-pr-from-receipt
  make_run "$run" passed
  run_gate "$run" "$RUN_HEAD"
  expect_code 0 "$CMD_STATUS" \
    "returned PR verification${CMD_STDERR:+: $CMD_STDERR}"
  result=$CMD_STDOUT
  jq -e --arg sha "$RUN_HEAD" '
    .events==[{
      code:0,
      event:"gate_ok",
      payload:{
        outcome:"validated",
        sha:$sha,
        pr:"https://example.test/pull/7"
      }
    }]
  ' "$result" >/dev/null \
    || fail "Gate should accept a returned PR only at the exact branch and head"
  calls=$(cat "$GH_CALLS")
  [ "$calls" = \
    $'pr\tview\thttps://example.test/pull/7\t--json\turl,headRefName,headRefOid' ] \
    || fail "Gate should verify the No-Mistakes PR URL directly: $calls"

  terminal="$RUNS_DIR/$run/artifacts/gate/terminal.json"
  jq -e '
    .no_mistakes.pr=="https://example.test/pull/7" and
    .result.events[0].payload.pr=="https://example.test/pull/7"
  ' "$terminal" >/dev/null \
    || fail "terminal recovery should seal the exact verified PR URL"
  run_gate "$run" "$RUN_HEAD" 2
  expect_code 0 "$CMD_STATUS" \
    "verified PR terminal replay${CMD_STDERR:+: $CMD_STDERR}"
  [ "$(wc -l <"$GH_CALLS" | tr -d ' ')" = 1 ] \
    || fail "terminal replay must not query or select another PR"
  [ "$(wc -l <"$NM_CALLS" | tr -d ' ')" = 1 ] \
    || fail "terminal replay must not start another delivery after PR recovery"

  rm -f "$GH_CALLS"
  run=gate-pr-branch-recovery
  make_run "$run" passed-no-pr
  run_gate "$run" "$RUN_HEAD"
  expect_code 0 "$CMD_STATUS" \
    "missing URL branch recovery${CMD_STDERR:+: $CMD_STDERR}"
  jq -e --arg sha "$RUN_HEAD" '
    .events==[{
      code:0,
      event:"gate_ok",
      payload:{
        outcome:"validated",
        sha:$sha,
        pr:"https://example.test/pull/7"
      }
    }]
  ' "$CMD_STDOUT" >/dev/null \
    || fail "Gate should recover one exact open PR when the receipt omits its URL"
  calls=$(cat "$GH_CALLS")
  [ "$calls" = \
    $'pr\tlist\t--head\tcombo/gate-pr-branch-recovery\t--state\topen\t--limit\t2\t--json\turl,headRefName,headRefOid' ] \
    || fail "Gate should use one bounded branch lookup for URL recovery: $calls"

  export CB_GATE_TEST_GH_MODE=zero
  run=gate-pr-recovery-zero
  make_run "$run" passed-no-pr
  run_gate "$run" "$RUN_HEAD"
  expect_code 0 "$CMD_STATUS" \
    "zero PR recovery rejection${CMD_STDERR:+: $CMD_STDERR}"
  jq -e '
    .exit_class=="completed" and
    .events==[{
      code:1,
      event:"gate_failed",
      payload:{reason:"github_pr_not_found"}
    }]
  ' "$CMD_STDOUT" >/dev/null \
    || fail "zero branch matches must fail Gate without guessing a PR"

  export CB_GATE_TEST_GH_MODE=multiple
  run=gate-pr-recovery-multiple
  make_run "$run" passed-no-pr
  run_gate "$run" "$RUN_HEAD"
  expect_code 0 "$CMD_STATUS" \
    "ambiguous PR recovery rejection${CMD_STDERR:+: $CMD_STDERR}"
  jq -e '
    .exit_class=="completed" and
    .events==[{
      code:1,
      event:"gate_failed",
      payload:{reason:"github_pr_ambiguous"}
    }]
  ' "$CMD_STDOUT" >/dev/null \
    || fail "multiple branch matches must fail Gate without choosing a PR"

  export CB_GATE_TEST_GH_MODE=wrong-branch
  run=gate-pr-wrong-branch
  make_run "$run" passed
  run_gate "$run" "$RUN_HEAD"
  expect_code 0 "$CMD_STATUS" \
    "wrong PR branch rejection${CMD_STDERR:+: $CMD_STDERR}"
  jq -e '.events[0].payload.reason=="github_pr_identity_mismatch"' \
    "$CMD_STDOUT" >/dev/null \
    || fail "a returned PR for another branch must fail Gate"

  export CB_GATE_TEST_GH_MODE=wrong-head
  run=gate-pr-wrong-head
  make_run "$run" passed
  run_gate "$run" "$RUN_HEAD"
  expect_code 0 "$CMD_STATUS" \
    "wrong PR head rejection${CMD_STDERR:+: $CMD_STDERR}"
  jq -e '.events[0].payload.reason=="github_pr_identity_mismatch"' \
    "$CMD_STDOUT" >/dev/null \
    || fail "a returned PR for another head must fail Gate"

  export CB_GATE_TEST_GH_MODE=exact
  pass "Gate recovers and seals one exact PR without duplicate delivery or lookup"
}
# -/ 2/9

# -- 3/9 CORE · test_seals_configured_identity --
test_seals_configured_identity() {
  local mismatch=gate-configured-identity-mismatch
  local run=gate-configured-identity result invocation poison
  rm -f "$NM_ACTIVE" "$NM_CALLS" "$NM_STARTS" "$NM_ATTACHES"

  write_no_mistakes_identity "other/model"
  make_run "$mismatch" passed
  run_gate "$mismatch" "$RUN_HEAD" 1
  expect_code 0 "$CMD_STATUS" \
    "effective identity mismatch${CMD_STDERR:+: $CMD_STDERR}"
  jq -e '
    .exit_class=="technical_error" and .events==[] and
    .errors==["adapter_exit:73"]
  ' "$CMD_STDOUT" >/dev/null \
    || fail "Gate must reject a configured model absent from effective No-Mistakes config"
  assert_absent "$NM_CALLED" \
    "identity mismatch must fail before No-Mistakes starts"

  write_no_mistakes_identity "deepseek/deepseek-v4-pro"
  make_run "$run" interrupt-once

  run_gate "$run" "$RUN_HEAD" 1
  expect_code 0 "$CMD_STATUS" \
    "configured identity interruption${CMD_STDERR:+: $CMD_STDERR}"
  result=$CMD_STDOUT
  jq -e '
    (.exit_class=="cancelled" and
      (.reasons==["adapter_exit:130"] or .reasons==["adapter_exit:143"])) or
    (.exit_class=="technical_error" and
      (.errors[0] | test("^adapter_exit:[1-9][0-9]*$")))
  ' "$result" >/dev/null \
    || fail "identity fixture should stop after sealing its in-progress invocation"

  invocation="$RUNS_DIR/$run/artifacts/gate/invocation.json"
  jq -e --arg config "$FAKE_NM_CONFIG" '
    .schema=="combo.gate-invocation/v2" and
    .preflight.runtime=="pi" and
    .preflight.model=="deepseek/deepseek-v4-pro" and
    .preflight.config_path==$config and
    (.preflight.doctor | contains("gate validation  pi is runnable")) and
    .preflight.version=="no-mistakes version v-test (fake)" and
    (.preflight.axi_run_help | contains("no-mistakes axi run")) and
    (.preflight.axi_run_help | contains("--intent")) and
    (.preflight.axi_run_help | contains("--yes")) and
    (.preflight.axi_run_help | contains("--auto-merge") | not) and
    (.preflight.axi_status_help | contains("no-mistakes axi status")) and
    (.preflight.axi_respond_help | contains("no-mistakes axi respond")) and
    (.argv | index("--model") | not) and
    (.argv | index("deepseek/deepseek-v4-pro") | not)
  ' "$invocation" >/dev/null \
    || fail "invocation seal should bind configured identity and observed AXI surface"

  poison="$invocation.poison"
  jq '.preflight.model="other/model"' "$invocation" >"$poison"
  chmod 0444 "$poison"
  mv -f "$poison" "$invocation"
  run_gate "$run" "$RUN_HEAD" 2
  expect_code 0 "$CMD_STATUS" \
    "poisoned configured identity${CMD_STDERR:+: $CMD_STDERR}"
  jq -e '
    .exit_class=="technical_error" and .events==[] and
    .errors==["adapter_exit:73"]
  ' "$CMD_STDOUT" >/dev/null \
    || fail "a changed runtime/model seal must fail closed before reattachment"
  [ "$(wc -l <"$NM_CALLS" | tr -d ' ')" = 1 ] \
    || fail "identity mismatch must not start or attach another No-Mistakes run"
  pass "Gate seals configured runtime/model identity and the supported AXI surface"
}
# -/ 3/9

# -- 4/9 CORE · test_rejects_candidate_drift --
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
# -/ 4/9

# -- 5/9 CORE · test_maps_terminal_outcomes --
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
# -/ 5/9

# -- 6/9 CORE · test_guards_argument_edges --
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
# -/ 6/9

# -- 7/9 CORE · test_replays_terminal_seal --
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
      .lease=="artifacts/gate/no-mistakes-lease-attempt-1.json" and
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
# -/ 7/9

# -- 8/9 CORE · test_adopts_interrupted_run --
test_adopts_interrupted_run() {
  local run=gate-interrupted-recovery first_result second_result invocation
  local invocation_before invocation_after invocation_mode terminal
  rm -f "$NM_ACTIVE" "$NM_STARTS" "$NM_ATTACHES" "$NM_CALLS"
  make_run "$run" interrupt-once

  run_gate "$run" "$RUN_HEAD" 1
  expect_code 0 "$CMD_STATUS" "interrupted Gate normalization${CMD_STDERR:+: $CMD_STDERR}"
  first_result=$CMD_STDOUT
  if ! jq -e '
    (.exit_class=="cancelled" and .events==[] and .errors==[] and
      (.reasons==["adapter_exit:130"] or .reasons==["adapter_exit:143"])) or
    (.exit_class=="technical_error" and .events==[] and .reasons==[] and
      (.errors[0] | test("^adapter_exit:[1-9][0-9]*$")))
  ' "$first_result" >/dev/null; then
    fail "an interrupted Gate should remain retryable through the universal envelope: $(cat "$first_result")"
  fi

  invocation="$RUNS_DIR/$run/artifacts/gate/invocation.json"
  assert_present "$invocation" \
    "Gate must seal the exact invocation before starting No-Mistakes"
  invocation_mode=$(stat -c '%a' "$invocation" 2>/dev/null ||
    stat -f '%Lp' "$invocation")
  [ "$invocation_mode" = 444 ] \
    || fail "Gate invocation seal should be read-only"
  jq -e \
    --arg sha "$RUN_HEAD" --arg branch "$RUN_BRANCH" \
    --arg worktree "$RUN_REPO" --arg binary "$FAKE_NM" '
      .schema=="combo.gate-invocation/v2" and
      .run_id=="gate-interrupted-recovery" and
      .branch==$branch and .worktree==$worktree and .candidate_sha==$sha and
      .initial_attempt==1 and .binary==$binary and
      .preflight.runtime=="pi" and
      .preflight.model=="deepseek/deepseek-v4-pro" and
      .argv==[
        "axi","run","--intent","validate exact candidate",
        "--fake-outcome=interrupt-once","--yes"
      ]
    ' "$invocation" >/dev/null \
    || fail "in-progress seal should retain the exact run, head, binary, and argv"
  invocation_before=$(cksum <"$invocation")
  assert_absent "$RUNS_DIR/$run/artifacts/gate/no-mistakes-attempt-1.toon" \
    "interruption before a terminal return must not invent a receipt"
  assert_absent "$RUNS_DIR/$run/artifacts/gate/terminal.json" \
    "interruption before a terminal return must not invent a terminal seal"

  run_gate "$run" "$RUN_HEAD" 2
  expect_code 0 "$CMD_STATUS" "interrupted Gate recovery${CMD_STDERR:+: $CMD_STDERR}"
  second_result=$CMD_STDOUT
  jq -e --arg sha "$RUN_HEAD" '
    .attempt==2 and .exit_class=="completed" and
    .events==[{
      code:0,
      event:"gate_ok",
      payload:{
        outcome:"validated",
        sha:$sha,
        pr:"https://example.test/pull/7"
      }
    }]
  ' "$second_result" >/dev/null \
    || fail "retry should adopt and finish the exact sealed invocation"

  invocation_after=$(cksum <"$invocation")
  [ "$invocation_after" = "$invocation_before" ] \
    || fail "retry must not replace or mutate the in-progress invocation seal"
  [ "$(wc -l <"$NM_STARTS" | tr -d ' ')" = 1 ] \
    || fail "interrupted recovery must start only one No-Mistakes run"
  [ "$(wc -l <"$NM_ATTACHES" | tr -d ' ')" = 1 ] \
    || fail "interrupted recovery must attach to the existing No-Mistakes run"

  terminal="$RUNS_DIR/$run/artifacts/gate/terminal.json"
  jq -e '
    .no_mistakes.run_id=="fake-gate-run" and
    .no_mistakes.receipt=="artifacts/gate/no-mistakes-attempt-2.toon" and
    .normalized_outcome=="validated"
  ' "$terminal" >/dev/null \
    || fail "recovered terminal seal should bind the adopted run and its receipt"
  pass "Gate adopts an interrupted No-Mistakes run from one immutable invocation seal"
}
# -/ 8/9

# -- 9/9 CORE · test_serializes_global_gate --
test_serializes_global_gate() {
  local first=gate-serial-first second=gate-serial-second stale=gate-serial-stale
  local first_repo first_head first_branch second_repo second_head second_branch
  local first_out first_err second_out second_err first_pid second_pid
  local first_status second_status first_result second_result lease lock owner
  rm -rf "$GATE_LEASES_DIR" "$NM_SERIAL_ACTIVE"
  rm -f "$NM_SERIAL_ENTERED" "$NM_SERIAL_OVERLAP" "$NM_CALLS"

  make_run "$first" slow-passed
  first_repo=$RUN_REPO
  first_head=$RUN_HEAD
  first_branch=$RUN_BRANCH
  make_run "$second" passed
  second_repo=$RUN_REPO
  second_head=$RUN_HEAD
  second_branch=$RUN_BRANCH

  first_out="$TMP_ROOT/$first.out"
  first_err="$TMP_ROOT/$first.background.err"
  CB_GATE_TEST_BRANCH=$first_branch CB_GATE_TEST_HEAD=$first_head \
    bash "$BIN/cb-step.sh" \
      "$first" gate 1 --candidate-sha "$first_head" \
      >"$first_out" 2>"$first_err" &
  first_pid=$!
  if ! wait_for_path "$NM_SERIAL_ACTIVE"; then
    wait "$first_pid" 2>/dev/null || true
    fail "first Gate did not enter the serialized fake No-Mistakes runtime"
  fi

  second_out="$TMP_ROOT/$second.out"
  second_err="$TMP_ROOT/$second.background.err"
  CB_GATE_TEST_BRANCH=$second_branch CB_GATE_TEST_HEAD=$second_head \
    bash "$BIN/cb-step.sh" \
      "$second" gate 1 --candidate-sha "$second_head" \
      >"$second_out" 2>"$second_err" &
  second_pid=$!

  wait "$first_pid" && first_status=0 || first_status=$?
  wait "$second_pid" && second_status=0 || second_status=$?
  expect_code 0 "$first_status" \
    "first serialized Gate$(test ! -s "$first_err" || printf ': %s' "$(cat "$first_err")")"
  expect_code 0 "$second_status" \
    "second serialized Gate$(test ! -s "$second_err" || printf ': %s' "$(cat "$second_err")")"
  first_result=$(cat "$first_out")
  second_result=$(cat "$second_out")
  jq -e '.events[0].event=="gate_ok"' "$first_result" >/dev/null \
    || fail "first serialized Gate should validate"
  jq -e '.events[0].event=="gate_ok"' "$second_result" >/dev/null \
    || fail "second serialized Gate should validate"
  assert_absent "$NM_SERIAL_OVERLAP" \
    "two Combo runs must never overlap in a host-global No-Mistakes Gate"
  [ "$(wc -l <"$NM_SERIAL_ENTERED" | tr -d ' ')" = 2 ] \
    || fail "both serialized Gate runs should eventually enter No-Mistakes"

  for lease in \
    "$RUNS_DIR/$first/artifacts/gate/no-mistakes-lease-attempt-1.json" \
    "$RUNS_DIR/$second/artifacts/gate/no-mistakes-lease-attempt-1.json"; do
    jq -e '
      .schema=="combo.gate-lease/v1" and
      .scope=="host-global" and .adapter=="no-mistakes" and
      .state=="acquired" and .recovered_from==null
    ' "$lease" >/dev/null \
      || fail "each Gate run should retain immutable host-global lease evidence"
  done
  assert_absent "$GATE_LEASES_DIR/no-mistakes.lock" \
    "the global Gate lease should be released after both terminal outcomes"

  make_run "$stale" passed
  lock="$GATE_LEASES_DIR/no-mistakes.lock"
  owner="$lock/owner.json"
  mkdir -p "$lock"
  jq -n '
    {
      schema:"combo.gate-lease-owner/v1",
      scope:"host-global",
      adapter:"no-mistakes",
      run_id:"dead-gate",
      branch:"combo/dead-gate",
      worktree:"/dead/worktree",
      candidate_sha:"0000000000000000000000000000000000000000",
      attempt:1,
      pid:99999999,
      token:"dead-owner",
      acquired_at:1
    }
  ' >"$owner"
  touch -t 200001010000 "$lock"
  run_gate "$stale" "$RUN_HEAD"
  expect_code 0 "$CMD_STATUS" "stale Gate lease recovery${CMD_STDERR:+: $CMD_STDERR}"
  jq -e '.events[0].event=="gate_ok"' "$CMD_STDOUT" >/dev/null \
    || fail "a dead global Gate owner should be recoverable"
  lease="$RUNS_DIR/$stale/artifacts/gate/no-mistakes-lease-attempt-1.json"
  jq -e '
    .schema=="combo.gate-lease/v1" and .state=="recovered" and
    .recovered_from.run_id=="dead-gate" and
    .recovered_from.token=="dead-owner"
  ' "$lease" >/dev/null \
    || fail "stale recovery should remain visible in immutable run-local evidence"
  assert_absent "$lock" "recovered global Gate lease should be released on exit"
  [ "$first_repo" != "$second_repo" ] \
    || fail "serialization fixture must use independently isolated worktrees"
  pass "Gate serializes No-Mistakes across runs and recovers a stale owner"
}
# -/ 9/9

test_validates_exact_sha
test_recovers_exact_pr
test_seals_configured_identity
test_rejects_candidate_drift
test_maps_terminal_outcomes
test_guards_argument_edges
test_replays_terminal_seal
test_adopts_interrupted_run
test_serializes_global_gate
