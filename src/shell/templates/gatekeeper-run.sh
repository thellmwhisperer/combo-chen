__AXI_STATUS_LIB__
no_mistakes_config_copy_pid=
no_mistakes_config_copy_status=
no_mistakes_config_copy_killed=0
no_mistakes_config_copy_done=.combo-chen-no-mistakes-config-copy.$$
gatekeeper_status_file=.combo-chen-gatekeeper-status.$$
rm -f "$no_mistakes_config_copy_done" "$gatekeeper_status_file"
if [ "${COMBO_CHEN_NO_MISTAKES_PREVIOUS_RUN_ABORTED:-0}" != "1" ]; then
__ABORT_PREVIOUS_RUN__
fi
if [ -f .no-mistakes.yaml ]; then
  (
__CONFIG_COPY__
    printf '%s\n' ok > "$no_mistakes_config_copy_done"
  ) &
  no_mistakes_config_copy_pid=$!
fi
# no-mistakes creates the active run worktree from inside axi run, so run
# the gate in parallel with the watcher but do not accept a successful gate
# until the watcher has copied the repo config into that worktree.
(
  __GATEKEEPER_COMMAND__
  printf '%s\n' "$?" > "$gatekeeper_status_file"
) &
gatekeeper_command_pid=$!
gatekeeper_finished_before_config=0
if [ -n "$no_mistakes_config_copy_pid" ]; then
  while [ ! -f "$no_mistakes_config_copy_done" ]; do
    if [ -f "$gatekeeper_status_file" ]; then
      gatekeeper_finished_before_config=1
      break
    fi
    if ! kill -0 "$no_mistakes_config_copy_pid" 2>/dev/null; then
      break
    fi
    sleep 1
  done
  if [ "$gatekeeper_finished_before_config" = "1" ]; then
    gatekeeper_precheck_code=$(cat "$gatekeeper_status_file" 2>/dev/null || printf '1')
    if [ "$gatekeeper_precheck_code" != "0" ]; then
      no_mistakes_config_copy_killed=1
      kill "$no_mistakes_config_copy_pid" 2>/dev/null || true
    fi
  fi
  wait "$no_mistakes_config_copy_pid" || no_mistakes_config_copy_status=1
  # Do not treat intentional kill as a config copy failure.
  if [ "$no_mistakes_config_copy_killed" = "1" ]; then
    no_mistakes_config_copy_status=
  fi
fi
wait "$gatekeeper_command_pid" || true
gatekeeper_inner_code=$(cat "$gatekeeper_status_file" 2>/dev/null || printf '1')
gatekeeper_raw_code="$gatekeeper_inner_code"
gate_config_failed=0
if [ "$gatekeeper_finished_before_config" = "1" ]; then
  printf '%s\n' "no-mistakes config copy failed: gatekeeper finished before config copy" >&2
  if [ "$gatekeeper_inner_code" = "0" ]; then
    gatekeeper_inner_code=1
  fi
  gate_config_failed=1
fi
if [ -n "$no_mistakes_config_copy_status" ]; then
  gatekeeper_inner_code=1
  gate_config_failed=1
fi
if [ "$gate_config_failed" = "1" ] && [ "$gatekeeper_raw_code" != "0" ]; then
  gatekeeper_inner_code=1
  if [ -n "${gatekeeper_log:-}" ]; then
    : > "${gatekeeper_log}.gate_config_failed"
  fi
fi
if [ "$gatekeeper_raw_code" != "0" ]; then
  if [ -n "${gatekeeper_log:-}" ]; then
    printf '%s\n' "$gatekeeper_raw_code" > "${gatekeeper_log}.raw_status"
  fi
fi
rm -f "$no_mistakes_config_copy_done" "$gatekeeper_status_file"
exit "$gatekeeper_inner_code"
