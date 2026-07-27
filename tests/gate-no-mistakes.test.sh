#!/usr/bin/env bash
# @overview Contract tests for the P7 No-Mistakes Gate adapter. Proves the
#   universal P4 envelope reaches a Gate that seals the Launcher-owned exact
#   branch/head, proves the configured Pi/DeepSeek identity against the effective
#   No-Mistakes config plus the observed version/AXI help contract, builds
#   documented axi argv, resolves one GitHub PR at that exact branch/head,
#   records its target branch's strict app-aware check policy with exact-SHA
#   check/status evidence, seals authenticated GitHub merged/failed/cancelled
#   outcomes, bounds armed-OPEN merge waiting before the host-global lease can
#   starve sibling runs, and replays durable invocation/terminal seals without
#   starting a duplicate delivery or PR lookup.
#
#   READING GUIDE
#   -------------
#   1. test_validates_exact_sha     <- canonical validated-mode invocation.
#   2. test_recovers_exact_pr       <- returned URL plus unique branch fallback.
#   3. test_seals_configured_identity <- immutable runtime/model + AXI surface.
#   4. test_rejects_candidate_drift <- no Gate call after the reviewed SHA moves.
#   5. test_maps_terminal_outcomes  <- passed, failed, and cancelled normalization.
#   6. test_guards_argument_edges   <- Bash 3.2 empty arrays and skip policy.
#   7. test_replays_terminal_seal   <- idempotent terminal recovery.
#   8. test_adopts_interrupted_run  <- retry one sealed in-progress invocation.
#   9. test_serializes_global_gate  <- cross-run exclusion and stale recovery.
#   10. test_arms_auto_merge_once   <- exact arm, bounded wait, final recovery.
#   11. test_seals_github_terminal_outcomes <- failed/cancelled fact recovery.
#
#   MAIN FLOW
#   ---------
#   fixture plan -> cb-step gate -> cb-gate -> fake axi -> normalized result
#
#   PUBLIC API
#   ----------
#   none
#
#   INTERNALS
#   ---------
#   write_config, write_no_mistakes_identity, make_run, run_gate,
#   invocation_args, wait_for_path
#
# @exports none
# @deps bash, cksum, date, git, gh-compatible fake, jq, ps, stat, touch,
#   tests/lib.sh, bin/cb-plan.sh, bin/cb-step.sh, bin/cb-gate.sh
set -u

# shellcheck source=tests/lib.sh disable=SC1091
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

BIN="$ROOT/bin"
TMP_ROOT=
cb_tmproot TMP_ROOT cb-gate-no-mistakes
RUNS_DIR="$TMP_ROOT/runs"
FAKE_ROLE="$TMP_ROOT/fake-role-adapter"
FAKE_NM="$TMP_ROOT/fake-no-mistakes"
FAKE_BIN_DIR="$TMP_ROOT/fake-bin"
FAKE_GH="$FAKE_BIN_DIR/gh"
FAKE_NM_HOME="$TMP_ROOT/no-mistakes-home"
FAKE_NM_CONFIG="$FAKE_NM_HOME/.no-mistakes/config.yaml"
NM_ARGV="$TMP_ROOT/no-mistakes.argv"
NM_CWD="$TMP_ROOT/no-mistakes.cwd"
NM_CALLED="$TMP_ROOT/no-mistakes.called"
NM_CALLS="$TMP_ROOT/no-mistakes.calls"
NM_ACTIVE="$TMP_ROOT/no-mistakes.active"
NM_STARTS="$TMP_ROOT/no-mistakes.starts"
NM_ATTACHES="$TMP_ROOT/no-mistakes.attaches"
NM_SERIAL_ACTIVE="$TMP_ROOT/no-mistakes.serial-active"
NM_SERIAL_ENTERED="$TMP_ROOT/no-mistakes.serial-entered"
NM_SERIAL_OVERLAP="$TMP_ROOT/no-mistakes.serial-overlap"
GH_CALLS="$TMP_ROOT/gh.calls"
GH_AUTO_MERGE_STATE="$TMP_ROOT/gh.auto-merge-state"
GH_ARM_INTERRUPT="$TMP_ROOT/gh.arm-interrupt"
GATE_LEASES_DIR="$TMP_ROOT/gate-leases"
mkdir -p "$RUNS_DIR"
mkdir -p "$FAKE_BIN_DIR"
mkdir -p "$FAKE_NM_HOME/.no-mistakes"
export CB_RUNS_DIR="$RUNS_DIR"
export CB_GATE_LEASES_DIR="$GATE_LEASES_DIR"
export CB_GATE_TEST_ARGV="$NM_ARGV"
export CB_GATE_TEST_CWD="$NM_CWD"
export CB_GATE_TEST_CALLED="$NM_CALLED"
export CB_GATE_TEST_CALLS="$NM_CALLS"
export CB_GATE_TEST_ACTIVE="$NM_ACTIVE"
export CB_GATE_TEST_STARTS="$NM_STARTS"
export CB_GATE_TEST_ATTACHES="$NM_ATTACHES"
export CB_GATE_TEST_SERIAL_ACTIVE="$NM_SERIAL_ACTIVE"
export CB_GATE_TEST_SERIAL_ENTERED="$NM_SERIAL_ENTERED"
export CB_GATE_TEST_SERIAL_OVERLAP="$NM_SERIAL_OVERLAP"
export CB_GATE_TEST_GH_CALLS="$GH_CALLS"
export CB_GATE_TEST_GH_AUTO_MERGE_STATE="$GH_AUTO_MERGE_STATE"
export CB_GATE_TEST_GH_MODE=exact
export PATH="$FAKE_BIN_DIR:$PATH"

CMD_STATUS=
CMD_STDOUT=
CMD_STDERR=
RUN_HEAD=
RUN_BRANCH=
RUN_REPO=

cb_write_fake "$FAKE_ROLE" '#!/usr/bin/env bash
exit 99
'

cb_write_fake "$FAKE_NM" '#!/usr/bin/env bash
set -u
if [ "$#" -eq 1 ] && [ "$1" = --version ]; then
  printf "%s\n" "no-mistakes version v-test (fake)"
  exit 0
fi
if [ "$#" -eq 1 ] && [ "$1" = doctor ]; then
  printf "%s\n" "  gate validation  pi is runnable"
  exit 0
fi
if [ "$#" -eq 3 ] && [ "$1" = axi ] && [ "$3" = --help ]; then
  case "$2" in
    run)
      cat <<EOF
Usage:
  no-mistakes axi run [flags]
      --intent string
      --skip string
  -y, --yes
EOF
      ;;
    status)
      cat <<EOF
Usage:
  no-mistakes axi status [flags]
      --run string
EOF
      ;;
    respond)
      cat <<EOF
Usage:
  no-mistakes axi respond [flags]
      --action string
  -y, --yes
EOF
      ;;
    *) exit 64 ;;
  esac
  exit 0
fi
: >"$CB_GATE_TEST_ARGV"
for argument in "$@"; do
  printf "%s\n" "$argument" >>"$CB_GATE_TEST_ARGV"
done
pwd -P >"$CB_GATE_TEST_CWD"
printf "called\n" >"$CB_GATE_TEST_CALLED"
printf "called\n" >>"$CB_GATE_TEST_CALLS"

serial_owned=0
if mkdir "$CB_GATE_TEST_SERIAL_ACTIVE" 2>/dev/null; then
  serial_owned=1
else
  : >"$CB_GATE_TEST_SERIAL_OVERLAP"
fi
cleanup_serial() {
  [ "$serial_owned" -eq 0 ] || rmdir "$CB_GATE_TEST_SERIAL_ACTIVE" 2>/dev/null || true
}
trap cleanup_serial EXIT
printf "%s\n" "$CB_GATE_TEST_BRANCH" >>"$CB_GATE_TEST_SERIAL_ENTERED"

outcome=
for argument in "$@"; do
  case "$argument" in
    --fake-outcome=*) outcome=${argument#*=} ;;
  esac
done
[ -n "$outcome" ] || outcome=passed
pr=https://example.test/pull/7
if [ "$outcome" = passed-no-pr ]; then
  outcome=passed
  pr=
fi
if [ "$outcome" = interrupt-once ]; then
  if [ ! -f "$CB_GATE_TEST_ACTIVE" ]; then
    printf "fake-gate-run\n" >"$CB_GATE_TEST_ACTIVE"
    printf "started\n" >>"$CB_GATE_TEST_STARTS"
    gate_pid=$(ps -o ppid= -p "$PPID" | tr -d " ")
    kill -TERM "$gate_pid"
    exit 75
  fi
  printf "attached\n" >>"$CB_GATE_TEST_ATTACHES"
  outcome=passed
fi
if [ "$outcome" = slow-passed ]; then
  sleep 0.4
  outcome=passed
fi
status=completed
[ "$outcome" != failed ] || status=failed
[ "$outcome" != cancelled ] || status=cancelled

cat <<EOF
run:
  id: "fake-gate-run"
  branch: $CB_GATE_TEST_BRANCH
  status: $status
  head: ${CB_GATE_TEST_HEAD:0:8}
  pr: "$pr"
  findings: none
outcome: $outcome
EOF
[ "$outcome" = passed ] || [ "$outcome" = checks-passed ]
'

cb_write_fake "$FAKE_GH" '#!/usr/bin/env bash
set -eu
{
  separator=
  for argument in "$@"; do
    printf "%s%s" "$separator" "$argument"
    separator="	"
  done
  printf "\n"
} >>"$CB_GATE_TEST_GH_CALLS"

mode=${CB_GATE_TEST_GH_MODE:-exact}
url=https://example.test/pull/7
branch=$CB_GATE_TEST_BRANCH
head=$CB_GATE_TEST_HEAD
case "$mode" in
  wrong-branch) branch=combo/wrong-branch ;;
  wrong-head) head=0000000000000000000000000000000000000000 ;;
esac

