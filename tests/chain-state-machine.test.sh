#!/usr/bin/env bash
# @overview Contract tests for the plan-driven P4 Combo state machine.
#   Proves fixed role order, full Reviewer rounds, needs-change correction,
#   normalized terminal classes, empty Reviewer plans, and mandatory cleanup.
#
#   READING GUIDE
#   -------------
#   1. test_runs_success_path          <- canonical plan traversal.
#   2. test_closes_adapter_stdin        <- adapters cannot consume plan traversal.
#   3. test_restarts_review_round      <- sole Coder loop and artifact routing.
#   4. test_normalizes_terminal_paths  <- technical error and cancellation.
#   5. test_handles_plan_edges         <- zero reviewers and failed Gate cleanup.
#
#   MAIN FLOW
#   ---------
#   config -> immutable plan -> cb-chain.sh -> cb-step.sh* -> chain-result.json
#
#   PUBLIC API
#   ----------
#   none
#
#   INTERNALS
#   ---------
#   write_config, make_run, run_chain, call_steps
#
# @exports none
# @deps bash, jq, tests/lib.sh, bin/cb-plan.sh, bin/cb-chain.sh, bin/cb-step.sh
set -u

# shellcheck source=tests/lib.sh disable=SC1091
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

BIN="$ROOT/bin"
TMP_ROOT=
cb_tmproot TMP_ROOT cb-chain-state
RUNS_DIR="$TMP_ROOT/runs"
FAKE="$TMP_ROOT/fake-chain-adapter"
SHA_A=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
SHA_B=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
mkdir -p "$RUNS_DIR"
export CB_RUNS_DIR="$RUNS_DIR"

CMD_STATUS=
CMD_STDOUT=
CMD_STDERR=

# shellcheck disable=SC2016
cb_write_fake "$FAKE" '#!/usr/bin/env bash
set -u
input=
output=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --input) input=$2; shift 2 ;;
    --output) output=$2; shift 2 ;;
    *) shift ;;
  esac
done
run_dir=$(jq -r ".paths.run_dir" "$input")
role=$(jq -r ".role" "$input")
step=$(jq -r ".step_id" "$input")
attempt=$(jq -r ".attempt" "$input")
candidate=$(jq -r ".candidate_sha // empty" "$input")
mode=$(jq -r ".config.mode" "$input")
if [ "$mode" = stdin-reader ]; then
  IFS= read -r _ || true
fi
jq -c "{step_id:.step_id,attempt:.attempt,candidate_sha:.candidate_sha,prior_artifacts:.prior_artifacts}" \
  "$input" >>"$run_dir/calls.jsonl"

