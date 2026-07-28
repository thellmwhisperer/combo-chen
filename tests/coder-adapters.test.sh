#!/usr/bin/env bash
# @overview Contract and deterministic end-to-end tests for the P5 Coder
#   adapters. Proves plan-selected invocation sequences, direct-agent and GNHF
#   schema enforcement, git-fact normalization, artifact routing, isolated
#   environments, mandatory GNHF safety flags, and ordinary PATH-routed push
#   rejection without treating same-UID mode bits as an integrity boundary.
#
#   READING GUIDE
#   -------------
#   1. Fixture adapters and configs       <- executable universal-envelope setup.
#   2. test_compiles_coder_sequences      <- config-only adapter selection.
#   3. test_runs_gnhf_then_direct         <- required correction-loop E2E.
#   4. test_normalizes_not_ready          <- fail-closed config/git behavior.
#
#   MAIN FLOW
#   ---------
#   config -> plan sequence -> cb-chain/cb-step -> agent tool -> verified SHA
#
#   PUBLIC API
#   ----------
#   none
#
#   INTERNALS
#   ---------
#   make_repo, direct_binding, gnhf_binding, write_config, make_run,
#   run_chain, run_step, assert_coder_sequence
#
# @exports none
# @deps bash, git, jq, tests/lib.sh, bin/cb-plan.sh, bin/cb-step.sh,
#   bin/cb-chain.sh, bin/cb-agent-run.sh
set -u

# shellcheck source=tests/lib.sh disable=SC1091
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

BIN="$ROOT/bin"
TMP_ROOT=
cb_tmproot TMP_ROOT cb-coder-adapters
RUNS_DIR="$TMP_ROOT/runs"
ROLE_FAKE="$TMP_ROOT/role-adapter"
DIRECT_FAKE="$TMP_ROOT/direct-agent"
GNHF_FAKE="$TMP_ROOT/gnhf"
NOOP_FAKE="$TMP_ROOT/noop-agent"
EXECUTED_MARKER="$TMP_ROOT/agent-executed"
mkdir -p "$RUNS_DIR"
export CB_RUNS_DIR="$RUNS_DIR"

CMD_STATUS=
CMD_STDOUT=
CMD_STDERR=

# -- 1/4 HELPER · Fixture adapters, repositories, and plan configs --
# shellcheck disable=SC2016
cb_write_fake "$ROLE_FAKE" '#!/usr/bin/env bash
set -eu
input=
output=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --input) input=$2; shift 2 ;;
    --output) output=$2; shift 2 ;;
    *) exit 64 ;;
  esac