case "$1" in
  repo)
    [ "$#" -eq 4 ] && [ "$2" = view ] &&
      [ "$3" = --json ] && [ "$4" = nameWithOwner,url ] || exit 64
    jq -cn \
      "{nameWithOwner:\"acme/repo\",url:\"https://example.test\"}"
    ;;
  api)
    [ "$#" -eq 2 ] || exit 64
    if [ "$2" = \
      "repos/acme/repo/branches/main/protection/required_status_checks" ]; then
      strict=true
      [ "${CB_GATE_TEST_GH_POLICY_MODE:-strict}" != loose ] || strict=false
      jq -cn --argjson strict "$strict" \
        "{
          strict:\$strict,
          contexts:[\"backend\",\"frontend\"],
          checks:[
            {context:\"backend\",app_id:101},
            {context:\"frontend\",app_id:-1}
          ]
        }"
    elif [ "$2" = \
      "repos/acme/repo/commits/$CB_GATE_TEST_HEAD/check-runs?filter=latest&per_page=100" ]; then
      backend_app=101
      backend_conclusion=success
      check_head=$CB_GATE_TEST_HEAD
      [ "${CB_GATE_TEST_GH_CHECK_MODE:-complete}" != unrelated ] ||
        backend_app=202
      [ "${CB_GATE_TEST_GH_CHECK_MODE:-complete}" != stale ] ||
        check_head=0000000000000000000000000000000000000000
      if [ -f "$CB_GATE_TEST_GH_AUTO_MERGE_STATE" ] &&
        [ "$(cat "$CB_GATE_TEST_GH_AUTO_MERGE_STATE")" = failed-then-closed ]; then
        backend_conclusion=failure
      fi
      jq -cn --argjson backend_app "$backend_app" --arg head "$check_head" \
        --arg conclusion "$backend_conclusion" \
        "{
          total_count:2,
          check_runs:[
            {
              name:\"backend\",
              head_sha:\$head,
              status:\"completed\",
              conclusion:\$conclusion,
              app:{id:\$backend_app}
            },
            {
              name:\"unrelated-check\",
              head_sha:\$head,
              status:\"completed\",
              conclusion:\"success\",
              app:{id:202}
            }
          ]
        }"
    elif [ "$2" = \
      "repos/acme/repo/commits/$CB_GATE_TEST_HEAD/status?per_page=100" ]; then
      if [ "${CB_GATE_TEST_GH_CHECK_MODE:-complete}" = unrelated ]; then
        jq -cn --arg head "$CB_GATE_TEST_HEAD" \
          "{sha:\$head,total_count:1,statuses:[
            {context:\"unrelated-frontend\",state:\"success\"}
          ]}"
      else
        jq -cn --arg head "$CB_GATE_TEST_HEAD" \
          "{sha:\$head,total_count:2,statuses:[
            {context:\"frontend\",state:\"success\"},
            {context:\"unrelated-status\",state:\"success\"}
          ]}"
      fi
    else
      exit 64
    fi
    ;;
  pr)
    [ "$#" -ge 3 ] || exit 64
    case "$2" in
      view)
    [ "$#" -eq 5 ] && [ "$3" = "$url" ] && [ "$4" = --json ] || exit 64
    case "$5" in
      url,headRefName,headRefOid)
        jq -cn --arg url "$url" --arg branch "$branch" --arg head "$head" \
          "{url:\$url,headRefName:\$branch,headRefOid:\$head}"
        ;;
      url,headRefName,headRefOid,state,autoMergeRequest,mergedAt,mergeCommit)
        auto_merge=null
        state=OPEN
        merged_at=null
        merge_commit=null
        if [ -f "$CB_GATE_TEST_GH_AUTO_MERGE_STATE" ]; then
          case "$(cat "$CB_GATE_TEST_GH_AUTO_MERGE_STATE")" in
            armed)
              auto_merge="{\"mergeMethod\":\"REBASE\"}"
              ;;
            armed-then-merged)
              auto_merge="{\"mergeMethod\":\"REBASE\"}"
              printf "merged\n" >"$CB_GATE_TEST_GH_AUTO_MERGE_STATE"
              ;;
            armed-then-closed)
              auto_merge="{\"mergeMethod\":\"REBASE\"}"
              printf "closed\n" >"$CB_GATE_TEST_GH_AUTO_MERGE_STATE"
              ;;
            armed-then-auto-cancelled)
              auto_merge="{\"mergeMethod\":\"REBASE\"}"
              printf "auto-cancelled\n" >"$CB_GATE_TEST_GH_AUTO_MERGE_STATE"
              ;;
            armed-failed-then-closed)
              auto_merge="{\"mergeMethod\":\"REBASE\"}"
              printf "failed-then-closed\n" >"$CB_GATE_TEST_GH_AUTO_MERGE_STATE"
              ;;
            failed-then-closed)
              state=CLOSED
              ;;
            merged)
              state=MERGED
              merged_at="\"2026-07-27T00:00:00Z\""
              merge_commit="{\"oid\":\"1111111111111111111111111111111111111111\"}"
              ;;
            closed)
              state=CLOSED
              ;;
            auto-cancelled)
              state=OPEN
              ;;
            *) exit 70 ;;
          esac
        fi
        jq -cn \
          --arg url "$url" --arg branch "$branch" --arg head "$head" \
          --arg state "$state" --argjson auto "$auto_merge" \
          --argjson merged_at "$merged_at" \
          --argjson merge_commit "$merge_commit" \
          "{
            url:\$url,
            headRefName:\$branch,
            headRefOid:\$head,
            state:\$state,
            autoMergeRequest:\$auto,
            mergedAt:\$merged_at,
            mergeCommit:\$merge_commit
          }"
        ;;
      url,headRefName,headRefOid,baseRefName,baseRefOid,state,autoMergeRequest,mergeStateStatus,mergeable,mergedAt,mergeCommit)
        auto_merge=null
        state=OPEN
        merged_at=null
        merge_commit=null
        if [ -f "$CB_GATE_TEST_GH_AUTO_MERGE_STATE" ]; then
          case "$(cat "$CB_GATE_TEST_GH_AUTO_MERGE_STATE")" in
            armed)
              auto_merge="{\"mergeMethod\":\"REBASE\"}"
              ;;
            armed-then-merged)
              auto_merge="{\"mergeMethod\":\"REBASE\"}"
              printf "merged\n" >"$CB_GATE_TEST_GH_AUTO_MERGE_STATE"
              ;;
            armed-then-closed)
              auto_merge="{\"mergeMethod\":\"REBASE\"}"
              printf "closed\n" >"$CB_GATE_TEST_GH_AUTO_MERGE_STATE"
              ;;
            armed-then-auto-cancelled)
              auto_merge="{\"mergeMethod\":\"REBASE\"}"
              printf "auto-cancelled\n" >"$CB_GATE_TEST_GH_AUTO_MERGE_STATE"
              ;;
            armed-failed-then-closed)
              auto_merge="{\"mergeMethod\":\"REBASE\"}"
              printf "failed-then-closed\n" >"$CB_GATE_TEST_GH_AUTO_MERGE_STATE"
              ;;
            failed-then-closed)
              state=CLOSED
              ;;
            merged)
              state=MERGED
              merged_at="\"2026-07-27T00:00:00Z\""
              merge_commit="{\"oid\":\"1111111111111111111111111111111111111111\"}"
              ;;
            closed)
              state=CLOSED
              ;;
            auto-cancelled)
              state=OPEN
              ;;
            *) exit 70 ;;
          esac
        fi
        jq -cn \
          --arg url "$url" --arg branch "$branch" --arg head "$head" \
          --arg state "$state" --argjson auto "$auto_merge" \
          --argjson merged_at "$merged_at" \
          --argjson merge_commit "$merge_commit" \
          "{
            url:\$url,
            headRefName:\$branch,
            headRefOid:\$head,
            baseRefName:\"main\",
            baseRefOid:\"2222222222222222222222222222222222222222\",
            state:\$state,
            autoMergeRequest:\$auto,
            mergeStateStatus:\"BLOCKED\",
            mergeable:\"MERGEABLE\",
            mergedAt:\$merged_at,
            mergeCommit:\$merge_commit
          }"
        ;;
      *) exit 64 ;;
    esac
    ;;
      list)
    [ "$#" -eq 10 ] && [ "$3" = --head ] &&
      [ "$4" = "$CB_GATE_TEST_BRANCH" ] &&
      [ "$5" = --state ] && [ "$6" = open ] &&
      [ "$7" = --limit ] && [ "$8" = 2 ] &&
      [ "$9" = --json ] &&
      [ "${10}" = url,headRefName,headRefOid ] || exit 64
    case "$mode" in
      zero)
        printf "[]\n"
        ;;
      multiple)
        jq -cn --arg branch "$branch" --arg head "$head" \
          "[
            {url:\"https://example.test/pull/7\",headRefName:\$branch,headRefOid:\$head},
            {url:\"https://example.test/pull/8\",headRefName:\$branch,headRefOid:\$head}
          ]"
        ;;
      *)
        jq -cn --arg url "$url" --arg branch "$branch" --arg head "$head" \
          "[{url:\$url,headRefName:\$branch,headRefOid:\$head}]"
        ;;
    esac
    ;;
      merge)
    [ "$#" -eq 5 ] && [ "$3" = "$url" ] &&
      [ "$4" = --auto ] && [ "$5" = --rebase ] || exit 64
    printf "%s\n" "${CB_GATE_TEST_GH_MERGE_EFFECT:-armed}" \
      >"$CB_GATE_TEST_GH_AUTO_MERGE_STATE"
    if [ -n "${CB_GATE_TEST_GH_INTERRUPT_AFTER_ARM:-}" ] &&
      [ ! -e "$CB_GATE_TEST_GH_INTERRUPT_AFTER_ARM" ]; then
      : >"$CB_GATE_TEST_GH_INTERRUPT_AFTER_ARM"
      gate_pid=$(ps -o ppid= -p "$PPID" | tr -d " ")
      kill -TERM "$gate_pid"
      exit 75
    fi
    printf "auto merge armed\n"
    ;;
      *) exit 64 ;;
    esac
    ;;
  *) exit 64 ;;
esac
'

write_no_mistakes_identity() {
  local model=$1
  printf '%s\n' \
    'agent: pi' \
    'agent_args_override:' \
    '  pi:' \
    '    - --model' \
    "    - $model" >"$FAKE_NM_CONFIG"
}

write_no_mistakes_identity "deepseek/deepseek-v4-pro"

