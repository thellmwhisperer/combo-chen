# Avoid double-starting the no-mistakes daemon when the mirror publish step
# already brought it up in this shell.
if [ "${COMBO_CHEN_NO_MISTAKES_DAEMON_STARTED:-0}" = "1" ]; then
  __GUARDED_COMMAND__
else
  no-mistakes daemon start && __GUARDED_COMMAND__
fi