done
run_dir=$(jq -r ".paths.run_dir" "$input")
role=$(jq -r ".role" "$input")
attempt=$(jq -r ".attempt" "$input")
candidate=$(jq -r ".candidate_sha // empty" "$input")
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
case "$role" in
  launcher)
    jq -n "$base + {
      exit_class:\"completed\",
      events:[{code:0,event:\"launch_ready\",payload:{
        worktree:\"fixture\",branch:\"combo/fixture\",
        base_sha:\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",
        runway_kind:\"fake\",lease_id:\"fake-lease\"
      }}]
    }" >"$output"
    ;;
  reviewer)
    if [ "$attempt" -le 2 ]; then
      finding="artifacts/needs-change.md"
      printf "change requested by configured reviewer\n" >"$run_dir/$finding"
      jq -n --arg sha "$candidate" --arg finding "$finding" "$base + {
        exit_class:\"completed\",
        events:[{code:1,event:\"needs_change\",payload:{
          sha:\$sha,artifact:\$finding
        }}],
        artifacts:[{id:\"needs-change\",path:\$finding}]
      }" >"$output"
    else
      jq -n --arg sha "$candidate" "$base + {
        exit_class:\"completed\",
        events:[{code:0,event:\"lgtm\",payload:{sha:\$sha}}]
      }" >"$output"
    fi
    ;;
  gate)
    jq -n --arg sha "$candidate" "$base + {
      exit_class:\"completed\",
      events:[{code:0,event:\"gate_ok\",payload:{
        outcome:\"validated\",sha:\$sha
      }}]
    }" >"$output"
    ;;
  cleaner)
    jq -n "$base + {
      exit_class:\"completed\",
      events:[{code:0,event:\"cleaned\",payload:{}}]
    }" >"$output"
    ;;
esac
'

# The direct fake consumes the universal input path exported by the adapter.
# On correction attempts it refuses to commit unless the injected artifact is
# present and non-empty. It also attempts a push, which the adapter must block.
# shellcheck disable=SC2016
cb_write_fake "$DIRECT_FAKE" '#!/usr/bin/env bash
set -eu
[ -z "${CB_SHOULD_NOT_LEAK+x}" ] || exit 81
[ "${COMBO_CODER_ADAPTER_ID:-}" = direct-agent ] || exit 82
[ -z "${COMBO_CODER_REAL_GIT+x}" ] || exit 87
input=${COMBO_CODER_STEP_INPUT:?}
repo=${COMBO_CODER_WORKTREE:?}
run_dir=$(jq -r ".paths.run_dir" "$input")
attempt=$(jq -r ".attempt" "$input")
schema=$(jq -r ".config.schema" "$input")
[ "$schema" = "combo.coder/direct-agent/v1" ] || exit 83
guard_dir=${PATH%%:*}
# Mode bits catch accidental replacement but are owner-reversible. Prove that
# limitation, restore the installed mode, then exercise the supported contract.
chmod 0755 "$guard_dir" || exit 88
chmod 0555 "$guard_dir" || exit 89
if rm -f "$guard_dir/git" 2>/dev/null \
  && printf "#!/bin/sh\nexit 0\n" >"$guard_dir/git" 2>/dev/null; then
  exit 90
fi
if [ "$attempt" -gt 1 ]; then
  finding=$(jq -r ".prior_artifacts[] | select(.id==\"needs-change\") | .path" "$input")
  [ -s "$run_dir/$finding" ] || exit 84
  grep -F "change requested" "$run_dir/$finding" >/dev/null || exit 85
  : >"$run_dir/direct-consumed-findings"
fi
if git -C "$repo" push origin HEAD:refs/heads/forbidden >/dev/null 2>&1; then
  exit 86
fi
printf "direct attempt %s\n" "$attempt" >>"$repo/work.txt"
git -C "$repo" add work.txt
git -C "$repo" commit -qm "direct attempt $attempt"
printf "direct|%s|%s\n" "$attempt" "$*" >>"$run_dir/tool-calls"
'

# The GNHF fake verifies the safety flags assembled by the adapter. It behaves
# like a bounded Ralph loop by producing one clean local commit.
# shellcheck disable=SC2016
cb_write_fake "$GNHF_FAKE" '#!/usr/bin/env bash
set -eu
[ -z "${CB_SHOULD_NOT_LEAK+x}" ] || exit 91
[ "${COMBO_CODER_ADAPTER_ID:-}" = gnhf ] || exit 92
input=${COMBO_CODER_STEP_INPUT:?}
repo=${COMBO_CODER_WORKTREE:?}
run_dir=$(jq -r ".paths.run_dir" "$input")
attempt=$(jq -r ".attempt" "$input")
args=" $* "
case "$args" in *" --agent codex "*) ;; *) exit 93 ;; esac
case "$args" in *" --max-iterations 3 "*) ;; *) exit 94 ;; esac
case "$args" in *" --stop-when tests-and-lint-green "*) ;; *) exit 95 ;; esac
case "$args" in *" --prevent-sleep on "*) ;; *) exit 96 ;; esac
case "$args" in *" --meteor-frequency 0 "*) ;; *) exit 97 ;; esac
case "$args" in *" --current-branch "*) ;; *) exit 98 ;; esac
case "$args" in *" --push "*) exit 99 ;; esac
printf "gnhf attempt %s\n" "$attempt" >>"$repo/work.txt"
git -C "$repo" add work.txt
git -C "$repo" commit -qm "gnhf attempt $attempt"
printf "gnhf|%s|%s\n" "$attempt" "$*" >>"$run_dir/tool-calls"
'

cb_write_fake "$NOOP_FAKE" "#!/bin/sh
: >\"$EXECUTED_MARKER\"
exit 0
"

make_repo() {
  local repo=$1 remote=$2
  mkdir -p "$repo"
  git init -q -b main "$repo"
  git -C "$repo" config user.name "Combo P5 Test"
  git -C "$repo" config user.email "combo-p5@example.test"
  printf 'base\n' >"$repo/work.txt"
  git -C "$repo" add work.txt
  git -C "$repo" commit -qm "base"
  git init -q --bare "$remote"
  git -C "$repo" remote add origin "$remote"
  git -C "$repo" push -q -u origin main
}

