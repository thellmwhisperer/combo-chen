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
#   6. test_native_end_envelopes             <- Launcher/Cleaner P4 failures.
#   7. test_cleaner_security_contracts       <- latest Gate + safe staging.
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
#   write_config, make_planned_run, run_step, run_step_with_stdin,
#   test_native_end_envelopes, make_cleaner_security_fixture,
#   write_gate_terminal, write_cleaner_seal, run_cleaner_adapter,
#   assert_cleaner_rejects_without_release, test_cleaner_latest_gate_attempt,
#   test_cleaner_unpredictable_staging, test_cleaner_security_contracts
#
# @exports none
# @deps bash, git, jq, tests/lib.sh, bin/cb-plan.sh, bin/cb-step.sh,
#   bin/cb-cleaner-adapter.sh
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
REAL_REALPATH=$(command -v realpath)

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

# -- 1/7 CORE · test_invokes_with_universal_envelope -- <- START HERE
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
# -/ 1/7

# -- 2/7 CORE · test_closes_adapter_stdin --
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
# -/ 2/7

# -- 3/7 CORE · test_accepts_role_outcomes --
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
# -/ 3/7

# -- 4/7 CORE · test_normalizes_non_product_exits --
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
# -/ 4/7

# -- 5/7 CORE · test_rejects_unsafe_invocations --
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
# -/ 5/7

# -- 6/7 CORE · test_native_end_envelopes --
test_native_end_envelopes() {
  local run=step-native-launcher result combined
  make_planned_run "$run"
  chmod u+w "$RUNS_DIR/$run/plan.json"
  jq --arg adapter "$BIN/cb-launcher-adapter.sh" '
    (.steps[] | select(.id=="launcher") | .argv) = [$adapter] |
    (.steps[] | select(.id=="launcher") | .config) = {
      schema:"combo.launcher/treehouse/v1",
      repo_dir:"/definitely-missing-combo-repository",
      base_ref:"main",
      setup_command:"",
      readiness:{
        required_seats:["coder"],
        seats:[{id:"coder",harness:"sh",auth_cmd:"exit 0"}]
      }
    }
  ' "$RUNS_DIR/$run/plan.json" >"$RUNS_DIR/$run/.plan.tmp"
  mv "$RUNS_DIR/$run/.plan.tmp" "$RUNS_DIR/$run/plan.json"
  chmod 0444 "$RUNS_DIR/$run/plan.json"

  run_step_with_stdin native-secret "$run" launcher 1
  expect_code 0 "$CMD_STATUS" \
    "native Launcher envelope failure${CMD_STDERR:+: $CMD_STDERR}"
  result=$CMD_STDOUT
  jq -e '
    .exit_class=="completed" and
    .events==[{code:1,event:"launch_not_ready",payload:{
      reasons:["repo:missing_or_unsafe"]
    }}]
  ' <"$result" >/dev/null \
    || fail "native Launcher should normalize a non-vacuous P4 failure"
  combined=$(cat "$RUNS_DIR/$run/steps/01-launcher/attempt-1/stdout.log" \
    "$RUNS_DIR/$run/steps/01-launcher/attempt-1/stderr.log")
  assert_not_contains "$combined" native-secret \
    "native Launcher must not consume caller stdin"

  run='step-native-cleaner'
  make_planned_run "$run"
  chmod u+w "$RUNS_DIR/$run/plan.json"
  jq --arg adapter "$BIN/cb-cleaner-adapter.sh" '
    (.steps[] | select(.id=="cleaner") | .argv) = [$adapter] |
    (.steps[] | select(.id=="cleaner") | .config) = {
      schema:"combo.cleaner/treehouse/v1"
    }
  ' "$RUNS_DIR/$run/plan.json" >"$RUNS_DIR/$run/.plan.tmp"
  mv "$RUNS_DIR/$run/.plan.tmp" "$RUNS_DIR/$run/plan.json"
  chmod 0444 "$RUNS_DIR/$run/plan.json"

  run_step_with_stdin native-secret "$run" cleaner 1
  expect_code 0 "$CMD_STATUS" \
    "native Cleaner envelope failure${CMD_STDERR:+: $CMD_STDERR}"
  jq -e '
    .exit_class=="completed" and
    .events==[{code:1,event:"clean_failed",payload:{
      reasons:["ownership:missing_or_unsafe"]
    }}]
  ' <"$CMD_STDOUT" >/dev/null \
    || fail "native Cleaner should normalize a non-vacuous P4 failure: $(cat "$CMD_STDOUT"); adapter stderr: $(cat "$RUNS_DIR/$run/steps/05-cleaner/attempt-1/stderr.log")"
  combined=$(cat "$RUNS_DIR/$run/steps/05-cleaner/attempt-1/stdout.log" \
    "$RUNS_DIR/$run/steps/05-cleaner/attempt-1/stderr.log")
  assert_not_contains "$combined" native-secret \
    "native Cleaner must not consume caller stdin"
  pass "native Launcher/Cleaner: honor P4 envelopes with isolated failures"
}
# -/ 6/7

