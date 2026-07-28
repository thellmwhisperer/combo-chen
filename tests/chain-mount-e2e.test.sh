#!/usr/bin/env bash
# @overview Opt-in, unmocked #339 course-correction proof. It runs the mounted
#   chain against Combo Chen itself, with GNHF producing a docs-only branch,
#   zero Reviewer steps, a review-disabled manual Gate, and exact Cleaner
#   release. Ordinary tests skip this remote-writing acceptance.
#
#   READING GUIDE
#   -------------
#   1. Hard authorization guards  <- exact repo, clean implementation, tools.
#   2. Compile docs-only plan     <- fresh main-combo-v1 plus operator bindings.
#   3. Interrupt and resume       <- five endpoints and immutable custody.
#   4. Verify terminal evidence   <- validated PR, docs-only diff, exact release.
#
#   MAIN FLOW
#   ---------
#   opt-in -> fresh base -> plan -> Launcher stop -> resume -> validated -> replay
#
#   PUBLIC API
#   ----------
#   COMBO_CHEN_E2E_ENABLE=course-correction-8cbcf1108dc5cf43
#   COMBO_CHEN_E2E_TARGET=thellmwhisperer/combo-chen
#   COMBO_CHEN_E2E_GNHF_AGENT=<operator-selected agent>
#   COMBO_CHEN_E2E_NM_RUNTIME=<effective No-Mistakes runtime>
#   COMBO_CHEN_E2E_NM_MODEL=<effective No-Mistakes model>
#   bash tests/chain-mount-e2e.test.sh
#
# @exports none
# @deps bash, git, gh-axi, gnhf, grep, jq, no-mistakes, tmux, treehouse,
#   tests/lib.sh, bin/cb-plan.sh, bin/cb-run.sh
set -euo pipefail

authorization=${COMBO_CHEN_E2E_ENABLE:-}
if [ "$authorization" != course-correction-8cbcf1108dc5cf43 ]; then
  printf 'skip - unmocked #339 course-correction E2E is not explicitly enabled\n'
  exit 0
fi

fail() {
  printf 'not ok - %s\n' "$1" >&2
  exit 1
}

root=$(CDPATH='' cd -- "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
bin=$root/bin
# shellcheck source=tests/lib.sh disable=SC1091
. "$root/tests/lib.sh"
target=${COMBO_CHEN_E2E_TARGET:-}
[ "$target" = thellmwhisperer/combo-chen ] \
  || fail "target must be exactly thellmwhisperer/combo-chen"
if [ -n "${COMBO_CHEN_E2E_REPO:-}" ] \
  && [ "$COMBO_CHEN_E2E_REPO" != "$target" ]; then
  fail "sandbox or alternate repository selection is forbidden"
fi
[ -z "$(git -C "$root" status --porcelain)" ] \
  || fail "implementation worktree must be clean before the real run"

for tool in gh-axi git gnhf jq no-mistakes realpath tmux treehouse; do
  command -v "$tool" >/dev/null 2>&1 || fail "required tool is missing: $tool"
done
gnhf_agent=${COMBO_CHEN_E2E_GNHF_AGENT:-}
nm_runtime=${COMBO_CHEN_E2E_NM_RUNTIME:-}
nm_model=${COMBO_CHEN_E2E_NM_MODEL:-}
[ -n "$gnhf_agent" ] || fail "COMBO_CHEN_E2E_GNHF_AGENT is required"
[ -n "$nm_runtime" ] || fail "COMBO_CHEN_E2E_NM_RUNTIME is required"
[ -n "$nm_model" ] || fail "COMBO_CHEN_E2E_NM_MODEL is required"

origin_url=$(git -C "$root" remote get-url origin)
case "$origin_url" in
  https://github.com/thellmwhisperer/combo-chen|\
  https://github.com/thellmwhisperer/combo-chen.git|\
  git@github.com:thellmwhisperer/combo-chen.git) ;;
  *) fail "origin is not the authorized Combo Chen repository" ;;
esac
repo_evidence=$(gh-axi api "/repos/$target")
printf '%s\n' "$repo_evidence" |
  grep -Fxq 'full_name: thellmwhisperer/combo-chen' \
  || fail "gh-axi did not confirm the authorized repository"
printf '%s\n' "$repo_evidence" |
  grep -Fxq 'default_branch: main-combo-v1' \
  || fail "gh-axi did not confirm the authorized base branch"

# -- 1/4 CORE · Freeze one fresh authorized base -- <- START HERE
git -C "$root" fetch origin main-combo-v1 >/dev/null
base_sha=$(git -C "$root" rev-parse --verify \
  'origin/main-combo-v1^{commit}')
