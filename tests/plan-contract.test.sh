#!/usr/bin/env bash
# @overview Contract tests for the immutable Combo v1 config-to-plan compiler.
#   Covers strict provider-neutral bindings, fixed role ordering, validated
#   Reviewer degradation, empty arrays, run-local publication, producer-failure
#   cleanup, and fail-closed collision/path handling.
#
#   READING GUIDE
#   -------------
#   1. test_compiles_immutable_plan  <- canonical config and exact plan shape.
#   2. test_accepts_reviewer_options <- zero members and fail/skip policy.
#   3. test_rejects_shared_adapter   <- Coder/Reviewer identity separation.
#   4. test_rejects_invalid_configs  <- registry/binding validation matrix.
#   5. test_rejects_path_attacks     <- containment and staging cleanup.
#
#   MAIN FLOW
#   ---------
#   fixture config -> cb-plan.sh -> immutable plan.json -> jq assertions
#
#   PUBLIC API
#   ----------
#   none
#
#   INTERNALS
#   ---------
#   write_config, run_plan, run_plan_with_staging_collision
#
# @exports none
# @deps bash, dash, jq, sha256sum/shasum, tests/lib.sh, bin/cb-plan.sh
set -u

# shellcheck source=tests/lib.sh disable=SC1091
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

BIN="$ROOT/bin"
TMP_ROOT=
cb_tmproot TMP_ROOT cb-plan-contract
RUNS_DIR="$TMP_ROOT/runs"
mkdir -p "$RUNS_DIR"
export CB_RUNS_DIR="$RUNS_DIR"

CMD_STATUS=
CMD_STDOUT=
CMD_STDERR=
COLLISION_PATH=

write_config() {
  local path=$1 reviewers=${2:-'[{"id":"review-a","adapter":"review-a","config":{"policy":"strict"}},{"id":"review-b","adapter":"review-b","config":{}}]'}
  local degraded=${3:-fail}
  jq -n --argjson reviewers "$reviewers" --arg degraded "$degraded" '
    {
      schema: "combo.config/v1",
      reviewer: {degraded:$degraded},
      adapters: {
        launcher: {argv:["fake-adapter","--mechanical"],roles:["launcher"]},
        coder: {argv:["fake-adapter","literal with spaces"],roles:["coder"]},
        "review-a": {argv:["fake-adapter","literal with spaces"],roles:["reviewer"]},
        "review-b": {argv:["other-adapter"],roles:["reviewer"]},
        gate: {argv:["fake-adapter","--gate"],roles:["gate"]},
        cleaner: {argv:["fake-adapter","--mechanical"],roles:["cleaner"]}
      },
      roles: {
        launcher: {adapter:"launcher",config:{runway:"fake"}},
        coder: {adapter:"coder",config:{strategy:"candidate"}},
        reviewers: $reviewers,
        gate: {adapter:"gate",config:{terminal_only:true}},
        cleaner: {adapter:"cleaner",config:{}}
      }
    }
  ' >"$path"
}

run_plan() {
  local run=$1 config=$2 errfile="$TMP_ROOT/.plan.err"
  CMD_STDOUT=$(sh "$BIN/cb-plan.sh" "$run" --config "$config" 2>"$errfile") \
    && CMD_STATUS=0 || CMD_STATUS=$?
  CMD_STDERR=$(cat "$errfile" 2>/dev/null || true)
}

run_plan_with_staging_collision() {
  local run=$1 config=$2 target=$3
  local dash_bin errfile="$TMP_ROOT/.${run}.err" pathfile="$TMP_ROOT/.${run}.path"
  dash_bin=$(command -v dash) || fail "dash is required for staging-collision coverage"

  CMD_STDOUT=$(
    "$dash_bin" -c '
      case "$2" in
        snapshot) collision=$CB_RUNS_DIR/$1/.config.snapshot.tmp ;;
        plan) collision=$CB_RUNS_DIR/$1/.plan.json.tmp.$$ ;;
        *) exit 64 ;;
      esac
      printf "existing\n" >"$collision"
      printf "%s\n" "$collision" >"$3"
      exec "$4" "$5" "$1" --config "$6"
    ' cb-plan-collision \
      "$run" "$target" "$pathfile" "$dash_bin" "$BIN/cb-plan.sh" "$config" \
      2>"$errfile"
  ) && CMD_STATUS=0 || CMD_STATUS=$?
  CMD_STDERR=$(cat "$errfile" 2>/dev/null || true)
  COLLISION_PATH=$(cat "$pathfile" 2>/dev/null || true)
}