direct_binding() {
  local repo=$1 base=$2 branch=$3 agent=${4:-"$DIRECT_FAKE"}
  jq -cn \
    --arg adapter direct-agent --arg repo "$repo" --arg base "$base" \
    --arg branch "$branch" --arg agent "$agent" '
      {
        adapter:$adapter,
        config:{
          schema:"combo.coder/direct-agent/v1",
          worktree:$repo,base_sha:$base,branch:$branch,
          argv:[$agent],prompt:"implement configured work",
          output_schema:"combo.step-output/v1",
          environment:{inherit:["PATH","HOME"],set:{}}
        }
      }
    '
}

gnhf_binding() {
  local repo=$1 base=$2 branch=$3 agent=${4:-"$GNHF_FAKE"}
  jq -cn \
    --arg adapter gnhf --arg repo "$repo" --arg base "$base" \
    --arg branch "$branch" --arg agent "$agent" '
      {
        adapter:$adapter,
        config:{
          schema:"combo.coder/gnhf/v1",
          worktree:$repo,base_sha:$base,branch:$branch,
          argv:[$agent],prompt:"run the configured Ralph loop",
          agent:"codex",max_iterations:3,
          stop_when:"tests-and-lint-green",
          prevent_sleep:"on",meteor_frequency:0,current_branch:true,
          output_schema:"combo.step-output/v1",
          environment:{inherit:["PATH","HOME"],set:{}}
        }
      }
    '
}

write_config() {
  local path=$1 invocations=$2
  jq -n \
    --arg role "$ROLE_FAKE" --arg runner "$BIN/cb-agent-run.sh" \
    --argjson invocations "$invocations" '
      {
        schema:"combo.config/v1",
        adapters:{
          launcher:{argv:[$role],roles:["launcher"]},
          "direct-agent":{argv:[$runner,"direct-agent"],roles:["coder"]},
          gnhf:{argv:[$runner,"gnhf"],roles:["coder"]},
          reviewer:{argv:[$role],roles:["reviewer"]},
          gate:{argv:[$role],roles:["gate"]},
          cleaner:{argv:[$role],roles:["cleaner"]}
        },
        roles:{
          launcher:{adapter:"launcher",config:{}},
          coder:{invocations:$invocations},
          reviewers:[{id:"review-a",adapter:"reviewer",config:{}}],
          gate:{adapter:"gate",config:{}},
          cleaner:{adapter:"cleaner",config:{}}
        }
      }
    ' >"$path"
}

make_run() {
  local run=$1 config=$2
  mkdir -p "$RUNS_DIR/$run"
  sh "$BIN/cb-plan.sh" "$run" --config "$config" >/dev/null \
    || fail "could not compile P5 plan for $run"
}

run_chain() {
  local run=$1
  local errfile="$TMP_ROOT/$run.chain.err"
  CMD_STDOUT=$(CB_SHOULD_NOT_LEAK=secret bash "$BIN/cb-chain.sh" "$run" 2>"$errfile") \
    && CMD_STATUS=0 || CMD_STATUS=$?
  CMD_STDERR=$(cat "$errfile" 2>/dev/null || true)
}

run_step() {
  local run=$1 attempt=$2
  shift 2
  local errfile="$TMP_ROOT/$run.step.err"
  CMD_STDOUT=$(CB_SHOULD_NOT_LEAK=secret bash "$BIN/cb-step.sh" \
    "$run" coder "$attempt" "$@" 2>"$errfile") \
    && CMD_STATUS=0 || CMD_STATUS=$?
  CMD_STDERR=$(cat "$errfile" 2>/dev/null || true)
}

assert_coder_sequence() {
  local run=$1 first=$2 second=$3
  jq -e --arg first "$first" \
    '.adapter_id==$first and (.config.schema|startswith("combo.coder/"))' \
    "$RUNS_DIR/$run/steps/02-coder/attempt-1/input.json" >/dev/null \
    || fail "attempt one must receive its configured adapter id and config"
  jq -e --arg second "$second" \
    '.adapter_id==$second and (.config.schema|startswith("combo.coder/"))' \
    "$RUNS_DIR/$run/steps/02-coder/attempt-2/input.json" >/dev/null \
    || fail "attempt two must receive its configured adapter id and config"
}
# -/ 1/4

