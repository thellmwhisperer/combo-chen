# A nonzero gate exit can mean "another gate already runs for this head"
# (daemon semaphore). If the live run matches this branch and head, hand the
# window to it instead of failing. Parses through the canonical axi-status
# lib defined by the surrounding gate script (Cite: #281).
if [ "$gatekeeper_code" -ne 0 ]; then
  status_probe_log="${gatekeeper_log}.status"
  gatekeeper_probe_matched=0
  if no-mistakes axi status > "$status_probe_log" 2>&1; then
    gatekeeper_probe_status=$(cat "$status_probe_log" 2>/dev/null || true)
    gatekeeper_run_id=$(no_mistakes_axi_field "$gatekeeper_probe_status" id)
    gatekeeper_run_branch=$(no_mistakes_axi_field "$gatekeeper_probe_status" branch)
    gatekeeper_run_head=$(no_mistakes_axi_field "$gatekeeper_probe_status" head)
    gatekeeper_run_status=$(no_mistakes_axi_field "$gatekeeper_probe_status" status)
    if [ "$gatekeeper_run_branch" = __EXPECTED_BRANCH__ ] && no_mistakes_axi_head_matches "$gatekeeper_run_head" __EXPECTED_HEAD__ && no_mistakes_axi_run_is_attachable "$gatekeeper_run_status"; then
      gatekeeper_probe_matched=1
    fi
  fi
  if [ "$gatekeeper_probe_matched" = "1" ]; then
    if [ -z "$gatekeeper_run_id" ]; then
      cat "$status_probe_log" >> "$gatekeeper_log" 2>/dev/null || true
      exit "$gatekeeper_code"
    fi
    gatekeeper_head_sha=$(git rev-parse HEAD 2>/dev/null || true)
    __EMIT__ gate_status --field state=fix_inflight --field head_sha="$gatekeeper_head_sha"
    gate_lease_release || true
    exec no-mistakes attach --run "$gatekeeper_run_id"
  fi
  cat "$status_probe_log" >> "$gatekeeper_log" 2>/dev/null || true
fi