write_config() {
  local path=$1 outcome=$2 arguments=${3:-} merge=${4:-manual}
  local merge_poll_seconds=${5:-} merge_wait_seconds=${6:-}
  if [ -z "$arguments" ]; then
    arguments=$(jq -cn --arg outcome "$outcome" '[("--fake-outcome=" + $outcome)]')
  fi
  jq -n \
    --arg role "$FAKE_ROLE" \
    --arg gate "$BIN/cb-gate.sh" \
    --arg nm "$FAKE_NM" \
    --arg merge "$merge" \
    --arg merge_poll_seconds "$merge_poll_seconds" \
    --arg merge_wait_seconds "$merge_wait_seconds" \
    --argjson arguments "$arguments" '
      {
        schema:"combo.config/v1",
        adapters:{
          launcher:{argv:[$role],roles:["launcher"]},
          coder:{argv:[$role],roles:["coder"]},
          reviewer:{argv:[$role],roles:["reviewer"]},
          gate:{argv:[$gate],roles:["gate"]},
          cleaner:{argv:[$role],roles:["cleaner"]}
        },
        roles:{
          launcher:{adapter:"launcher",config:{}},
          coder:{adapter:"coder",config:{}},
          reviewers:[{id:"review-a",adapter:"reviewer",config:{}}],
          gate:{
            adapter:"gate",
            config:(
              {
                schema:"combo.gate.no-mistakes/v1",
                binary:$nm,
                runtime:"pi",
                model:"deepseek/deepseek-v4-pro",
                arguments:$arguments,
                intent:"validate exact candidate",
                approval:"auto",
                review:true,
                merge:$merge
              } +
              (if $merge_poll_seconds=="" then {} else
                {merge_poll_seconds:($merge_poll_seconds|tonumber)}
              end) +
              (if $merge_wait_seconds=="" then {} else
                {merge_wait_seconds:($merge_wait_seconds|tonumber)}
              end)
            )
          },
          cleaner:{adapter:"cleaner",config:{}}
        }
      }
    ' >"$path"
}

make_run() {
  local run=$1 outcome=$2 merge=${3:-manual}
  local merge_poll_seconds=${4:-} merge_wait_seconds=${5:-} config base
  config="$TMP_ROOT/$run.config.json"
  RUN_REPO="$TMP_ROOT/$run-repo"
  read -r base RUN_HEAD < <(cb_candidate_repo "$RUN_REPO" "$run")
  RUN_BRANCH="combo/$run"
  git -C "$RUN_REPO" switch -qc "$RUN_BRANCH"

  mkdir -p "$RUNS_DIR/$run/agents"
  jq -n \
    --arg run "$run" \
    --arg repo "$RUN_REPO" \
    --arg worktree "$RUN_REPO" \
    --arg branch "$RUN_BRANCH" \
    --arg base "$base" '
      {
        run:$run,
        runway_kind:"git-worktree-explicit",
        repo_dir:$repo,
        worktree:$worktree,
        branch:$branch,
        base_sha:$base,
        ownership_id:("git-worktree:" + $run)
      }
    ' >"$RUNS_DIR/$run/agents/launcher.ownership.json"
  write_config \
    "$config" "$outcome" "" "$merge" \
    "$merge_poll_seconds" "$merge_wait_seconds"
  sh "$BIN/cb-plan.sh" "$run" --config "$config" >/dev/null \
    || fail "could not compile Gate fixture plan for $run"
}

run_gate() {
  local run=$1 candidate=$2 attempt=${3:-1} errfile
  errfile="$TMP_ROOT/$run.err"
  rm -f "$NM_ARGV" "$NM_CWD" "$NM_CALLED"
  export CB_GATE_TEST_BRANCH="$RUN_BRANCH"
  export CB_GATE_TEST_HEAD="$RUN_HEAD"
  CMD_STDOUT=$(HOME="$FAKE_NM_HOME" bash "$BIN/cb-step.sh" \
    "$run" gate "$attempt" --candidate-sha "$candidate" 2>"$errfile") \
    && CMD_STATUS=0 || CMD_STATUS=$?
  CMD_STDERR=$(cat "$errfile" 2>/dev/null || true)
}

invocation_args() {
  jq -Rsc 'split("\n") | map(select(length>0))' "$NM_ARGV"
}

wait_for_path() {
  local path=$1 deadline
  deadline=$(( $(date +%s) + 5 ))
  while [ ! -e "$path" ]; do
    [ "$(date +%s)" -lt "$deadline" ] || return 1
    sleep 0.01
  done
}

# -- 1/11 CORE · test_validates_exact_sha -- <- START HERE
test_validates_exact_sha() {
  local run=gate-exact result receipt
  make_run "$run" passed
  run_gate "$run" "$RUN_HEAD"
  expect_code 0 "$CMD_STATUS" "exact Gate invocation${CMD_STDERR:+: $CMD_STDERR}"
  result=$CMD_STDOUT

  jq -e --arg sha "$RUN_HEAD" '
    .exit_class=="completed" and
    .events==[{
      code:0,
      event:"gate_ok",
      payload:{
        outcome:"validated",
        sha:$sha,
        pr:"https://example.test/pull/7"
      }
    }] and
    .artifacts==[
      {
        id:"gate-invocation",
        path:"artifacts/gate/invocation.json"
      },
      {
        id:"gate-lease",
        path:"artifacts/gate/no-mistakes-lease-attempt-1.json"
      },
      {
        id:"no-mistakes-outcome",
        path:"artifacts/gate/no-mistakes-attempt-1.toon"
      },
      {
        id:"gate-terminal",
        path:"artifacts/gate/terminal.json"
      }
    ]
  ' "$result" >/dev/null || fail "exact passed outcome should become gate_ok(validated)"

  assert_present "$NM_CALLED" "Gate should invoke No-Mistakes after exact-SHA preflight"
  [ "$(cat "$NM_CWD")" = "$RUN_REPO" ] \
    || fail "No-Mistakes should run in the Launcher-owned worktree"
  [ "$(invocation_args)" = \
    '["axi","run","--intent","validate exact candidate","--fake-outcome=passed","--yes"]' ] \
    || fail "Gate should build the documented axi run argv from config"
  assert_no_grep "--auto-merge" "$NM_ARGV" "Gate must never invent a No-Mistakes auto-merge flag"
  assert_no_grep $'pr\tmerge' "$GH_CALLS" \
    "manual merge authority must not arm GitHub auto-merge"

  receipt="$RUNS_DIR/$run/artifacts/gate/no-mistakes-attempt-1.toon"
  assert_present "$receipt" "Gate should preserve the machine-readable No-Mistakes outcome"
  assert_grep "outcome: passed" "$receipt" "Gate outcome receipt should contain the trusted terminal fact"
  pass "Gate validates the exact candidate and builds documented No-Mistakes argv"
}
# -/ 1/11

# -- 2/11 CORE · test_recovers_exact_pr --
test_recovers_exact_pr() {
  local run result terminal calls

  rm -f "$GH_CALLS" "$NM_CALLS"
  export CB_GATE_TEST_GH_MODE=exact
  run=gate-pr-from-receipt
  make_run "$run" passed
  run_gate "$run" "$RUN_HEAD"
  expect_code 0 "$CMD_STATUS" \
    "returned PR verification${CMD_STDERR:+: $CMD_STDERR}"
  result=$CMD_STDOUT
  jq -e --arg sha "$RUN_HEAD" '
    .events==[{
      code:0,
      event:"gate_ok",
      payload:{
        outcome:"validated",
        sha:$sha,
        pr:"https://example.test/pull/7"
      }
    }]
  ' "$result" >/dev/null \
    || fail "Gate should accept a returned PR only at the exact branch and head"
  calls=$(cat "$GH_CALLS")
  [ "$calls" = \
    $'pr\tview\thttps://example.test/pull/7\t--json\turl,headRefName,headRefOid' ] \
    || fail "Gate should verify the No-Mistakes PR URL directly: $calls"

  terminal="$RUNS_DIR/$run/artifacts/gate/terminal.json"
  jq -e '
    .no_mistakes.pr=="https://example.test/pull/7" and
    .result.events[0].payload.pr=="https://example.test/pull/7"
  ' "$terminal" >/dev/null \
    || fail "terminal recovery should seal the exact verified PR URL"
  run_gate "$run" "$RUN_HEAD" 2
  expect_code 0 "$CMD_STATUS" \
    "verified PR terminal replay${CMD_STDERR:+: $CMD_STDERR}"
  [ "$(wc -l <"$GH_CALLS" | tr -d ' ')" = 1 ] \
    || fail "terminal replay must not query or select another PR"
  [ "$(wc -l <"$NM_CALLS" | tr -d ' ')" = 1 ] \
    || fail "terminal replay must not start another delivery after PR recovery"

  rm -f "$GH_CALLS"
  run=gate-pr-branch-recovery
  make_run "$run" passed-no-pr
  run_gate "$run" "$RUN_HEAD"
  expect_code 0 "$CMD_STATUS" \
    "missing URL branch recovery${CMD_STDERR:+: $CMD_STDERR}"
  jq -e --arg sha "$RUN_HEAD" '
    .events==[{
      code:0,
      event:"gate_ok",
      payload:{
        outcome:"validated",
        sha:$sha,
        pr:"https://example.test/pull/7"
      }
    }]
  ' "$CMD_STDOUT" >/dev/null \
    || fail "Gate should recover one exact open PR when the receipt omits its URL"
  calls=$(cat "$GH_CALLS")
  [ "$calls" = \
    $'pr\tlist\t--head\tcombo/gate-pr-branch-recovery\t--state\topen\t--limit\t2\t--json\turl,headRefName,headRefOid' ] \
    || fail "Gate should use one bounded branch lookup for URL recovery: $calls"

  export CB_GATE_TEST_GH_MODE=zero
  run=gate-pr-recovery-zero
  make_run "$run" passed-no-pr
  run_gate "$run" "$RUN_HEAD"
  expect_code 0 "$CMD_STATUS" \
    "zero PR recovery rejection${CMD_STDERR:+: $CMD_STDERR}"
  jq -e '
    .exit_class=="completed" and
    .events==[{
      code:1,
      event:"gate_failed",
      payload:{reason:"github_pr_not_found"}
    }]
  ' "$CMD_STDOUT" >/dev/null \
    || fail "zero branch matches must fail Gate without guessing a PR"

  export CB_GATE_TEST_GH_MODE=multiple
  run=gate-pr-recovery-multiple
  make_run "$run" passed-no-pr
  run_gate "$run" "$RUN_HEAD"
  expect_code 0 "$CMD_STATUS" \
    "ambiguous PR recovery rejection${CMD_STDERR:+: $CMD_STDERR}"
  jq -e '
    .exit_class=="completed" and
    .events==[{
      code:1,
      event:"gate_failed",
      payload:{reason:"github_pr_ambiguous"}
    }]
  ' "$CMD_STDOUT" >/dev/null \
    || fail "multiple branch matches must fail Gate without choosing a PR"

  export CB_GATE_TEST_GH_MODE=wrong-branch
  run=gate-pr-wrong-branch
  make_run "$run" passed
  run_gate "$run" "$RUN_HEAD"
  expect_code 0 "$CMD_STATUS" \
    "wrong PR branch rejection${CMD_STDERR:+: $CMD_STDERR}"
  jq -e '.events[0].payload.reason=="github_pr_identity_mismatch"' \
    "$CMD_STDOUT" >/dev/null \
    || fail "a returned PR for another branch must fail Gate"

  export CB_GATE_TEST_GH_MODE=wrong-head
  run=gate-pr-wrong-head
  make_run "$run" passed
  run_gate "$run" "$RUN_HEAD"
  expect_code 0 "$CMD_STATUS" \
    "wrong PR head rejection${CMD_STDERR:+: $CMD_STDERR}"
  jq -e '.events[0].payload.reason=="github_pr_identity_mismatch"' \
    "$CMD_STDOUT" >/dev/null \
    || fail "a returned PR for another head must fail Gate"

  export CB_GATE_TEST_GH_MODE=exact
  pass "Gate recovers and seals one exact PR without duplicate delivery or lookup"
}
# -/ 2/11

