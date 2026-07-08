# Idle role window: hold the pane until combo-chen prompts it; INT drops to
# a plain shell.
printf '[combo-chen] __ROLE__ window idle; waiting for combo-chen to prompt it.\n'
combo_chen_idle=1
trap 'combo_chen_idle=0' INT
while [ "$combo_chen_idle" = 1 ]; do sleep 3600; done
exec "${SHELL:-/bin/sh}"