# -- 1/5 CORE · test_compiles_immutable_plan -- <- START HERE
test_compiles_immutable_plan() {
  local run=plan-success run_dir config plan before
  local fallback_bin="$TMP_ROOT/fallback-bin"
  local real_shasum
  run_dir=$(cb_make_run "$run")
  config="$TMP_ROOT/config-success.json"
  plan="$run_dir/plan.json"
  write_config "$config"

  run_plan "$run" "$config"
  expect_code 0 "$CMD_STATUS" "valid plan compile${CMD_STDERR:+: $CMD_STDERR}"
  [ "$CMD_STDOUT" = "$plan" ] || fail "compiler should print the plan path"
  assert_present "$plan" "plan.json should be published"
  [ "$(cb_file_mode "$plan")" = "444" ] || fail "plan.json should be read-only"

  jq -e --arg run "$run" --arg dir "$run_dir" '
    .schema == "combo.run-plan/v1" and
    .run_id == $run and
    .paths == {
      run_dir:$dir,
      artifacts_dir:($dir + "/artifacts"),
      steps_dir:($dir + "/steps")
    } and
    ([.steps[].role] == ["launcher","coder","reviewer","reviewer","gate","cleaner"]) and
    ([.steps[] | select(.role=="reviewer") | .member_id] == ["review-a","review-b"]) and
    (.steps[1].adapter_id == "coder") and
    (.steps[1].argv == ["fake-adapter","literal with spaces"]) and
    (.steps[1].config == {strategy:"candidate"}) and
    (.steps[2].adapter_id == "review-a") and
    (.steps[2].argv == ["fake-adapter","literal with spaces"]) and
    (.steps[2].config == {policy:"strict"}) and
    (.reviewer == {degraded:"fail"}) and
    (.reviewer_count == 2) and
    (keys == ["paths","reviewer","reviewer_count","run_id","schema","steps"])
  ' "$plan" >/dev/null || fail "compiled plan shape should match the frozen contract"

  real_shasum=$(command -v shasum) || fail "shasum is required by the fallback regression"
  mkdir -p "$fallback_bin"
  cb_write_fake "$fallback_bin/sha256sum" '#!/bin/sh
exit 69
'
  cb_write_fake "$fallback_bin/shasum" "#!/bin/sh
exec \"$real_shasum\" \"\$@\"
"
  before=$(PATH="$fallback_bin:$PATH" cb_file_sha256 "$plan")
  [ -n "$before" ] || fail "digest fallback must produce a non-empty hash"
  printf '{"schema":"mutated"}\n' >"$config"
  [ "$(jq -r '.schema' "$plan")" = "combo.run-plan/v1" ] \
    || fail "plan must not depend on the source config after publication"

  run_plan "$run" "$config"
  expect_code 73 "$CMD_STATUS" "existing plan collision"
  [ "$before" = "$(PATH="$fallback_bin:$PATH" cb_file_sha256 "$plan")" ] \
    || fail "existing plan must remain byte-identical"
  pass "cb-plan: publishes one immutable, collision-safe provider-neutral run plan"
}
# -/ 1/5

# -- 2/5 CORE · test_accepts_reviewer_options --
test_accepts_reviewer_options() {
  local run=plan-empty run_dir config plan default_run default_dir default_config
  run_dir=$(cb_make_run "$run")
  config="$TMP_ROOT/config-empty.json"
  plan="$run_dir/plan.json"
  write_config "$config" '[]' skip

  run_plan "$run" "$config"
  expect_code 0 "$CMD_STATUS" "empty reviewers${CMD_STDERR:+: $CMD_STDERR}"
  jq -e '
    .reviewer == {degraded:"skip"} and
    .reviewer_count == 0 and
    ([.steps[].role] == ["launcher","coder","gate","cleaner"]) and
    ([.steps[] | select(.role=="reviewer")] | length == 0)
  ' "$plan" >/dev/null || fail "empty Reviewer array should compile directly from Coder to Gate"

  default_run='plan-default-degraded'
  default_dir=$(cb_make_run "$default_run")
  default_config="$TMP_ROOT/config-default-degraded.json"
  write_config "$default_config"
  jq 'del(.reviewer)' "$default_config" >"$TMP_ROOT/config-default-degraded.tmp"
  mv "$TMP_ROOT/config-default-degraded.tmp" "$default_config"
  run_plan "$default_run" "$default_config"
  expect_code 0 "$CMD_STATUS" "default Reviewer policy${CMD_STDERR:+: $CMD_STDERR}"
  jq -e '.reviewer == {degraded:"fail"}' "$default_dir/plan.json" >/dev/null \
    || fail "omitted Reviewer degradation policy should default to fail"
  pass "cb-plan: validates fail/skip policy and accepts zero Reviewer members"
}
# -/ 2/5

