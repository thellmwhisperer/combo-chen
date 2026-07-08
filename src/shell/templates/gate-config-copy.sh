# Copy the combo worktree .no-mistakes.yaml into the daemon's active run
# worktree so the gate runner validates with pinned commands. Embedded by
# no-mistakes-gatekeeper-run.sh, which defines the axi-status-lib functions.
no_mistakes_expected_branch=__EXPECTED_BRANCH__
if [ -z "$no_mistakes_expected_branch" ]; then
  no_mistakes_expected_branch=$(git branch --show-current 2>/dev/null || true)
fi
no_mistakes_config_copied=0
no_mistakes_config_attempt=0
no_mistakes_config_attempt_limit=${COMBO_CHEN_NO_MISTAKES_CONFIG_COPY_ATTEMPTS:-120}
while [ "$no_mistakes_config_attempt" -lt "$no_mistakes_config_attempt_limit" ]; do
  no_mistakes_repo_status=$(no-mistakes status 2>/dev/null || true)
  no_mistakes_axi_status=$(no-mistakes axi status 2>/dev/null || true)
  no_mistakes_run_id=$(no_mistakes_axi_field "$no_mistakes_axi_status" id)
  no_mistakes_run_branch=$(no_mistakes_axi_field "$no_mistakes_axi_status" branch)
  no_mistakes_run_status=$(no_mistakes_axi_field "$no_mistakes_axi_status" status)
  no_mistakes_gate_path=$(no_mistakes_axi_field "$no_mistakes_repo_status" gate)
  if [ -n "$no_mistakes_run_id" ] && [ -n "$no_mistakes_gate_path" ] && [ "$no_mistakes_run_branch" = "$no_mistakes_expected_branch" ] && no_mistakes_axi_run_is_active "$no_mistakes_run_status"; then
    no_mistakes_data_dir=$(dirname "$(dirname "$no_mistakes_gate_path")")
    no_mistakes_repo_id=$(basename "$no_mistakes_gate_path" .git)
    no_mistakes_run_dir="$no_mistakes_data_dir/worktrees/$no_mistakes_repo_id/$no_mistakes_run_id"
    if [ -d "$no_mistakes_run_dir" ]; then
      cp -p .no-mistakes.yaml "$no_mistakes_run_dir/.no-mistakes.yaml" || exit 1
      no_mistakes_config_copied=1
      printf '%s\n' "copied .no-mistakes.yaml to $no_mistakes_run_dir/.no-mistakes.yaml"
      break
    fi
  fi
  no_mistakes_config_attempt=$((no_mistakes_config_attempt + 1))
  sleep 1
done
if [ "$no_mistakes_config_copied" != "1" ]; then
  printf '%s\n' "no-mistakes config copy failed: active run worktree not found" >&2
  exit 1
fi