case "$base_sha" in
  [0-9a-f][0-9a-f][0-9a-f][0-9a-f]*) ;;
  *) fail "fresh main-combo-v1 did not resolve to a commit" ;;
esac
expected_base_branch=main-combo-v1
expected_base_ref=refs/heads/$expected_base_branch
if git -C "$root" show-ref --verify --quiet "$expected_base_ref"; then
  [ "$(git -C "$root" rev-parse --verify "$expected_base_ref^{commit}")" \
    = "$base_sha" ] \
    || fail "local expected-base branch disagrees with fresh origin"
else
  git -C "$root" update-ref "$expected_base_ref" "$base_sha" "" \
    || fail "could not materialize the fresh local expected-base branch"
fi
run=${COMBO_CHEN_E2E_RUN_ID:-e2e-339-$(date -u +%Y%m%d%H%M%S)}
case "$run" in ''|-*|*[!a-z0-9-]*) fail "invalid E2E run id" ;; esac
evidence_root=$root/.tmp/chain-mount-e2e/$run
runs_dir=$evidence_root/runs
run_dir=$runs_dir/$run
config=$evidence_root/config.json
[ ! -e "$evidence_root" ] || fail "E2E run evidence already exists"
mkdir -p "$run_dir"
# -/ 1/4

# -- 2/4 CORE · Compile the zero-Reviewer docs-only plan --
gnhf_binary=$(realpath "$(command -v gnhf)")
nm_binary=$(realpath "$(command -v no-mistakes)")
prompt="Act as the GNHF Coder seat for Combo Chen issue #339. Produce a
documentation-only architecture update on the current combo/$run branch.
Read the checked-out product and the read-only chain implementation reference
at $root/bin/cb-run.sh, $root/bin/cb-chain.sh,
$root/bin/cb-launcher-adapter.sh, $root/bin/cb-agent-run.sh,
$root/bin/cb-gate.sh, and $root/bin/cb-cleaner-adapter.sh. Update or add files
only below docs/ so architecture, specifications, operator guides, commands,
five visible tmux endpoints, zero-or-more Reviewer routing, immutable Launcher
custody, expected-base Gate rejection, replay, terminal outcomes, and exact
Cleaner behavior match the real Bash v1 product. Deliberately do not edit
README.md, AGENTS.md, product code, tests, workflows, CI, configuration, or
anything outside docs/. Inspect before writing, avoid duplicated prose, run
documentation-relevant validation, and commit every generated docs change
locally. Finish only when at least one new commit exists and every changed path
from origin/main-combo-v1 is under docs/."

jq -n \
  --arg launcher "$bin/cb-launcher-adapter.sh" \
  --arg coder "$bin/cb-agent-run.sh" \
  --arg gate "$bin/cb-gate.sh" \
  --arg cleaner "$bin/cb-cleaner-adapter.sh" \
  --arg repo "$root" --arg base "$base_sha" \
  --arg expected_base_branch "$expected_base_branch" \
  --arg gnhf "$gnhf_binary" --arg agent "$gnhf_agent" \
  --arg prompt "$prompt" --arg nm "$nm_binary" \
  --arg runtime "$nm_runtime" --arg model "$nm_model" '
    {
      schema:"combo.config/v1",
      adapters:{
        launcher:{argv:[$launcher],roles:["launcher"]},
        gnhf:{argv:[$coder,"gnhf"],roles:["coder"]},
        gate:{argv:[$gate],roles:["gate"]},
        cleaner:{argv:[$cleaner],roles:["cleaner"]}
      },
      roles:{
        launcher:{
          adapter:"launcher",
          config:{
            schema:"combo.launcher/treehouse/v1",
            repo_dir:$repo,
            base_ref:$expected_base_branch,
            setup_command:"",
            readiness:{
              required_seats:["coder","gate"],
              seats:[
                {id:"coder",harness:$gnhf,auth_cmd:"gnhf --version"},
                {id:"gate",harness:$nm,auth_cmd:"no-mistakes doctor"}
              ]
            }
          }
        },
        coder:{
          adapter:"gnhf",
          config:{
            schema:"combo.coder/gnhf/v1",
            argv:[$gnhf],
            prompt:$prompt,
            agent:$agent,
            max_iterations:4,
            stop_when:"a committed docs-only architecture/specification/guide update is complete and accurate",
            prevent_sleep:"on",
            meteor_frequency:0,
            current_branch:true,
            output_schema:"combo.step-output/v1",
            environment:{inherit:["PATH","HOME"],set:{}}
          }
        },
        reviewers:[],
        gate:{
          adapter:"gate",
          config:{
            schema:"combo.gate.no-mistakes/v1",
            binary:$nm,
            runtime:$runtime,
            model:$model,
            arguments:[],
            intent:"Update Combo Chen docs, architecture, specifications, and guides to match the real Bash v1 chain while excluding README and all non-docs payloads.",
            approval:"auto",
            review:false,
            merge:"manual",
            expected_base_branch:$expected_base_branch,
            expected_base_sha:$base,
            allowed_paths:["docs/"],
            no_mistakes_command_timeout_seconds:14400,
            github_command_timeout_seconds:300
          }
        },
        cleaner:{
          adapter:"cleaner",
          config:{schema:"combo.cleaner/treehouse/v1"}
        }
      }
    }
  ' >"$config"