# -- 7/7 CORE · test_cleaner_security_contracts --
CLEANER_FAKE_BIN="$TMP_ROOT/cleaner-fake-bin"
CLEANER_INPUT=
CLEANER_OUTPUT=
CLEANER_RUN_ROOT=
CLEANER_WORKTREE=
CLEANER_RETURN_CALLS=

mkdir -p "$CLEANER_FAKE_BIN"
cb_write_fake "$CLEANER_FAKE_BIN/treehouse" '#!/bin/sh
case "${1:-}" in
  status)
    printf "alpha leased %s (held by %s)\n" \
      "$CB_CLEANER_TEST_WORKTREE" "$CB_CLEANER_TEST_RUN"
    ;;
  return)
    printf "%s\n" "${2:-}" >>"$CB_CLEANER_TEST_RETURN_CALLS"
    ;;
  *)
    exit 64
    ;;
esac
'

make_cleaner_security_fixture() {
  local run=$1 fixture repo base invocation ownership
  fixture="$TMP_ROOT/cleaner-$run"
  repo="$fixture/repo"
  CLEANER_RUN_ROOT="$RUNS_DIR/$run"
  CLEANER_WORKTREE="$fixture/worktree"
  CLEANER_RETURN_CALLS="$fixture/treehouse-return.calls"
  invocation="$CLEANER_RUN_ROOT/steps/05-cleaner/attempt-1"
  CLEANER_INPUT="$invocation/input.json"
  CLEANER_OUTPUT="$invocation/adapter-output.json"
  mkdir -p "$repo" "$CLEANER_RUN_ROOT/agents" \
    "$CLEANER_RUN_ROOT/steps/04-gate" "$invocation"
  git -C "$repo" init -q -b main
  git -C "$repo" config user.name "Cleaner Security Test"
  git -C "$repo" config user.email "cleaner-security@example.test"
  printf 'base\n' >"$repo/file.txt"
  git -C "$repo" add file.txt
  git -C "$repo" commit -qm "fixture base"
  base=$(git -C "$repo" rev-parse HEAD)
  git -C "$repo" worktree add -q -b "combo/$run" \
    "$CLEANER_WORKTREE" "$base"
  ownership="$CLEANER_RUN_ROOT/agents/launcher.ownership.json"
  jq -cn \
    --arg run "$run" --arg repo "$repo" --arg worktree "$CLEANER_WORKTREE" \
    --arg branch "combo/$run" --arg base "$base" '
      {
        run:$run,runway_kind:"treehouse",repo_dir:$repo,
        worktree:$worktree,branch:$branch,base_sha:$base,lease_id:$run
      }
    ' >"$ownership"
  chmod 0444 "$ownership"
  {
    printf "CB_REPO_DIR='%s'\n" "$repo"
    printf "CB_CLEAN_CUSTODY_CMD='exit 0'\n"
  } >"$CLEANER_RUN_ROOT/config.env"
  jq -cn \
    --arg run "$run" --arg input "$CLEANER_INPUT" \
    --arg output "$CLEANER_OUTPUT" --arg root "$CLEANER_RUN_ROOT" \
    --arg invocation "$invocation" '
      {
        schema:"combo.step-input/v1",run_id:$run,step_id:"cleaner",
        adapter_id:"cleaner",role:"cleaner",attempt:1,candidate_sha:null,
        config:{schema:"combo.cleaner/treehouse/v1"},
        prior_artifacts:[],
        paths:{
          run_dir:$root,artifacts_dir:($root+"/artifacts"),
          steps_dir:($root+"/steps"),invocation_dir:$invocation,
          input_path:$input,output_path:$output
        }
      }
    ' >"$CLEANER_INPUT"
  chmod 0444 "$CLEANER_INPUT"
}

