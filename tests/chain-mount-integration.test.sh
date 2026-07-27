#!/usr/bin/env bash
# @overview Deterministic mounted-chain acceptance for the Combo v1 dispatcher.
#   Uses real isolated tmux windows plus fake Treehouse, Coder, Reviewer,
#   No-Mistakes, and GitHub boundaries to prove endpoint execution, immutable
#   Launcher custody, expected-base rejection, resume, and exact cleanup.
#
#   READING GUIDE
#   -------------
#   1. Fixture commands and config       <- deterministic five-seat inputs.
#   2. run_mounted_chain                 <- interrupt then resume one run.
#   3. assert_mounted_evidence           <- artifact-only acceptance checks.
#   4. run_mutation_checks               <- prove each bypass is detected.
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
#   cleanup_fixture, tmux_command, meta_value, write_config,
#   run_mounted_chain, assert_mounted_evidence, run_mutation_checks
#
# @exports none
# @deps bash, git, jq, tmux, tests/lib.sh, bin/cb-plan.sh, bin/cb-run.sh,
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

# -- 1/4 HELPER · Fixture commands and immutable config --
git -C "$REPO" init -q -b main
git -C "$REPO" config user.name "Combo Mount Test"
git -C "$REPO" config user.email "combo-mount@example.test"
printf 'base\n' >"$REPO/work.txt"
git -C "$REPO" add work.txt
git -C "$REPO" commit -qm "fixture base"
BASE_SHA=$(git -C "$REPO" rev-parse HEAD)

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
# -/ 1/4

# -- 2/4 CORE · run_mounted_chain -- <- START HERE
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

RUN_STATUS=
RUN_STDOUT=
RUN_STDERR=
run_dispatcher() {
  local stop_after=${1:-} err="$TMP_ROOT/run.err"
  if [ "$MUTATION" = bypass-endpoint ]; then
    RUN_STDOUT=$(CB_CHAIN_STOP_AFTER_ROLE="$stop_after" \
      bash "$BIN/cb-chain.sh" "$RUN" 2>"$err") \
      && RUN_STATUS=0 || RUN_STATUS=$?
  else
    RUN_STDOUT=$(CB_CHAIN_STOP_AFTER_ROLE="$stop_after" \
      bash "$BIN/cb-run.sh" "$RUN" 2>"$err") \
      && RUN_STATUS=0 || RUN_STATUS=$?
  fi
  RUN_STDERR=$(cat "$err" 2>/dev/null || true)
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
    printf '{"schema":"stale-endpoint-job/v1"}\n' \
      >"$RUNS_DIR/$RUN/dispatch/jobs/coder-attempt-1.json"
    chmod 0444 "$RUNS_DIR/$RUN/dispatch/jobs/coder-attempt-1.json"
    printf 'advanced after custody\n' >"$REPO/base-advance.txt"
    git -C "$REPO" add base-advance.txt
    git -C "$REPO" commit -qm "fixture advances symbolic base"
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
  expect_code 1 "$RUN_STATUS" \
    "mounted expected-base rejection${RUN_STDERR:+: $RUN_STDERR}"
  [ "$RUN_STDOUT" = failed ] \
    || fail "dispatcher must print exactly one truthful failed outcome"
}

run_mounted_chain
# -/ 2/4

# -- 3/4 CORE · assert_mounted_evidence --
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
# -/ 3/4

# -- 4/4 CORE · run_mutation_checks --
run_mutation_checks() {
  local mutation status
  [ -z "${CB_CHAIN_MOUNT_MUTATION_ACTIVE:-}" ] || return 0
  for mutation in \
    bypass-envelope bypass-custody bypass-endpoint \
    bypass-preflight bypass-cleaner; do
    CB_CHAIN_MOUNT_MUTATION_ACTIVE=1 \
      CB_CHAIN_MOUNT_MUTATION="$mutation" \
      bash "$0" >"$TMP_ROOT/mutation-$mutation.out" \
      2>"$TMP_ROOT/mutation-$mutation.err" \
      && status=0 || status=$?
    [ "$status" -ne 0 ] \
      || fail "integration acceptance survived mutation: $mutation"
  done
  pass "chain mount mutations: every envelope/custody/endpoint/base/release bypass is killed"
}

run_mutation_checks
# -/ 4/4

printf '\nchain-mount-integration: all tests passed\n'