base="{
  schema:\"combo.step-output/v1\",
  run_id:$(jq -c ".run_id" "$input"),
  step_id:$(jq -c ".step_id" "$input"),
  role:$(jq -c ".role" "$input"),
  attempt:$attempt,
  artifacts:[],
  reasons:[],
  errors:[]
}"
case "$role:$mode" in
  launcher:*)
    jq -n "$base + {
      exit_class:\"completed\",
      events:[{code:0,event:\"launch_ready\",payload:{
        worktree:\"/worktree\",branch:\"combo/test\",
        base_sha:\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",
        runway_kind:\"fake\",lease_id:\"fake-lease\"
      }}]
    }" >"$output"
    ;;
  coder:technical)
    exit 42
    ;;
  coder:cancelled)
    jq -n "$base + {
      exit_class:\"cancelled\",events:[],
      reasons:[\"operator_cancelled\"]
    }" >"$output"
    ;;
  coder:*)
    sha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
    [ "$attempt" -eq 1 ] || sha=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
    jq -n --arg sha "$sha" "$base + {
      exit_class:\"completed\",
      events:[{code:0,event:\"coder_ready\",payload:{
        sha:\$sha,branch:\"combo/test\"
      }}]
    }" >"$output"
    ;;
  reviewer:correction)
    if [ "$candidate" = aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ] \
      && [ "$step" = reviewer/review-a ]; then
      finding="artifacts/review-a-round-1.md"
      printf "change requested\n" >"$run_dir/$finding"
      jq -n --arg sha "$candidate" --arg finding "$finding" "$base + {
        exit_class:\"completed\",
        events:[{code:1,event:\"needs_change\",payload:{
          sha:\$sha,artifact:\$finding
        }}],
        artifacts:[{id:\"review-a-findings\",path:\$finding}]
      }" >"$output"
    else
      jq -n --arg sha "$candidate" "$base + {
        exit_class:\"completed\",
        events:[{code:0,event:\"lgtm\",payload:{sha:\$sha}}]
      }" >"$output"
    fi
    ;;
  reviewer:*)
    jq -n --arg sha "$candidate" "$base + {
      exit_class:\"completed\",
      events:[{code:0,event:\"lgtm\",payload:{sha:\$sha}}]
    }" >"$output"
    ;;
  gate:gate-failure)
    jq -n "$base + {
      exit_class:\"completed\",
      events:[{code:1,event:\"gate_failed\",payload:{
        reason:\"validation_failed\"
      }}]
    }" >"$output"
    ;;
  gate:*)
    jq -n --arg sha "$candidate" "$base + {
      exit_class:\"completed\",
      events:[{code:0,event:\"gate_ok\",payload:{
        outcome:\"validated\",sha:\$sha
      }}]
    }" >"$output"
    ;;
  cleaner:*)
    jq -n "$base + {
      exit_class:\"completed\",
      events:[{code:0,event:\"cleaned\",payload:{}}]
    }" >"$output"
    ;;
esac
'

write_config() {
  local path=$1 mode=$2 reviewers=${3:-'["review-a","review-b"]'}
  jq -n --arg fake "$FAKE" --arg mode "$mode" --argjson reviewers "$reviewers" '
    {
      schema:"combo.config/v1",
      adapters:{
        fake:{
          argv:[$fake],
          roles:["launcher","coder","reviewer","gate","cleaner"]
        }
      },
      roles:{
        launcher:{adapter:"fake",config:{mode:$mode}},
        coder:{adapter:"fake",config:{mode:$mode}},
        reviewers:[$reviewers[] | {
          id:.,adapter:"fake",config:{mode:$mode}
        }],
        gate:{adapter:"fake",config:{mode:$mode}},
        cleaner:{adapter:"fake",config:{mode:$mode}}
      }
    }
  ' >"$path"
}

make_run() {
  local run=$1 mode=$2 reviewers=${3:-'["review-a","review-b"]'}
  local run_dir="$RUNS_DIR/$run" config="$TMP_ROOT/$run.config.json"
  mkdir -p "$run_dir"
  write_config "$config" "$mode" "$reviewers"
  bash "$BIN/cb-plan.sh" "$run" --config "$config" >/dev/null \
    || fail "could not compile fixture plan for $run"
}

run_chain() {
  local run=$1
  local errfile="$TMP_ROOT/$run.err"
  CMD_STDOUT=$(bash "$BIN/cb-chain.sh" "$run" 2>"$errfile") \
    && CMD_STATUS=0 || CMD_STATUS=$?
  CMD_STDERR=$(cat "$errfile" 2>/dev/null || true)
}

call_steps() {
  jq -Rrs '[split("\n")[] | fromjson? | .step_id] | join(",")' "$1"
}

# -- 1/5 CORE · test_runs_success_path -- <- START HERE
test_runs_success_path() {
  local run=chain-success result calls before_result before_calls
  make_run "$run" success
  run_chain "$run"
  expect_code 0 "$CMD_STATUS" "success chain${CMD_STDERR:+: $CMD_STDERR}"
  result=$CMD_STDOUT
  calls="$RUNS_DIR/$run/calls.jsonl"
  [ "$result" = "$RUNS_DIR/$run/chain-result.json" ] \
    || fail "chain should print its immutable result path"
  [ "$(call_steps "$calls")" = \
    "launcher,coder,reviewer/review-a,reviewer/review-b,gate,cleaner" ] \
    || fail "chain should follow the frozen plan order"
  jq -e --arg sha "$SHA_A" '
    .schema=="combo.chain-result/v1" and .run_id=="chain-success" and
    .exit_class=="completed" and .candidate_sha==$sha and
    .terminal=={role:"gate",code:0,event:"gate_ok"} and
    .cleanup=={exit_class:"completed",code:0,event:"cleaned",reasons:[],errors:[]}
  ' "$result" >/dev/null || fail "success should publish the normalized Gate and Cleaner outcome"
  before_result=$(cat "$result")
  before_calls=$(wc -l <"$calls")
  run_chain "$run"
  expect_code 73 "$CMD_STATUS" "chain result collision"
  [ "$(cat "$result")" = "$before_result" ] \
    || fail "an existing chain result must remain byte-identical"
  [ "$(wc -l <"$calls")" -eq "$before_calls" ] \
    || fail "an existing chain result must block before another adapter runs"
  pass "cb-chain: follows Launcher, Coder, every Reviewer, Gate, and Cleaner"
}
# -/ 1/5

# -- 2/5 CORE · test_closes_adapter_stdin --
test_closes_adapter_stdin() {
  local run=chain-stdin-reader calls="$RUNS_DIR/chain-stdin-reader/calls.jsonl"
  make_run "$run" stdin-reader
  run_chain "$run"
  expect_code 0 "$CMD_STATUS" "stdin-reading adapter chain${CMD_STDERR:+: $CMD_STDERR}"
  [ "$(call_steps "$calls")" = \
    "launcher,coder,reviewer/review-a,reviewer/review-b,gate,cleaner" ] \
    || fail "adapters must not consume the Reviewer traversal stream"
  pass "cb-chain: closes stdin for every adapter without skipping Reviewers"
}
# -/ 2/5

# -- 3/5 CORE · test_restarts_review_round --
test_restarts_review_round() {
  local run=chain-correction calls="$RUNS_DIR/chain-correction/calls.jsonl"
  make_run "$run" correction
  run_chain "$run"
  expect_code 0 "$CMD_STATUS" "correction chain${CMD_STDERR:+: $CMD_STDERR}"
  [ "$(call_steps "$calls")" = \
    "launcher,coder,reviewer/review-a,reviewer/review-b,coder,reviewer/review-a,reviewer/review-b,gate,cleaner" ] \
    || fail "needs-change should finish the round, then restart all reviewers after Coder"
  jq -e --arg a "$SHA_A" --arg b "$SHA_B" '
    select(.step_id=="coder" and .attempt==2) |
    .candidate_sha==$a and
    .prior_artifacts==[{id:"review-a-findings",path:"artifacts/review-a-round-1.md"}]
  ' "$calls" >/dev/null || fail "correcting Coder should receive the rejected SHA and findings"
  jq -e --arg b "$SHA_B" '
    select(.step_id=="reviewer/review-a" and .attempt==2) |
    .candidate_sha==$b
  ' "$calls" >/dev/null || fail "the next Reviewer round should start from member one on the new SHA"
  jq -e --arg b "$SHA_B" '
    select(.step_id=="gate") | .candidate_sha==$b
  ' "$calls" >/dev/null || fail "Gate should receive only the unanimously approved SHA"
  pass "cb-chain: loops only Reviewer needs-change back through Coder and restarts the full array"
}
# -/ 3/5

# -- 4/5 CORE · test_normalizes_terminal_paths --
test_normalizes_terminal_paths() {
  local run result
  run=chain-technical
  make_run "$run" technical
  run_chain "$run"
  expect_code 70 "$CMD_STATUS" "technical adapter failure"
  result=$CMD_STDOUT
  [ "$(call_steps "$RUNS_DIR/$run/calls.jsonl")" = "launcher,coder,cleaner" ] \
    || fail "technical failure should route directly to Cleaner"
  jq -e '
    .exit_class=="technical_error" and
    .terminal=={role:"coder",code:null,event:null} and
    .errors==["adapter_exit:42"] and .cleanup.event=="cleaned"
  ' "$result" >/dev/null || fail "technical error should be preserved independently from cleanup"

  run=chain-cancelled
  make_run "$run" cancelled
  run_chain "$run"
  expect_code 130 "$CMD_STATUS" "normalized cancellation"
  result=$CMD_STDOUT
  [ "$(call_steps "$RUNS_DIR/$run/calls.jsonl")" = "launcher,coder,cleaner" ] \
    || fail "cancellation should route directly to Cleaner"
  jq -e '
    .exit_class=="cancelled" and
    .terminal=={role:"coder",code:null,event:null} and
    .reasons==["operator_cancelled"] and .cleanup.event=="cleaned"
  ' "$result" >/dev/null || fail "cancellation should be preserved independently from cleanup"
  pass "cb-chain: preserves normalized technical and cancelled terminal classes"
}
# -/ 4/5

# -- 5/5 CORE · test_handles_plan_edges --
test_handles_plan_edges() {
  local run result
  run=chain-empty-reviewers
  make_run "$run" success '[]'
  run_chain "$run"
  expect_code 0 "$CMD_STATUS" "empty Reviewer plan${CMD_STDERR:+: $CMD_STDERR}"
  [ "$(call_steps "$RUNS_DIR/$run/calls.jsonl")" = "launcher,coder,gate,cleaner" ] \
    || fail "empty Reviewer plan should advance directly from Coder to Gate"

  run=chain-gate-failure
  make_run "$run" gate-failure
  run_chain "$run"
  expect_code 1 "$CMD_STATUS" "terminal Gate failure"
  result=$CMD_STDOUT
  [ "$(call_steps "$RUNS_DIR/$run/calls.jsonl")" = \
    "launcher,coder,reviewer/review-a,reviewer/review-b,gate,cleaner" ] \
    || fail "Cleaner must execute after a terminal Gate failure"
  jq -e '
    .exit_class=="completed" and
    .terminal=={role:"gate",code:1,event:"gate_failed"} and
    .reasons==["validation_failed"] and .cleanup.event=="cleaned"
  ' "$result" >/dev/null || fail "failed Gate and successful cleanup should both remain observable"
  pass "cb-chain: handles zero Reviewers and always cleans after terminal Gate"
}
# -/ 5/5

test_runs_success_path
test_closes_adapter_stdin
test_restarts_review_round
test_normalizes_terminal_paths
test_handles_plan_edges

printf '\nchain-state-machine: all tests passed\n'
