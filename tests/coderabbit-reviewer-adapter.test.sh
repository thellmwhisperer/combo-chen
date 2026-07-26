#!/usr/bin/env bash
# @overview Contract tests for the P6 direct CodeRabbit Reviewer adapter.
#   Proves the adapter runs the configured CodeRabbit binary against one clean
#   exact candidate, supplies the review contract and prior artifacts, and
#   normalizes agent JSONL into exact-SHA 0/1 Reviewer outcomes.
#
#   READING GUIDE
#   -------------
#   1. Fixture CLI, repository, and plan helpers <- executable adapter boundary.
#   2. test_normalizes_nonblocking_lgtm          <- critical-only clean result.
#   3. test_normalizes_blocking_findings         <- findings artifact mapping.
#   4. test_fails_closed                         <- config, SHA, output, process.
#
#   MAIN FLOW
#   ---------
#   plan config -> cb-step -> CodeRabbit adapter -> JSONL -> Reviewer result
#
#   PUBLIC API
#   ----------
#   none
#
#   INTERNALS
#   ---------
#   write_config, make_run, run_reviewer, result_file, rabbit_file
#
# @exports none
# @deps bash, git, jq, tests/lib.sh, bin/cb-plan.sh, bin/cb-step.sh,
#   bin/cb-reviewer-adapter.sh
set -u

# shellcheck source=tests/lib.sh disable=SC1091
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

BIN="$ROOT/bin"
TMP_ROOT=
cb_tmproot TMP_ROOT cb-coderabbit-reviewer
RUNS_DIR="$TMP_ROOT/runs"
REPO="$TMP_ROOT/repo"
RABBIT="$TMP_ROOT/bin/coderabbit"
RABBIT_REAL="$TMP_ROOT/bin/coderabbit-real"
CAPTURES="$TMP_ROOT/captures"
MARKER="$TMP_ROOT/coderabbit-ran"
mkdir -p "$RUNS_DIR" "$REPO" "$(dirname "$RABBIT")" "$CAPTURES"
export CB_RUNS_DIR="$RUNS_DIR"
export CB_RABBIT_TEST_CAPTURES="$CAPTURES"
export CB_RABBIT_TEST_MARKER="$MARKER"

CMD_STATUS=
CMD_STDOUT=
CMD_STDERR=

# -- 1/4 HELPER · Fixture CodeRabbit CLI, repository, and immutable plans --
# shellcheck disable=SC2016
cb_write_fake "$RABBIT_REAL" '#!/usr/bin/env bash
set -eu
original=("$@")
[ "$#" -gt 0 ] && [ "$1" = review ] || exit 64
shift
base=
context=
directory=
agent=0
committed=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --agent) agent=1; shift ;;
    --committed) committed=1; shift ;;
    --base-commit) base=$2; shift 2 ;;
    --dir) directory=$2; shift 2 ;;
    --config) context=$2; shift 2 ;;
    *) exit 64 ;;
  esac
done
[ "$agent" -eq 1 ] && [ "$committed" -eq 1 ] || exit 64
[ -n "$base" ] && [ -n "$directory" ] && [ -n "$context" ] || exit 64
run=$(sed -n "s/^Run: //p" "$context")
[ -n "$run" ] || exit 64
touch "$CB_RABBIT_TEST_MARKER"
printf "%s\n" "${original[@]}" >"$CB_RABBIT_TEST_CAPTURES/$run.argv"
cp "$context" "$CB_RABBIT_TEST_CAPTURES/$run.context"
pwd -P >"$CB_RABBIT_TEST_CAPTURES/$run.cwd"

case "$run" in
  rabbit-process-failure)
    exit 42
    ;;
  rabbit-invalid-json)
    printf "not-json\n"
    exit 0
    ;;
esac

jq -cn --arg dir "$directory" --arg base "$base" "{
  type:\"review_context\",reviewType:\"committed\",
  workingDirectory:\$dir,baseCommit:\$base
}"
case "$run" in
  rabbit-nonblocking)
    jq -cn "{
      type:\"finding\",severity:\"major\",fileName:\"src/nonblocking.sh\",
      codegenInstructions:\"\",suggestions:[],
      comment:\"Major evidence must not block critical-only review.\"
    }"
    jq -cn "{
      type:\"complete\",status:\"review_completed\",findings:1,
      reviewedFiles:[\"src/nonblocking.sh\"]
    }"
    ;;
  rabbit-critical)
    jq -cn "{
      type:\"finding\",severity:\"major\",fileName:\"src/nonblocking.sh\",
      codegenInstructions:\"\",suggestions:[],
      comment:\"Do not route this non-critical evidence to Coder.\"
    }"
    jq -cn "{
      type:\"finding\",severity:\"critical\",fileName:\"src/blocking.sh\",
      codegenInstructions:\"Guard the exact candidate.\",suggestions:[],
      comment:\"Critical candidate mismatch.\"
    }"
    jq -cn "{
      type:\"complete\",status:\"review_completed\",findings:2,
      reviewedFiles:[\"src/nonblocking.sh\",\"src/blocking.sh\"]
    }"
    ;;
  *)
    jq -cn "{
      type:\"complete\",status:\"review_completed\",findings:0,
      reviewedFiles:[]
    }"
    ;;
