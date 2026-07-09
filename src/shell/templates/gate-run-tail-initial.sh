# Initial-gate tail: a PR must exist after the gate; journal it and start the
# reviewer, or escalate when the gate finished without opening one.
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
__STATUS_IDLE_HEAD__
  __EMIT__ pr_opened --field url="$pr_url"
  __ACTIVATE_REVIEWER__
else
__STATUS_IDLE_HEAD__
  __EMIT__ needs_human --field reason=pr_missing
fi
