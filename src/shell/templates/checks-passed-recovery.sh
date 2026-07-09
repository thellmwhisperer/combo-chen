# Normalize the checks-passed plus context-canceled outcome: a gate whose
# checks all passed but whose run was canceled afterwards counts as success,
# unless the config copy failed (that stays a hard gate failure).
gatekeeper_recovery_reason=${gatekeeper_recovery_reason:-}
gatekeeper_raw_status_file="${gatekeeper_log}.raw_status"
gatekeeper_config_fail_file="${gatekeeper_log}.gate_config_failed"
if [ -f "$gatekeeper_config_fail_file" ]; then
  rm -f "$gatekeeper_raw_status_file" "$gatekeeper_config_fail_file"
else
  gatekeeper_raw_code=$(cat "$gatekeeper_raw_status_file" 2>/dev/null || printf '')
  case "$gatekeeper_raw_code" in
    '' | 0 | *[!0-9]*) gatekeeper_raw_failed=0 ;;
    *) gatekeeper_raw_failed=1 ;;
  esac
  rm -f "$gatekeeper_raw_status_file"
  if [ "$gatekeeper_code" -ne 0 ] && [ "$gatekeeper_raw_failed" = "1" ] && awk 'BEGIN { seen=0; found=0 } { line=tolower($0) } line ~ /^outcome:[[:space:]]*checks-passed[[:space:]]*$/ { seen=1; next } seen && line ~ /context[[:space:]]+canceled/ { found=1 } END { exit found ? 0 : 1 }' "$gatekeeper_log"; then
    gatekeeper_recovery_reason=checks_passed_context_canceled
    gatekeeper_code=0
  fi
fi
