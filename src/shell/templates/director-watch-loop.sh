# director-watch retry/backoff loop: poll director-tick, exit clean on
# terminal reviewer output, journal watch_error/watch_dead on repeated
# failures with exponential backoff.
failures=0
backoff=__INITIAL_BACKOFF__
watch_failure_limit=__FAILURE_LIMIT__
watch_backoff_cap=__BACKOFF_CAP_THRESHOLD__
watch_backoff_max=__MAX_BACKOFF__
while :; do
  output=$(__TICK_COMMAND__ 2>&1)
  rc=$?
  printf "%s\n" "$output"
  printf "%s\n" "$output" | grep -Eq __TERMINAL_PATTERN__ && exit 0
  transient=0
  printf "%s\n" "$output" | grep -Eq __TRANSIENT_PATTERN__ && transient=1
  if [ "$rc" -eq 0 ] && [ "$transient" -eq 0 ]; then
    failures=0
    backoff=__INITIAL_BACKOFF__
    sleep __POLL_SECONDS__
    continue
  fi
  failure_rc="$rc"
  [ "$failure_rc" -eq 0 ] && failure_rc=__TRANSIENT_EXIT_CODE__
  failures=$((failures + 1))
  output_snippet=$(printf "%s\n" "$output" | head -c 500)
  __EMIT__ watch_error --field "exit_code=$failure_rc" --field "tick_exit_code=$rc" --field "stderr=$output_snippet" --field "consecutive_failures=$failures" --field "watcher=director" >/dev/null 2>&1 || true
  if [ "$failures" -ge "$watch_failure_limit" ]; then
    __EMIT__ watch_dead --field "exit_code=$failure_rc" --field "tick_exit_code=$rc" --field "stderr=$output_snippet" --field "consecutive_failures=$failures" --field "watcher=director" >/dev/null 2>&1 || true
    exit "$failure_rc"
  fi
  sleep "$backoff"
  if [ "$backoff" -ge "$watch_backoff_cap" ]; then backoff="$watch_backoff_max"; else backoff=$((backoff * 2)); fi
done