CB_RUNS_DIR=$runs_dir bash "$bin/cb-plan.sh" \
  "$run" --config "$config" >/dev/null
plan_sha=$(cb_file_sha256 "$run_dir/plan.json")
# -/ 2/4

# -- 3/4 CORE · Interrupt after Launcher, then resume through Cleaner --
export CB_RUNS_DIR=$runs_dir
export CB_TMUX_SOCKET=cb-e2e-"$run"
export CB_TMUX_CONF=/dev/null
teardown() {
  if [ -f "${custody:-}" ]; then
    holder_status=$(cd "$root" && treehouse status 2>/dev/null || true)
    if printf '%s\n' "$holder_status" |
      awk -v holder="$run" '
        NF==6 && $4=="(held" && $5=="by" && $6==holder ")" { found=1 }
        END { exit !found }
      '; then
      printf 'warning - exact custody holder remains for typed recovery: %s\n' \
        "$run" >&2
    fi
  fi
  tmux -L "$CB_TMUX_SOCKET" -f /dev/null kill-server \
    >/dev/null 2>&1 || true
}
trap teardown EXIT
set +e
first_output=$(CB_CHAIN_STOP_AFTER_ROLE=launcher \
  bash "$bin/cb-run.sh" "$run" </dev/null)
first_status=$?
set -e
[ "$first_status" -eq 130 ] || fail "Launcher interruption was not exit 130"
[ -z "$first_output" ] || fail "interruption fabricated terminal stdout"
custody=$run_dir/agents/launcher.ownership.json
[ -f "$custody" ] && [ ! -L "$custody" ] \
  || fail "Launcher custody is missing"
custody_sha=$(cb_file_sha256 "$custody")

set +e
terminal_output=$(bash "$bin/cb-run.sh" "$run" </dev/null)
terminal_status=$?
set -e
[ "$terminal_status" -eq 0 ] \
  || fail "real chain ended nonzero; inspect $run_dir/chain-result.json"
[ "$terminal_output" = validated ] \
  || fail "manual Gate did not print the truthful validated outcome"
# -/ 3/4

# -- 4/4 CORE · Verify machine-readable topology, PR, replay, and release --
[ "$(cb_file_sha256 "$run_dir/plan.json")" = "$plan_sha" ] \
  || fail "real chain mutated plan.json"
[ "$(cb_file_sha256 "$custody")" = "$custody_sha" ] \
  || fail "real resume rewrote Launcher custody"
[ "$(cb_file_mode "$custody")" = 444 ] \
  || fail "real Launcher custody is not read-only"

for role in launcher coder reviewer gate cleaner; do
  meta=$run_dir/agents/$role.meta
  [ -f "$meta" ] || fail "missing real endpoint metadata: $role"
  window_id=$(awk -F= '$1=="window_id"{print $2}' "$meta")
  tmux -L "$CB_TMUX_SOCKET" -f /dev/null display-message \
    -p -t "$window_id" '#{pane_dead}' | grep -qx 0 \
    || fail "real endpoint is not occupied: $role"
done
reviewer_plan_count=$(jq \
  '[.steps[] | select(.role=="reviewer")] | length' \
  "$run_dir/plan.json")
reviewer_dispatch_count=$(jq -R \
  'fromjson? | select(.role=="reviewer")' \
  "$run_dir/dispatch-log.jsonl" | wc -l | tr -d ' ')
reviewer_job_count=$(find "$run_dir/dispatch/jobs" -type f \
  -name 'reviewer-*' -print | wc -l | tr -d ' ')
reviewer_step_count=$(find "$run_dir/steps" -mindepth 1 -maxdepth 1 \
  -type d -name '*-reviewer*' -print | wc -l | tr -d ' ')
reviewer_event_count=$(jq -R \
  'fromjson? | select(.agent=="reviewer" or .role=="reviewer")' \
  "$run_dir/journal.jsonl" | wc -l | tr -d ' ')
