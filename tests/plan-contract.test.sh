#!/usr/bin/env bash
# @overview Contract tests for the immutable Combo v1 config-to-plan compiler.
#   Covers strict provider-neutral bindings, fixed role ordering, empty Reviewer
#   arrays, run-local publication, and fail-closed collision/path handling.
#
#   READING GUIDE
#   -------------
#   1. test_compiles_immutable_plan  <- canonical config and exact plan shape.
#   2. test_accepts_empty_reviewers  <- zero-member Reviewer contract.
#   3. test_rejects_invalid_configs  <- registry/binding validation matrix.
#   4. test_rejects_path_attacks     <- run/config/plan containment.
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
#   make_run, write_config, run_plan, plan_mode
#
# @exports none
# @deps bash, jq, tests/lib.sh, bin/cb-plan.sh
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

make_run() {
  mkdir -p "$RUNS_DIR/$1"
  printf '%s/%s\n' "$RUNS_DIR" "$1"
}

write_config() {
  local path=$1 reviewers=${2:-'[{"id":"review-a","adapter":"shared","config":{"policy":"strict"}},{"id":"review-b","adapter":"review-b","config":{}}]'}
  jq -n --argjson reviewers "$reviewers" '
    {
      schema: "combo.config/v1",
      adapters: {
        launcher: {argv:["fake-adapter","--mechanical"],roles:["launcher"]},
        shared: {argv:["fake-adapter","literal with spaces"],roles:["coder","reviewer"]},
        "review-b": {argv:["other-adapter"],roles:["reviewer"]},
        gate: {argv:["fake-adapter","--gate"],roles:["gate"]},
        cleaner: {argv:["fake-adapter","--mechanical"],roles:["cleaner"]}
      },
      roles: {
        launcher: {adapter:"launcher",config:{runway:"fake"}},
        coder: {adapter:"shared",config:{strategy:"candidate"}},
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

plan_mode() {
  stat -f '%Lp' "$1" 2>/dev/null || stat -c '%a' "$1"
}

# -- 1/4 CORE · test_compiles_immutable_plan -- <- START HERE
test_compiles_immutable_plan() {
  local run=plan-success run_dir config plan before
  run_dir=$(make_run "$run")
  config="$TMP_ROOT/config-success.json"
  plan="$run_dir/plan.json"
  write_config "$config"

  run_plan "$run" "$config"
  expect_code 0 "$CMD_STATUS" "valid plan compile${CMD_STDERR:+: $CMD_STDERR}"
  [ "$CMD_STDOUT" = "$plan" ] || fail "compiler should print the plan path"
  assert_present "$plan" "plan.json should be published"
  [ "$(plan_mode "$plan")" = "444" ] || fail "plan.json should be read-only"

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
    (.steps[1].adapter_id == "shared") and
    (.steps[1].argv == ["fake-adapter","literal with spaces"]) and
    (.steps[1].config == {strategy:"candidate"}) and
    (.steps[2].config == {policy:"strict"}) and
    (.reviewer_count == 2) and
    (keys == ["paths","reviewer_count","run_id","schema","steps"])
  ' "$plan" >/dev/null || fail "compiled plan shape should match the frozen contract"

  before=$(sha256sum "$plan" 2>/dev/null | awk '{print $1}' || shasum -a 256 "$plan" | awk '{print $1}')
  printf '{"schema":"mutated"}\n' >"$config"
  [ "$(jq -r '.schema' "$plan")" = "combo.run-plan/v1" ] \
    || fail "plan must not depend on the source config after publication"

  run_plan "$run" "$config"
  expect_code 73 "$CMD_STATUS" "existing plan collision"
  [ "$before" = "$(sha256sum "$plan" 2>/dev/null | awk '{print $1}' || shasum -a 256 "$plan" | awk '{print $1}')" ] \
    || fail "existing plan must remain byte-identical"
  pass "cb-plan: publishes one immutable, collision-safe provider-neutral run plan"
}
# -/ 1/4

# -- 2/4 CORE · test_accepts_empty_reviewers --
test_accepts_empty_reviewers() {
  local run=plan-empty run_dir config plan
  run_dir=$(make_run "$run")
  config="$TMP_ROOT/config-empty.json"
  plan="$run_dir/plan.json"
  write_config "$config" '[]'

  run_plan "$run" "$config"
  expect_code 0 "$CMD_STATUS" "empty reviewers${CMD_STDERR:+: $CMD_STDERR}"
  jq -e '
    .reviewer_count == 0 and
    ([.steps[].role] == ["launcher","coder","gate","cleaner"]) and
    ([.steps[] | select(.role=="reviewer")] | length == 0)
  ' "$plan" >/dev/null || fail "empty Reviewer array should compile directly from Coder to Gate"
  pass "cb-plan: accepts zero Reviewer members without a synthetic phase"
}
# -/ 2/4

# -- 3/4 CORE · test_rejects_invalid_configs --
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
    run_dir=$(make_run "$run")
    config="$TMP_ROOT/config-invalid-$index.json"
    jq --arg fake "$fake" "$mutation | .adapters.launcher.argv[0] = \$fake" "$base" >"$config"
    CB_PLAN_TEST_MARKER="$marker" run_plan "$run" "$config"
    expect_code 64 "$CMD_STATUS" "invalid config case $index"
    assert_absent "$run_dir/plan.json" "invalid config must not publish a plan (case $index)"
  done <<'EOF'
.roles.coder.adapter = "missing"
.roles.gate.adapter = "shared"
.adapters.shared.argv = "fake-adapter"
.adapters.shared.roles = ["coder","coder"]
.roles.reviewers[1].id = "review-a"
.roles.coder.config = []
.extra = true
EOF

  assert_absent "$marker" "config validation must never execute an adapter"
  pass "cb-plan: rejects malformed registries, incompatible bindings, and duplicate members"
}
# -/ 3/4

# -- 4/4 CORE · test_rejects_path_attacks --
test_rejects_path_attacks() {
  local outside="$TMP_ROOT/outside" config="$TMP_ROOT/config-paths.json"
  mkdir -p "$outside"
  write_config "$config"

  ln -s "$outside" "$RUNS_DIR/symlink-run"
  run_plan symlink-run "$config"
  expect_code 73 "$CMD_STATUS" "symlink run directory"
  assert_absent "$outside/plan.json" "symlink run must not publish outside runs root"

  local run=config-link run_dir
  run_dir=$(make_run "$run")
  ln -s "$config" "$TMP_ROOT/config-link.json"
  run_plan "$run" "$TMP_ROOT/config-link.json"
  expect_code 73 "$CMD_STATUS" "symlink config"
  assert_absent "$run_dir/plan.json" "symlink config must not publish a plan"

  run='plan-link'
  run_dir=$(make_run "$run")
  local victim="$outside/victim"
  printf 'precious\n' >"$victim"
  ln -s "$victim" "$run_dir/plan.json"
  run_plan "$run" "$config"
  expect_code 73 "$CMD_STATUS" "symlink plan collision"
  [ "$(cat "$victim")" = "precious" ] || fail "plan symlink victim must remain unchanged"
  pass "cb-plan: contains run-local publication and rejects config/plan symlinks"
}
# -/ 4/4

test_compiles_immutable_plan
test_accepts_empty_reviewers
test_rejects_invalid_configs
test_rejects_path_attacks

printf '\nplan-contract: all tests passed\n'
