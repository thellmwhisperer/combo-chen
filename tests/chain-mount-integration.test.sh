#!/usr/bin/env bash
# @overview Deterministic mounted-chain acceptance for the Combo v1 dispatcher.
#   Uses real isolated tmux windows plus fake Treehouse, Coder, Reviewer,
#   No-Mistakes, and GitHub boundaries to prove endpoint execution, immutable
#   Launcher custody, expected-base rejection, trusted terminal/process truth,
#   resume, and exact cleanup.
#
#   READING GUIDE
#   -------------
#   1. Fixture commands and config       <- deterministic five-seat inputs.
#   2. run_mounted_chain                 <- interrupt then resume one run.
#   3. assert_mounted_evidence           <- artifact-only acceptance checks.
#   4. assert_dispatch_security           <- installed link + path containment.
#   5. run_mutation_checks                <- prove each bypass is detected.
#
#   MAIN FLOW
#   ---------
#   plan -> cb-run -> tmux endpoints -> normalized steps -> failed + cleaned
#
#   PUBLIC API
#   ----------
#   none
#
#   INTERNALS
#   ---------
#   cleanup_fixture, tmux_command, meta_value, wait_for_controlled_path,
#   wait_for_controlled_line,
#   write_config, assert_chain_rejects_unsafe_dispatchers,
#   assert_job_snapshot_race, run_mounted_chain, assert_mounted_evidence,
#   assert_receipt_liveness_race, install_chain_result,
#   write_printable_gate_terminal, assert_terminal_artifact_security,
#   assert_dispatch_security, run_mutation_checks
#
# @exports none
# @deps bash, git, jq, stat, tmux, tests/lib.sh, bin/cb-plan.sh, bin/cb-run.sh,
#   bin/cb-launcher-adapter.sh, bin/cb-agent-run.sh, bin/cb-gate.sh,
#   bin/cb-cleaner-adapter.sh
set -u

if ! command -v tmux >/dev/null 2>&1; then
  printf 'skip - tmux not available\n' >&2
  exit 0
fi

# shellcheck source=tests/lib.sh disable=SC1091
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

BIN="$ROOT/bin"
TMP_ROOT=
cb_tmproot TMP_ROOT cb-chain-mount
RUNS_DIR="$TMP_ROOT/runs"
REPO="$TMP_ROOT/repo"
WORKTREE="$TMP_ROOT/treehouse-worktree"
FAKE_BIN="$TMP_ROOT/fake-bin"
TREEHOUSE_STATE="$TMP_ROOT/treehouse.state"
TREEHOUSE_GET_CALLS="$TMP_ROOT/treehouse.get.calls"
TREEHOUSE_RETURN_CALLS="$TMP_ROOT/treehouse.return.calls"
CODER_FACTS="$TMP_ROOT/coder.facts"
NM_CALLS="$TMP_ROOT/no-mistakes.calls"
GH_CALLS="$TMP_ROOT/gh.calls"
CONFIG="$TMP_ROOT/config.json"
TMUX_SOCKET="cbmount-$$-$RANDOM"
RUN="mount-$RANDOM"
MUTATION=${CB_CHAIN_MOUNT_MUTATION:-none}
REAL_STAT=${CB_CHAIN_TEST_SYSTEM_STAT:-$(command -v stat)}
mkdir -p "$RUNS_DIR" "$REPO" "$FAKE_BIN"

cleanup_fixture() {
  tmux -L "$TMUX_SOCKET" -f /dev/null kill-server 2>/dev/null || true
  if [ -d "$WORKTREE" ]; then
    git -C "$REPO" worktree remove --force "$WORKTREE" >/dev/null 2>&1 || true
  fi
  cb_cleanup
}
trap cleanup_fixture EXIT

tmux_command() {
  tmux -L "$TMUX_SOCKET" -f /dev/null "$@"
}

meta_value() {
  local role=$1 key=$2
  awk -F= -v key="$key" '
    $1==key {value=substr($0,length(key)+2)}
    END {if (value!="") print value; else exit 1}
  ' "$RUNS_DIR/$RUN/agents/$role.meta"
}

wait_for_controlled_path() {
  local path=$1 pid=${2:-} wait_seconds=${3:-8} deadline
  deadline=$((SECONDS + wait_seconds))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if [ -e "$path" ] || [ -L "$path" ]; then
      return 0
    fi
    if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then
      return 1
    fi
    sleep 0.02
  done
  [ -e "$path" ] || [ -L "$path" ]
}

wait_for_controlled_line() {
  local file=$1 fixed=$2 wait_seconds=${3:-8} deadline
  deadline=$((SECONDS + wait_seconds))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if [ -f "$file" ] && grep -F "$fixed" "$file" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.02
  done
  [ -f "$file" ] && grep -F "$fixed" "$file" >/dev/null 2>&1
}

# -- 1/5 HELPER · Fixture commands and immutable config --
git -C "$REPO" init -q -b main
git -C "$REPO" config user.name "Combo Mount Test"
git -C "$REPO" config user.email "combo-mount@example.test"
printf 'base\n' >"$REPO/work.txt"
git -C "$REPO" add work.txt
git -C "$REPO" commit -qm "fixture base"
BASE_SHA=$(git -C "$REPO" rev-parse HEAD)