esac
'
ln -s "$(basename "$RABBIT_REAL")" "$RABBIT"

git init -q -b main "$REPO"
git -C "$REPO" config user.name "Combo P6 Test"
git -C "$REPO" config user.email "combo-p6@example.test"
printf 'base\n' >"$REPO/candidate.txt"
git -C "$REPO" add candidate.txt
git -C "$REPO" commit -qm "base"
BASE_SHA=$(git -C "$REPO" rev-parse HEAD)
printf 'candidate\n' >>"$REPO/candidate.txt"
git -C "$REPO" add candidate.txt
git -C "$REPO" commit -qm "candidate"
CANDIDATE_SHA=$(git -C "$REPO" rev-parse HEAD)

write_config() {
  local path=$1 mutation=${2:-.}
  jq -n \
    --arg adapter "$BIN/cb-reviewer-adapter.sh" \
    --arg rabbit "$RABBIT" --arg repo "$REPO" --arg base "$BASE_SHA" '
      {
        schema:"combo.config/v1",
        adapters:{
          launcher:{argv:["/usr/bin/true"],roles:["launcher"]},
          coder:{argv:["/usr/bin/true"],roles:["coder"]},
          reviewer:{argv:[$adapter,"coderabbit"],roles:["reviewer"]},
          gate:{argv:["/usr/bin/true"],roles:["gate"]},
          cleaner:{argv:["/usr/bin/true"],roles:["cleaner"]}
        },
        roles:{
          launcher:{adapter:"launcher",config:{}},
          coder:{adapter:"coder",config:{}},
          reviewers:[{
            id:"rabbit",
            adapter:"reviewer",
            config:{
              schema:"combo.reviewer/coderabbit/v1",
              argv:[$rabbit],
              worktree:$repo,
              base_sha:$base,
              contract:"Review the exact candidate without writing code.",
              blocking_severities:["critical"]
            }
          }],
          gate:{adapter:"gate",config:{}},
          cleaner:{adapter:"cleaner",config:{}}
        }
      }
    ' | jq "$mutation" >"$path"
}

make_run() {
  local run=$1 mutation=${2:-.}
  local run_dir="$RUNS_DIR/$run" config="$TMP_ROOT/$run.config.json"
  mkdir -p "$run_dir/artifacts"
  printf 'Prior reviewer evidence.\n' >"$run_dir/artifacts/context.md"
  write_config "$config" "$mutation"
  sh "$BIN/cb-plan.sh" "$run" --config "$config" >/dev/null \
    || fail "could not compile CodeRabbit Reviewer plan for $run"
}

run_reviewer() {
  local run=$1 sha=${2:-"$CANDIDATE_SHA"}
  local errfile="$TMP_ROOT/$run.err"
  CMD_STDOUT=$(bash "$BIN/cb-step.sh" \
    "$run" reviewer/rabbit 1 \
    --candidate-sha "$sha" \
    --prior-artifacts '[{"id":"review-context","path":"artifacts/context.md"}]' \
    2>"$errfile") && CMD_STATUS=0 || CMD_STATUS=$?
  CMD_STDERR=$(cat "$errfile" 2>/dev/null || true)
}

result_file() {
  printf '%s\n' "$CMD_STDOUT"
}

rabbit_file() {
  printf '%s/steps/03-reviewer-rabbit/attempt-1/%s\n' \
    "$RUNS_DIR/$1" "$2"
}
# -/ 1/4

# -- 2/4 CORE · test_normalizes_nonblocking_lgtm -- <- START HERE
test_normalizes_nonblocking_lgtm() {
  local run=rabbit-nonblocking result raw context args expected
  make_run "$run"
  rm -f "$MARKER"
  run_reviewer "$run"
  expect_code 0 "$CMD_STATUS" "nonblocking CodeRabbit review${CMD_STDERR:+: $CMD_STDERR}"
  result=$(result_file)
  raw=$(rabbit_file "$run" coderabbit-output.jsonl)
  context="$CAPTURES/$run.context"
  args="$CAPTURES/$run.argv"

  assert_present "$MARKER" "valid CodeRabbit config must execute the direct CLI"
  assert_present "$raw" "raw CodeRabbit JSONL must remain as run-local evidence"
  assert_grep '"severity":"major"' "$raw" \
    "nonblocking findings must remain visible in raw evidence"
  jq -e --arg sha "$CANDIDATE_SHA" '
    .exit_class=="completed" and
    .events==[{code:0,event:"lgtm",payload:{sha:$sha}}] and
    .artifacts==[] and .errors==[] and .reasons==[]
  ' "$result" >/dev/null \
    || fail "a review without configured blocking severities must normalize to LGTM"

  assert_grep "Review the exact candidate without writing code." "$context" \
    "CodeRabbit must receive the configured review contract"
  assert_grep "$CANDIDATE_SHA" "$context" \
    "CodeRabbit context must pin the exact candidate SHA"
  assert_grep "Prior reviewer evidence." "$context" \
    "CodeRabbit context must include prior artifact contents"
  [ "$(cat "$CAPTURES/$run.cwd")" = "$REPO" ] \
    || fail "CodeRabbit must execute from the configured worktree"
  expected=$(printf 'review\n--agent\n--committed\n--base-commit\n%s\n--dir\n%s\n--config\n%s\n' \
    "$BASE_SHA" "$REPO" "$(rabbit_file "$run" coderabbit-context.md)")
  [ "$(cat "$args")" = "$expected" ] \
    || fail "adapter must invoke the direct CodeRabbit CLI with frozen committed scope"
  pass "cb-reviewer-adapter: normalizes nonblocking CodeRabbit evidence to exact-SHA LGTM"
}
# -/ 2/4

