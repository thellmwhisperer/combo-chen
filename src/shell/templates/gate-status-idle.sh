if [ -n "$gatekeeper_recovery_reason" ]; then
  __EMIT__ gate_status --field state=idle__HEAD_FIELD__ --field recovery="$gatekeeper_recovery_reason"
else
  __EMIT__ gate_status --field state=idle__HEAD_FIELD__
fi
