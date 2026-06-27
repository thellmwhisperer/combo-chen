#!/bin/sh
# combo-chen runner for __COMBO_ID__ — generated, do not edit.
# Sequencing is mechanics; judgment stays with agents and humans.
set -u
coder_status="$(dirname "$0")/coder.exit"
coder_start_marker="$(dirname "$0")/coder-started.$$"
gnhf_iteration_snapshot="$(dirname "$0")/gnhf-iterations.$$"
gatekeeper_log="$(dirname "$0")/gatekeeper.log"
autoclose_log="$(dirname "$0")/autoclose.log"
rebase_log="$(dirname "$0")/rebase.log"
runner_progress="${COMBO_CHEN_RUNNER_PROGRESS:-0}"
runner_status() {
  if [ "$runner_progress" = "1" ]; then
    printf '%s\n' "$1"
  fi
}
gnhf_snapshot_iterations() {
  rm -f "$gnhf_iteration_snapshot"
  if [ ! -d .gnhf/runs ]; then
    : > "$gnhf_iteration_snapshot"
    return 0
  fi
  if ! command -v node >/dev/null 2>&1; then
    return 1
  fi
  node - "$gnhf_iteration_snapshot" <<'NODE'
const fs = require("fs");
const path = require("path");

const snapshotPath = process.argv[2];
const runsDir = path.join(process.cwd(), ".gnhf", "runs");

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(entryPath);
    } else {
      yield entryPath;
    }
  }
}

try {
  const rows = [];
  for (const file of walk(runsDir)) {
    const name = path.basename(file);
    if (!name.startsWith("iteration-") || !name.endsWith(".jsonl")) continue;
    const stat = fs.statSync(file);
    rows.push(JSON.stringify({ path: path.resolve(file), size: stat.size }));
  }
  fs.writeFileSync(snapshotPath, rows.join("\n") + (rows.length > 0 ? "\n" : ""));
} catch {
  process.exit(1);
}
NODE
  if [ "$?" -ne 0 ]; then
    rm -f "$gnhf_iteration_snapshot"
  fi
}
gnhf_stop_condition_met() {
  if [ ! -d .gnhf/runs ]; then
    return 1
  fi
  if ! command -v node >/dev/null 2>&1; then
    return 1
  fi
  node - "$coder_start_marker" "$gnhf_iteration_snapshot" <<'NODE'
const fs = require("fs");
const path = require("path");

let markerMs = 0;
try {
  markerMs = fs.statSync(process.argv[2]).mtimeMs;
} catch {
  process.exit(1);
}

const runsDir = path.join(process.cwd(), ".gnhf", "runs");
const preRunSizes = new Map();

try {
  const snapshot = fs.readFileSync(process.argv[3], "utf8");
  for (const line of snapshot.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const row = JSON.parse(line);
    if (typeof row?.path !== "string" || typeof row?.size !== "number") process.exit(1);
    preRunSizes.set(path.resolve(row.path), row.size);
  }
} catch {
  process.exit(1);
}

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(entryPath);
    } else {
      yield entryPath;
    }
  }
}

function isStopConditionResult(value) {
  try {
    const parsed = JSON.parse(value);
    return parsed !== null &&
      typeof parsed === "object" &&
      parsed.success === true &&
      parsed.should_fully_stop === true;
  } catch {
    return false;
  }
}

try {
  for (const file of walk(runsDir)) {
    const name = path.basename(file);
    if (!name.startsWith("iteration-") || !name.endsWith(".jsonl")) continue;
    const resolved = path.resolve(file);
    const stat = fs.statSync(file);
    const priorSize = preRunSizes.get(resolved);
    const content = fs.readFileSync(file);
    let resultText;
    if (priorSize !== undefined) {
      if (stat.size <= priorSize) continue;
      resultText = content.subarray(priorSize).toString("utf8");
    } else {
      if (stat.mtimeMs < markerMs) continue;
      resultText = content.toString("utf8");
    }
    const lines = resultText.split(/\r?\n/);
    for (const line of lines) {
      if (line.trim() === "") continue;
      if (isStopConditionResult(line)) process.exit(0);
      try {
        const event = JSON.parse(line);
        const text = event?.item?.type === "agent_message" ? event.item.text : undefined;
        if (typeof text === "string" && isStopConditionResult(text)) process.exit(0);
      } catch {}
    }
  }
} catch {
  process.exit(1);
}

process.exit(1);
NODE
}

cd __WORKTREE__ || {
  printf '%s\n' "runner: failed to enter worktree" >&2
  exit 1
}
__RUNNER_STATUS_SYNC__
__BASE_FETCH__
if ! git rebase __BASE_REF__ >> "$rebase_log" 2>&1; then
  __EMIT__ rebase_conflict --field base="$(git merge-base HEAD __BASE_REF__ 2>/dev/null || true)"
  exit 1
fi
coder_base_sha=$(git rev-parse HEAD 2>/dev/null || true)

__RUNNER_STATUS_STARTING_CODER__
__EMIT__ coder_started || exit 1