# -- 3/5 CORE · test_rejects_shared_adapter --
test_rejects_shared_adapter() {
  local run=plan-shared-adapter run_dir config
  run_dir=$(cb_make_run "$run")
  config="$TMP_ROOT/config-shared-adapter.json"
  write_config "$config"
  jq '
    .adapters.coder.roles = ["coder","reviewer"] |
    .roles.reviewers[0].adapter = "coder"
  ' "$config" >"$TMP_ROOT/config-shared-adapter.tmp"
  mv "$TMP_ROOT/config-shared-adapter.tmp" "$config"

  run_plan "$run" "$config"
  expect_code 64 "$CMD_STATUS" "shared Coder/Reviewer adapter"
  assert_absent "$run_dir/plan.json" \
    "a Reviewer sharing the Coder adapter ID must not publish a plan"
  pass "cb-plan: rejects a Reviewer configured with the Coder adapter ID"
}
# -/ 3/5

# -- 4/5 CORE · test_rejects_invalid_configs --
test_rejects_invalid_configs() {
  local base="$TMP_ROOT/config-invalid-base.json" index=0 mutation run run_dir config marker
  write_config "$base"
  marker="$TMP_ROOT/adapter-executed"
  local fake="$TMP_ROOT/fake-adapter"
  # shellcheck disable=SC2016
  printf '#!/bin/sh\ntouch "$CB_PLAN_TEST_MARKER"\n' >"$fake"
  chmod +x "$fake"

  while IFS= read -r mutation; do
    index=$((index + 1))
    run="invalid-$index"
    run_dir=$(cb_make_run "$run")
    config="$TMP_ROOT/config-invalid-$index.json"
    jq --arg fake "$fake" "$mutation | .adapters.launcher.argv[0] = \$fake" "$base" >"$config"
    CB_PLAN_TEST_MARKER="$marker" run_plan "$run" "$config"
    expect_code 64 "$CMD_STATUS" "invalid config case $index"
    assert_absent "$run_dir/plan.json" "invalid config must not publish a plan (case $index)"
  done <<'EOF'
.roles.coder.adapter = "missing"
.roles.gate.adapter = "coder"
.adapters.coder.argv = "fake-adapter"
.adapters.coder.roles = ["coder","coder"]
.roles.reviewers[1].id = "review-a"
.roles.coder.config = []
.reviewer.degraded = "ignore"
.reviewer.extra = true
.extra = true
EOF

  assert_absent "$marker" "config validation must never execute an adapter"
  pass "cb-plan: rejects malformed registries, incompatible bindings, and duplicate members"
}
# -/ 4/5