cb_write_fake "$FAKE_BIN/stat" '#!/bin/sh
if [ "$#" -eq 3 ] && [ "$1" = -c ] && [ "$2" = %i ]; then
  case "$3" in
    /dev/fd/*) printf "1\n"; exit 0 ;;
  esac
fi
exec "$CB_CHAIN_TEST_SYSTEM_STAT" "$@"
'

cb_write_fake "$FAKE_BIN/treehouse" '#!/usr/bin/env bash
set -eu
command_name=${1:-}
case "$command_name" in
  get)
    holder=
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --lease-holder) holder=$2; shift 2 ;;
        *) shift ;;
      esac
    done
    [ -n "$holder" ] || exit 64
    [ ! -e "$CB_CHAIN_TEST_WORKTREE" ] || exit 75
    git -C "$CB_CHAIN_TEST_REPO" worktree add --detach \
      "$CB_CHAIN_TEST_WORKTREE" "$CB_CHAIN_TEST_BASE" >/dev/null
    printf "%s|%s\n" "$holder" "$CB_CHAIN_TEST_WORKTREE" \
      >"$CB_CHAIN_TEST_TREEHOUSE_STATE"
    printf "get\n" >>"$CB_CHAIN_TEST_TREEHOUSE_GET_CALLS"
    printf "%s\n" "$CB_CHAIN_TEST_WORKTREE"
    ;;
  status)
    [ -f "$CB_CHAIN_TEST_TREEHOUSE_STATE" ] || exit 0
    IFS="|" read -r holder path <"$CB_CHAIN_TEST_TREEHOUSE_STATE"
    display=$path
    case "$path" in
      "$HOME"/*) display="~/${path#"$HOME"/}" ;;
    esac
    printf "alpha leased %s (held by %s)\n" "$display" "$holder"
    ;;
  return)
    path=${2:-}
    [ -f "$CB_CHAIN_TEST_TREEHOUSE_STATE" ] || exit 75
    IFS="|" read -r holder recorded <"$CB_CHAIN_TEST_TREEHOUSE_STATE"
    [ "$path" = "$recorded" ] || exit 76
    printf "%s\n" "$path" >>"$CB_CHAIN_TEST_TREEHOUSE_RETURN_CALLS"
    if [ "${CB_CHAIN_TEST_MUTATION:-}" = bypass-cleaner ]; then
      exit 0
    fi
    git -C "$CB_CHAIN_TEST_REPO" worktree remove "$path" >/dev/null
    rm "$CB_CHAIN_TEST_TREEHOUSE_STATE"
    ;;
  *) exit 64 ;;
esac
'

cb_write_fake "$FAKE_BIN/coder" '#!/usr/bin/env bash
set -eu
repo=${COMBO_CODER_WORKTREE:?}
input=${COMBO_CODER_STEP_INPUT:?}
jq -cn \
  --arg worktree "$repo" \
  --arg base "$(git -C "$repo" rev-parse HEAD)" \
  --arg branch "$(git -C "$repo" branch --show-current)" \
  --arg lease "$(jq -r ".run_id" "$input")" \
  "{worktree:\$worktree,pre_head:\$base,branch:\$branch,lease_id:\$lease}" \
  >"$CB_CHAIN_TEST_CODER_FACTS"
printf "candidate\n" >>"$repo/work.txt"
git -C "$repo" add work.txt
git -C "$repo" commit -qm "fixture candidate"
'

cb_write_fake "$FAKE_BIN/reviewer" '#!/usr/bin/env bash
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
candidate=$(jq -r ".candidate_sha" "$input")
jq -cn \
  --arg run "$(jq -r ".run_id" "$input")" \
  --arg step "$(jq -r ".step_id" "$input")" \
  --argjson attempt "$(jq -r ".attempt" "$input")" \
  --arg sha "$candidate" \
  "{
    schema:\"combo.step-output/v1\",
    run_id:\$run,step_id:\$step,role:\"reviewer\",attempt:\$attempt,
    exit_class:\"completed\",
    events:[{code:0,event:\"lgtm\",payload:{sha:\$sha}}],
    artifacts:[],reasons:[],errors:[]
  }" >"$output"
'

cb_write_fake "$FAKE_BIN/no-mistakes" '#!/bin/sh
printf "%s\n" "$*" >>"$CB_CHAIN_TEST_NM_CALLS"
exit 75
'

cb_write_fake "$FAKE_BIN/gh" '#!/bin/sh
printf "%s\n" "$*" >>"$CB_CHAIN_TEST_GH_CALLS"
exit 75
'

cb_write_fake "$FAKE_BIN/bypass-launcher" '#!/usr/bin/env bash
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
run=$(jq -r ".run_id" "$input")
run_dir=$(jq -r ".paths.run_dir" "$input")
mkdir -p "$run_dir/agents"
jq -cn \
  --arg run "$run" --arg repo "$CB_CHAIN_TEST_REPO" \
  --arg branch main --arg base "$CB_CHAIN_TEST_BASE" \
  "{
    run:\$run,runway_kind:\"treehouse\",repo_dir:\$repo,worktree:\$repo,
    branch:\$branch,base_sha:\$base,lease_id:\$run
  }" >"$run_dir/agents/launcher.ownership.json"
chmod 0444 "$run_dir/agents/launcher.ownership.json"
jq -cn \
  --arg run "$run" --argjson attempt "$(jq -r ".attempt" "$input")" \
  --arg repo "$CB_CHAIN_TEST_REPO" --arg base "$CB_CHAIN_TEST_BASE" \
  "{
    schema:\"combo.step-output/v1\",run_id:\$run,step_id:\"launcher\",
    role:\"launcher\",attempt:\$attempt,exit_class:\"completed\",
    events:[{code:0,event:\"launch_ready\",payload:{
      worktree:\$repo,branch:\"main\",base_sha:\$base,
      runway_kind:\"treehouse\",lease_id:\$run
    }}],artifacts:[],reasons:[],errors:[]
  }" >"$output"
'

write_config() {
  local launcher="$BIN/cb-launcher-adapter.sh"
  local expected_sha=0000000000000000000000000000000000000000
  if [ "$MUTATION" = bypass-envelope ]; then
    launcher="$FAKE_BIN/bypass-launcher"
  fi
  if [ "$MUTATION" = bypass-preflight ]; then
    expected_sha=$BASE_SHA
  fi
  jq -n \
    --arg launcher "$launcher" \
    --arg coder_adapter "$BIN/cb-agent-run.sh" \
    --arg reviewer "$FAKE_BIN/reviewer" \
    --arg gate "$BIN/cb-gate.sh" \
    --arg cleaner "$BIN/cb-cleaner-adapter.sh" \
    --arg repo "$REPO" --arg base "$BASE_SHA" \
    --arg coder "$FAKE_BIN/coder" --arg nm "$FAKE_BIN/no-mistakes" \
    --arg coder_facts "$CODER_FACTS" \
    --arg expected "$expected_sha" '
      {
        schema:"combo.config/v1",
        adapters:{
          launcher:{argv:[$launcher],roles:["launcher"]},
          "direct-agent":{argv:[$coder_adapter,"direct-agent"],roles:["coder"]},
          reviewer:{argv:[$reviewer],roles:["reviewer"]},
          gate:{argv:[$gate],roles:["gate"]},
          cleaner:{argv:[$cleaner],roles:["cleaner"]}
        },
        roles:{
          launcher:{
            adapter:"launcher",
            config:{
              schema:"combo.launcher/treehouse/v1",
              repo_dir:$repo,
              base_ref:"main",
              setup_command:"",
              readiness:{
                required_seats:["coder","reviewer","gate"],
                seats:[
                  {id:"coder",harness:"sh",auth_cmd:"exit 0"},
                  {id:"reviewer",harness:"sh",auth_cmd:"exit 0"},
                  {id:"gate",harness:"sh",auth_cmd:"exit 0"}
                ]
              }
            }
          },
          coder:{
            adapter:"direct-agent",
            config:{
              schema:"combo.coder/direct-agent/v1",
              argv:[$coder],
              prompt:"make one deterministic local commit",
              output_schema:"combo.step-output/v1",
              environment:{
                inherit:["PATH","HOME"],
                set:{CB_CHAIN_TEST_CODER_FACTS:$coder_facts}
              }
            }
          },
          reviewers:[{
            id:"review-a",adapter:"reviewer",config:{}
          }],
          gate:{
            adapter:"gate",
            config:{
              schema:"combo.gate.no-mistakes/v1",
              binary:$nm,runtime:"pi",model:"fixture/model",
              arguments:[],intent:"validate fixture",approval:"auto",
              review:true,merge:"manual",
              expected_base_branch:"main",
              expected_base_sha:$expected
            }
          },
          cleaner:{
            adapter:"cleaner",
            config:{schema:"combo.cleaner/treehouse/v1"}
          }
        }
      }
    ' >"$CONFIG"
}

write_config
mkdir -p "$RUNS_DIR/$RUN"
CB_RUNS_DIR="$RUNS_DIR" sh "$BIN/cb-plan.sh" \
  "$RUN" --config "$CONFIG" >/dev/null \
  || fail "could not compile mounted-chain fixture plan"
PLAN_SHA=$(cb_file_sha256 "$RUNS_DIR/$RUN/plan.json")
CUSTODY_SHA=
# Simulate a crash after native launch inputs were sealed but before the
# mechanical Launcher ran. The first endpoint attempt must adopt exact matches.
jq -c '.roles.launcher.config.readiness' "$CONFIG" \
  >"$RUNS_DIR/$RUN/launcher-readiness.json"
chmod 0444 "$RUNS_DIR/$RUN/launcher-readiness.json"
{
  printf "CB_REPO_DIR='%s'\n" "$REPO"
  printf "CB_RUNWAY_MODE='treehouse'\n"
  printf "CB_READINESS_FILE='%s'\n" \
    "$RUNS_DIR/$RUN/launcher-readiness.json"
  printf "CB_BASE_REF='main'\n"
  printf "CB_SETUP_CMD=''\n"
  printf "CB_CLEAN_CUSTODY_CMD='exit 0'\n"
} >"$RUNS_DIR/$RUN/config.env"
chmod 0600 "$RUNS_DIR/$RUN/config.env"
# -/ 1/5

# -- 2/5 CORE · run_mounted_chain -- <- START HERE
export PATH="$FAKE_BIN:$PATH"
export SHELL=/bin/bash
export CB_RUNS_DIR="$RUNS_DIR"
export CB_TMUX_SOCKET="$TMUX_SOCKET"
export CB_TMUX_CONF=/dev/null
export CB_SEND_SLEEP=0.05
export CB_SEND_SETTLE=0.02
export CB_SEND_RETRIES=3
export CB_CHAIN_TEST_REPO="$REPO"
export CB_CHAIN_TEST_WORKTREE="$WORKTREE"
export CB_CHAIN_TEST_BASE="$BASE_SHA"
export CB_CHAIN_TEST_TREEHOUSE_STATE="$TREEHOUSE_STATE"
export CB_CHAIN_TEST_TREEHOUSE_GET_CALLS="$TREEHOUSE_GET_CALLS"
export CB_CHAIN_TEST_TREEHOUSE_RETURN_CALLS="$TREEHOUSE_RETURN_CALLS"
export CB_CHAIN_TEST_CODER_FACTS="$CODER_FACTS"
export CB_CHAIN_TEST_NM_CALLS="$NM_CALLS"
export CB_CHAIN_TEST_GH_CALLS="$GH_CALLS"
export CB_CHAIN_TEST_MUTATION="$MUTATION"
export CB_CHAIN_TEST_SYSTEM_STAT="$REAL_STAT"

INSTALLED_BIN="$TMP_ROOT/installed/bin"
INSTALLED_LIBEXEC="$TMP_ROOT/installed/libexec"
ARBITRARY_CWD="$TMP_ROOT/arbitrary-cwd"
INSTALLED_DISPATCHER="$INSTALLED_BIN/combo-chain"
RUN_DISPATCHER_SOURCE=${CB_CHAIN_RUN_UNDER_TEST:-"$BIN/cb-run.sh"}
CHAIN_GUARD_SOURCE=${CB_CHAIN_UNDER_TEST:-"$BIN/cb-chain.sh"}
mkdir -p "$INSTALLED_BIN" "$INSTALLED_LIBEXEC" "$ARBITRARY_CWD"
ln -s "$RUN_DISPATCHER_SOURCE" "$INSTALLED_LIBEXEC/cb-run.sh"
ln -s ../libexec/cb-run.sh "$INSTALLED_DISPATCHER"

RUN_STATUS=
RUN_STDOUT=
RUN_STDERR=
run_dispatcher() {
  local stop_after=${1:-} err="$TMP_ROOT/run.err"
  if [ "$MUTATION" = bypass-endpoint ]; then
    RUN_STDOUT=$(CB_CHAIN_STOP_AFTER_ROLE="$stop_after" \
      bash "$BIN/cb-chain.sh" "$RUN" </dev/null 2>"$err") \
      && RUN_STATUS=0 || RUN_STATUS=$?
  else
    RUN_STDOUT=$(cd "$ARBITRARY_CWD" && \
      CB_CHAIN_STOP_AFTER_ROLE="$stop_after" \
      "$INSTALLED_DISPATCHER" "$RUN" </dev/null 2>"$err") \
      && RUN_STATUS=0 || RUN_STATUS=$?
  fi
  RUN_STDERR=$(cat "$err" 2>/dev/null || true)
}

assert_chain_rejects_unsafe_dispatchers() {
  local unsafe_target="$INSTALLED_BIN/unsafe-target"
  local unsafe_link="$INSTALLED_BIN/unsafe-link"
  local broken_link="$INSTALLED_BIN/broken-link"
  local cycle_a="$INSTALLED_BIN/cycle-a"
  local cycle_b="$INSTALLED_BIN/cycle-b"
  local label dispatcher err status

  cp "$BIN/cb-run.sh" "$unsafe_target"
  chmod 0644 "$unsafe_target"
  ln -s "$unsafe_target" "$unsafe_link"
  ln -s "$INSTALLED_BIN/missing-target" "$broken_link"
  ln -s "$cycle_b" "$cycle_a"
  ln -s "$cycle_a" "$cycle_b"

  while IFS='|' read -r label dispatcher; do
    err="$TMP_ROOT/canonical-dispatcher-$label.err"
    CB_CHAIN_DISPATCHER="$dispatcher" \
      bash "$CHAIN_GUARD_SOURCE" "$RUN" \
      </dev/null >"$TMP_ROOT/canonical-dispatcher-$label.out" 2>"$err" \
      && status=0 || status=$?
    expect_code 73 "$status" "cb-chain $label dispatcher guard"
    assert_contains "$(cat "$err")" \
      "endpoint dispatcher is missing or unsafe" \
      "cb-chain did not evaluate the product guard for $label dispatcher"
    assert_absent "$RUNS_DIR/$RUN/agents/launcher.ownership.json" \
      "rejected $label dispatcher reached Launcher execution"
    [ ! -L "$RUNS_DIR/$RUN/agents/launcher.ownership.json" ] \
      || fail "rejected $label dispatcher left dangling Launcher custody"
    assert_absent "$RUNS_DIR/$RUN/chain-result.json" \
      "rejected $label dispatcher fabricated a chain result"
    [ ! -L "$RUNS_DIR/$RUN/chain-result.json" ] \
      || fail "rejected $label dispatcher left a dangling chain result"
  done <<EOF
installed-symlink|$INSTALLED_DISPATCHER
non-executable|$unsafe_target
unsafe-link|$unsafe_link
broken-link|$broken_link
cyclic-link|$cycle_a
EOF
}

assert_chain_rejects_unsafe_dispatchers

assert_job_snapshot_race() {
  local race_bin="$TMP_ROOT/job-snapshot-bin"
  local ready="$TMP_ROOT/job-snapshot.ready"
  local release="$TMP_ROOT/job-snapshot.release"
  local name=reviewer-snapshot-race.job.json
  local receipt_name=reviewer-snapshot-race.receipt.json
  local job="$RUNS_DIR/$RUN/dispatch/jobs/$name"
  local receipt="$RUNS_DIR/$RUN/dispatch/$receipt_name"
  local runner="$TMP_ROOT/job-snapshot-runner"
  local replacement="$TMP_ROOT/job-snapshot.replacement"
  local original=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
  local result input candidate

  mkdir "$race_bin"
  cb_write_fake "$race_bin/jq" '#!/usr/bin/env bash
if [ "${1:-}" = -c ] && [ "${2:-}" = .prior_artifacts ]; then
  printf "validated-job-snapshot\n" >"$CB_JOB_SNAPSHOT_READY"
  attempts=800
  while [ ! -e "$CB_JOB_SNAPSHOT_RELEASE" ]; do
    [ "$attempts" -gt 0 ] || exit 75
    attempts=$((attempts - 1))
    sleep 0.01
  done
fi
exec "$CB_JOB_SNAPSHOT_REAL_JQ" "$@"
'
  jq -cn \
    --arg run "$RUN" --arg job "$name" --arg receipt "$receipt_name" \
    --arg candidate "$original" '
      {
        schema:"combo.endpoint-job/v1",run_id:$run,role:"reviewer",
        step_id:"reviewer/review-a",attempt:300,candidate_sha:$candidate,
        prior_artifacts:[],job_name:$job,receipt_name:$receipt
      }
    ' >"$job"
  chmod 0444 "$job"
  cb_write_fake "$runner" "#!/bin/sh
PATH='$race_bin':\"\$PATH\" \\
CB_JOB_SNAPSHOT_READY='$ready' \\
CB_JOB_SNAPSHOT_RELEASE='$release' \\
CB_JOB_SNAPSHOT_REAL_JQ='$(command -v jq)' \\
exec '$INSTALLED_DISPATCHER' --endpoint-job '$RUN' '$name'
"
  CB_RUNS_DIR="$RUNS_DIR" sh "$BIN/cb-send.sh" \
    "$RUN" reviewer "sh '$runner'" </dev/null >/dev/null \
    || fail "could not steer the immutable-job snapshot fixture"
  if ! wait_for_controlled_path "$ready" "" 8; then
    touch "$release"
    fail "job replacement fixture did not reach its validated in-memory snapshot"
  fi
  [ "$(cat "$ready")" = validated-job-snapshot ] \
    || fail "job replacement fixture synchronized at the wrong boundary"
  jq --arg replacement "$BASE_SHA" '.candidate_sha=$replacement' \
    "$job" >"$replacement"
  chmod 0444 "$replacement"
  mv -f "$replacement" "$job"
  touch "$release"
  if ! wait_for_controlled_path "$receipt" "" 8; then
    fail "job replacement fixture did not publish its endpoint receipt"
  fi
  [ -f "$receipt" ] && [ ! -L "$receipt" ] \
    || fail "job replacement fixture receipt is unsafe"
  result=$(jq -r '.result_path' "$receipt")
  assert_present "$result" \
    "job replacement fixture did not publish the reviewer result"
  input="$RUNS_DIR/$RUN/steps/03-reviewer-review-a/attempt-300/input.json"
  candidate=$(jq -r '.candidate_sha' "$input")
  [ "$candidate" = "$original" ] \
    || fail "mutable endpoint job replacement changed the dispatched candidate"
  [ "$(jq -r '.candidate_sha' "$job")" = "$BASE_SHA" ] \
    || fail "job replacement counterfactual did not install its changed SHA"
  wait_for_controlled_line "$RUNS_DIR/$RUN/dispatch-log.jsonl" \
    '"attempt":300' 8 \
    || fail "job replacement fixture did not finish its endpoint dispatch record"
  awk '!/"attempt":300/' "$RUNS_DIR/$RUN/dispatch-log.jsonl" \
    >"$RUNS_DIR/$RUN/.dispatch-log.snapshot-race"
  mv "$RUNS_DIR/$RUN/.dispatch-log.snapshot-race" \
    "$RUNS_DIR/$RUN/dispatch-log.jsonl"
  rm -f -- "$job" "$receipt"
  rm -r -- "$RUNS_DIR/$RUN/steps/03-reviewer-review-a/attempt-300"
}

run_mounted_chain() {
  if [ "$MUTATION" != bypass-endpoint ]; then
    run_dispatcher launcher
    expect_code 130 "$RUN_STATUS" \
      "mounted chain interruption${RUN_STDERR:+: $RUN_STDERR}"
    assert_absent "$RUNS_DIR/$RUN/chain-result.json" \
      "interrupted chain must not fabricate a terminal result"
    assert_present "$RUNS_DIR/$RUN/agents/launcher.ownership.json" \
      "Launcher must publish custody before the interruption"
    CUSTODY_SHA=$(cb_file_sha256 \
      "$RUNS_DIR/$RUN/agents/launcher.ownership.json")
    assert_job_snapshot_race
    printf '{"schema":"stale-endpoint-job/v1"}\n' \
      >"$RUNS_DIR/$RUN/dispatch/jobs/coder-attempt-1.job.json"
    chmod 0444 "$RUNS_DIR/$RUN/dispatch/jobs/coder-attempt-1.job.json"
    if [ "$MUTATION" != bypass-preflight ]; then
      printf 'advanced after custody\n' >"$REPO/base-advance.txt"
      git -C "$REPO" add base-advance.txt
      git -C "$REPO" commit -qm "fixture advances symbolic base"
    fi
    if [ "$MUTATION" = bypass-custody ]; then
      chmod u+w "$RUNS_DIR/$RUN/agents/launcher.ownership.json"
      jq '.branch="combo/tampered"' \
        "$RUNS_DIR/$RUN/agents/launcher.ownership.json" \
        >"$RUNS_DIR/$RUN/agents/.launcher.ownership.mutation"
      mv "$RUNS_DIR/$RUN/agents/.launcher.ownership.mutation" \
        "$RUNS_DIR/$RUN/agents/launcher.ownership.json"
      chmod 0444 "$RUNS_DIR/$RUN/agents/launcher.ownership.json"
    fi
  fi

  run_dispatcher
  case "$MUTATION" in
    bypass-envelope)
      [ "$(jq -r '
        .steps[] | select(.id=="launcher") | .argv[0]
      ' "$RUNS_DIR/$RUN/plan.json")" = "$BIN/cb-launcher-adapter.sh" ] \
        || fail "MUTATION_KILLED:bypass-envelope:native launcher envelope absent"
      ;;
    bypass-custody)
      [ "$CUSTODY_SHA" = "$(cb_file_sha256 \
        "$RUNS_DIR/$RUN/agents/launcher.ownership.json")" ] \
        || fail "MUTATION_KILLED:bypass-custody:launcher custody changed"
      ;;
    bypass-endpoint)
      [ -f "$RUNS_DIR/$RUN/dispatch-log.jsonl" ] \
        && [ "$(grep -c '"role":"launcher"' \
          "$RUNS_DIR/$RUN/dispatch-log.jsonl")" -gt 0 ] \
        || fail "MUTATION_KILLED:bypass-endpoint:missing endpoint dispatch evidence"
      ;;
    bypass-preflight)
      [ "$RUN_STATUS" -eq 1 ] \
        && jq -e '
          .terminal=={role:"gate",code:1,event:"gate_failed"} and
          .reasons==["expected_base_sha_mismatch"]
        ' "$RUNS_DIR/$RUN/chain-result.json" >/dev/null 2>&1 \
        || fail "MUTATION_KILLED:bypass-preflight:expected-base rejection absent"
      ;;
    bypass-cleaner)
      [ ! -e "$WORKTREE" ] && [ ! -L "$WORKTREE" ] \
        || fail "MUTATION_KILLED:bypass-cleaner:leased worktree remains"
      ;;
  esac
  expect_code 1 "$RUN_STATUS" \
    "mounted expected-base rejection${RUN_STDERR:+: $RUN_STDERR}"
  [ "$RUN_STDOUT" = failed ] \
    || fail "dispatcher must print exactly one truthful failed outcome"
}

run_mounted_chain
# -/ 2/5

# -- 3/5 CORE · assert_mounted_evidence --
assert_mounted_evidence() {
  local expected_names actual_names role mode receipt window_id
  local expected_order calls plan launcher_argv return_path

  tmux_command has-session -t "=combo-$RUN" >/dev/null 2>&1 \
    || fail "mounted tmux session is missing"
  expected_names=$(for role in launcher coder reviewer gate cleaner; do
    printf 'cb-%s-%s\n' "$RUN" "$role"
  done | sort)
  actual_names=$(tmux_command list-windows -t "=combo-$RUN" \
    -F '#{window_name}' | sort)
  [ "$actual_names" = "$expected_names" ] \
    || fail "mounted session does not contain exactly five canonical windows"

  for role in launcher coder reviewer gate cleaner; do
    assert_present "$RUNS_DIR/$RUN/agents/$role.meta" \
      "missing $role endpoint metadata"
    case "$role" in coder|reviewer) mode=tui ;; *) mode=shell ;; esac
    [ "$(meta_value "$role" mode)" = "$mode" ] \
      || fail "$role endpoint mode mismatch"
    window_id=$(meta_value "$role" window_id)
    receipt=$(find "$RUNS_DIR/$RUN/dispatch" -type f \
      -name '*.receipt.json' -exec jq -r \
      --arg role "$role" 'select(.role==$role) | .window_id' {} + \
      | tail -n 1)
    [ "$receipt" = "$window_id" ] \
      || fail "$role did not execute inside its recorded tmux endpoint"
  done

  plan="$RUNS_DIR/$RUN/plan.json"
  [ "$(cb_file_sha256 "$plan")" = "$PLAN_SHA" ] \
    || fail "mounted execution mutated plan.json"
  jq -e --arg run "$RUN" --arg repo "$REPO" --arg worktree "$WORKTREE" \
    --arg base "$BASE_SHA" '
      keys==[
        "base_sha","branch","lease_id","repo_dir","run","runway_kind","worktree"
      ] and
      .run==$run and .runway_kind=="treehouse" and .repo_dir==$repo and
      .worktree==$worktree and .branch==("combo/" + $run) and
      .base_sha==$base and .lease_id==$run
    ' "$RUNS_DIR/$RUN/agents/launcher.ownership.json" >/dev/null \
    || fail "Launcher custody does not contain the exact write-once key set"
  [ "$(cb_file_mode "$RUNS_DIR/$RUN/agents/launcher.ownership.json")" = 444 ] \
    || fail "Launcher custody is not immutable"
  [ "$(cb_file_sha256 \
    "$RUNS_DIR/$RUN/agents/launcher.ownership.json")" = "$CUSTODY_SHA" ] \
    || fail "resume rewrote Launcher custody"
  [ "$(wc -l <"$TREEHOUSE_GET_CALLS" | tr -d ' ')" = 1 ] \
    || fail "Launcher replay duplicated Treehouse acquisition"

  jq -e --arg worktree "$WORKTREE" --arg branch "combo/$RUN" '
    .worktree==$worktree and .branch==$branch
  ' "$CODER_FACTS" >/dev/null \
    || fail "Coder did not consume Launcher worktree/branch facts"
  jq -e '
    (.config | has("worktree") or has("base_sha") or has("branch")) | not
  ' "$RUNS_DIR/$RUN/steps/02-coder/attempt-2/input.json" >/dev/null \
    || fail "Coder runtime custody leaked into the immutable plan/input config"
  assert_absent "$RUNS_DIR/$RUN/dispatch/coder-attempt-1.receipt.json" \
    "resume adopted a stale endpoint job instead of using a fresh attempt"

  calls=$(jq -Rrs '
    [split("\n")[] | fromjson? | .role] | join(",")
  ' "$RUNS_DIR/$RUN/dispatch-log.jsonl")
  expected_order=launcher,launcher,coder,reviewer,gate,cleaner
  [ "$calls" = "$expected_order" ] \
    || fail "endpoint topology diverged: $calls"
  ! grep -F 'address' "$RUNS_DIR/$RUN/dispatch-log.jsonl" >/dev/null \
    || fail "mounted chain introduced an Addressing phase"
  [ "$(grep -c '"role":"gate"' \
    "$RUNS_DIR/$RUN/dispatch-log.jsonl")" = 1 ] \
    || fail "Gate was re-entered"

  jq -e '
    .schema=="combo.chain-result/v1" and
    .terminal=={
      role:"gate",code:1,event:"gate_failed"
    } and
    .reasons==["expected_base_sha_mismatch"] and
    .cleanup=={
      exit_class:"completed",code:0,event:"cleaned",reasons:[],errors:[]
    }
  ' "$RUNS_DIR/$RUN/chain-result.json" >/dev/null \
    || fail "chain result did not preserve Gate truth plus Cleaner outcome"
  assert_absent "$NM_CALLS" \
    "expected-base mismatch reached a publication-shaped No-Mistakes call"
  assert_absent "$GH_CALLS" \
    "expected-base mismatch reached a publication-shaped GitHub call"
  return_path=$(cat "$TREEHOUSE_RETURN_CALLS" 2>/dev/null || true)
  [ "$return_path" = "$WORKTREE" ] \
    || fail "Cleaner did not return exactly the recorded custody path"
  assert_absent "$WORKTREE" "Cleaner did not release the sandbox worktree"

  launcher_argv=$(jq -r '
    .steps[] | select(.id=="launcher") | .argv[0]
  ' "$plan")
  [ "$launcher_argv" = "$BIN/cb-launcher-adapter.sh" ] \
    || fail "mounted chain bypassed the native Launcher envelope"
  [ "$(jq -r '
    .steps[] | select(.id=="cleaner") | .argv[0]
  ' "$plan")" = "$BIN/cb-cleaner-adapter.sh" ] \
    || fail "mounted chain bypassed the native Cleaner envelope"

  run_dispatcher
  expect_code 1 "$RUN_STATUS" "terminal replay"
  [ "$RUN_STDOUT" = failed ] \
    || fail "terminal replay must print the same single truthful outcome"
  [ "$(wc -l <"$TREEHOUSE_RETURN_CALLS" | tr -d ' ')" = 1 ] \
    || fail "terminal replay duplicated Cleaner release"
  [ "$(grep -c '"role":"gate"' \
    "$RUNS_DIR/$RUN/dispatch-log.jsonl")" = 1 ] \
    || fail "terminal replay duplicated Gate"

  CB_RUNS_DIR="$RUNS_DIR" CB_TMUX_SOCKET="$TMUX_SOCKET" \
    CB_TMUX_CONF=/dev/null CB_SEND_SLEEP=0.05 CB_SEND_SETTLE=0.02 \
    sh "$BIN/cb-send.sh" "$RUN" coder "printf coder-steerable" >/dev/null \
    || fail "Coder endpoint is not steerable after convergence"
  CB_RUNS_DIR="$RUNS_DIR" CB_TMUX_SOCKET="$TMUX_SOCKET" \
    CB_TMUX_CONF=/dev/null CB_SEND_SLEEP=0.05 CB_SEND_SETTLE=0.02 \
    sh "$BIN/cb-send.sh" "$RUN" reviewer "printf reviewer-steerable" >/dev/null \
    || fail "Reviewer endpoint is not steerable after convergence"
}

assert_mounted_evidence
pass "cb-run: mounts, resumes, rejects before publication, and cleans exactly"
# -/ 3/5

assert_receipt_liveness_race() {
  local lab="$TMP_ROOT/receipt-race" lab_bin="$TMP_ROOT/receipt-race/bin"
  local race_runs="$TMP_ROOT/receipt-race/runs" race_run=receipt-race
  local receipt="$race_runs/$race_run/dispatch/coder-attempt-901.receipt.json"
  local out="$lab/out" err="$lab/err" status job_path

  mkdir -p "$lab_bin" "$race_runs/$race_run/dispatch/jobs"
  cp "$BIN/cb-run.sh" "$lab_bin/cb-run.sh"
  chmod 0755 "$lab_bin/cb-run.sh"
  cb_write_fake "$lab_bin/cb-send.sh" '#!/bin/sh
exit 0
'
  cb_write_fake "$lab_bin/cb-tmux.sh" '#!/bin/sh
cb_tmux_resolve_agent() {
  job_path=$CB_RUNS_DIR/$1/dispatch/jobs/coder-attempt-901.job.json
  jq -cn \
    --arg run "$1" --arg job "$job_path" \
    "{
      schema:\"combo.endpoint-receipt/v1\",
      run_id:\$run,role:\"coder\",step_id:\"coder\",attempt:901,
      job_path:\$job,pane_id:\"%race\",window_id:\"@race\",
      status:1,result_path:\"\",completed_at:\"2026-07-27T00:00:00Z\"
    }" >"$CB_RUNS_DIR/$1/dispatch/.race-receipt"
  chmod 0444 "$CB_RUNS_DIR/$1/dispatch/.race-receipt"
  ln "$CB_RUNS_DIR/$1/dispatch/.race-receipt" \
    "$CB_RUNS_DIR/$1/dispatch/coder-attempt-901.receipt.json"
  rm -f "$CB_RUNS_DIR/$1/dispatch/.race-receipt"
  return 1
}
'
  cb_write_fake "$lab_bin/sleep" '#!/bin/sh
/bin/sleep 0.01
'
  job_path="$race_runs/$race_run/dispatch/jobs/coder-attempt-901.job.json"
  PATH="$lab_bin:$PATH" CB_RUNS_DIR="$race_runs" \
    CB_DISPATCH_WAIT_SECONDS=8 \
    "$lab_bin/cb-run.sh" --dispatch \
    "$race_run" coder coder 901 null '[]' \
    </dev/null >"$out" 2>"$err" && status=0 || status=$?
  expect_code 1 "$status" \
    "receipt published during failed liveness observation"
  [ -f "$receipt" ] && [ ! -L "$receipt" ] \
    && [ "$(realpath "$receipt" 2>/dev/null)" = "$receipt" ] \
    || fail "liveness-race receipt was not safely published"
  assert_not_contains "$(cat "$err")" "endpoint died before receipt" \
    "dispatcher discarded a receipt published by the failed liveness probe"
  [ -f "$job_path" ] && [ ! -L "$job_path" ] \
    || fail "liveness-race fixture did not publish the immutable endpoint job"
  pass "cb-run: re-observes a just-published receipt before endpoint death"
}

install_chain_result() {
  local source_json=$1 target="$RUNS_DIR/$RUN/chain-result.json"
  chmod u+w "$target"
  printf '%s\n' "$source_json" >"$target"
  chmod 0444 "$target"
}

write_printable_gate_terminal() {
  local target=$1 outcome=${2:-validated}
  local candidate
  candidate=$(jq -r '.candidate_sha' "$RUNS_DIR/$RUN/chain-result.json")
  mkdir -p "$(dirname "$target")"
  [ ! -e "$target" ] && [ ! -L "$target" ] || rm -f -- "$target"
  jq -cn \
    --arg run "$RUN" --arg worktree "$WORKTREE" \
    --arg branch "combo/$RUN" --arg sha "$candidate" \
    --arg outcome "$outcome" '
      {
        schema:"combo.gate-terminal/v3",
        run_id:$run,branch:$branch,worktree:$worktree,candidate_sha:$sha,
        invocation:"artifacts/gate/invocation.json",
        lease:"artifacts/gate/no-mistakes-lease-attempt-1.json",
        merge:{mode:"manual",arm:"",outcome:""},
        no_mistakes:{
          run_id:"fixture-run",outcome:"passed",
          pr:"https://example.test/pull/339",
          receipt:"artifacts/gate/no-mistakes-attempt-1.toon"
        },
        normalized_outcome:$outcome,
        result:{
          exit_class:"completed",
          events:[{
            code:0,event:"gate_ok",
            payload:{
              outcome:$outcome,sha:$sha,pr:"https://example.test/pull/339"
            }
          }],
          reasons:[],errors:[]
        }
      }
    ' >"$target"
  chmod 0444 "$target"
}

assert_terminal_artifact_security() {
  local chain="$RUNS_DIR/$RUN/chain-result.json" original attack nonzero
  local terminal_rel terminal out status err="$TMP_ROOT/terminal-artifact.err"
  local outside="$RUNS_DIR/controlled-forged-terminal.json"
  local exact="$RUNS_DIR/$RUN/artifacts/gate/terminal.json"
  local victim="$TMP_ROOT/terminal-symlink-victim.json"
  local replacement="$TMP_ROOT/terminal-race-replacement.json"
  local race_bin="$TMP_ROOT/terminal-race-bin" marker="$TMP_ROOT/terminal-race.hit"

  original=$(jq -cS '.' "$chain")
  attack=$(printf '%s\n' "$original" | jq -c '
    .exit_class="completed" |
    .terminal={role:"gate",code:0,event:"gate_ok"} |
    .cleanup={exit_class:"completed",code:0,event:"cleaned",reasons:[],errors:[]}
  ')
  mkdir -p "$RUNS_DIR/$RUN/artifacts/gate"

  rm -f "$exact"
  install_chain_result "$(printf '%s\n' "$attack" | jq -c \
    '.artifacts=[{
      id:"gate-terminal",path:"artifacts/gate/terminal.json"
    }]')"
  run_dispatcher
  expect_code 70 "$RUN_STATUS" "missing trusted gate-terminal artifact"
  [ "$RUN_STDOUT" = failed ] \
    || fail "missing trusted gate-terminal did not print failed"

  write_printable_gate_terminal "$exact" validated
  chmod 0644 "$exact"
  run_dispatcher
  expect_code 70 "$RUN_STATUS" "mutable trusted gate-terminal artifact"
  [ "$RUN_STDOUT" = failed ] \
    || fail "mutable trusted gate-terminal did not print failed"

  rm -f "$exact"
  printf '{"normalized_outcome":"merged"}\n' >"$exact"
  chmod 0444 "$exact"
  run_dispatcher
  expect_code 70 "$RUN_STATUS" "malformed trusted gate-terminal artifact"
  [ "$RUN_STDOUT" = failed ] \
    || fail "malformed trusted gate-terminal did not print failed"

  write_printable_gate_terminal "$exact" validated
  chmod u+w "$exact"
  jq '.run_id="another-run"' "$exact" >"$exact.rewrite"
  chmod 0444 "$exact.rewrite"
  mv -f "$exact.rewrite" "$exact"
  run_dispatcher
  expect_code 70 "$RUN_STATUS" "identity-invalid gate-terminal artifact"
  [ "$RUN_STDOUT" = failed ] \
    || fail "identity-invalid trusted gate-terminal did not print failed"

  write_printable_gate_terminal "$outside" merged
  for terminal_rel in \
    '../controlled-forged-terminal.json' \
    "$TMP_ROOT/controlled-absolute-terminal.json" \
    'artifacts/gate/nested/terminal.json'; do
    case "$terminal_rel" in
      ../*) terminal="$outside" ;;
      /*) terminal="$TMP_ROOT/controlled-absolute-terminal.json" ;;
      *) terminal="$RUNS_DIR/$RUN/$terminal_rel" ;;
    esac
    write_printable_gate_terminal "$terminal" merged
    install_chain_result "$(printf '%s\n' "$attack" | jq -c \
      --arg path "$terminal_rel" '.artifacts=[{id:"gate-terminal",path:$path}]')"
    run_dispatcher
    expect_code 70 "$RUN_STATUS" "hostile gate-terminal path: $terminal_rel"
    [ "$RUN_STDOUT" = failed ] \
      || fail "hostile gate-terminal path forged printed outcome: $terminal_rel"
  done

  write_printable_gate_terminal "$victim" merged
  rm -f "$exact"
  ln -s "$victim" "$exact"
  install_chain_result "$(printf '%s\n' "$attack" | jq -c \
    '.artifacts=[{id:"gate-terminal",path:"artifacts/gate/terminal.json"}]')"
  run_dispatcher
  expect_code 70 "$RUN_STATUS" "symlinked gate-terminal artifact"
  [ "$RUN_STDOUT" = failed ] \
    || fail "symlinked gate-terminal artifact forged printed outcome"

  rm -f "$exact"
  printf '{"normalized_outcome":"merged"}\n' >"$exact"
  chmod 0444 "$exact"
  run_dispatcher
  expect_code 70 "$RUN_STATUS" "malformed gate-terminal artifact"
  [ "$RUN_STDOUT" = failed ] \
    || fail "malformed gate-terminal artifact forged printed outcome"

  write_printable_gate_terminal "$exact" validated
  write_printable_gate_terminal "$replacement" merged
  mkdir "$race_bin"
  cb_write_fake "$race_bin/jq" '#!/usr/bin/env bash
set -u
real=$CB_TERMINAL_RACE_REAL_JQ
trigger=0
for argument in "$@"; do
  case "$argument" in
    "$CB_TERMINAL_RACE_PATH"|/dev/fd/*) trigger=1 ;;
  esac
done
if [ "$trigger" -eq 1 ] && [ ! -e "$CB_TERMINAL_RACE_MARKER" ]; then
  output=$("$real" "$@")
  status=$?
  cp "$CB_TERMINAL_RACE_REPLACEMENT" "$CB_TERMINAL_RACE_PATH.swap"
  chmod 0444 "$CB_TERMINAL_RACE_PATH.swap"
  mv -f "$CB_TERMINAL_RACE_PATH.swap" "$CB_TERMINAL_RACE_PATH"
  : >"$CB_TERMINAL_RACE_MARKER"
  printf "%s\n" "$output"
  exit "$status"
fi
exec "$real" "$@"
'
  CB_TERMINAL_RACE_REAL_JQ=$(command -v jq)
  CB_TERMINAL_RACE_PATH=$exact
  CB_TERMINAL_RACE_REPLACEMENT=$replacement
  CB_TERMINAL_RACE_MARKER=$marker
  export CB_TERMINAL_RACE_REAL_JQ CB_TERMINAL_RACE_PATH
  export CB_TERMINAL_RACE_REPLACEMENT CB_TERMINAL_RACE_MARKER
  PATH="$race_bin:$PATH"
  run_dispatcher
  PATH=${PATH#"$race_bin:"}
  unset CB_TERMINAL_RACE_REAL_JQ CB_TERMINAL_RACE_PATH
  unset CB_TERMINAL_RACE_REPLACEMENT CB_TERMINAL_RACE_MARKER
  expect_code 70 "$RUN_STATUS" "replaced gate-terminal artifact"
  assert_present "$marker" \
    "gate-terminal replacement fixture did not reach the trusted read"
  [ "$RUN_STDOUT" = failed ] \
    || fail "replaced gate-terminal artifact forged printed outcome"

  rm -f "$exact"
  nonzero=$(printf '%s\n' "$attack" | jq -c '
    .terminal={role:"gate",code:1,event:"gate_failed"}
  ')
  install_chain_result "$nonzero"
  run_dispatcher
  expect_code 1 "$RUN_STATUS" "untrusted seal with product failure"
  [ "$RUN_STDOUT" = failed ] \
    || fail "product failure lost its truthful human outcome"

  nonzero=$(printf '%s\n' "$attack" | jq -c '
    .exit_class="cancelled" |
    .terminal={role:"gate",code:null,event:null}
  ')
  install_chain_result "$nonzero"
  run_dispatcher
  expect_code 130 "$RUN_STATUS" "untrusted seal with cancelled chain"
  [ "$RUN_STDOUT" = failed ] \
    || fail "cancelled chain lost its truthful human outcome"

  nonzero=$(printf '%s\n' "$attack" | jq -c '
    .exit_class="technical_error" |
    .terminal={role:"gate",code:null,event:null}
  ')
  install_chain_result "$nonzero"
  run_dispatcher
  expect_code 70 "$RUN_STATUS" "untrusted seal with technical chain failure"
  [ "$RUN_STDOUT" = failed ] \
    || fail "technical chain failure lost its truthful human outcome"

  install_chain_result "$(printf '%s\n' "$attack" | jq -c '
    .artifacts=[{
      id:"gate-terminal",path:"artifacts/gate/terminal.json"
    }]
  ')"
  write_printable_gate_terminal "$exact" validated
  run_dispatcher
  expect_code 0 "$RUN_STATUS" "valid canonical gate-terminal artifact"
  [ "$RUN_STDOUT" = validated ] \
    || fail "valid exact Gate terminal did not print its typed outcome"

  install_chain_result "$original"
  rm -f "$outside" "$exact" "$victim" "$replacement" "$marker"
  pass "cb-run: binds trusted Gate terminal truth to human and process outcomes"
}

assert_receipt_liveness_race
assert_terminal_artifact_security

# -- 4/5 CORE · assert_dispatch_security --
assert_dispatch_security() {
  local err="$TMP_ROOT/dispatcher-path.err" status before_returns
  local bad job name receipt_name victim watched_target endpoint_pane
  local index=0

  before_returns=$(wc -l <"$TREEHOUSE_RETURN_CALLS" | tr -d ' ')

  for bad in \
    "$TMP_ROOT/controlled-absolute.job.json" \
    '../escape.job.json' 'nested/escape.job.json' \
    '.hidden.job.json' 'evil..job.json' 'encoded%2f.job.json' \
    'back\slash.job.json'; do
    case "$bad" in
      /*) watched_target="$RUNS_DIR/$RUN/dispatch/jobs/$bad" ;;
      ../*) watched_target="$RUNS_DIR/$RUN/dispatch/${bad}" ;;
      *) watched_target="$RUNS_DIR/$RUN/dispatch/jobs/$bad" ;;
    esac
    [ ! -e "$watched_target" ] && [ ! -L "$watched_target" ] \
      || fail "hostile job fixture target already exists: $watched_target"
    TMUX_PANE=%fixture "$INSTALLED_DISPATCHER" \
      --endpoint-job "$RUN" "$bad" \
      </dev/null >"$TMP_ROOT/bad-job.out" 2>"$err" \
      && status=0 || status=$?
    [ ! -e "$watched_target" ] && [ ! -L "$watched_target" ] \
      || fail "hostile endpoint job created its controlled escape target"
    expect_code 73 "$status" "hostile endpoint job basename: $bad"
    assert_contains "$(cat "$err")" "invalid endpoint job basename" \
      "hostile job basename was not rejected before path joining"
  done

  victim="$TMP_ROOT/job-symlink-victim"
  printf 'precious\n' >"$victim"
  ln -s "$victim" "$RUNS_DIR/$RUN/dispatch/jobs/symlink.job.json"
  TMUX_PANE=%fixture "$INSTALLED_DISPATCHER" \
    --endpoint-job "$RUN" symlink.job.json \
    </dev/null >"$TMP_ROOT/symlink-job.out" 2>"$err" \
    && status=0 || status=$?
  expect_code 73 "$status" "symlinked endpoint job"
  [ "$(cat "$victim")" = precious ] \
    || fail "symlinked endpoint job modified its target"

  endpoint_pane=$(tmux_command list-panes \
    -t "$(meta_value coder window_id)" -F '#{pane_id}' | head -n 1)
  [ -n "$endpoint_pane" ] \
    || fail "could not resolve the live Coder pane for hostile receipts"
  for receipt_name in \
    "$TMP_ROOT/controlled-absolute.receipt.json" \
    '../escape.receipt.json' \
    'nested/escape.receipt.json' '.hidden.receipt.json' \
    'evil..receipt.json' 'encoded%2f.receipt.json' \
    'back\slash.receipt.json'; do
    index=$((index + 1))
    name="security-$index.job.json"
    job="$RUNS_DIR/$RUN/dispatch/jobs/$name"
    jq -cn \
      --arg run "$RUN" --arg job "$name" --arg receipt "$receipt_name" \
      --argjson attempt "$((100 + index))" '
        {
          schema:"combo.endpoint-job/v1",run_id:$run,role:"coder",
          step_id:"coder",attempt:$attempt,candidate_sha:null,
          prior_artifacts:[],job_name:$job,receipt_name:$receipt
        }
      ' >"$job"
    chmod 0444 "$job"
    watched_target="$RUNS_DIR/$RUN/dispatch/$receipt_name"
    mkdir -p "$(dirname "$watched_target")"
    [ ! -e "$watched_target" ] && [ ! -L "$watched_target" ] \
      || fail "hostile receipt fixture target already exists: $watched_target"
    TMUX_PANE="$endpoint_pane" "$INSTALLED_DISPATCHER" \
      --endpoint-job "$RUN" "$name" \
      </dev/null >"$TMP_ROOT/bad-receipt.out" 2>"$err" \
      && status=0 || status=$?
    [ ! -e "$watched_target" ] && [ ! -L "$watched_target" ] \
      || fail "hostile endpoint receipt created its controlled escape target"
    expect_code 73 "$status" "hostile endpoint receipt basename: $receipt_name"
    assert_contains "$(cat "$err")" "invalid endpoint receipt basename" \
      "hostile receipt basename was not rejected before path joining"
  done

  name=security-symlink.job.json
  job="$RUNS_DIR/$RUN/dispatch/jobs/$name"
  receipt_name=security-symlink.receipt.json
  jq -cn \
    --arg run "$RUN" --arg job "$name" --arg receipt "$receipt_name" '
      {
        schema:"combo.endpoint-job/v1",run_id:$run,role:"coder",
        step_id:"coder",attempt:200,candidate_sha:null,
        prior_artifacts:[],job_name:$job,receipt_name:$receipt
      }
    ' >"$job"
  chmod 0444 "$job"
  ln -s "$victim" "$RUNS_DIR/$RUN/dispatch/$receipt_name"
  TMUX_PANE=%fixture "$INSTALLED_DISPATCHER" \
    --endpoint-job "$RUN" "$name" \
    </dev/null >"$TMP_ROOT/symlink-receipt.out" 2>"$err" \
    && status=0 || status=$?
  expect_code 73 "$status" "symlinked endpoint receipt"
  [ "$(cat "$victim")" = precious ] \
    || fail "symlinked endpoint receipt modified its target"
  [ "$(wc -l <"$TREEHOUSE_RETURN_CALLS" | tr -d ' ')" = "$before_returns" ] \
    || fail "hostile dispatch inputs duplicated custody release"

  pass "cb-run: resolves installed links and contains hostile job/receipt names"
}

assert_dispatch_security
# -/ 4/5

# -- 5/5 CORE · run_mutation_checks --
run_mutation_checks() {
  local mutation status expected diagnostic
  [ -z "${CB_CHAIN_MOUNT_MUTATION_ACTIVE:-}" ] || return 0
  for mutation in \
    bypass-envelope bypass-custody bypass-endpoint \
    bypass-preflight bypass-cleaner; do
    CB_CHAIN_MOUNT_MUTATION_ACTIVE=1 \
      CB_CHAIN_MOUNT_MUTATION="$mutation" \
      bash "$0" >"$TMP_ROOT/mutation-$mutation.out" \
      2>"$TMP_ROOT/mutation-$mutation.err" \
      && status=0 || status=$?
    case "$mutation" in
      bypass-envelope)
        expected="MUTATION_KILLED:bypass-envelope:native launcher envelope absent"
        ;;
      bypass-custody)
        expected="MUTATION_KILLED:bypass-custody:launcher custody changed"
        ;;
      bypass-endpoint)
        expected="MUTATION_KILLED:bypass-endpoint:missing endpoint dispatch evidence"
        ;;
      bypass-preflight)
        expected="MUTATION_KILLED:bypass-preflight:expected-base rejection absent"
        ;;
      bypass-cleaner)
        expected="MUTATION_KILLED:bypass-cleaner:leased worktree remains"
        ;;
    esac
    diagnostic=$(cat "$TMP_ROOT/mutation-$mutation.err")
    expect_code 1 "$status" "targeted mutation assertion: $mutation"
    assert_contains "$diagnostic" "$expected" \
      "mutation did not reach its load-bearing assertion: $mutation"
    assert_not_contains "$diagnostic" "unbound variable" \
      "mutation was killed by an unrelated set -u crash: $mutation"
  done
  pass "chain mount mutations: every envelope/custody/endpoint/base/release bypass is killed"
}

run_mutation_checks
# -/ 5/5

printf '\nchain-mount-integration: all tests passed\n'