# -- 3/4 CORE · test_normalizes_blocking_findings --
test_normalizes_blocking_findings() {
  local run=rabbit-critical result artifact
  make_run "$run"
  run_reviewer "$run"
  expect_code 0 "$CMD_STATUS" "critical CodeRabbit review${CMD_STDERR:+: $CMD_STDERR}"
  result=$(result_file)
  artifact="$RUNS_DIR/$run/artifacts/findings-r1-rabbit.md"
  assert_present "$artifact" "critical findings must produce a Coder-facing artifact"
  assert_grep "Critical candidate mismatch." "$artifact" \
    "configured blocking findings must be preserved"
  if grep -F "Do not route this non-critical evidence" "$artifact" >/dev/null 2>&1; then
    fail "nonblocking CodeRabbit evidence must not grow the Coder correction scope"
  fi
  jq -e --arg sha "$CANDIDATE_SHA" '
    .exit_class=="completed" and
    .events==[{code:1,event:"needs_change",payload:{
      sha:$sha,artifact:"artifacts/findings-r1-rabbit.md"
    }}] and
    .artifacts==[{
      id:"review-rabbit-round-1",
      path:"artifacts/findings-r1-rabbit.md"
    }]
  ' "$result" >/dev/null \
    || fail "configured blocking CodeRabbit findings must normalize to needs_change"
  pass "cb-reviewer-adapter: maps only configured CodeRabbit severities to needs_change"
}
# -/ 3/4

# -- 4/4 CORE · test_fails_closed --
test_fails_closed() {
  local run result
  run=rabbit-invalid-config
  make_run "$run" 'del(.roles.reviewers[0].config.contract)'
  rm -f "$MARKER"
  run_reviewer "$run"
  expect_code 0 "$CMD_STATUS" "invalid CodeRabbit config${CMD_STDERR:+: $CMD_STDERR}"
  result=$(result_file)
  assert_absent "$MARKER" "invalid CodeRabbit config must fail before execution"
  jq -e '
    .exit_class=="technical_error" and
    .events==[] and .errors==["config:invalid_coderabbit"]
  ' "$result" >/dev/null || fail "invalid CodeRabbit config must fail deterministically"

  run=rabbit-stale-candidate
  make_run "$run"
  rm -f "$MARKER"
  run_reviewer "$run" bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
  expect_code 0 "$CMD_STATUS" "stale CodeRabbit candidate${CMD_STDERR:+: $CMD_STDERR}"
  result=$(result_file)
  assert_absent "$MARKER" "a stale candidate SHA must fail before CodeRabbit execution"
  jq -e '
    .exit_class=="technical_error" and
    .events==[] and .errors==["candidate:head_mismatch"]
  ' "$result" >/dev/null || fail "stale CodeRabbit input must never enter the fold"

  run=rabbit-invalid-json
  make_run "$run"
  run_reviewer "$run"
  expect_code 0 "$CMD_STATUS" "invalid CodeRabbit JSONL${CMD_STDERR:+: $CMD_STDERR}"
  result=$(result_file)
  jq -e '
    .exit_class=="technical_error" and
    .events==[] and .errors==["coderabbit_output:invalid"]
  ' "$result" >/dev/null || fail "malformed CodeRabbit JSONL must fail closed"

  run=rabbit-process-failure
  make_run "$run"
  run_reviewer "$run"
  expect_code 0 "$CMD_STATUS" "CodeRabbit process failure${CMD_STDERR:+: $CMD_STDERR}"
  result=$(result_file)
  jq -e '
    .exit_class=="technical_error" and
    .events==[] and .errors==["coderabbit_exit:42"]
  ' "$result" >/dev/null || fail "CodeRabbit process failures must be deterministic"
  pass "cb-reviewer-adapter: rejects invalid config, stale SHA, JSONL, and process failure"
}
# -/ 4/4

test_normalizes_nonblocking_lgtm
test_normalizes_blocking_findings
test_fails_closed

printf '\ncoderabbit-reviewer-adapter: all tests passed\n'