# -- 5/5 CORE · test_rejects_path_attacks --
test_rejects_path_attacks() {
  local outside="$TMP_ROOT/outside" config="$TMP_ROOT/config-paths.json"
  local producer_bin real_jq errfile
  mkdir -p "$outside"
  write_config "$config"

  ln -s "$outside" "$RUNS_DIR/symlink-run"
  run_plan symlink-run "$config"
  expect_code 73 "$CMD_STATUS" "symlink run directory"
  assert_absent "$outside/plan.json" "symlink run must not publish outside runs root"

  local run=config-link run_dir
  run_dir=$(cb_make_run "$run")
  ln -s "$config" "$TMP_ROOT/config-link.json"
  run_plan "$run" "$TMP_ROOT/config-link.json"
  expect_code 73 "$CMD_STATUS" "symlink config"
  assert_absent "$run_dir/plan.json" "symlink config must not publish a plan"

  run='plan-link'
  run_dir=$(cb_make_run "$run")
  local victim="$outside/victim"
  printf 'precious\n' >"$victim"
  ln -s "$victim" "$run_dir/plan.json"
  run_plan "$run" "$config"
  expect_code 73 "$CMD_STATUS" "symlink plan collision"
  [ "$(cat "$victim")" = "precious" ] || fail "plan symlink victim must remain unchanged"

  run='snapshot-collision'
  run_dir=$(cb_make_run "$run")
  run_plan_with_staging_collision "$run" "$config" snapshot
  expect_code 73 "$CMD_STATUS" "config snapshot collision under dash"
  assert_contains "$CMD_STDERR" "config snapshot path already exists" \
    "dash must reach the explicit snapshot-collision fallback"
  [ "$(cat "$COLLISION_PATH")" = "existing" ] \
    || fail "config snapshot collision must preserve the existing file"
  assert_absent "$run_dir/plan.json" "snapshot collision must not publish a plan"

  run='plan-staging-collision'
  run_dir=$(cb_make_run "$run")
  run_plan_with_staging_collision "$run" "$config" plan
  expect_code 73 "$CMD_STATUS" "plan staging collision under dash"
  assert_contains "$CMD_STDERR" "plan staging path already exists" \
    "dash must reach the explicit plan-staging fallback"
  [ "$(cat "$COLLISION_PATH")" = "existing" ] \
    || fail "plan staging collision must preserve the existing file"
  assert_absent "$run_dir/plan.json" "staging collision must not publish a plan"

  run='snapshot-producer-failure'
  run_dir=$(cb_make_run "$run")
  producer_bin="$TMP_ROOT/snapshot-producer-bin"
  mkdir -p "$producer_bin"
  cb_write_fake "$producer_bin/cat" '#!/bin/sh
printf partial
exit 69
'
  errfile="$TMP_ROOT/.snapshot-producer.err"
  CMD_STDOUT=$(env PATH="$producer_bin:$PATH" \
    sh "$BIN/cb-plan.sh" "$run" --config "$config" 2>"$errfile") \
    && CMD_STATUS=0 || CMD_STATUS=$?
  CMD_STDERR=$(cat "$errfile" 2>/dev/null || true)
  expect_code 73 "$CMD_STATUS" "config snapshot producer failure"
  assert_absent "$run_dir/.config.snapshot.tmp" \
    "failed config producer must not strand its staging file"
  run_plan "$run" "$config"
  expect_code 0 "$CMD_STATUS" "retry after config producer failure"

  run='plan-producer-failure'
  run_dir=$(cb_make_run "$run")
  producer_bin="$TMP_ROOT/plan-producer-bin"
  real_jq=$(command -v jq) || fail "jq is required"
  mkdir -p "$producer_bin"
  cb_write_fake "$producer_bin/jq" "#!/bin/sh
case \" \$* \" in
  *\" --arg run \"*) printf '{\"partial\":'; exit 69 ;;
esac
exec \"$real_jq\" \"\$@\"
"
  errfile="$TMP_ROOT/.plan-producer.err"
  CMD_STDOUT=$(env PATH="$producer_bin:$PATH" \
    sh "$BIN/cb-plan.sh" "$run" --config "$config" 2>"$errfile") \
    && CMD_STATUS=0 || CMD_STATUS=$?
  CMD_STDERR=$(cat "$errfile" 2>/dev/null || true)
  expect_code 73 "$CMD_STATUS" "plan producer failure"
  assert_absent "$run_dir/.config.snapshot.tmp" \
    "failed plan producer must clean the config snapshot"
  if compgen -G "$run_dir/.plan.json.tmp.*" >/dev/null; then
    fail "failed plan producer must not strand its staging file"
  fi
  run_plan "$run" "$config"
  expect_code 0 "$CMD_STATUS" "retry after plan producer failure"
  pass "cb-plan: contains run-local publication and rejects config/plan symlinks"
}
# -/ 5/5

test_compiles_immutable_plan
test_accepts_reviewer_options
test_rejects_shared_adapter
test_rejects_invalid_configs
test_rejects_path_attacks

printf '\nplan-contract: all tests passed\n'
