# Single-shot attach probe: attach if the current-head run is live right now,
# exit quietly otherwise. Same matching contract as gatekeeper-attach.sh.
__AXI_STATUS_LIB__
cd __WORKTREE__ || exit 1
expected_branch=__EXPECTED_BRANCH__
expected_head=$(git rev-parse --short=7 HEAD 2>/dev/null || true)
gatekeeper_attach_mode=__ATTACH_MODE__
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