# -- 2/4 CORE · test_compiles_coder_sequences -- <- START HERE
test_compiles_coder_sequences() {
  local repo="$TMP_ROOT/sequence-repo" remote="$TMP_ROOT/sequence-remote.git"
  local base branch=main direct gnhf sequence config run expected
  make_repo "$repo" "$remote"
  base=$(git -C "$repo" rev-parse HEAD)
  direct=$(direct_binding "$repo" "$base" "$branch")
  gnhf=$(gnhf_binding "$repo" "$base" "$branch")

  for expected in "gnhf,direct-agent" "gnhf,gnhf" \
    "direct-agent,direct-agent" "direct-agent,gnhf"; do
    run="sequence-${expected//,/-}"
    config="$TMP_ROOT/$run.config.json"
    if [ "$expected" = "gnhf,direct-agent" ]; then
      sequence=$(jq -cn --argjson a "$gnhf" --argjson b "$direct" '[$a,$b]')
    elif [ "$expected" = "gnhf,gnhf" ]; then
      sequence=$(jq -cn --argjson a "$gnhf" '[$a,$a]')
    elif [ "$expected" = "direct-agent,direct-agent" ]; then
      sequence=$(jq -cn --argjson a "$direct" '[$a,$a]')
    else
      sequence=$(jq -cn --argjson a "$direct" --argjson b "$gnhf" '[$a,$b]')
    fi
    write_config "$config" "$sequence"
    make_run "$run" "$config"
    [ "$(jq -r '.steps[1].invocations | map(.adapter_id) | join(",")' \
      "$RUNS_DIR/$run/plan.json")" = "$expected" ] \
      || fail "plan should preserve configured Coder sequence $expected"
  done
  pass "cb-plan: compiles loop/agent Coder sequences without state-machine changes"
}
# -/ 2/4

# -- 3/4 CORE · test_runs_gnhf_then_direct --
test_runs_gnhf_then_direct() {
  local run=p5-gnhf-direct repo="$TMP_ROOT/e2e-repo"
  local remote="$TMP_ROOT/e2e-remote.git" config="$TMP_ROOT/e2e.config.json"
  local base direct gnhf sequence result commits remote_head
  make_repo "$repo" "$remote"
  base=$(git -C "$repo" rev-parse HEAD)
  direct=$(direct_binding "$repo" "$base" main)
  gnhf=$(gnhf_binding "$repo" "$base" main)
  sequence=$(jq -cn --argjson a "$gnhf" --argjson b "$direct" '[$a,$b]')
  write_config "$config" "$sequence"
  make_run "$run" "$config"

  run_chain "$run"
  expect_code 0 "$CMD_STATUS" "GNHF-to-direct chain${CMD_STDERR:+: $CMD_STDERR}"
  result=$CMD_STDOUT
  commits=$(git -C "$repo" rev-list --count "$base..HEAD")
  [ "$commits" -eq 3 ] \
    || fail "GNHF, direct correction, and repeated correction must create commits"
  jq -e --arg sha "$(git -C "$repo" rev-parse HEAD)" '
    .exit_class=="completed" and .candidate_sha==$sha and
    .terminal=={role:"gate",code:0,event:"gate_ok"}
  ' "$result" >/dev/null || fail "Gate must receive the second exact candidate SHA"
  assert_coder_sequence "$run" gnhf direct-agent
  assert_present "$RUNS_DIR/$run/direct-consumed-findings" \
    "direct correction must consume the injected needs_change artifact"
  assert_grep "gnhf|1|" "$RUNS_DIR/$run/tool-calls" "GNHF fake should execute first"
  assert_grep "direct|2|implement configured work" "$RUNS_DIR/$run/tool-calls" \
    "direct fake should receive the configured prompt"
  assert_grep "direct|3|implement configured work" "$RUNS_DIR/$run/tool-calls" \
    "the final configured correction adapter must repeat on later findings"
  remote_head=$(git --git-dir="$remote" rev-parse refs/heads/main)
  [ "$remote_head" = "$base" ] || fail "Coder adapters must never push candidate commits"
  ! git --git-dir="$remote" show-ref --verify --quiet refs/heads/forbidden \
    || fail "direct-agent push attempt must be blocked"

  run=p5-direct-gnhf
  repo="$TMP_ROOT/switched-repo"
  remote="$TMP_ROOT/switched-remote.git"
  config="$TMP_ROOT/switched.config.json"
  make_repo "$repo" "$remote"
  base=$(git -C "$repo" rev-parse HEAD)
  direct=$(direct_binding "$repo" "$base" main)
  gnhf=$(gnhf_binding "$repo" "$base" main)
  sequence=$(jq -cn --argjson a "$direct" --argjson b "$gnhf" '[$a,$b]')
  write_config "$config" "$sequence"
  make_run "$run" "$config"
  run_chain "$run"
  expect_code 0 "$CMD_STATUS" "config-switched direct-to-GNHF chain${CMD_STDERR:+: $CMD_STDERR}"
  [ "$(git -C "$repo" rev-list --count "$base..HEAD")" -eq 3 ] \
    || fail "switching adapter order through config must retain correction retries"
  assert_coder_sequence "$run" direct-agent gnhf
  pass "cb-agent-run: GNHF candidate and direct correction use only configured adapters"
}
# -/ 3/4

