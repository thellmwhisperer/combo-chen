#!/bin/sh
# tests/run.sh - serial runner for the combo-chen Bash v1 chain tests.
#
# Runs every tests/*.test.sh in lexicographic order. Each file exits non-zero on
# first failure (fail-fast per file). This script tallies failures and exits
# non-zero if any file failed. No lanes, no JSON timing, no per-test timeouts.
set -u

ROOT=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd)
ran=0
failures=0

for test_file in "$ROOT"/tests/*.test.sh; do
  [ -f "$test_file" ] || continue
  ran=$((ran + 1))
  printf -- '--- %s ---\n' "$(basename "$test_file")"
  if "$test_file"; then
    :
  else
    failures=$((failures + 1))
    printf 'FAIL: %s\n' "$(basename "$test_file")" >&2
  fi
done

printf '\n%d suite(s) run, %d failure(s)\n' "$ran" "$failures"
[ "$failures" -eq 0 ] && [ "$ran" -gt 0 ]
