#!/usr/bin/env bash
# @overview Contract tests for the P6 direct-agent Reviewer adapter. Proves a
#   configured agent receives the immutable universal input with the review
#   contract, prior artifacts, and exact candidate SHA, then returns a typed
#   0/1 member result that is normalized into the P4 Reviewer outcome schema.
#
#   READING GUIDE
#   -------------
#   1. Fixture agent and plan helpers      <- executable adapter boundary.
#   2. test_normalizes_lgtm                <- exact-SHA unanimous input.
#   3. test_materializes_findings          <- code 1 artifact normalization.
#   4. test_fails_closed                   <- config, output, and process errors.
#
#   MAIN FLOW
#   ---------
#   plan config -> cb-step -> reviewer adapter -> configured agent -> result
#
#   PUBLIC API
#   ----------
#   none
#
#   INTERNALS
#   ---------
#   write_config, make_run, run_reviewer, captured_input
#
# @exports none
# @deps bash, jq, tests/lib.sh, bin/cb-plan.sh, bin/cb-step.sh,
#   bin/cb-reviewer-adapter.sh
set -u

# shellcheck source=tests/lib.sh disable=SC1091
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

BIN="$ROOT/bin"
TMP_ROOT=
cb_tmproot TMP_ROOT cb-reviewer-adapters
RUNS_DIR="$TMP_ROOT/runs"
AGENT="$TMP_ROOT/direct-reviewer"
CAPTURES="$TMP_ROOT/captures"
MARKER="$TMP_ROOT/agent-ran"
SHA_A=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
mkdir -p "$RUNS_DIR" "$CAPTURES"
export CB_RUNS_DIR="$RUNS_DIR"
export CB_REVIEWER_TEST_CAPTURES="$CAPTURES"
export CB_REVIEWER_TEST_MARKER="$MARKER"

CMD_STATUS=
CMD_STDOUT=
CMD_STDERR=

# -- 1/4 HELPER · Fixture agent and immutable Reviewer plans --
# shellcheck disable=SC2016
cb_write_fake "$AGENT" '#!/usr/bin/env bash
set -eu
mode=$1
shift
input=
output=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --input) input=$2; shift 2 ;;
    --output) output=$2; shift 2 ;;
    *) exit 64 ;;
  esac
done
[ -n "$input" ] && [ -n "$output" ] || exit 64
touch "$CB_REVIEWER_TEST_MARKER"
step=$(jq -r ".step_id" "$input")
attempt=$(jq -r ".attempt" "$input")
run=$(jq -r ".run_id" "$input")
cp "$input" "$CB_REVIEWER_TEST_CAPTURES/$run-${step#reviewer/}-$attempt.json"
sha=$(jq -r ".candidate_sha" "$input")
case "$mode" in
  approve)
    jq -n --arg sha "$sha" "{
      schema:\"combo.reviewer-member-output/v1\",
      sha:\$sha,code:0,findings:\"\"
    }" >"$output"
    ;;
  reject)
    jq -n --arg sha "$sha" "{
      schema:\"combo.reviewer-member-output/v1\",
      sha:\$sha,code:1,
      findings:\"## Blocking findings\\n\\n- Preserve the exact candidate contract.\"
    }" >"$output"
    ;;
  wrong-sha)
    jq -n "{
      schema:\"combo.reviewer-member-output/v1\",
      sha:\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\",
      code:0,findings:\"\"
    }" >"$output"
    ;;
  fail)
    exit 42
    ;;
  *)
    exit 64
    ;;
esac
'

write_config() {
  local path=$1 mode=$2 mutation=${3:-.}
  jq -n \
    --arg adapter "$BIN/cb-reviewer-adapter.sh" \
    --arg agent "$AGENT" --arg mode "$mode" '
      {
        schema:"combo.config/v1",
        adapters:{
          launcher:{argv:["/usr/bin/true"],roles:["launcher"]},
          coder:{argv:["/usr/bin/true"],roles:["coder"]},
          reviewer:{argv:[$adapter,"direct-agent"],roles:["reviewer"]},
          gate:{argv:["/usr/bin/true"],roles:["gate"]},
          cleaner:{argv:["/usr/bin/true"],roles:["cleaner"]}
        },
        roles:{
          launcher:{adapter:"launcher",config:{}},
          coder:{adapter:"coder",config:{}},
          reviewers:[{
            id:"model-a",
            adapter:"reviewer",
            config:{
              schema:"combo.reviewer/direct-agent/v1",
              argv:[$agent,$mode],
              contract:"Review the candidate without writing code.",
              output_schema:"combo.reviewer-member-output/v1"
            }
          }],
          gate:{adapter:"gate",config:{}},
          cleaner:{adapter:"cleaner",config:{}}
        }
      }
    ' | jq "$mutation" >"$path"
}

make_run() {
  local run=$1 mode=$2 mutation=${3:-.}
  local run_dir="$RUNS_DIR/$run" config="$TMP_ROOT/$run.config.json"
  mkdir -p "$run_dir/artifacts"
  printf 'immutable context\n' >"$run_dir/artifacts/context.md"
  write_config "$config" "$mode" "$mutation"
  sh "$BIN/cb-plan.sh" "$run" --config "$config" >/dev/null \
    || fail "could not compile direct Reviewer plan for $run"
}

