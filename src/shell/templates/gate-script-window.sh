# Run a generated gate script in the background while the visible pane
# attaches to the live no-mistakes run; fall back to the script log when the
# attach cannot resolve a run, then hold the window for the next run.
combo_chen_gate_script_window_log=__WINDOW_LOG__
combo_chen_gate_script_done=__DONE_FILE__
rm -f "$combo_chen_gate_script_done"
(
  sh __SCRIPT_PATH__ > "$combo_chen_gate_script_window_log" 2>&1
  combo_chen_gate_script_inner_code=$?
  printf '%s\n' "$combo_chen_gate_script_inner_code" > "$combo_chen_gate_script_done"
  exit "$combo_chen_gate_script_inner_code"
) &
combo_chen_gate_script_pid=$!
# Do not orphan the background gate script if this wrapper dies before wait
# (tmux window killed or replaced, signal during the attach probe).
trap 'kill "$combo_chen_gate_script_pid" 2>/dev/null || true' EXIT INT TERM
combo_chen_gate_attach_code=0
(
__ATTACH_WITH_DONE__
) || combo_chen_gate_attach_code=$?
if [ "$combo_chen_gate_attach_code" -ne 0 ]; then
  printf "[combo-chen] gatekeeper attach exited with code %s; showing gate script log.\n" "$combo_chen_gate_attach_code" >&2
  tail -80 "$combo_chen_gate_script_window_log" >&2 2>/dev/null || true
fi
combo_chen_gate_script_code=0
wait "$combo_chen_gate_script_pid" || combo_chen_gate_script_code=$?
trap - EXIT INT TERM
if [ -f "$combo_chen_gate_script_done" ]; then
  combo_chen_gate_script_code=$(cat "$combo_chen_gate_script_done" 2>/dev/null || printf "%s" "$combo_chen_gate_script_code")
fi
printf "\n[combo-chen] gate script exited with code %s\n" "$combo_chen_gate_script_code"
printf "[combo-chen] gatekeeper final attach probe for current run.\n"
combo_chen_gate_attach_code=0
(
__FINAL_ATTACH_PROBE__
) || combo_chen_gate_attach_code=$?
if [ "$combo_chen_gate_attach_code" -ne 0 ]; then
  printf "[combo-chen] gatekeeper final attach exited with code %s\n" "$combo_chen_gate_attach_code" >&2
fi
printf "[combo-chen] gatekeeper idle; waiting for the next current-head run.\n"
if [ "${COMBO_CHEN_GATEKEEPER_WINDOW_HOLD:-1}" = "0" ]; then
  exit "$combo_chen_gate_script_code"
fi
combo_chen_idle=1
trap 'combo_chen_idle=0' INT
while [ "$combo_chen_idle" = 1 ]; do
  combo_chen_gate_attach_code=0
  (
__IDLE_ATTACH__
  ) || combo_chen_gate_attach_code=$?
  printf "\n[combo-chen] gatekeeper attach exited with code %s\n" "$combo_chen_gate_attach_code"
  printf "[combo-chen] gatekeeper idle; waiting for the next current-head run.\n"
  sleep 1
done
exec "${SHELL:-/bin/sh}"