# -- 3/11 CORE · test_seals_configured_identity --
test_seals_configured_identity() {
  local mismatch=gate-configured-identity-mismatch
  local run=gate-configured-identity result invocation poison
  rm -f "$NM_ACTIVE" "$NM_CALLS" "$NM_STARTS" "$NM_ATTACHES"

  write_no_mistakes_identity "other/model"
  make_run "$mismatch" passed
  run_gate "$mismatch" "$RUN_HEAD" 1
  expect_code 0 "$CMD_STATUS" \
    "effective identity mismatch${CMD_STDERR:+: $CMD_STDERR}"
  jq -e '
    .exit_class=="technical_error" and .events==[] and
    .errors==["adapter_exit:73"]
  ' "$CMD_STDOUT" >/dev/null \
    || fail "Gate must reject a configured model absent from effective No-Mistakes config"
  assert_absent "$NM_CALLED" \
    "identity mismatch must fail before No-Mistakes starts"

  write_no_mistakes_identity "deepseek/deepseek-v4-pro"
  make_run "$run" interrupt-once

  run_gate "$run" "$RUN_HEAD" 1
  expect_code 0 "$CMD_STATUS" \
    "configured identity interruption${CMD_STDERR:+: $CMD_STDERR}"
  result=$CMD_STDOUT
  jq -e '
    (.exit_class=="cancelled" and
      (.reasons==["adapter_exit:130"] or .reasons==["adapter_exit:143"])) or
    (.exit_class=="technical_error" and
      (.errors[0] | test("^adapter_exit:[1-9][0-9]*$")))
  ' "$result" >/dev/null \
    || fail "identity fixture should stop after sealing its in-progress invocation"

  invocation="$RUNS_DIR/$run/artifacts/gate/invocation.json"
  jq -e --arg config "$FAKE_NM_CONFIG" '
    .schema=="combo.gate-invocation/v3" and
    .merge=="manual" and
    .preflight.runtime=="pi" and
    .preflight.model=="deepseek/deepseek-v4-pro" and
    .preflight.config_path==$config and
    (.preflight.doctor | contains("gate validation  pi is runnable")) and
    .preflight.version=="no-mistakes version v-test (fake)" and
    (.preflight.axi_run_help | contains("no-mistakes axi run")) and
    (.preflight.axi_run_help | contains("--intent")) and
    (.preflight.axi_run_help | contains("--yes")) and
    (.preflight.axi_run_help | contains("--auto-merge") | not) and
    (.preflight.axi_status_help | contains("no-mistakes axi status")) and
    (.preflight.axi_respond_help | contains("no-mistakes axi respond")) and
    (.argv | index("--model") | not) and
    (.argv | index("deepseek/deepseek-v4-pro") | not)
  ' "$invocation" >/dev/null \
    || fail "invocation seal should bind configured identity and observed AXI surface"

  poison="$invocation.poison"
  jq '.preflight.model="other/model"' "$invocation" >"$poison"
  chmod 0444 "$poison"
  mv -f "$poison" "$invocation"
  run_gate "$run" "$RUN_HEAD" 2
  expect_code 0 "$CMD_STATUS" \
    "poisoned configured identity${CMD_STDERR:+: $CMD_STDERR}"
  jq -e '
    .exit_class=="technical_error" and .events==[] and
    .errors==["adapter_exit:73"]
  ' "$CMD_STDOUT" >/dev/null \
    || fail "a changed runtime/model seal must fail closed before reattachment"
  [ "$(wc -l <"$NM_CALLS" | tr -d ' ')" = 1 ] \
    || fail "identity mismatch must not start or attach another No-Mistakes run"
  pass "Gate seals configured runtime/model identity and the supported AXI surface"
}
# -/ 3/11

# -- 4/11 CORE · test_rejects_candidate_drift --
test_rejects_candidate_drift() {
  local run=gate-drift result
  make_run "$run" passed
  printf 'drift\n' >>"$RUN_REPO/file.txt"
  git -C "$RUN_REPO" add file.txt
  git -C "$RUN_REPO" commit -qm "test drift"

  run_gate "$run" "$RUN_HEAD"
  expect_code 0 "$CMD_STATUS" "candidate drift product failure${CMD_STDERR:+: $CMD_STDERR}"
  result=$CMD_STDOUT
  jq -e '
    .exit_class=="completed" and
    .events==[{
      code:1,
      event:"gate_failed",
      payload:{reason:"candidate_head_changed"}
    }]
  ' "$result" >/dev/null || fail "candidate drift should become a terminal gate_failed event"
  assert_absent "$NM_CALLED" "No-Mistakes must not run after the reviewed candidate moves"
  pass "Gate rejects candidate drift before invoking No-Mistakes"
}
# -/ 4/11

# -- 5/11 CORE · test_maps_terminal_outcomes --
test_maps_terminal_outcomes() {
  local run result

  run=gate-checks-passed
  make_run "$run" checks-passed
  run_gate "$run" "$RUN_HEAD"
  expect_code 0 "$CMD_STATUS" "checks-passed mapping${CMD_STDERR:+: $CMD_STDERR}"
  result=$CMD_STDOUT
  jq -e '.events[0].event=="gate_ok" and .events[0].payload.outcome=="validated"' \
    "$result" >/dev/null || fail "checks-passed should be a validated Gate outcome"

  run=gate-failed
  make_run "$run" failed
  run_gate "$run" "$RUN_HEAD"
  expect_code 0 "$CMD_STATUS" "failed mapping${CMD_STDERR:+: $CMD_STDERR}"
  result=$CMD_STDOUT
  jq -e '
    .exit_class=="completed" and
    .events==[{
      code:1,
      event:"gate_failed",
      payload:{reason:"no_mistakes_failed"}
    }]
  ' "$result" >/dev/null || fail "failed should become gate_failed"

  run=gate-cancelled
  make_run "$run" cancelled
  run_gate "$run" "$RUN_HEAD"
  expect_code 0 "$CMD_STATUS" "cancelled mapping${CMD_STDERR:+: $CMD_STDERR}"
  result=$CMD_STDOUT
  jq -e '
    .exit_class=="cancelled" and .events==[] and
    .reasons==["no_mistakes_cancelled"] and .errors==[]
  ' "$result" >/dev/null || fail "cancelled should remain a universal cancelled exit"
  pass "Gate maps documented passed, failed, and cancelled outcomes"
}
# -/ 5/11

# -- 6/11 CORE · test_guards_argument_edges --
test_guards_argument_edges() {
  local run result config

  run=gate-empty-arguments
  make_run "$run" passed
  config="$TMP_ROOT/$run.empty.config.json"
  write_config "$config" passed '[]'
  rm -f "$RUNS_DIR/$run/plan.json"
  sh "$BIN/cb-plan.sh" "$run" --config "$config" >/dev/null \
    || fail "could not compile empty-arguments Gate plan"
  run_gate "$run" "$RUN_HEAD"
  expect_code 0 "$CMD_STATUS" "empty argument array${CMD_STDERR:+: $CMD_STDERR}"
  result=$CMD_STDOUT
  jq -e '.events[0].event=="gate_ok"' "$result" >/dev/null \
    || fail "an empty argument array should work on Bash 3.2"

  run=gate-bare-skip
  make_run "$run" passed
  config="$TMP_ROOT/$run.skip.config.json"
  write_config "$config" passed '["--skip","review"]'
  rm -f "$RUNS_DIR/$run/plan.json"
  sh "$BIN/cb-plan.sh" "$run" --config "$config" >/dev/null \
    || fail "could not compile bare-skip Gate plan"
  run_gate "$run" "$RUN_HEAD"
  expect_code 0 "$CMD_STATUS" "bare skip policy rejection${CMD_STDERR:+: $CMD_STDERR}"
  result=$CMD_STDOUT
  jq -e '
    .exit_class=="technical_error" and .events==[] and
    .errors==["adapter_exit:64"]
  ' "$result" >/dev/null || fail "bare --skip review must not bypass review=true"
  assert_absent "$NM_CALLED" "invalid review skip must be rejected before No-Mistakes"
  pass "Gate handles empty argv on Bash 3.2 and rejects bare review skips"
}
# -/ 6/11