# -- 4/4 CORE · test_normalizes_not_ready --
test_normalizes_not_ready() {
  local repo="$TMP_ROOT/not-ready-repo" remote="$TMP_ROOT/not-ready-remote.git"
  local base direct sequence config run result
  make_repo "$repo" "$remote"
  base=$(git -C "$repo" rev-parse HEAD)

  run=p5-no-commit
  config="$TMP_ROOT/no-commit.config.json"
  direct=$(direct_binding "$repo" "$base" main "$NOOP_FAKE")
  sequence=$(jq -cn --argjson direct "$direct" '[$direct]')
  write_config "$config" "$sequence"
  make_run "$run" "$config"
  rm -f "$EXECUTED_MARKER"
  run_step "$run" 1
  expect_code 0 "$CMD_STATUS" "no-commit direct agent${CMD_STDERR:+: $CMD_STDERR}"
  result=$CMD_STDOUT
  assert_present "$EXECUTED_MARKER" "valid direct config should execute its agent"
  jq -e '
    .exit_class=="completed" and
    .events==[{code:1,event:"coder_not_ready",payload:{
      errors:["candidate:no_new_commit"]
    }}]
  ' "$result" >/dev/null || fail "a successful no-commit agent must normalize to coder_not_ready"

  run=p5-invalid-config
  config="$TMP_ROOT/invalid.config.json"
  direct=$(direct_binding "$repo" "$base" main "$NOOP_FAKE")
  direct=$(jq -c 'del(.config.output_schema)' <<<"$direct")
  sequence=$(jq -cn --argjson direct "$direct" '[$direct]')
  write_config "$config" "$sequence"
  make_run "$run" "$config"
  rm -f "$EXECUTED_MARKER"
  run_step "$run" 1
  expect_code 0 "$CMD_STATUS" "invalid direct config normalization${CMD_STDERR:+: $CMD_STDERR}"
  result=$CMD_STDOUT
  assert_absent "$EXECUTED_MARKER" "invalid config must fail before agent execution"
  jq -e '
    .exit_class=="completed" and
    .events[0].event=="coder_not_ready" and
    .events[0].payload.errors==["config:invalid_direct_agent"]
  ' "$result" >/dev/null || fail "invalid direct config must publish a stable reason"

  run=p5-candidate-mismatch
  config="$TMP_ROOT/candidate-mismatch.config.json"
  direct=$(direct_binding "$repo" "$base" main "$NOOP_FAKE")
  sequence=$(jq -cn --argjson direct "$direct" '[$direct]')
  write_config "$config" "$sequence"
  make_run "$run" "$config"
  rm -f "$EXECUTED_MARKER"
  run_step "$run" 1 --candidate-sha aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
  expect_code 0 "$CMD_STATUS" "candidate mismatch normalization${CMD_STDERR:+: $CMD_STDERR}"
  assert_absent "$EXECUTED_MARKER" "candidate mismatch must fail before execution"
  jq -e '
    .events[0].event=="coder_not_ready" and
    .events[0].payload.errors==["candidate:head_mismatch"]
  ' "$CMD_STDOUT" >/dev/null || fail "candidate mismatch must have a stable reason"

  run=5p5-dirty-worktree
  config="$TMP_ROOT/dirty-worktree.config.json"
  direct=$(direct_binding "$repo" "$base" main "$NOOP_FAKE")
  sequence=$(jq -cn --argjson direct "$direct" '[$direct]')
  write_config "$config" "$sequence"
  make_run "$run" "$config"
  printf 'uncommitted\n' >>"$repo/work.txt"
  rm -f "$EXECUTED_MARKER"
  run_step "$run" 1
  expect_code 0 "$CMD_STATUS" "dirty worktree normalization${CMD_STDERR:+: $CMD_STDERR}"
  assert_absent "$EXECUTED_MARKER" "dirty worktree must fail before execution"
  jq -e '
    .events[0].event=="coder_not_ready" and
    .events[0].payload.errors==["candidate:dirty_worktree"]
  ' "$CMD_STDOUT" >/dev/null || fail "dirty worktree must have a stable reason"
  pass "cb-agent-run: invalid config and unverifiable candidates fail closed"
}
# -/ 4/4

test_compiles_coder_sequences
test_runs_gnhf_then_direct
test_normalizes_not_ready

printf '\ncoder-adapters: all tests passed\n'
