#!/bin/sh
# Generated gate script shared by the initial-gate retry and the post-address
# gate. Publishes the head to the mirror, runs the gate with the config-copy
# watcher, classifies the outcome, and journals every transition through emit.
set -u
__AXI_STATUS_LIB__
printf '%s\n' __BANNER__
gatekeeper_log=__GATEKEEPER_LOG__
status_file=__STATUS_FILE__
autoclose_log=__AUTOCLOSE_LOG__
cd __WORKTREE__ || exit 1
__EMIT__ gate_started
gatekeeper_start_sha=$(git rev-parse HEAD 2>/dev/null || true)
gate_lease_code=0
__GATE_LEASE_SCRIPT__
__EMIT__ gate_status --field state=fix_inflight --field head_sha="$gatekeeper_start_sha"
rm -f "$status_file"
(
  gatekeeper_code=0
  (
__MIRROR_PUBLISH__
__GATEKEEPER_RUN__
  ) || gatekeeper_code=$?
  printf '%s\n' "$gatekeeper_code" > "$status_file"
) 2>&1 | tee "$gatekeeper_log"
gatekeeper_code=$(cat "$status_file" 2>/dev/null || printf '1')
rm -f "$status_file"
__ALREADY_RUNNING_GUARD__
__AWAITING_APPROVAL_CHECK__
__RECOVERY_SCRIPT__
if [ "$gatekeeper_code" -ne 0 ]; then
  gatekeeper_head_sha=$(git rev-parse HEAD 2>/dev/null || true)
__FAILURE_REASON__
  __EMIT__ gate_status --field state=failed --field head_sha="$gatekeeper_head_sha"
  __EMIT__ gate_failed --field exit_code="$gatekeeper_code" --field reason="$gatekeeper_failure_reason"
  exit "$gatekeeper_code"
fi
gatekeeper_head_sha=$(git rev-parse HEAD 2>/dev/null || true)
pr_url=$(gh pr list --head __BRANCH__ --json url --jq '.[0].url' 2>/dev/null || true)
__TAIL__