# -- 7/11 CORE · test_replays_terminal_seal --
test_replays_terminal_seal() {
  local run=gate-terminal-replay first_result second_result terminal poison
  rm -f "$NM_CALLS"
  make_run "$run" passed

  run_gate "$run" "$RUN_HEAD" 1
  expect_code 0 "$CMD_STATUS" "initial terminal Gate${CMD_STDERR:+: $CMD_STDERR}"
  first_result=$CMD_STDOUT
  jq -e '.events[0].event=="gate_ok"' "$first_result" >/dev/null \
    || fail "initial Gate attempt should seal a successful terminal result"
  terminal="$RUNS_DIR/$run/artifacts/gate/terminal.json"
  jq -e \
    --arg sha "$RUN_HEAD" --arg branch "$RUN_BRANCH" --arg worktree "$RUN_REPO" '
      .schema=="combo.gate-terminal/v3" and
      .run_id=="gate-terminal-replay" and
      .branch==$branch and .worktree==$worktree and .candidate_sha==$sha and
      .lease=="artifacts/gate/no-mistakes-lease-attempt-1.json" and
      .no_mistakes=={
        run_id:"fake-gate-run",
        outcome:"passed",
        pr:"https://example.test/pull/7",
        receipt:"artifacts/gate/no-mistakes-attempt-1.toon"
      } and
      .merge=={mode:"manual",arm:"",outcome:""} and
      .normalized_outcome=="validated"
    ' "$terminal" >/dev/null \
    || fail "terminal seal should retain exact run, branch, head, PR, and NM identity"

  run_gate "$run" "$RUN_HEAD" 2
  expect_code 0 "$CMD_STATUS" "terminal Gate replay${CMD_STDERR:+: $CMD_STDERR}"
  second_result=$CMD_STDOUT
  jq -e --arg sha "$RUN_HEAD" '
    .attempt==2 and
    .events==[{
      code:0,
      event:"gate_ok",
      payload:{
        outcome:"validated",
        sha:$sha,
        pr:"https://example.test/pull/7"
      }
    }] and
    any(.artifacts[];
      .id=="no-mistakes-outcome" and
      .path=="artifacts/gate/no-mistakes-attempt-1.toon")
  ' "$second_result" >/dev/null \
    || fail "recovery should replay the original exact-head terminal seal"
  [ "$(wc -l <"$NM_CALLS" | tr -d ' ')" = 1 ] \
    || fail "terminal recovery must not start a second No-Mistakes delivery"

  poison="$terminal.poison"
  jq '.candidate_sha="0000000000000000000000000000000000000000"' \
    "$terminal" >"$poison"
  chmod 0444 "$poison"
  mv -f "$poison" "$terminal"
  run_gate "$run" "$RUN_HEAD" 3
  expect_code 0 "$CMD_STATUS" "poisoned terminal normalization${CMD_STDERR:+: $CMD_STDERR}"
  jq -e '
    .exit_class=="technical_error" and .events==[] and
    .errors==["adapter_exit:73"]
  ' "$CMD_STDOUT" >/dev/null \
    || fail "a terminal seal for another head must fail closed"
  [ "$(wc -l <"$NM_CALLS" | tr -d ' ')" = 1 ] \
    || fail "a poisoned terminal seal must not trigger another delivery"
  pass "Gate replays a durable terminal seal without duplicating No-Mistakes"
}
# -/ 7/11

# -- 8/11 CORE · test_adopts_interrupted_run --
test_adopts_interrupted_run() {
  local run=gate-interrupted-recovery first_result second_result invocation
  local invocation_before invocation_after invocation_mode terminal
  rm -f "$NM_ACTIVE" "$NM_STARTS" "$NM_ATTACHES" "$NM_CALLS"
  make_run "$run" interrupt-once

  run_gate "$run" "$RUN_HEAD" 1
  expect_code 0 "$CMD_STATUS" "interrupted Gate normalization${CMD_STDERR:+: $CMD_STDERR}"
  first_result=$CMD_STDOUT
  if ! jq -e '
    (.exit_class=="cancelled" and .events==[] and .errors==[] and
      (.reasons==["adapter_exit:130"] or .reasons==["adapter_exit:143"])) or
    (.exit_class=="technical_error" and .events==[] and .reasons==[] and
      (.errors[0] | test("^adapter_exit:[1-9][0-9]*$")))
  ' "$first_result" >/dev/null; then
    fail "an interrupted Gate should remain retryable through the universal envelope: $(cat "$first_result")"
  fi

  invocation="$RUNS_DIR/$run/artifacts/gate/invocation.json"
  assert_present "$invocation" \
    "Gate must seal the exact invocation before starting No-Mistakes"
  invocation_mode=$(stat -c '%a' "$invocation" 2>/dev/null ||
    stat -f '%Lp' "$invocation")
  [ "$invocation_mode" = 444 ] \
    || fail "Gate invocation seal should be read-only"
  jq -e \
    --arg sha "$RUN_HEAD" --arg branch "$RUN_BRANCH" \
    --arg worktree "$RUN_REPO" --arg binary "$FAKE_NM" '
      .schema=="combo.gate-invocation/v3" and
      .run_id=="gate-interrupted-recovery" and
      .branch==$branch and .worktree==$worktree and .candidate_sha==$sha and
      .initial_attempt==1 and .binary==$binary and .merge=="manual" and
      .preflight.runtime=="pi" and
      .preflight.model=="deepseek/deepseek-v4-pro" and
      .argv==[
        "axi","run","--intent","validate exact candidate",
        "--fake-outcome=interrupt-once","--yes"
      ]
    ' "$invocation" >/dev/null \
    || fail "in-progress seal should retain the exact run, head, binary, and argv"
  invocation_before=$(cksum <"$invocation")
  assert_absent "$RUNS_DIR/$run/artifacts/gate/no-mistakes-attempt-1.toon" \
    "interruption before a terminal return must not invent a receipt"
  assert_absent "$RUNS_DIR/$run/artifacts/gate/terminal.json" \
    "interruption before a terminal return must not invent a terminal seal"

  run_gate "$run" "$RUN_HEAD" 2
  expect_code 0 "$CMD_STATUS" "interrupted Gate recovery${CMD_STDERR:+: $CMD_STDERR}"
  second_result=$CMD_STDOUT
  jq -e --arg sha "$RUN_HEAD" '
    .attempt==2 and .exit_class=="completed" and
    .events==[{
      code:0,
      event:"gate_ok",
      payload:{
        outcome:"validated",
        sha:$sha,
        pr:"https://example.test/pull/7"
      }
    }]
  ' "$second_result" >/dev/null \
    || fail "retry should adopt and finish the exact sealed invocation"

  invocation_after=$(cksum <"$invocation")
  [ "$invocation_after" = "$invocation_before" ] \
    || fail "retry must not replace or mutate the in-progress invocation seal"
  [ "$(wc -l <"$NM_STARTS" | tr -d ' ')" = 1 ] \
    || fail "interrupted recovery must start only one No-Mistakes run"
  [ "$(wc -l <"$NM_ATTACHES" | tr -d ' ')" = 1 ] \
    || fail "interrupted recovery must attach to the existing No-Mistakes run"

  terminal="$RUNS_DIR/$run/artifacts/gate/terminal.json"
  jq -e '
    .no_mistakes.run_id=="fake-gate-run" and
    .no_mistakes.receipt=="artifacts/gate/no-mistakes-attempt-2.toon" and
    .normalized_outcome=="validated"
  ' "$terminal" >/dev/null \
    || fail "recovered terminal seal should bind the adopted run and its receipt"
  pass "Gate adopts an interrupted No-Mistakes run from one immutable invocation seal"
}
# -/ 8/11

# -- 9/11 CORE · test_serializes_global_gate --
test_serializes_global_gate() {
  local first=gate-serial-first second=gate-serial-second stale=gate-serial-stale
  local first_repo first_head first_branch second_repo second_head second_branch
  local first_out first_err second_out second_err first_pid second_pid
  local first_status second_status first_result second_result lease lock owner
  rm -rf "$GATE_LEASES_DIR" "$NM_SERIAL_ACTIVE"
  rm -f "$NM_SERIAL_ENTERED" "$NM_SERIAL_OVERLAP" "$NM_CALLS"

  make_run "$first" slow-passed
  first_repo=$RUN_REPO
  first_head=$RUN_HEAD
  first_branch=$RUN_BRANCH
  make_run "$second" passed
  second_repo=$RUN_REPO
  second_head=$RUN_HEAD
  second_branch=$RUN_BRANCH

  first_out="$TMP_ROOT/$first.out"
  first_err="$TMP_ROOT/$first.background.err"
  CB_GATE_TEST_BRANCH=$first_branch CB_GATE_TEST_HEAD=$first_head \
    bash "$BIN/cb-step.sh" \
      "$first" gate 1 --candidate-sha "$first_head" \
      >"$first_out" 2>"$first_err" &
  first_pid=$!
  if ! wait_for_path "$NM_SERIAL_ACTIVE"; then
    wait "$first_pid" 2>/dev/null || true
    fail "first Gate did not enter the serialized fake No-Mistakes runtime"
  fi

  second_out="$TMP_ROOT/$second.out"
  second_err="$TMP_ROOT/$second.background.err"
  CB_GATE_TEST_BRANCH=$second_branch CB_GATE_TEST_HEAD=$second_head \
    bash "$BIN/cb-step.sh" \
      "$second" gate 1 --candidate-sha "$second_head" \
      >"$second_out" 2>"$second_err" &
  second_pid=$!

  wait "$first_pid" && first_status=0 || first_status=$?
  wait "$second_pid" && second_status=0 || second_status=$?
  expect_code 0 "$first_status" \
    "first serialized Gate$(test ! -s "$first_err" || printf ': %s' "$(cat "$first_err")")"
  expect_code 0 "$second_status" \
    "second serialized Gate$(test ! -s "$second_err" || printf ': %s' "$(cat "$second_err")")"
  first_result=$(cat "$first_out")
  second_result=$(cat "$second_out")
  jq -e '.events[0].event=="gate_ok"' "$first_result" >/dev/null \
    || fail "first serialized Gate should validate"
  jq -e '.events[0].event=="gate_ok"' "$second_result" >/dev/null \
    || fail "second serialized Gate should validate"
  assert_absent "$NM_SERIAL_OVERLAP" \
    "two Combo runs must never overlap in a host-global No-Mistakes Gate"
  [ "$(wc -l <"$NM_SERIAL_ENTERED" | tr -d ' ')" = 2 ] \
    || fail "both serialized Gate runs should eventually enter No-Mistakes"

  for lease in \
    "$RUNS_DIR/$first/artifacts/gate/no-mistakes-lease-attempt-1.json" \
    "$RUNS_DIR/$second/artifacts/gate/no-mistakes-lease-attempt-1.json"; do
    jq -e '
      .schema=="combo.gate-lease/v1" and
      .scope=="host-global" and .adapter=="no-mistakes" and
      .state=="acquired" and .recovered_from==null
    ' "$lease" >/dev/null \
      || fail "each Gate run should retain immutable host-global lease evidence"
  done
  assert_absent "$GATE_LEASES_DIR/no-mistakes.lock" \
    "the global Gate lease should be released after both terminal outcomes"

  make_run "$stale" passed
  lock="$GATE_LEASES_DIR/no-mistakes.lock"
  owner="$lock/owner.json"
  mkdir -p "$lock"
  jq -n '
    {
      schema:"combo.gate-lease-owner/v1",
      scope:"host-global",
      adapter:"no-mistakes",
      run_id:"dead-gate",
      branch:"combo/dead-gate",
      worktree:"/dead/worktree",
      candidate_sha:"0000000000000000000000000000000000000000",
      attempt:1,
      pid:99999999,
      token:"dead-owner",
      acquired_at:1
    }
  ' >"$owner"
  touch -t 200001010000 "$lock"
  run_gate "$stale" "$RUN_HEAD"
  expect_code 0 "$CMD_STATUS" "stale Gate lease recovery${CMD_STDERR:+: $CMD_STDERR}"
  jq -e '.events[0].event=="gate_ok"' "$CMD_STDOUT" >/dev/null \
    || fail "a dead global Gate owner should be recoverable"
  lease="$RUNS_DIR/$stale/artifacts/gate/no-mistakes-lease-attempt-1.json"
  jq -e '
    .schema=="combo.gate-lease/v1" and .state=="recovered" and
    .recovered_from.run_id=="dead-gate" and
    .recovered_from.token=="dead-owner"
  ' "$lease" >/dev/null \
    || fail "stale recovery should remain visible in immutable run-local evidence"
  assert_absent "$lock" "recovered global Gate lease should be released on exit"
  [ "$first_repo" != "$second_repo" ] \
    || fail "serialization fixture must use independently isolated worktrees"
  pass "Gate serializes No-Mistakes across runs and recovers a stale owner"
}
# -/ 9/11

