# Post-address tail: the PR already exists; refresh its head, keep the
# autoclose contract, and record gate_validated for the published head.
if [ -z "${pr_url:-}" ]; then pr_url=__PR_URL__; fi
pr_head_sha=$(gh pr view "$pr_url" --json headRefOid --jq '.headRefOid' 2>/dev/null || true)
if [ -n "${pr_head_sha:-}" ]; then
  gatekeeper_head_sha="$pr_head_sha"
fi
if __ENSURE_PR_AUTOCLOSE__ "$pr_url" > "$autoclose_log" 2>&1; then
  :
else
  autoclose_code=$?
  if [ -n "$gatekeeper_head_sha" ]; then
    __EMIT__ gate_status --field state=failed --field head_sha="$gatekeeper_head_sha"
  else
    __EMIT__ gate_status --field state=failed
  fi
  __EMIT__ gate_failed --field exit_code="$autoclose_code"
  __EMIT__ pr_autoclose_failed --field exit_code="$autoclose_code" --field url="$pr_url"
  exit "$autoclose_code"
fi
if [ -n "$gatekeeper_head_sha" ]; then
__STATUS_IDLE_HEAD__
  __EMIT__ gate_validated --field sha="$gatekeeper_head_sha"
else
__STATUS_IDLE_NO_HEAD__
fi
