#!/usr/bin/env bash
# @overview Contract tests for the universal Combo step-adapter boundary.
#   Proves immutable run-local inputs/results, argv-safe configured execution,
#   closed adapter stdin, role-specific 0/1 outcomes, normalized failures, and
#   pre-execution guards.
#
#   READING GUIDE
#   -------------
#   1. test_invokes_with_universal_envelope <- canonical input/output contract.
#   2. test_closes_adapter_stdin             <- process I/O ownership boundary.
#   3. test_accepts_role_outcomes            <- allowed 0/1 product matrix.
#   4. test_normalizes_non_product_exits     <- technical/cancelled classes.
#   5. test_rejects_unsafe_invocations       <- artifacts, paths, collisions.
#
#   MAIN FLOW
#   ---------
#   immutable plan -> cb-step.sh -> configured argv -> validated result.json
#
#   PUBLIC API
#   ----------
#   none
#
#   INTERNALS
#   ---------
#   write_config, make_planned_run, run_step, run_step_with_stdin
#
# @exports none
# @deps bash, jq, tests/lib.sh, bin/cb-plan.sh, bin/cb-step.sh
set -u

# shellcheck source=tests/lib.sh disable=SC1091
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

BIN="$ROOT/bin"
TMP_ROOT=
cb_tmproot TMP_ROOT cb-step-contract
RUNS_DIR="$TMP_ROOT/runs"
FAKE="$TMP_ROOT/fake-step-adapter"
CAPTURE="$TMP_ROOT/captured-input.json"
MARKER="$TMP_ROOT/adapter-ran"
VICTIM="$TMP_ROOT/result-temp-victim"
STDIN_CAPTURE="$TMP_ROOT/stdin-capture"
mkdir -p "$RUNS_DIR"
export CB_RUNS_DIR="$RUNS_DIR"
export CB_STEP_TEST_CAPTURE="$CAPTURE"
export CB_STEP_TEST_MARKER="$MARKER"
export CB_STEP_TEST_VICTIM="$VICTIM"
export CB_STEP_TEST_STDIN_CAPTURE="$STDIN_CAPTURE"

SHA_A=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
REAL_MKDIR=$(command -v mkdir)
REAL_JQ=$(command -v jq)

CMD_STATUS=
CMD_STDOUT=
CMD_STDERR=

cb_write_fake "$FAKE" '#!/usr/bin/env bash
set -u
input=
output=
adapter_exit=0
adapter_sleep=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --input) input=$2; shift 2 ;;
    --output) output=$2; shift 2 ;;
    *) shift ;;
  esac