write_gate_terminal() {
  local attempt=$1 event=${2:-gate_failed}
  local attempt_dir="$CLEANER_RUN_ROOT/steps/04-gate/attempt-$attempt"
  mkdir -p "$attempt_dir"
  if [ "$event" = gate_failed ]; then
    jq -cn \
      --arg run "${CLEANER_RUN_ROOT##*/}" --argjson attempt "$attempt" '
        {
          schema:"combo.step-output/v1",run_id:$run,step_id:"gate",
          role:"gate",attempt:$attempt,exit_class:"completed",
          events:[{code:1,event:"gate_failed",payload:{reason:"fixture"}}],
          artifacts:[],reasons:[],errors:[]
        }
      ' >"$attempt_dir/result.json"
  else
    jq -cn \
      --arg run "${CLEANER_RUN_ROOT##*/}" --argjson attempt "$attempt" \
      --arg event "$event" '
        {
          schema:"combo.step-output/v1",run_id:$run,step_id:"gate",
          role:"gate",attempt:$attempt,exit_class:"completed",
          events:[{code:0,event:$event,payload:{}}],
          artifacts:[],reasons:[],errors:[]
        }
      ' >"$attempt_dir/result.json"
  fi
  chmod 0444 "$attempt_dir/result.json"
}

write_cleaner_seal() {
  local ownership="$CLEANER_RUN_ROOT/agents/launcher.ownership.json"
  jq -c '. + {released:true,reasons:[]} | del(.lease_id)' "$ownership" \
    >"$CLEANER_RUN_ROOT/agents/cleaner.ownership.json"
  chmod 0444 "$CLEANER_RUN_ROOT/agents/cleaner.ownership.json"
}

run_cleaner_adapter() {
  local extra_path=${1:-} err="$TMP_ROOT/cleaner-adapter.err"
  local run="${CLEANER_RUN_ROOT##*/}"
  CMD_STDOUT=$(
    PATH="${extra_path:+$extra_path:}$CLEANER_FAKE_BIN:$PATH" \
      CB_RUNS_DIR="$RUNS_DIR" \
      CB_CLEANER_TEST_RUN="$run" \
      CB_CLEANER_TEST_WORKTREE="$CLEANER_WORKTREE" \
      CB_CLEANER_TEST_RETURN_CALLS="$CLEANER_RETURN_CALLS" \
      bash "$BIN/cb-cleaner-adapter.sh" \
        --input "$CLEANER_INPUT" --output "$CLEANER_OUTPUT" 2>"$err"
  ) && CMD_STATUS=0 || CMD_STATUS=$?
  CMD_STDERR=$(cat "$err" 2>/dev/null || true)
}

assert_cleaner_rejects_without_release() {
  run_cleaner_adapter "${1:-}"
  expect_code 0 "$CMD_STATUS" \
    "Cleaner rejection should normalize${CMD_STDERR:+: $CMD_STDERR}"
  jq -e '
    .exit_class=="completed" and
    .events[0].code==1 and .events[0].event=="clean_failed" and
    (.events[0].payload.reasons[0] | startswith("gate:"))
  ' "$CLEANER_OUTPUT" >/dev/null \
    || fail "Cleaner did not reject unsafe latest Gate custody"
  assert_absent "$CLEANER_RETURN_CALLS" \
    "Cleaner released Treehouse custody after rejecting Gate evidence"
  assert_present "$CLEANER_WORKTREE" \
    "Cleaner removed the worktree after rejecting Gate evidence"
}