run_reviewer() {
  local run=$1
  local errfile="$TMP_ROOT/$run.err"
  CMD_STDOUT=$(bash "$BIN/cb-step.sh" \
    "$run" reviewer/model-a 1 \
    --candidate-sha "$SHA_A" \
    --prior-artifacts '[{"id":"review-context","path":"artifacts/context.md"}]' \
    2>"$errfile") && CMD_STATUS=0 || CMD_STATUS=$?
  CMD_STDERR=$(cat "$errfile" 2>/dev/null || true)
}

captured_input() {
  printf '%s/%s-model-a-1.json\n' "$CAPTURES" "$1"
}
# -/ 1/4

# -- 2/4 CORE · test_normalizes_lgtm -- <- START HERE
test_normalizes_lgtm() {
  local run=reviewer-direct-lgtm result capture
  make_run "$run" approve
  rm -f "$MARKER"
  run_reviewer "$run"
  expect_code 0 "$CMD_STATUS" "direct Reviewer LGTM${CMD_STDERR:+: $CMD_STDERR}"
  result=$CMD_STDOUT
  capture=$(captured_input "$run")
  assert_present "$MARKER" "valid direct Reviewer config should execute the agent"
  jq -e --arg sha "$SHA_A" '
    .role=="reviewer" and .step_id=="reviewer/model-a" and
    .candidate_sha==$sha and
    .config.contract=="Review the candidate without writing code." and
    .prior_artifacts==[
      {id:"review-context",path:"artifacts/context.md"}
    ]
  ' "$capture" >/dev/null \
    || fail "the agent must receive contract, artifacts, and exact candidate SHA"
  jq -e --arg sha "$SHA_A" '
    .exit_class=="completed" and
    .events==[{code:0,event:"lgtm",payload:{sha:$sha}}] and
    .artifacts==[] and .errors==[] and .reasons==[]
  ' "$result" >/dev/null || fail "member code 0 must normalize to exact-SHA LGTM"
  pass "cb-reviewer-adapter: passes the complete immutable input to a configured direct agent"
}
# -/ 2/4

# -- 3/4 CORE · test_materializes_findings --
test_materializes_findings() {
  local run=reviewer-direct-needs-change result artifact
  make_run "$run" reject
  run_reviewer "$run"
  expect_code 0 "$CMD_STATUS" "direct Reviewer rejection${CMD_STDERR:+: $CMD_STDERR}"
  result=$CMD_STDOUT
  artifact="$RUNS_DIR/$run/artifacts/findings-r1-model-a.md"
  assert_present "$artifact" \
    "member code 1 must publish a findings artifact: $(cat "$result")"
  assert_grep "Preserve the exact candidate contract." "$artifact" \
    "findings markdown must be preserved for the correcting Coder"
  jq -e --arg sha "$SHA_A" '
    .exit_class=="completed" and
    .events==[{code:1,event:"needs_change",payload:{
      sha:$sha,artifact:"artifacts/findings-r1-model-a.md"
    }}] and
    .artifacts==[{
      id:"review-model-a-round-1",
      path:"artifacts/findings-r1-model-a.md"
    }]
  ' "$result" >/dev/null || fail "member code 1 must normalize to needs_change plus findings"
  pass "cb-reviewer-adapter: materializes typed member findings as a run-local artifact"
}
# -/ 3/4

# -- 4/4 CORE · test_fails_closed --
test_fails_closed() {
  local run result
  run=reviewer-direct-invalid-config
  make_run "$run" approve 'del(.roles.reviewers[0].config.contract)'
  rm -f "$MARKER"
  run_reviewer "$run"
  expect_code 0 "$CMD_STATUS" "invalid direct Reviewer config${CMD_STDERR:+: $CMD_STDERR}"
  result=$CMD_STDOUT
  assert_absent "$MARKER" "invalid adapter config must fail before agent execution"
  jq -e '
    .exit_class=="technical_error" and
    .events==[] and .errors==["config:invalid_direct_agent"]
  ' "$result" >/dev/null || fail "invalid config must become a stable technical error"

  run=reviewer-direct-wrong-sha
  make_run "$run" wrong-sha
  run_reviewer "$run"
  expect_code 0 "$CMD_STATUS" "wrong-SHA direct Reviewer output${CMD_STDERR:+: $CMD_STDERR}"
  result=$CMD_STDOUT
  jq -e '
    .exit_class=="technical_error" and
    .events==[] and .errors==["agent_output:invalid"]
  ' "$result" >/dev/null || fail "an agent verdict for another SHA must never enter the fold"

  run=reviewer-direct-agent-failure
  make_run "$run" fail
  run_reviewer "$run"
  expect_code 0 "$CMD_STATUS" "direct Reviewer process failure${CMD_STDERR:+: $CMD_STDERR}"
  result=$CMD_STDOUT
  jq -e '
    .exit_class=="technical_error" and
    .events==[] and .errors==["agent_exit:42"]
  ' "$result" >/dev/null || fail "agent process failures must have a normalized technical class"
  pass "cb-reviewer-adapter: rejects invalid config, stale verdicts, and process failures"
}
# -/ 4/4

test_normalizes_lgtm
test_materializes_findings
test_fails_closed

printf '\nreviewer-adapters: all tests passed\n'
