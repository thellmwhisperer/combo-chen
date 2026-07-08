# Branch-scoped gate lease: exit codes 75/76 mean another capsule owns the
# gate or the lease is already satisfied; both are clean no-op exits.
__GATE_LEASE_ACQUIRE__ --head-sha "$gatekeeper_start_sha" || gate_lease_code=$?
if [ "$gate_lease_code" -eq 75 ]; then exit 0; fi
if [ "$gate_lease_code" -eq 76 ]; then exit 0; fi
if [ "$gate_lease_code" -ne 0 ]; then exit "$gate_lease_code"; fi
gate_lease_release_cmd=__GATE_LEASE_RELEASE__
gate_lease_release() {
  sh -c "$gate_lease_release_cmd" >/dev/null 2>&1 || true
}
trap gate_lease_release EXIT
