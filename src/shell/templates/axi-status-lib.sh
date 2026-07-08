# Canonical no-mistakes axi status field parsing. Cite: issue #281 - the ad
# hoc sed copies diverged (quote-stripping existed for id: but not head:), so
# the gatekeeper attach matcher could never match a quoted head and the window
# polled to timeout. Every axi status consumer parses through these helpers.
no_mistakes_axi_field() {
  printf '%s\n' "$1" | sed -n "s/^[[:space:]]*$2:[[:space:]]*//p" | sed -n '1p' | sed 's/^"//; s/"$//; s/[[:space:]]*$//'
}

# Statuses that mean a run occupies the branch (config copy, abort guard).
no_mistakes_axi_run_is_active() {
  case "$1" in
    active | in_progress | pending | running) return 0 ;;
    *) return 1 ;;
  esac
}

# Statuses a live attach can follow; pending runs are not attachable yet.
no_mistakes_axi_run_is_attachable() {
  case "$1" in
    active | in_progress | running) return 0 ;;
    *) return 1 ;;
  esac
}

# Prefix-tolerant head comparison: axi status prints a short quoted head and
# callers hold a short rev-parse head; either side may be the shorter one.
no_mistakes_axi_head_matches() {
  if [ -z "$1" ] || [ -z "$2" ]; then
    return 1
  fi
  case "$1" in
    "$2"*) return 0 ;;
  esac
  case "$2" in
    "$1"*) return 0 ;;
  esac
  return 1
}