done
touch "$CB_STEP_TEST_MARKER"
cp "$input" "$CB_STEP_TEST_CAPTURE"
if [ "$(jq -r ".config.read_stdin // false" "$input")" = true ]; then
  if IFS= read -r caller_input; then
    printf "consumed:%s\n" "$caller_input" >"$CB_STEP_TEST_STDIN_CAPTURE"
  else
    printf "closed\n" >"$CB_STEP_TEST_STDIN_CAPTURE"
  fi
fi
adapter_sleep=$(jq -r ".config.adapter_sleep // 0" "$input")
[ "$adapter_sleep" -eq 0 ] || sleep "$adapter_sleep"
adapter_exit=$(jq -r ".config.adapter_exit // 0" "$input")
if [ "$adapter_exit" -ne 0 ]; then
  exit "$adapter_exit"
fi
if [ "$(jq -r ".config.poison_result // false" "$input")" = true ]; then
  printf "forged\n" >"$(dirname "$output")/result.json"
fi
if [ "$(jq -r ".config.poison_result_tmp // false" "$input")" = true ]; then
  ln -s "$CB_STEP_TEST_VICTIM" "$(dirname "$output")/.result.json.tmp"
fi
jq -c "
  . as \$input |
  \$input.config.outcome + {
    schema:\"combo.step-output/v1\",
    run_id:\$input.run_id,
    step_id:\$input.step_id,
    role:\$input.role,
    attempt:\$input.attempt
  }
" "$input" >"$output"
'

write_config() {
  local path=$1
  jq -n --arg fake "$FAKE" '
    def outcome($event; $code; $payload):
      {
        outcome: {
          exit_class:"completed",
          events:[{code:$code,event:$event,payload:$payload}],
          artifacts:[],
          reasons:[],
          errors:[]
        }
      };
    {
      schema:"combo.config/v1",
      adapters:{
        launcher:{argv:[$fake,"literal argument with spaces"],roles:["launcher"]},
        coder:{argv:[$fake,"literal argument with spaces"],roles:["coder"]},
        reviewer:{argv:[$fake,"literal argument with spaces"],roles:["reviewer"]},
        gate:{argv:[$fake,"literal argument with spaces"],roles:["gate"]},
        cleaner:{argv:[$fake,"literal argument with spaces"],roles:["cleaner"]}
      },
      roles:{
        launcher:{adapter:"launcher",config:outcome("launch_ready";0;{
          worktree:"/worktree",branch:"combo/test",base_sha:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          runway_kind:"treehouse",lease_id:"test"
        })},
        coder:{adapter:"coder",config:outcome("coder_ready";0;{
          sha:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",branch:"combo/test"
        })},
        reviewers:[{id:"review-a",adapter:"reviewer",config:outcome("lgtm";0;{
          sha:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        })}],
        gate:{adapter:"gate",config:outcome("gate_ok";0;{
          outcome:"validated",sha:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        })},
        cleaner:{adapter:"cleaner",config:outcome("cleaned";0;{})}
      }
    }
  ' >"$path"
}

make_planned_run() {
  local run=$1
  local config="$TMP_ROOT/$run.config.json"
  mkdir -p "$RUNS_DIR/$run"
  write_config "$config"
  sh "$BIN/cb-plan.sh" "$run" --config "$config" >/dev/null \
    || fail "could not compile fixture plan for $run"
}

run_step() {
  local run=$1 step=$2 attempt=$3
  shift 3
  local errfile="$TMP_ROOT/.step.err"
  CMD_STDOUT=$(bash "$BIN/cb-step.sh" "$run" "$step" "$attempt" "$@" 2>"$errfile") \
    && CMD_STATUS=0 || CMD_STATUS=$?
  CMD_STDERR=$(cat "$errfile" 2>/dev/null || true)
}

run_step_with_stdin() {
  local stdin_value=$1 run=$2 step=$3 attempt=$4
  shift 4
  local errfile="$TMP_ROOT/.step.err"
  CMD_STDOUT=$(printf '%s\n' "$stdin_value" \
    | bash "$BIN/cb-step.sh" "$run" "$step" "$attempt" "$@" 2>"$errfile") \
    && CMD_STATUS=0 || CMD_STATUS=$?
  CMD_STDERR=$(cat "$errfile" 2>/dev/null || true)
}

# -- 1/5 CORE · test_invokes_with_universal_envelope -- <- START HERE
test_invokes_with_universal_envelope() {
  local run=step-envelope prior result input
  make_planned_run "$run"
  mkdir -p "$RUNS_DIR/$run/artifacts"
  printf 'review findings\n' >"$RUNS_DIR/$run/artifacts/findings.md"
  prior='[{"id":"findings","path":"artifacts/findings.md"}]'

  run_step "$run" coder 1 --candidate-sha "$SHA_A" --prior-artifacts "$prior"
  expect_code 0 "$CMD_STATUS" "valid adapter invocation${CMD_STDERR:+: $CMD_STDERR}"
  result=$CMD_STDOUT
  input="$RUNS_DIR/$run/steps/02-coder/attempt-1/input.json"
  [ "$result" = "$RUNS_DIR/$run/steps/02-coder/attempt-1/result.json" ] \
    || fail "cb-step should print the immutable result path"
  assert_present "$input" "step input should be published"
  assert_present "$result" "step result should be published"
  [ "$(cb_file_mode "$input")" = "444" ] || fail "step input should be read-only"
  [ "$(cb_file_mode "$result")" = "444" ] || fail "step result should be read-only"

  jq -e --arg run "$run" --arg root "$RUNS_DIR/$run" --arg sha "$SHA_A" '
    .schema=="combo.step-input/v1" and
    .run_id==$run and .step_id=="coder" and .adapter_id=="coder" and
    .role=="coder" and .attempt==1 and .candidate_sha==$sha and
    .config.outcome.events[0].event=="coder_ready" and
    .prior_artifacts==[{id:"findings",path:"artifacts/findings.md"}] and
    .paths=={
      run_dir:$root,
      artifacts_dir:($root+"/artifacts"),
      steps_dir:($root+"/steps"),
      invocation_dir:($root+"/steps/02-coder/attempt-1"),
      input_path:($root+"/steps/02-coder/attempt-1/input.json"),
      output_path:($root+"/steps/02-coder/attempt-1/adapter-output.json")
    } and
    (keys==["adapter_id","attempt","candidate_sha","config","paths","prior_artifacts","role","run_id","schema","step_id"])
  ' "$CAPTURE" >/dev/null || fail "adapter should receive the exact universal input envelope"
  jq -e '
    .schema=="combo.step-output/v1" and .exit_class=="completed" and
    .events==[{code:0,event:"coder_ready",payload:{
      sha:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",branch:"combo/test"
    }}] and .artifacts==[] and .reasons==[] and .errors==[]
  ' "$result" >/dev/null || fail "validated result should preserve normalized adapter output"
  pass "cb-step: invokes configured argv with an immutable universal envelope"
}
# -/ 1/5

# -- 2/5 CORE · test_closes_adapter_stdin --
test_closes_adapter_stdin() {
  local run=step-stdin-closed
  make_planned_run "$run"
  chmod u+w "$RUNS_DIR/$run/plan.json"
  jq '(.steps[] | select(.id=="coder") | .config.read_stdin) = true' \
    "$RUNS_DIR/$run/plan.json" >"$RUNS_DIR/$run/.plan.tmp"
  mv "$RUNS_DIR/$run/.plan.tmp" "$RUNS_DIR/$run/plan.json"
  chmod 0444 "$RUNS_DIR/$run/plan.json"

  run_step_with_stdin caller-secret "$run" coder 1
  expect_code 0 "$CMD_STATUS" "stdin-closing adapter invocation${CMD_STDERR:+: $CMD_STDERR}"
  [ "$(cat "$STDIN_CAPTURE")" = closed ] \
    || fail "cb-step must prevent adapters from consuming caller stdin"
  pass "cb-step: closes adapter stdin at the universal process boundary"
}
# -/ 2/5

# -- 3/5 CORE · test_accepts_role_outcomes --
test_accepts_role_outcomes() {
  local run=step-role-outcomes spec step args result
  make_planned_run "$run"
  while IFS='|' read -r step args; do
    # shellcheck disable=SC2086
    run_step "$run" "$step" 1 $args
    expect_code 0 "$CMD_STATUS" "$step allowed outcome${CMD_STDERR:+: $CMD_STDERR}"
    result=$CMD_STDOUT
    jq -e '.exit_class=="completed" and (.events|length)==1' "$result" >/dev/null \
      || fail "$step should publish one completed product event"
  done <<EOF
launcher|
coder|--candidate-sha $SHA_A
reviewer/review-a|--candidate-sha $SHA_A
gate|--candidate-sha $SHA_A
cleaner|--candidate-sha $SHA_A
EOF

  run='step-needs-change'
  make_planned_run "$run"
  chmod u+w "$RUNS_DIR/$run/plan.json"
  jq '
    (.steps[] | select(.id=="launcher") | .config.outcome.events) = [{
      code:1,event:"launch_not_ready",payload:{reasons:["runway_unavailable"]}
    }] |
    (.steps[] | select(.id=="coder") | .config.outcome.events) = [{
      code:1,event:"coder_not_ready",payload:{errors:["candidate_missing"]}
    }] |
    (.steps[] | select(.id=="reviewer/review-a") | .config.outcome.events) = [{
      code:1,event:"needs_change",payload:{
        sha:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",artifact:"artifacts/findings.md"
      }
    }] |
    (.steps[] | select(.id=="gate") | .config.outcome.events) = [{
      code:1,event:"gate_failed",payload:{reason:"validation_failed"}
    }] |
    (.steps[] | select(.id=="cleaner") | .config.outcome.events) = [{
      code:1,event:"clean_failed",payload:{reasons:["custody_active"]}
    }]
  ' "$RUNS_DIR/$run/plan.json" >"$RUNS_DIR/$run/.plan.tmp"
  mv "$RUNS_DIR/$run/.plan.tmp" "$RUNS_DIR/$run/plan.json"
  chmod 0444 "$RUNS_DIR/$run/plan.json"
  mkdir -p "$RUNS_DIR/$run/artifacts"
  printf 'change request\n' >"$RUNS_DIR/$run/artifacts/findings.md"
  while IFS='|' read -r step event args; do
    # shellcheck disable=SC2086
    run_step "$run" "$step" 1 $args
    expect_code 0 "$CMD_STATUS" "$step code-1 outcome${CMD_STDERR:+: $CMD_STDERR}"
    jq -e --arg event "$event" '
      .exit_class=="completed" and
      .events[0].code==1 and .events[0].event==$event
    ' "$CMD_STDOUT" >/dev/null || fail "$step code 1 should remain normalized $event"
  done <<EOF
launcher|launch_not_ready|
coder|coder_not_ready|--candidate-sha $SHA_A
reviewer/review-a|needs_change|--candidate-sha $SHA_A
gate|gate_failed|--candidate-sha $SHA_A
cleaner|clean_failed|--candidate-sha $SHA_A
EOF
  pass "cb-step: accepts only the role-specific 0/1 product outcome matrix"
}
# -/ 3/5

# -- 4/5 CORE · test_normalizes_non_product_exits --
test_normalizes_non_product_exits() {
  local run=step-technical result
  make_planned_run "$run"
  chmod u+w "$RUNS_DIR/$run/plan.json"
  jq '(.steps[] | select(.id=="coder") | .config.adapter_exit) = 42' \
    "$RUNS_DIR/$run/plan.json" >"$RUNS_DIR/$run/.plan.tmp"
  mv "$RUNS_DIR/$run/.plan.tmp" "$RUNS_DIR/$run/plan.json"
  chmod 0444 "$RUNS_DIR/$run/plan.json"

  run_step "$run" coder 1
  expect_code 0 "$CMD_STATUS" "adapter process error should normalize${CMD_STDERR:+: $CMD_STDERR}"
  result=$CMD_STDOUT
  jq -e '
    .exit_class=="technical_error" and .events==[] and .artifacts==[] and
    .reasons==[] and .errors==["adapter_exit:42"]
  ' "$result" >/dev/null || fail "nonzero adapter exit should become technical_error"

  run='step-cancelled'
  make_planned_run "$run"
  chmod u+w "$RUNS_DIR/$run/plan.json"
  jq '(.steps[] | select(.id=="coder") | .config.outcome) = {
    exit_class:"cancelled",events:[],artifacts:[],
    reasons:["operator_cancelled"],errors:[]
  }' "$RUNS_DIR/$run/plan.json" >"$RUNS_DIR/$run/.plan.tmp"
  mv "$RUNS_DIR/$run/.plan.tmp" "$RUNS_DIR/$run/plan.json"
  chmod 0444 "$RUNS_DIR/$run/plan.json"
  run_step "$run" coder 1
  expect_code 0 "$CMD_STATUS" "normalized cancellation${CMD_STDERR:+: $CMD_STDERR}"
  jq -e '.exit_class=="cancelled" and .reasons==["operator_cancelled"]' "$CMD_STDOUT" >/dev/null \
    || fail "cancelled output should remain a normalized terminal class"

  run='step-invalid-output'
  make_planned_run "$run"
  chmod u+w "$RUNS_DIR/$run/plan.json"
  jq '(.steps[] | select(.id=="reviewer/review-a") | .config.outcome.events) = [{
    code:0,event:"coder_ready",payload:{
      sha:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",branch:"combo/test"
    }
  }]' "$RUNS_DIR/$run/plan.json" >"$RUNS_DIR/$run/.plan.tmp"
  mv "$RUNS_DIR/$run/.plan.tmp" "$RUNS_DIR/$run/plan.json"
  chmod 0444 "$RUNS_DIR/$run/plan.json"
  run_step "$run" reviewer/review-a 1 --candidate-sha "$SHA_A"
  expect_code 0 "$CMD_STATUS" "invalid role output should normalize${CMD_STDERR:+: $CMD_STDERR}"
  jq -e '
    .exit_class=="technical_error" and .events==[] and
    .errors==["adapter_output:invalid"]
  ' "$CMD_STDOUT" >/dev/null || fail "cross-role event should become technical_error"

  run='step-newline-artifact'
  make_planned_run "$run"
  mkdir -p "$RUNS_DIR/$run/artifacts"
  printf 'findings\n' >"$RUNS_DIR/$run/artifacts/findings.md"
  chmod u+w "$RUNS_DIR/$run/plan.json"
  jq '(.steps[] | select(.id=="reviewer/review-a") |
    .config.outcome.events[0]) = {
      code:1,event:"needs_change",payload:{
        sha:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        artifact:"artifacts/findings.md\n"
      }
    }' "$RUNS_DIR/$run/plan.json" >"$RUNS_DIR/$run/.plan.tmp"
  mv "$RUNS_DIR/$run/.plan.tmp" "$RUNS_DIR/$run/plan.json"
  chmod 0444 "$RUNS_DIR/$run/plan.json"
  run_step "$run" reviewer/review-a 1 --candidate-sha "$SHA_A"
  expect_code 0 "$CMD_STATUS" "control character artifact should normalize${CMD_STDERR:+: $CMD_STDERR}"
  jq -e '
    .exit_class=="technical_error" and .events==[] and
    .errors==["adapter_output:invalid"]
  ' "$CMD_STDOUT" >/dev/null || fail "raw newline artifact path should be rejected"

  run='step-timeout'
  make_planned_run "$run"
  chmod u+w "$RUNS_DIR/$run/plan.json"
  jq '(.steps[] | select(.id=="coder") | .config.adapter_sleep) = 2' \
    "$RUNS_DIR/$run/plan.json" >"$RUNS_DIR/$run/.plan.tmp"
  mv "$RUNS_DIR/$run/.plan.tmp" "$RUNS_DIR/$run/plan.json"
  chmod 0444 "$RUNS_DIR/$run/plan.json"
  export CB_STEP_TIMEOUT_SECONDS=1
  run_step "$run" coder 1
  unset CB_STEP_TIMEOUT_SECONDS
  expect_code 0 "$CMD_STATUS" "adapter timeout should normalize${CMD_STDERR:+: $CMD_STDERR}"
  jq -e '
    .exit_class=="cancelled" and .events==[] and
    .reasons==["adapter_timeout:1"]
  ' "$CMD_STDOUT" >/dev/null || fail "timeout should become a normalized cancellation"
  pass "cb-step: normalizes process errors, invalid outputs, cancellation, and timeout"
}
# -/ 4/5