# -- 10/11 CORE · test_arms_auto_merge_once --
test_arms_auto_merge_once() {
  local run=gate-auto-merge result arm outcome terminal merge_calls gh_calls nm_calls
  local arm_mode outcome_mode poison
  local pending=gate-auto-merge-timeout
  local zero_poll=gate-auto-merge-zero-poll
  local immediate=gate-auto-merge-immediate
  local interrupted=gate-auto-merge-interrupted first_result second_result
  local loose=gate-auto-merge-loose-policy
  local stale=gate-auto-merge-stale-checks
  local partial=gate-auto-merge-partial-checks
  rm -f "$GH_CALLS" "$GH_AUTO_MERGE_STATE" "$GH_ARM_INTERRUPT"

  export CB_GATE_TEST_GH_MERGE_EFFECT=armed
  export CB_STEP_TIMEOUT_SECONDS=3
  make_run "$pending" passed auto 1 1
  run_gate "$pending" "$RUN_HEAD"
  unset CB_GATE_TEST_GH_MERGE_EFFECT CB_STEP_TIMEOUT_SECONDS
  expect_code 0 "$CMD_STATUS" \
    "bounded auto-merge wait${CMD_STDERR:+: $CMD_STDERR}"
  jq -e '
    .exit_class=="completed" and .reasons==[] and .errors==[] and
    .events==[{
      code:1,
      event:"gate_failed",
      payload:{reason:"github_auto_merge_timeout"}
    }] and
    any(.artifacts[];
      .id=="gate-merge-arm" and
      .path=="artifacts/gate/merge-arm.json") and
    any(.artifacts[];
      .id=="gate-terminal" and
      .path=="artifacts/gate/terminal.json") and
    all(.artifacts[]; .id!="gate-merge-outcome")
  ' "$CMD_STDOUT" >/dev/null \
    || fail "an armed PR with pending checks must become a durable Gate escalation"
  assert_present "$RUNS_DIR/$pending/artifacts/gate/merge-arm.json" \
    "merge timeout should retain the immutable arm"
  assert_absent "$RUNS_DIR/$pending/artifacts/gate/merge-outcome.json" \
    "a local wait timeout must not invent a GitHub terminal observation"
  terminal="$RUNS_DIR/$pending/artifacts/gate/terminal.json"
  jq -e '
    .schema=="combo.gate-terminal/v6" and
    .normalized_outcome=="failed" and
    .no_mistakes.outcome=="passed" and
    .merge=={
      mode:"auto",
      arm:"artifacts/gate/merge-arm.json",
      outcome:""
    } and
    .result=={
      exit_class:"completed",
      events:[{
        code:1,
        event:"gate_failed",
        payload:{reason:"github_auto_merge_timeout"}
      }],
      reasons:[],
      errors:[]
    }
  ' "$terminal" >/dev/null \
    || fail "merge timeout should seal a documented escalation without fake GitHub outcome"
  assert_absent "$GATE_LEASES_DIR/no-mistakes.lock" \
    "merge timeout must release the host-global Gate lease"
  gh_calls=$(wc -l <"$GH_CALLS" | tr -d " ")
  nm_calls=$(wc -l <"$NM_CALLS" | tr -d " ")
  run_gate "$pending" "$RUN_HEAD" 2
  expect_code 0 "$CMD_STATUS" \
    "merge-timeout terminal replay${CMD_STDERR:+: $CMD_STDERR}"
  jq -e '
    .events==[{
      code:1,
      event:"gate_failed",
      payload:{reason:"github_auto_merge_timeout"}
    }]
  ' "$CMD_STDOUT" >/dev/null \
    || fail "merge-timeout replay should preserve the escalation reason"
  [ "$(wc -l <"$GH_CALLS" | tr -d " ")" -eq "$gh_calls" ] \
    || fail "merge-timeout replay must not query or mutate GitHub"
  [ "$(wc -l <"$NM_CALLS" | tr -d " ")" -eq "$nm_calls" ] \
    || fail "merge-timeout replay must not re-enter No-Mistakes"
  assert_absent "$GATE_LEASES_DIR/no-mistakes.lock" \
    "merge-timeout replay must not reacquire the global lease"

  export CB_GATE_MERGE_POLL_SECONDS=0
  make_run "$zero_poll" passed auto
  run_gate "$zero_poll" "$RUN_HEAD"
  unset CB_GATE_MERGE_POLL_SECONDS
  expect_code 0 "$CMD_STATUS" \
    "zero merge poll interval${CMD_STDERR:+: $CMD_STDERR}"
  jq -e '
    .exit_class=="technical_error" and .events==[] and .reasons==[] and
    .errors==["adapter_exit:64"]
  ' "$CMD_STDOUT" >/dev/null \
    || fail "Gate must reject a zero merge poll interval before acquiring the lease"
  assert_absent "$NM_CALLED" \
    "an invalid merge poll interval must not enter No-Mistakes"
  assert_absent "$GATE_LEASES_DIR/no-mistakes.lock" \
    "an invalid merge poll interval must not acquire the global lease"

  rm -f "$GH_CALLS" "$GH_AUTO_MERGE_STATE"
  export CB_GATE_TEST_GH_MERGE_EFFECT=armed-then-merged
  export CB_GATE_MERGE_POLL_SECONDS=1
  make_run "$run" passed auto
  run_gate "$run" "$RUN_HEAD"
  unset CB_GATE_TEST_GH_MERGE_EFFECT CB_GATE_MERGE_POLL_SECONDS
  expect_code 0 "$CMD_STATUS" \
    "configured auto-merge Gate${CMD_STDERR:+: $CMD_STDERR}"
  result=$CMD_STDOUT
  jq -e --arg sha "$RUN_HEAD" '
    .events==[{
      code:0,
      event:"gate_ok",
      payload:{
        outcome:"merged",
        sha:$sha,
        pr:"https://example.test/pull/7"
      }
    }] and
    any(.artifacts[];
      .id=="gate-merge-arm" and
      .path=="artifacts/gate/merge-arm.json") and
    any(.artifacts[];
      .id=="gate-merge-outcome" and
      .path=="artifacts/gate/merge-outcome.json")
  ' "$result" >/dev/null \
    || fail "auto mode should wait for and publish the authenticated final merge"

  merge_calls=$(grep -c $'^pr\tmerge\thttps://example.test/pull/7\t--auto\t--rebase$' \
    "$GH_CALLS" || true)
  [ "$merge_calls" -eq 1 ] \
    || fail "Gate should execute the sole auto-rebase arm exactly once"
  arm="$RUNS_DIR/$run/artifacts/gate/merge-arm.json"
  arm_mode=$(stat -c '%a' "$arm" 2>/dev/null || stat -f '%Lp' "$arm")
  [ "$arm_mode" = 444 ] \
    || fail "merge-arm evidence should be immutable"
  jq -e \
    --arg run "$run" --arg branch "$RUN_BRANCH" --arg worktree "$RUN_REPO" \
    --arg sha "$RUN_HEAD" --arg gh "$FAKE_GH" '
      .schema=="combo.gate-merge-arm/v2" and
      .run_id==$run and .branch==$branch and .worktree==$worktree and
      .candidate_sha==$sha and .pr=="https://example.test/pull/7" and
      .mode=="auto" and .state=="armed" and .source=="command" and
      .requirements=={
        repository:{
          name_with_owner:"acme/repo",
          url:"https://example.test"
        },
        target_branch:"main",
        strict:true,
        checks:[
          {context:"backend",app_id:101},
          {context:"frontend",app_id:-1}
        ]
      } and
      .command=={
        binary:$gh,
        argv:[
          "pr","merge","https://example.test/pull/7","--auto","--rebase"
        ]
      } and
      .observation.state=="OPEN" and
      .observation.autoMergeRequest.mergeMethod=="REBASE" and
      .observation.headRefOid==$sha and
      .observation.checks.sha==$sha
    ' "$arm" >/dev/null \
    || fail "merge-arm seal should bind exact policy, checks, authority, PR, and head"
  outcome="$RUNS_DIR/$run/artifacts/gate/merge-outcome.json"
  outcome_mode=$(stat -c '%a' "$outcome" 2>/dev/null || stat -f '%Lp' "$outcome")
  [ "$outcome_mode" = 444 ] \
    || fail "merge-outcome evidence should be immutable"
  jq -e \
    --arg run "$run" --arg branch "$RUN_BRANCH" --arg worktree "$RUN_REPO" \
    --arg sha "$RUN_HEAD" '
      .schema=="combo.gate-merge-outcome/v2" and
      .run_id==$run and .branch==$branch and .worktree==$worktree and
      .candidate_sha==$sha and .pr=="https://example.test/pull/7" and
      .outcome=="merged" and
      .requirements.strict==true and
      .requirements.target_branch=="main" and
      .requirements.checks==[
        {context:"backend",app_id:101},
        {context:"frontend",app_id:-1}
      ] and
      .observation.state=="MERGED" and
      .observation.autoMergeRequest==null and
      .observation.mergedAt=="2026-07-27T00:00:00Z" and
      .observation.mergeCommit.oid=="1111111111111111111111111111111111111111" and
      .observation.checks.sha==$sha and
      any(.observation.checks.check_runs[];
        .name=="backend" and .app_id==101 and
        .status=="COMPLETED" and .conclusion=="SUCCESS") and
      any(.observation.checks.statuses[];
        .context=="frontend" and .state=="SUCCESS")
  ' "$outcome" >/dev/null \
    || fail "merge outcome should retain exact successful required-check evidence"
  assert_grep \
    $'repo\tview\t--json\tnameWithOwner,url' "$GH_CALLS" \
    "Gate should resolve the authenticated target repository"
  assert_grep \
    $'api\trepos/acme/repo/branches/main/protection/required_status_checks' \
    "$GH_CALLS" \
    "Gate should read the actual target-branch check policy"
  assert_grep \
    $'api\trepos/acme/repo/commits/'"$RUN_HEAD"$'/check-runs?filter=latest&per_page=100' \
    "$GH_CALLS" \
    "Gate should read check runs from the exact reviewed SHA"
  assert_grep \
    $'api\trepos/acme/repo/commits/'"$RUN_HEAD"$'/status?per_page=100' \
    "$GH_CALLS" \
    "Gate should read statuses from the exact reviewed SHA"
  terminal="$RUNS_DIR/$run/artifacts/gate/terminal.json"
  jq -e '
    .schema=="combo.gate-terminal/v3" and
    .normalized_outcome=="merged" and
    .merge=={
      mode:"auto",
      arm:"artifacts/gate/merge-arm.json",
      outcome:"artifacts/gate/merge-outcome.json"
    }
  ' "$terminal" >/dev/null \
    || fail "terminal recovery should retain the immutable arm and final observation"

  gh_calls=$(wc -l <"$GH_CALLS" | tr -d " ")
  run_gate "$run" "$RUN_HEAD" 2
  expect_code 0 "$CMD_STATUS" \
    "auto-merge terminal replay${CMD_STDERR:+: $CMD_STDERR}"
  merge_calls=$(grep -c $'^pr\tmerge\thttps://example.test/pull/7\t--auto\t--rebase$' \
    "$GH_CALLS" || true)
  [ "$merge_calls" -eq 1 ] \
    || fail "terminal replay must never duplicate the merge arm"
  [ "$(wc -l <"$GH_CALLS" | tr -d " ")" -eq "$gh_calls" ] \
    || fail "terminal replay must not observe GitHub again after a final merge"
  poison="$outcome.poison"
  jq '
    .requirements.checks[1]={
      context:"unrelated-status",
      app_id:-1
    }
  ' "$outcome" >"$poison"
  chmod 0444 "$poison"
  mv -f "$poison" "$outcome"
  run_gate "$run" "$RUN_HEAD" 3
  expect_code 0 "$CMD_STATUS" \
    "mismatched merge evidence replay${CMD_STDERR:+: $CMD_STDERR}"
  jq -e '
    .exit_class=="technical_error" and .events==[] and
    .errors==["adapter_exit:73"]
  ' "$CMD_STDOUT" >/dev/null \
    || fail "terminal replay must reject independently valid mismatched policies"
  [ "$(wc -l <"$GH_CALLS" | tr -d " ")" -eq "$gh_calls" ] \
    || fail "mismatched terminal evidence must not query or mutate GitHub"

  rm -f "$GH_CALLS" "$GH_AUTO_MERGE_STATE"
  export CB_GATE_TEST_GH_MERGE_EFFECT=merged
  make_run "$immediate" passed auto
  run_gate "$immediate" "$RUN_HEAD"
  unset CB_GATE_TEST_GH_MERGE_EFFECT
  expect_code 0 "$CMD_STATUS" \
    "immediate GitHub auto-merge${CMD_STDERR:+: $CMD_STDERR}"
  jq -e --arg sha "$RUN_HEAD" '
    .exit_class=="completed" and
    .events==[{
      code:0,
      event:"gate_ok",
      payload:{
        outcome:"merged",
        sha:$sha,
        pr:"https://example.test/pull/7"
      }
    }]
  ' "$CMD_STDOUT" >/dev/null \
    || fail "an authenticated immediately merged PR must become the final merged Gate outcome"
  jq -e '
    .source=="command" and .state=="armed" and
    .observation.state=="MERGED" and
    .observation.autoMergeRequest==null and
    .observation.mergedAt=="2026-07-27T00:00:00Z" and
    .observation.mergeCommit.oid=="1111111111111111111111111111111111111111"
  ' "$RUNS_DIR/$immediate/artifacts/gate/merge-arm.json" >/dev/null \
    || fail "an immediately merged PR should still seal the completed arm effect"
  jq -e '
    .normalized_outcome=="merged" and
    .merge.outcome=="artifacts/gate/merge-outcome.json" and
    .result.events[0].payload.outcome=="merged"
  ' "$RUNS_DIR/$immediate/artifacts/gate/terminal.json" >/dev/null \
    || fail "the terminal seal should retain the authenticated merged outcome"

  run_gate "$immediate" "$RUN_HEAD" 2
  expect_code 0 "$CMD_STATUS" \
    "immediate merged terminal replay${CMD_STDERR:+: $CMD_STDERR}"
  jq -e '.events[0].payload.outcome=="merged"' "$CMD_STDOUT" >/dev/null \
    || fail "terminal replay should preserve the final merged outcome"
  merge_calls=$(grep -c $'^pr\tmerge\thttps://example.test/pull/7\t--auto\t--rebase$' \
    "$GH_CALLS" || true)
  [ "$merge_calls" -eq 1 ] \
    || fail "merged terminal replay must not duplicate the merge arm"

  rm -f "$GH_CALLS" "$GH_AUTO_MERGE_STATE" "$GH_ARM_INTERRUPT"
  make_run "$interrupted" passed auto
  export CB_GATE_TEST_GH_INTERRUPT_AFTER_ARM="$GH_ARM_INTERRUPT"
  run_gate "$interrupted" "$RUN_HEAD"
  unset CB_GATE_TEST_GH_INTERRUPT_AFTER_ARM
  first_result=$CMD_STDOUT
  if ! jq -e '
    (.exit_class=="cancelled" and .events==[] and
      (.reasons==["adapter_exit:130"] or .reasons==["adapter_exit:143"])) or
    (.exit_class=="technical_error" and .events==[] and
      (.errors[0] | test("^adapter_exit:[1-9][0-9]*$")))
  ' "$first_result" >/dev/null; then
    fail "an interrupted merge arm should remain retryable: $first_result"
  fi
  assert_present "$GH_AUTO_MERGE_STATE" \
    "the fake GitHub effect must precede the simulated Gate interruption"
  assert_absent "$RUNS_DIR/$interrupted/artifacts/gate/merge-arm.json" \
    "interruption before arm publication must not invent a seal"
  assert_absent "$RUNS_DIR/$interrupted/artifacts/gate/terminal.json" \
    "interruption before arm publication must not invent a terminal result"

  printf "armed-then-merged\n" >"$GH_AUTO_MERGE_STATE"
  export CB_GATE_MERGE_POLL_SECONDS=1
  run_gate "$interrupted" "$RUN_HEAD" 2
  unset CB_GATE_MERGE_POLL_SECONDS
  expect_code 0 "$CMD_STATUS" \
    "interrupted auto-merge recovery${CMD_STDERR:+: $CMD_STDERR}"
  second_result=$CMD_STDOUT
  jq -e '
    .events[0].event=="gate_ok" and
    .events[0].payload.outcome=="merged"
  ' "$second_result" >/dev/null \
    || fail "retry should recover the authenticated existing merge arm"
  merge_calls=$(grep -c $'^pr\tmerge\thttps://example.test/pull/7\t--auto\t--rebase$' \
    "$GH_CALLS" || true)
  [ "$merge_calls" -eq 1 ] \
    || fail "recovery after the GitHub effect must not invoke a second arm"
  jq -e '.state=="armed" and .source=="observed"' \
    "$RUNS_DIR/$interrupted/artifacts/gate/merge-arm.json" >/dev/null \
    || fail "recovery should seal the authenticated pre-existing arm"

  rm -f "$GH_CALLS" "$GH_AUTO_MERGE_STATE"
  export CB_GATE_TEST_GH_POLICY_MODE=loose
  export CB_GATE_TEST_GH_MERGE_EFFECT=merged
  make_run "$loose" passed auto
  run_gate "$loose" "$RUN_HEAD"
  unset CB_GATE_TEST_GH_POLICY_MODE CB_GATE_TEST_GH_MERGE_EFFECT
  expect_code 0 "$CMD_STATUS" \
    "non-strict target policy rejection${CMD_STDERR:+: $CMD_STDERR}"
  jq -e '
    .events==[{
      code:1,
      event:"gate_failed",
      payload:{reason:"github_required_checks_not_strict"}
    }]
  ' "$CMD_STDOUT" >/dev/null \
    || fail "Gate must reject a target branch without strict required checks"
  assert_no_grep $'pr\tmerge\t' "$GH_CALLS" \
    "Gate must reject a loose policy before arming auto-merge"

  rm -f "$GH_CALLS" "$GH_AUTO_MERGE_STATE"
  export CB_GATE_TEST_GH_CHECK_MODE=stale
  export CB_GATE_TEST_GH_MERGE_EFFECT=merged
  make_run "$stale" passed auto
  run_gate "$stale" "$RUN_HEAD"
  unset CB_GATE_TEST_GH_CHECK_MODE CB_GATE_TEST_GH_MERGE_EFFECT
  expect_code 0 "$CMD_STATUS" \
    "stale required-check rejection${CMD_STDERR:+: $CMD_STDERR}"
  jq -e '
    .exit_class=="technical_error" and .events==[] and
    .errors==["adapter_exit:73"]
  ' "$CMD_STDOUT" >/dev/null \
    || fail "Gate must reject check runs returned for another commit SHA"
  assert_no_grep $'pr\tmerge\t' "$GH_CALLS" \
    "Gate must reject stale check evidence before arming auto-merge"
  assert_absent "$RUNS_DIR/$stale/artifacts/gate/merge-arm.json" \
    "stale check evidence must not produce an immutable merge arm"

  rm -f "$GH_CALLS" "$GH_AUTO_MERGE_STATE"
  export CB_GATE_TEST_GH_CHECK_MODE=unrelated
  export CB_GATE_TEST_GH_MERGE_EFFECT=merged
  make_run "$partial" passed auto
  run_gate "$partial" "$RUN_HEAD"
  unset CB_GATE_TEST_GH_CHECK_MODE CB_GATE_TEST_GH_MERGE_EFFECT
  expect_code 0 "$CMD_STATUS" \
    "partial required-check rejection${CMD_STDERR:+: $CMD_STDERR}"
  jq -e '
    .events==[{
      code:1,
      event:"gate_failed",
      payload:{reason:"github_required_checks_incomplete"}
    }]
  ' "$CMD_STDOUT" >/dev/null \
    || fail "wrong-app and unrelated successes must not satisfy required checks"
  assert_absent "$RUNS_DIR/$partial/artifacts/gate/merge-outcome.json" \
    "partial required checks must not produce a merged outcome seal"
  assert_absent "$RUNS_DIR/$partial/artifacts/gate/terminal.json" \
    "partial required checks must not hand Cleaner a successful terminal"

  pass "Gate binds strict exact-SHA checks, arms once, observes merge, and recovers"
}
# -/ 10/11