reviewer_artifact_count=$(find "$run_dir/artifacts" -type f \
  -path '*reviewer*' -print 2>/dev/null | wc -l | tr -d ' ')
for count in \
  "$reviewer_plan_count" "$reviewer_dispatch_count" "$reviewer_job_count" \
  "$reviewer_step_count" "$reviewer_event_count" "$reviewer_artifact_count"; do
  [ "$count" -eq 0 ] || fail "Reviewer endpoint recorded forbidden activity"
done
reviewer_absence=$evidence_root/reviewer-absence.json
jq -n --arg run "$run" '
  {
    schema:"combo.reviewer-absence-evidence/v1",
    run_id:$run,
    endpoint_present:true,
    plan_members:0,
    endpoint_dispatches:0,
    endpoint_jobs:0,
    step_attempts:0,
    journal_events:0,
    artifacts:0,
    llm_invocations:0,
    basis:"no plan member, dispatch, job, step attempt, journal event, or artifact"
  }
' >"$reviewer_absence"
chmod 0444 "$reviewer_absence"
roles=$(jq -Rrs '[split("\n")[] | fromjson? | .role] | join(",")' \
  "$run_dir/dispatch-log.jsonl")
[ "$roles" = launcher,launcher,coder,gate,cleaner ] \
  || fail "real zero-Reviewer topology diverged: $roles"
jq -e '
  .terminal=={role:"gate",code:0,event:"gate_ok"} and
  .cleanup=={
    exit_class:"completed",code:0,event:"cleaned",reasons:[],errors:[]
  } and
  ([.artifacts[].id] | index("gate-terminal")!=null)
' "$run_dir/chain-result.json" >/dev/null \
  || fail "real terminal Gate/Cleaner result is not normalized"

terminal_rel=$(jq -r \
  '.artifacts[] | select(.id=="gate-terminal") | .path' \
  "$run_dir/chain-result.json")
terminal=$run_dir/$terminal_rel
pr_url=$(jq -r '.no_mistakes.pr' "$terminal")
case "$pr_url" in
  https://github.com/thellmwhisperer/combo-chen/pull/[1-9]*) ;;
  *) fail "Gate did not seal a full authorized Combo Chen PR URL" ;;
esac
worktree=$(jq -r '.worktree' "$custody")
released_status=$(cd "$root" && treehouse status) \
  || fail "Treehouse status failed while verifying exact release"
if printf '%s\n' "$released_status" |
  awk -v holder="$run" '
    NF==6 && $4=="(held" && $5=="by" && $6==holder ")" { found=1 }
    END { exit !found }
  '; then
  fail "Cleaner did not release the exact custody holder"
fi
jq -e --arg worktree "$worktree" '
  .released==true and .worktree==$worktree and .runway_kind=="treehouse" and
  .reasons==[]
' "$run_dir/agents/cleaner.ownership.json" >/dev/null \
  || fail "Cleaner release seal does not match Launcher custody"

changed_paths=$(gh-axi pr diff "$pr_url" --name-only)
[ -n "$changed_paths" ] || fail "docs PR has no changed paths"
while IFS= read -r path; do
  case "$path" in
    README.md) fail "generated PR touched README.md" ;;
    docs/*) ;;
    *) fail "generated PR escaped strict docs-only scope: $path" ;;
  esac
done <<<"$changed_paths"

dispatch_before=$(wc -l <"$run_dir/dispatch-log.jsonl" | tr -d ' ')
replay_output=$(bash "$bin/cb-run.sh" "$run" </dev/null)
[ "$replay_output" = validated ] || fail "terminal replay changed outcome"
[ "$(wc -l <"$run_dir/dispatch-log.jsonl" | tr -d ' ')" = "$dispatch_before" ] \
  || fail "terminal replay duplicated an endpoint effect"

summary=$evidence_root/summary.json
jq -n \
  --arg run "$run" --arg base "$base_sha" --arg pr "$pr_url" \
  --arg output "$terminal_output" --arg worktree "$worktree" \
  --arg paths "$changed_paths" '
    {
      schema:"combo.chain-mount-e2e-evidence/v1",
      run_id:$run,
      base_sha:$base,
      terminal_output:$output,
      pr:$pr,
      released_worktree:$worktree,
      changed_paths:($paths|split("\n")),
      reviewers:0,
      reviewer_absence:"reviewer-absence.json",
      replay:"no-duplicate-effects"
    }
  ' >"$summary"
chmod 0444 "$summary"
printf 'ok - real #339 chain validated %s\n' "$pr_url"
printf 'evidence: %s\n' "$summary"
# -/ 4/4