rm -f "$coder_status" "$coder_start_marker" "$gnhf_iteration_snapshot"
: > "$coder_start_marker"
gnhf_snapshot_iterations
(
  coder_code=0
  __CODER_COMMAND__ || coder_code=$?
  printf '%s\n' "$coder_code" > "$coder_status"
)
code=$(cat "$coder_status" 2>/dev/null || printf '1')
case "$code" in
  ""|*[!0-9]*) code=1 ;;
esac
rm -f "$coder_status"

if [ "$code" -ne 0 ] && gnhf_stop_condition_met; then
  __RUNNER_STATUS_STOP_CONDITION__
  code=0
fi
rm -f "$coder_start_marker" "$gnhf_iteration_snapshot"

if [ "$code" -eq 0 ]; then
  __EMIT__ coder_done || exit 1
else
  if [ "$runner_progress" = "1" ]; then
    printf '%s\n' "runner: coder failed with exit $code; stopping runner"
  fi
  coder_head_sha=$(git rev-parse HEAD 2>/dev/null || true)
  new_commit_count=0
  if [ -n "$coder_base_sha" ] && [ -n "$coder_head_sha" ]; then
    new_commit_count=$(git rev-list --count "$coder_base_sha..$coder_head_sha" 2>/dev/null || printf '0')
  fi
  case "$new_commit_count" in
    ""|*[!0-9]*) new_commit_count=0 ;;
  esac
  if [ "$new_commit_count" -gt 0 ]; then
    has_new_commits=true
  else
    has_new_commits=false
  fi
  __EMIT__ coder_failed --field exit_code=$code --field has_new_commits=$has_new_commits --field base_sha=$coder_base_sha --field head_sha=$coder_head_sha --field new_commit_count=$new_commit_count || exit "$code"
  exit $code
fi

__RUNNER_STATUS_CODER_FINISHED__
__EMIT__ gate_started
gatekeeper_start_sha=$(git rev-parse HEAD 2>/dev/null || true)
gate_lease_code=0
__GATE_LEASE_SCRIPT__
__EMIT__ gate_status --field state=fix_inflight --field head_sha="$gatekeeper_start_sha"

gatekeeper_code=0
(
__GATEKEEPER_MIRROR_SCRIPT__
__GATEKEEPER_RUN_SCRIPT__
) < /dev/null > "$gatekeeper_log" 2>&1 || gatekeeper_code=$?

if grep -Eq '^outcome:[[:space:]]*awaiting_approval[[:space:]]*$' "$gatekeeper_log"; then
  gatekeeper_head_sha=$(git rev-parse HEAD 2>/dev/null || true)
  __EMIT__ gate_status --field state=awaiting_approval --field head_sha="$gatekeeper_head_sha"
  __EMIT__ needs_human --field reason=gate_waiting
  exit 0
fi

if [ "$gatekeeper_code" -ne 0 ]; then
  gatekeeper_head_sha=$(git rev-parse HEAD 2>/dev/null || true)
  gatekeeper_failure_reason=gate_failed
  if grep -Eiq 'daemon.*(dead|died|exited|not running)|connection refused|ECONNREFUSED' "$gatekeeper_log"; then
    gatekeeper_failure_reason=daemon_dead
  fi
  __EMIT__ gate_status --field state=failed --field head_sha="$gatekeeper_head_sha"
  __EMIT__ gate_failed --field exit_code=$gatekeeper_code --field reason="$gatekeeper_failure_reason"
  exit $gatekeeper_code
fi

__RUNNER_STATUS_GATEKEEPER_FINISHED__
gatekeeper_head_sha=$(git rev-parse HEAD 2>/dev/null || true)

pr_url=$(gh pr list --head __BRANCH__ --json url --jq '.[0].url' 2>/dev/null || true)
if [ -n "${pr_url:-}" ]; then
  pr_head_sha=$(gh pr view "$pr_url" --json headRefOid --jq '.headRefOid' 2>/dev/null || true)
  if [ -n "${pr_head_sha:-}" ]; then
    gatekeeper_head_sha="$pr_head_sha"
  fi
  if __ENSURE_PR_AUTOCLOSE__ "$pr_url" > "$autoclose_log" 2>&1; then
    :
  else
    autoclose_code=$?
    __EMIT__ gate_status --field state=failed --field head_sha="$gatekeeper_head_sha"
    __EMIT__ gate_failed --field exit_code="$autoclose_code"
    __EMIT__ pr_autoclose_failed --field exit_code="$autoclose_code" --field url="$pr_url"
    exit "$autoclose_code"
  fi
  __EMIT__ gate_status --field state=idle --field head_sha="$gatekeeper_head_sha"
  __EMIT__ pr_opened --field url="$pr_url"
  __RUNNER_STATUS_PR_DETECTED__
  __ACTIVATE_REVIEWER__
else
  __RUNNER_STATUS_NO_PR__
  __EMIT__ gate_status --field state=idle --field head_sha="$gatekeeper_head_sha"
  __EMIT__ needs_human --field reason=pr_missing
fi
