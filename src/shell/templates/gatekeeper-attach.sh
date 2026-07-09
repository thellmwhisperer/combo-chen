# Resolve the current-head no-mistakes run through the canonical axi-status
# parser and attach to it. The run id does not exist until the runner reaches
# gatekeeper, and bare attach is repo-global in no-mistakes and can follow a
# sibling combo run, so branch AND head must match before attaching.
__AXI_STATUS_LIB__
cd __WORKTREE__ || exit 1
expected_branch=__EXPECTED_BRANCH__
expected_head=$(git rev-parse --short=7 HEAD 2>/dev/null || true)
gatekeeper_attach_mode=__ATTACH_MODE__
gatekeeper_done_file=__DONE_FILE__
attach_max_attempts=__MAX_ATTEMPTS__
attempt=0
while :; do
  no_mistakes_status=$(no-mistakes axi status 2>/dev/null || true)
  no_mistakes_run_id=$(no_mistakes_axi_field "$no_mistakes_status" id)
  no_mistakes_run_branch=$(no_mistakes_axi_field "$no_mistakes_status" branch)
  no_mistakes_run_head=$(no_mistakes_axi_field "$no_mistakes_status" head)
  no_mistakes_run_status=$(no_mistakes_axi_field "$no_mistakes_status" status)
  if [ -n "$no_mistakes_run_id" ] && [ "$no_mistakes_run_branch" = "$expected_branch" ] && no_mistakes_axi_head_matches "$no_mistakes_run_head" "$expected_head" && no_mistakes_axi_run_is_attachable "$no_mistakes_run_status"; then
    if [ "$gatekeeper_attach_mode" = "exec" ]; then
      exec no-mistakes attach --run "$no_mistakes_run_id"
    else
      no-mistakes attach --run "$no_mistakes_run_id"
    fi
  fi
  if [ -n "$gatekeeper_done_file" ] && [ -f "$gatekeeper_done_file" ]; then
    echo "gatekeeper-attach: gate script finished before attach became available" >&2
    exit 2
  fi
  attempt=$((attempt + 1))
  if [ "$attempt" -gt "$attach_max_attempts" ]; then
    echo "gatekeeper-attach: timed out after __TIMEOUT_SECONDS__ seconds" >&2
    exit 1
  fi
  echo "gatekeeper-attach: waiting for gatekeeper on $expected_branch@$expected_head (attempt $attempt/$attach_max_attempts)..." >&2
  sleep __RETRY_INTERVAL_SECONDS__
done