test_cleaner_latest_gate_attempt() {
  local attempt target race_bin replacement

  make_cleaner_security_fixture cleaner-inflight-latest
  write_gate_terminal 1
  mkdir "$CLEANER_RUN_ROOT/steps/04-gate/attempt-2"
  assert_cleaner_rejects_without_release

  make_cleaner_security_fixture cleaner-numeric-latest
  for attempt in 1 2 3 4 5 6 7 8 9; do
    write_gate_terminal "$attempt"
  done
  write_gate_terminal 10 lgtm
  assert_cleaner_rejects_without_release

  make_cleaner_security_fixture cleaner-gap
  write_gate_terminal 1
  write_gate_terminal 3
  assert_cleaner_rejects_without_release

  make_cleaner_security_fixture cleaner-malformed-latest
  write_gate_terminal 1
  mkdir "$CLEANER_RUN_ROOT/steps/04-gate/attempt-2"
  printf 'not-json\n' \
    >"$CLEANER_RUN_ROOT/steps/04-gate/attempt-2/result.json"
  chmod 0444 "$CLEANER_RUN_ROOT/steps/04-gate/attempt-2/result.json"
  assert_cleaner_rejects_without_release

  make_cleaner_security_fixture cleaner-symlink-latest
  write_gate_terminal 1
  mkdir "$CLEANER_RUN_ROOT/steps/04-gate/attempt-2"
  target="$TMP_ROOT/symlinked-gate-result.json"
  printf '{}\n' >"$target"
  ln -s "$target" \
    "$CLEANER_RUN_ROOT/steps/04-gate/attempt-2/result.json"
  assert_cleaner_rejects_without_release

  make_cleaner_security_fixture cleaner-nonterminal-latest
  write_gate_terminal 1
  write_gate_terminal 2 lgtm
  assert_cleaner_rejects_without_release

  make_cleaner_security_fixture cleaner-replaced-latest
  write_gate_terminal 1
  target="$CLEANER_RUN_ROOT/steps/04-gate/attempt-1/result.json"
  replacement="$TMP_ROOT/replacement-gate-result.json"
  jq '.events[0].event="lgtm"' "$target" >"$replacement"
  chmod 0444 "$replacement"
  race_bin="$TMP_ROOT/cleaner-race-bin"
  mkdir "$race_bin"
  cb_write_fake "$race_bin/jq" '#!/usr/bin/env bash
target=${CB_CLEANER_TEST_RACE_TARGET:-}
last=${!#}
if [ -n "$target" ] && [ "$last" = "$target" ] \
  && [ ! -e "$CB_CLEANER_TEST_RACE_DONE" ]; then
  "$CB_CLEANER_TEST_REAL_JQ" "$@"
  code=$?
  if [ "$code" -eq 0 ]; then
    mv "$CB_CLEANER_TEST_RACE_REPLACEMENT" "$target"
    touch "$CB_CLEANER_TEST_RACE_DONE"
  fi
  exit "$code"
fi
exec "$CB_CLEANER_TEST_REAL_JQ" "$@"
'
  export CB_CLEANER_TEST_RACE_TARGET="$target"
  export CB_CLEANER_TEST_RACE_REPLACEMENT="$replacement"
  export CB_CLEANER_TEST_RACE_DONE="$TMP_ROOT/cleaner-race.done"
  export CB_CLEANER_TEST_REAL_JQ="$REAL_JQ"
  assert_cleaner_rejects_without_release "$race_bin"
  unset CB_CLEANER_TEST_RACE_TARGET CB_CLEANER_TEST_RACE_REPLACEMENT
  unset CB_CLEANER_TEST_RACE_DONE CB_CLEANER_TEST_REAL_JQ

  pass "native Cleaner: only the immutable highest numeric Gate attempt authorizes release"
}

test_cleaner_unpredictable_staging() {
  local run pid status ready release poison victim blocker_bin
  local out="$TMP_ROOT/cleaner-pid.out" err="$TMP_ROOT/cleaner-pid.err"

  make_cleaner_security_fixture cleaner-pid-guess
  write_gate_terminal 1
  write_cleaner_seal
  run="${CLEANER_RUN_ROOT##*/}"
  ready="$TMP_ROOT/cleaner-realpath.ready"
  release="$TMP_ROOT/cleaner-realpath.release"
  blocker_bin="$TMP_ROOT/cleaner-realpath-bin"
  mkdir "$blocker_bin"
  cb_write_fake "$blocker_bin/realpath" '#!/bin/sh
touch "$CB_CLEANER_TEST_BLOCK_READY"
while [ ! -e "$CB_CLEANER_TEST_BLOCK_RELEASE" ]; do sleep 0.01; done
exec "$CB_CLEANER_TEST_REAL_REALPATH" "$@"
'
  PATH="$blocker_bin:$CLEANER_FAKE_BIN:$PATH" \
    CB_RUNS_DIR="$RUNS_DIR" \
    CB_CLEANER_TEST_RUN="$run" \
    CB_CLEANER_TEST_WORKTREE="$CLEANER_WORKTREE" \
    CB_CLEANER_TEST_RETURN_CALLS="$CLEANER_RETURN_CALLS" \
    CB_CLEANER_TEST_BLOCK_READY="$ready" \
    CB_CLEANER_TEST_BLOCK_RELEASE="$release" \
    CB_CLEANER_TEST_REAL_REALPATH="$REAL_REALPATH" \
    bash "$BIN/cb-cleaner-adapter.sh" \
      --input "$CLEANER_INPUT" --output "$CLEANER_OUTPUT" \
      >"$out" 2>"$err" &
  pid=$!
  while [ ! -e "$ready" ]; do sleep 0.01; done
  victim="$TMP_ROOT/cleaner-pid-victim"
  poison="$CLEANER_RUN_ROOT/steps/05-cleaner/attempt-1/.cleaner-adapter-output.$pid"
  ln -s "$victim" "$poison"
  touch "$release"
  wait "$pid" && status=0 || status=$?
  expect_code 0 "$status" "PID-guess staging attack$(cat "$err")"
  jq -e '.events[0].event=="cleaned"' "$CLEANER_OUTPUT" >/dev/null \
    || fail "PID-guess staging attack poisoned the Cleaner outcome"
  assert_symlink "$poison" "Cleaner replaced the attacker-owned PID symlink"
  assert_absent "$victim" "Cleaner wrote through the attacker-owned PID symlink"
  rm -f "$poison"

  make_cleaner_security_fixture cleaner-interrupted-stage
  write_gate_terminal 1
  write_cleaner_seal
  run="${CLEANER_RUN_ROOT##*/}"
  ready="$TMP_ROOT/cleaner-jq.ready"
  release="$TMP_ROOT/cleaner-jq.release"
  blocker_bin="$TMP_ROOT/cleaner-jq-bin"
  mkdir "$blocker_bin"
  cb_write_fake "$blocker_bin/jq" '#!/usr/bin/env bash
for argument in "$@"; do
  case "$argument" in
    *combo.step-output/v1*)
      touch "$CB_CLEANER_TEST_BLOCK_READY"
      while [ ! -e "$CB_CLEANER_TEST_BLOCK_RELEASE" ]; do sleep 0.01; done
      break
      ;;
  esac
done
exec "$CB_CLEANER_TEST_REAL_JQ" "$@"
'
  PATH="$blocker_bin:$CLEANER_FAKE_BIN:$PATH" \
    CB_RUNS_DIR="$RUNS_DIR" \
    CB_CLEANER_TEST_RUN="$run" \
    CB_CLEANER_TEST_WORKTREE="$CLEANER_WORKTREE" \
    CB_CLEANER_TEST_RETURN_CALLS="$CLEANER_RETURN_CALLS" \
    CB_CLEANER_TEST_BLOCK_READY="$ready" \
    CB_CLEANER_TEST_BLOCK_RELEASE="$release" \
    CB_CLEANER_TEST_REAL_JQ="$REAL_JQ" \
    bash "$BIN/cb-cleaner-adapter.sh" \
      --input "$CLEANER_INPUT" --output "$CLEANER_OUTPUT" \
      >"$out" 2>"$err" &
  pid=$!
  while [ ! -e "$ready" ]; do sleep 0.01; done
  kill -TERM "$pid"
  touch "$release"
  wait "$pid" && status=0 || status=$?
  [ "$status" -ne 0 ] || fail "interrupted Cleaner staging unexpectedly succeeded"
  assert_absent "$CLEANER_OUTPUT" \
    "interrupted Cleaner staging published an authoritative output"
  if find "$CLEANER_RUN_ROOT/steps/05-cleaner/attempt-1" -maxdepth 1 \
    -name '.cleaner-adapter-output.*' -print -quit | grep . >/dev/null; then
    fail "interrupted Cleaner staging poisoned a future invocation"
  fi
  run_cleaner_adapter
  expect_code 0 "$CMD_STATUS" \
    "Cleaner retry after interruption${CMD_STDERR:+: $CMD_STDERR}"
  jq -e '.events[0].event=="cleaned"' "$CLEANER_OUTPUT" >/dev/null \
    || fail "Cleaner retry after interrupted staging did not converge"

  pass "native Cleaner: unpredictable owned staging survives PID guesses and interruption"
}

test_cleaner_security_contracts() {
  test_cleaner_latest_gate_attempt
  test_cleaner_unpredictable_staging
}
# -/ 7/7

case "${CB_STEP_ADAPTER_SECURITY_ONLY:-}" in
  latest-gate)
    test_cleaner_latest_gate_attempt
    exit 0
    ;;
  staging)
    test_cleaner_unpredictable_staging
    exit 0
    ;;
esac

test_invokes_with_universal_envelope
test_closes_adapter_stdin
test_accepts_role_outcomes
test_normalizes_non_product_exits
test_rejects_unsafe_invocations
test_native_end_envelopes
test_cleaner_security_contracts

printf '\nstep-adapter-contract: all tests passed\n'
