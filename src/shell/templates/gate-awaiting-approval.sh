if grep -Eq '^outcome:[[:space:]]*awaiting_approval[[:space:]]*$' "$gatekeeper_log"; then
  gatekeeper_head_sha=$(git rev-parse HEAD 2>/dev/null || true)
  __EMIT__ gate_status --field state=awaiting_approval --field head_sha="$gatekeeper_head_sha"
  __EMIT__ needs_human --field reason=gate_waiting
  exit 0
fi