# -- 5/5 CORE · test_rejects_unsafe_invocations --
test_rejects_unsafe_invocations() {
  local run='step-directory-race' outside="$TMP_ROOT/outside"
  local fakebin="$TMP_ROOT/race-bin" barrier="$TMP_ROOT/mkdir-barrier"
  local out1="$TMP_ROOT/race-1.out" out2="$TMP_ROOT/race-2.out"
  local err1="$TMP_ROOT/race-1.err" err2="$TMP_ROOT/race-2.err"
  local pid1 pid2 status1 status2
  make_planned_run "$run"
  "$REAL_MKDIR" -p "$fakebin" "$barrier"
  cb_write_fake "$fakebin/mkdir" "#!/usr/bin/env bash
wait_for_peer() {
  peer=\$1
  attempts=200
  while [ ! -e \"\$peer\" ]; do
    if [ \"\$attempts\" -eq 0 ]; then
      echo \"barrier peer did not arrive: \$peer\" >&2
      exit 75
    fi
    attempts=\$((attempts - 1))
    sleep 0.01
  done
}
target=\${!#}
if [ \"\$target\" = \"$RUNS_DIR/$run/artifacts\" ]; then
  if \"$REAL_MKDIR\" \"$barrier/first\" 2>/dev/null; then
    touch \"$barrier/first-arrived\"
    wait_for_peer \"$barrier/second-arrived\"
  else
    touch \"$barrier/second-arrived\"
    wait_for_peer \"$barrier/first-arrived\"
  fi
fi
exec \"$REAL_MKDIR\" \"\$@\"
"
  PATH="$fakebin:$PATH" bash "$BIN/cb-step.sh" "$run" coder 1 >"$out1" 2>"$err1" &
  pid1=$!
  PATH="$fakebin:$PATH" bash "$BIN/cb-step.sh" "$run" coder 2 >"$out2" 2>"$err2" &
  pid2=$!
  wait "$pid1" && status1=0 || status1=$?
  wait "$pid2" && status2=0 || status2=$?
  expect_code 0 "$status1" "first concurrent attempt$(cat "$err1")"
  expect_code 0 "$status2" "second concurrent attempt$(cat "$err2")"
  assert_present "$(cat "$out1")" "first concurrent result should be published"
  assert_present "$(cat "$out2")" "second concurrent result should be published"

  run='step-argv-truncated'
  make_planned_run "$run"
  local jq_fakebin="$TMP_ROOT/jq-race-bin"
  "$REAL_MKDIR" -p "$jq_fakebin"
  cb_write_fake "$jq_fakebin/jq" "#!/usr/bin/env bash
if [ \"\${1:-}\" = -j ]; then
  \"$REAL_JQ\" -j '.argv[0] + \"\\u0000\"'
  exit 42
fi
exec \"$REAL_JQ\" \"\$@\"
"
  rm -f "$MARKER"
  PATH="$jq_fakebin:$PATH" run_step "$run" coder 1
  [ "$CMD_STATUS" -ne 0 ] || fail "truncated adapter argv should fail"
  assert_absent "$MARKER" "truncated argv must fail before adapter execution"

  run='step-guards'
  make_planned_run "$run"
  mkdir -p "$outside"
  rm -f "$MARKER"
  run_step "$run" coder 1 --prior-artifacts '[{"id":"escape","path":"../outside"}]'
  [ "$CMD_STATUS" -ne 0 ] || fail "traversal prior artifact should fail"
  assert_absent "$MARKER" "invalid prior artifacts must fail before adapter execution"

  run_step "$run" coder 01
  expect_code 64 "$CMD_STATUS" "leading-zero attempt"
  assert_absent "$MARKER" "non-canonical attempts must fail before adapter execution"

  chmod u+w "$RUNS_DIR/$run/plan.json"
  jq --arg outside "$outside" '.paths.steps_dir=$outside' \
    "$RUNS_DIR/$run/plan.json" >"$RUNS_DIR/$run/.plan.tmp"
  mv "$RUNS_DIR/$run/.plan.tmp" "$RUNS_DIR/$run/plan.json"
  chmod 0444 "$RUNS_DIR/$run/plan.json"
  run_step "$run" coder 1
  [ "$CMD_STATUS" -ne 0 ] || fail "escaped plan paths should fail"
  assert_absent "$outside/02-coder" "escaped steps path must not be created"

  run='step-collision'
  make_planned_run "$run"
  run_step "$run" coder 1
  expect_code 0 "$CMD_STATUS" "first attempt"
  local result=$CMD_STDOUT before
  before=$(cb_file_sha256 "$result")
  [ -n "$before" ] || fail "could not digest the published result"
  run_step "$run" coder 1
  [ "$CMD_STATUS" -ne 0 ] || fail "attempt collision should fail"
  [ "$before" = "$(cb_file_sha256 "$result")" ] \
    || fail "attempt collision must preserve the existing result"

  run='step-result-poison'
  make_planned_run "$run"
  chmod u+w "$RUNS_DIR/$run/plan.json"
  jq '(.steps[] | select(.id=="coder") | .config.poison_result) = true' \
    "$RUNS_DIR/$run/plan.json" >"$RUNS_DIR/$run/.plan.tmp"
  mv "$RUNS_DIR/$run/.plan.tmp" "$RUNS_DIR/$run/plan.json"
  chmod 0444 "$RUNS_DIR/$run/plan.json"
  run_step "$run" coder 1
  expect_code 0 "$CMD_STATUS" "adapter result-path poisoning${CMD_STDERR:+: $CMD_STDERR}"
  jq -e '.schema=="combo.step-output/v1" and .exit_class=="completed"' "$CMD_STDOUT" >/dev/null \
    || fail "canonical result path must contain only the validated result"

  run='step-result-temp-poison'
  make_planned_run "$run"
  printf 'precious\n' >"$VICTIM"
  chmod u+w "$RUNS_DIR/$run/plan.json"
  jq '(.steps[] | select(.id=="coder") | .config.poison_result_tmp) = true' \
    "$RUNS_DIR/$run/plan.json" >"$RUNS_DIR/$run/.plan.tmp"
  mv "$RUNS_DIR/$run/.plan.tmp" "$RUNS_DIR/$run/plan.json"
  chmod 0444 "$RUNS_DIR/$run/plan.json"
  run_step "$run" coder 1
  expect_code 0 "$CMD_STATUS" "adapter result-temp poisoning${CMD_STDERR:+: $CMD_STDERR}"
  [ "$(cat "$VICTIM")" = precious ] || fail "result staging must not write through adapter symlinks"
  jq -e '.schema=="combo.step-output/v1" and .exit_class=="completed"' "$CMD_STDOUT" >/dev/null \
    || fail "temp-path poisoning must still publish only the validated result"
  pass "cb-step: rejects unsafe artifacts, paths, attempts, collisions, and result poisoning"
}
# -/ 5/5

test_invokes_with_universal_envelope
test_closes_adapter_stdin
test_accepts_role_outcomes
test_normalizes_non_product_exits
test_rejects_unsafe_invocations

printf '\nstep-adapter-contract: all tests passed\n'
