# Abort any active no-mistakes run on the expected branch before starting a
# new gate. Embedded by no-mistakes-gatekeeper-run.sh and mirror-publish.sh,
# which define the axi-status-lib functions.
no_mistakes_expected_branch=__EXPECTED_BRANCH__
if [ -z "$no_mistakes_expected_branch" ]; then
  no_mistakes_expected_branch=$(git branch --show-current 2>/dev/null || true)
fi
no_mistakes_abort_attempt=0
no_mistakes_abort_attempt_limit=${COMBO_CHEN_NO_MISTAKES_ABORT_ATTEMPTS:-3}
no_mistakes_abort_failed=0
while [ "$no_mistakes_abort_attempt" -lt "$no_mistakes_abort_attempt_limit" ]; do
  no_mistakes_previous_status=$(no-mistakes axi status 2>/dev/null || true)
  no_mistakes_previous_run_id=$(no_mistakes_axi_field "$no_mistakes_previous_status" id)
  no_mistakes_previous_branch=$(no_mistakes_axi_field "$no_mistakes_previous_status" branch)
  no_mistakes_previous_run_status=$(no_mistakes_axi_field "$no_mistakes_previous_status" status)
  if [ -z "$no_mistakes_previous_run_id" ] || [ "$no_mistakes_previous_branch" != "$no_mistakes_expected_branch" ] || ! no_mistakes_axi_run_is_active "$no_mistakes_previous_run_status"; then
    break
  fi
  printf '%s\n' "aborting previous no-mistakes run $no_mistakes_previous_run_id on $no_mistakes_previous_branch"
  no_mistakes_abort_attempt=$((no_mistakes_abort_attempt + 1))
  if ! no-mistakes axi abort >/dev/null 2>&1; then
    no_mistakes_abort_failed=1
    break
  fi
  sleep 1
done
if [ "$no_mistakes_abort_failed" = "1" ] || [ "$no_mistakes_abort_attempt" -ge "$no_mistakes_abort_attempt_limit" ]; then
  no_mistakes_after_abort_status=$(no-mistakes axi status 2>/dev/null || true)
  no_mistakes_after_abort_id=$(no_mistakes_axi_field "$no_mistakes_after_abort_status" id)
  no_mistakes_after_abort_branch=$(no_mistakes_axi_field "$no_mistakes_after_abort_status" branch)
  no_mistakes_after_abort_run_status=$(no_mistakes_axi_field "$no_mistakes_after_abort_status" status)
  if [ -n "$no_mistakes_after_abort_id" ] && [ "$no_mistakes_after_abort_branch" = "$no_mistakes_expected_branch" ] && no_mistakes_axi_run_is_active "$no_mistakes_after_abort_run_status"; then
    printf '%s\n' "no-mistakes previous run still active after abort: $no_mistakes_after_abort_id on $no_mistakes_after_abort_branch" >&2
    exit 1
  fi
fi