# -- 11/11 CORE · test_seals_github_terminal_outcomes --
test_seals_github_terminal_outcomes() {
  local closed=gate-auto-merge-closed auto_cancelled=gate-auto-merge-cancelled
  local failed=gate-auto-merge-check-failed
  local outcome terminal poison gh_calls nm_calls

  rm -f "$GH_CALLS" "$NM_CALLS" "$GH_AUTO_MERGE_STATE"
  export CB_GATE_TEST_GH_MERGE_EFFECT=armed-failed-then-closed
  export CB_GATE_MERGE_POLL_SECONDS=1
  make_run "$failed" passed auto
  run_gate "$failed" "$RUN_HEAD"
  unset CB_GATE_TEST_GH_MERGE_EFFECT CB_GATE_MERGE_POLL_SECONDS
  expect_code 0 "$CMD_STATUS" \
    "failed required-check terminal${CMD_STDERR:+: $CMD_STDERR}"
  jq -e '
    .exit_class=="completed" and .reasons==[] and .errors==[] and
    .events==[{
      code:1,
      event:"gate_failed",
      payload:{reason:"github_required_checks_failed"}
    }] and
    any(.artifacts[];
      .id=="gate-merge-outcome" and
      .path=="artifacts/gate/merge-outcome.json") and
    any(.artifacts[];
      .id=="gate-terminal" and
      .path=="artifacts/gate/terminal.json")
  ' "$CMD_STDOUT" >/dev/null \
    || fail "definitive check failure did not become durable: $(jq -c . "$CMD_STDOUT")"
  outcome="$RUNS_DIR/$failed/artifacts/gate/merge-outcome.json"
  terminal="$RUNS_DIR/$failed/artifacts/gate/terminal.json"
  jq -e --arg sha "$RUN_HEAD" '
    .schema=="combo.gate-merge-outcome/v4" and
    .candidate_sha==$sha and .outcome=="failed" and
    .reason=="github_required_checks_failed" and
    .requirements==.observed_requirements and
    .observation.state=="OPEN" and
    .observation.autoMergeRequest.mergeMethod=="REBASE" and
    .observation.headRefOid==$sha and
    any(.observation.checks.check_runs[];
      .name=="backend" and .app_id==101 and
      .head_sha==$sha and .status=="COMPLETED" and
      .conclusion=="FAILURE")
  ' "$outcome" >/dev/null \
    || fail "failed outcome evidence should bind the exact required check and armed PR"
  jq -e '
    .schema=="combo.gate-terminal/v5" and
    .normalized_outcome=="failed" and
    .no_mistakes.outcome=="passed" and
    .merge=={
      mode:"auto",
      arm:"artifacts/gate/merge-arm.json",
      outcome:"artifacts/gate/merge-outcome.json"
    } and
    .result=={
      exit_class:"completed",
      events:[{
        code:1,
        event:"gate_failed",
        payload:{reason:"github_required_checks_failed"}
      }],
      reasons:[],
      errors:[]
    }
  ' "$terminal" >/dev/null \
    || fail "failed terminal seal should distinguish GitHub from NM failure"

  gh_calls=$(wc -l <"$GH_CALLS" | tr -d " ")
  nm_calls=$(wc -l <"$NM_CALLS" | tr -d " ")
  run_gate "$failed" "$RUN_HEAD" 2
  expect_code 0 "$CMD_STATUS" \
    "failed required-check replay${CMD_STDERR:+: $CMD_STDERR}"
  jq -e '
    .events==[{
      code:1,
      event:"gate_failed",
      payload:{reason:"github_required_checks_failed"}
    }]
  ' "$CMD_STDOUT" >/dev/null \
    || fail "failed terminal replay should preserve the exact GitHub reason"
  [ "$(wc -l <"$GH_CALLS" | tr -d " ")" -eq "$gh_calls" ] \
    || fail "failed terminal replay must not observe or mutate GitHub again"
  [ "$(wc -l <"$NM_CALLS" | tr -d " ")" -eq "$nm_calls" ] \
    || fail "failed terminal replay must not re-enter No-Mistakes"

  rm -f "$GH_CALLS" "$NM_CALLS" "$GH_AUTO_MERGE_STATE"
  export CB_GATE_TEST_GH_MERGE_EFFECT=armed-then-closed
  export CB_GATE_MERGE_POLL_SECONDS=1
  make_run "$closed" passed auto
  run_gate "$closed" "$RUN_HEAD"
  unset CB_GATE_TEST_GH_MERGE_EFFECT CB_GATE_MERGE_POLL_SECONDS
  expect_code 0 "$CMD_STATUS" \
    "closed auto-merge terminal${CMD_STDERR:+: $CMD_STDERR}"
  jq -e '
    .exit_class=="cancelled" and .events==[] and
    .reasons==["github_pr_closed"] and .errors==[] and
    any(.artifacts[];
      .id=="gate-merge-outcome" and
      .path=="artifacts/gate/merge-outcome.json") and
    any(.artifacts[];
      .id=="gate-terminal" and
      .path=="artifacts/gate/terminal.json")
  ' "$CMD_STDOUT" >/dev/null \
    || fail "an authenticated closed PR should become a durable cancelled Gate"
  outcome="$RUNS_DIR/$closed/artifacts/gate/merge-outcome.json"
  terminal="$RUNS_DIR/$closed/artifacts/gate/terminal.json"
  jq -e --arg sha "$RUN_HEAD" '
    .schema=="combo.gate-merge-outcome/v3" and
    .candidate_sha==$sha and .outcome=="cancelled" and
    .reason=="github_pr_closed" and
    .requirements==.observed_requirements and
    .observation.state=="CLOSED" and
    .observation.headRefOid==$sha
  ' "$outcome" >/dev/null \
    || fail "closed outcome evidence should bind the exact PR, head, and policy"
  jq -e '
    .schema=="combo.gate-terminal/v4" and
    .normalized_outcome=="cancelled" and
    .no_mistakes.outcome=="passed" and
    .merge=={
      mode:"auto",
      arm:"artifacts/gate/merge-arm.json",
      outcome:"artifacts/gate/merge-outcome.json"
    } and
    .result.exit_class=="cancelled" and
    .result.reasons==["github_pr_closed"]
  ' "$terminal" >/dev/null \
    || fail "closed terminal seal should distinguish GitHub from NM cancellation"

  gh_calls=$(wc -l <"$GH_CALLS" | tr -d " ")
  nm_calls=$(wc -l <"$NM_CALLS" | tr -d " ")
  run_gate "$closed" "$RUN_HEAD" 2
  expect_code 0 "$CMD_STATUS" \
    "closed terminal replay${CMD_STDERR:+: $CMD_STDERR}"
  jq -e '
    .exit_class=="cancelled" and
    .reasons==["github_pr_closed"]
  ' "$CMD_STDOUT" >/dev/null \
    || fail "closed terminal replay should preserve cancellation"
  [ "$(wc -l <"$GH_CALLS" | tr -d " ")" -eq "$gh_calls" ] \
    || fail "closed terminal replay must not observe or mutate GitHub again"
  [ "$(wc -l <"$NM_CALLS" | tr -d " ")" -eq "$nm_calls" ] \
    || fail "closed terminal replay must not re-enter No-Mistakes"
  poison="$terminal.poison"
  jq '.result.reasons=["github_auto_merge_cancelled"]' \
    "$terminal" >"$poison"
  chmod 0444 "$poison"
  mv -f "$poison" "$terminal"
  run_gate "$closed" "$RUN_HEAD" 3
  expect_code 0 "$CMD_STATUS" \
    "mismatched cancellation replay${CMD_STDERR:+: $CMD_STDERR}"
  jq -e '
    .exit_class=="technical_error" and .events==[] and
    .errors==["adapter_exit:73"]
  ' "$CMD_STDOUT" >/dev/null \
    || fail "terminal replay must reject mismatched cancellation evidence"
  [ "$(wc -l <"$GH_CALLS" | tr -d " ")" -eq "$gh_calls" ] \
    || fail "invalid cancellation evidence must not query or mutate GitHub"
  [ "$(wc -l <"$NM_CALLS" | tr -d " ")" -eq "$nm_calls" ] \
    || fail "invalid cancellation evidence must not re-enter No-Mistakes"

  rm -f "$GH_CALLS" "$NM_CALLS" "$GH_AUTO_MERGE_STATE"
  export CB_GATE_TEST_GH_MERGE_EFFECT=armed-then-auto-cancelled
  export CB_GATE_MERGE_POLL_SECONDS=1
  make_run "$auto_cancelled" passed auto
  run_gate "$auto_cancelled" "$RUN_HEAD"
  unset CB_GATE_TEST_GH_MERGE_EFFECT CB_GATE_MERGE_POLL_SECONDS
  expect_code 0 "$CMD_STATUS" \
    "disabled auto-merge terminal${CMD_STDERR:+: $CMD_STDERR}"
  jq -e '
    .exit_class=="cancelled" and .events==[] and
    .reasons==["github_auto_merge_cancelled"] and .errors==[]
  ' "$CMD_STDOUT" >/dev/null \
    || fail "removing an authenticated merge arm should cancel Gate"
  jq -e '
    .schema=="combo.gate-merge-outcome/v3" and
    .outcome=="cancelled" and
    .reason=="github_auto_merge_cancelled" and
    .observation.state=="OPEN" and
    .observation.autoMergeRequest==null
  ' "$RUNS_DIR/$auto_cancelled/artifacts/gate/merge-outcome.json" >/dev/null \
    || fail "auto-merge cancellation should retain authenticated OPEN evidence"

  pass "Gate seals and replays authenticated GitHub failed/cancelled outcomes"
}
# -/ 11/11

test_validates_exact_sha
test_recovers_exact_pr
test_seals_configured_identity
test_rejects_candidate_drift
test_maps_terminal_outcomes
test_guards_argument_edges
test_replays_terminal_seal
test_adopts_interrupted_run
test_serializes_global_gate
test_arms_auto_merge_once
test_seals_github_terminal_outcomes
