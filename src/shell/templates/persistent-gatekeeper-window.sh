# Keep the gatekeeper tmux window alive across attach cycles so operators
# always have a live pane; INT drops to a plain shell.
combo_chen_idle=1
trap 'combo_chen_idle=0' INT
while [ "$combo_chen_idle" = 1 ]; do
(
__ATTACH_COMMAND__
)
combo_chen_gatekeeper_window_code=$?
printf "\n[combo-chen] gatekeeper exited with code %s\n" "$combo_chen_gatekeeper_window_code"
printf "[combo-chen] gatekeeper idle; waiting for the next current-head run.\n"
if [ "${COMBO_CHEN_GATEKEEPER_WINDOW_HOLD:-1}" = "0" ]; then
  exit "$combo_chen_gatekeeper_window_code"
fi
sleep 1
done
exec "${SHELL:-/bin/sh}"
