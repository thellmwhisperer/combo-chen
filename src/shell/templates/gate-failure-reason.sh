# Classify a gate failure as daemon death when the log carries the daemon
# fingerprints; everything else stays a plain gate_failed.
gatekeeper_failure_reason=gate_failed
if grep -Eiq 'daemon.*(dead|died|exited|not running)|connection refused|ECONNREFUSED' "$gatekeeper_log"; then
  gatekeeper_failure_reason=daemon_dead
fi
