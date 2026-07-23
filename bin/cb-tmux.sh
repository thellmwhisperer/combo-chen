#!/bin/sh
# Combo v1 tmux primitives. Sourceable library (no main).
# All orchestration targets come from run-local agent meta; pane capture is
# never a product decision path. Session targets always use exact `=name`
# matching so a runId cannot prefix-hit another session.
set -eu

CB_TMUX_BOOT_WINDOW=${CB_TMUX_BOOT_WINDOW:-_cb_boot}

# Run tmux against an optional isolated socket/config (tests set CB_TMUX_SOCKET).
cb_tmux() {
  if [ -n "${CB_TMUX_SOCKET:-}" ]; then
    command tmux -L "$CB_TMUX_SOCKET" -f "${CB_TMUX_CONF:-/dev/null}" "$@"
  elif [ -n "${CB_TMUX_CONF:-}" ]; then
    command tmux -f "$CB_TMUX_CONF" "$@"
  else
    command tmux "$@"
  fi
}

cb_tmux_session_name() {
  # <runId>
  printf 'combo-%s\n' "$1"
}

cb_tmux_window_name() {
  # <runId> <agent>
  printf 'cb-%s-%s\n' "$1" "$2"
}

# Exact session target: leading '=' disables tmux prefix matching.
cb_tmux_exact_session() {
  # <session-name>
  printf '=%s\n' "$1"
}

cb_tmux_has_session_exact() {
  # <session-name>
  cb_tmux has-session -t "$(cb_tmux_exact_session "$1")" 2>/dev/null
}

cb_tmux_shell() {
  # Resolve a runnable shell; refuse nonexistent/non-executable values.
  shell=${SHELL:-/bin/sh}
  if [ ! -x "$shell" ]; then
    echo "cb-tmux: shell not executable: $shell" >&2
    return 1
  fi
  printf '%s\n' "$shell"
}

cb_tmux_session_ensure() {
  # <runId> -> prints session name
  # Creates a disposable boot window only so later new-window -c can attach.
  # The boot window is never published as an agent endpoint.
  run=$1
  ses=$(cb_tmux_session_name "$run")
  exact=$(cb_tmux_exact_session "$ses")
  shell=
  if ! cb_tmux_has_session_exact "$ses"; then
    shell=$(cb_tmux_shell) || return 1
    cb_tmux new-session -d -s "$ses" -n "$CB_TMUX_BOOT_WINDOW" "$shell" || return 1
    if ! cb_tmux_has_session_exact "$ses"; then
      echo "cb-tmux: session vanished after create: $ses" >&2
      return 1
    fi
    cb_tmux set-window-option -t "$exact:$CB_TMUX_BOOT_WINDOW" automatic-rename off 2>/dev/null || true
    cb_tmux set-window-option -t "$exact:$CB_TMUX_BOOT_WINDOW" allow-rename off 2>/dev/null || true
  fi
  printf '%s\n' "$ses"
}

cb_tmux_window_create() {
  # <session> <name> <cwd> [command] -> prints stable window id
  # Always uses new-window -c. Never renames/respawns the boot window into an
  # agent endpoint. Refuses duplicate names. Verifies exact-session ownership.
  # Optional command becomes the window's initial process (preferred over send-keys).
  ses=$1
  wname=$2
  cwd=$3
  command=${4:-}
  exact=$(cb_tmux_exact_session "$ses")
  wid=
  live_name=
  start_cmd=

  if ! cb_tmux_has_session_exact "$ses"; then
    echo "cb-tmux: session missing: $ses" >&2
    return 1
  fi
  if cb_tmux list-windows -t "$exact" -F '#{window_name}' 2>/dev/null | grep -qx "$wname"; then
    echo "error: window $ses:$wname already exists" >&2
    return 1
  fi

  if [ -n "$command" ]; then
    start_cmd=$command
  else
    start_cmd=$(cb_tmux_shell) || return 1
  fi
  if [ -n "$cwd" ]; then
    [ -d "$cwd" ] || {
      echo "cb-tmux: cwd missing: $cwd" >&2
      return 1
    }
    wid=$(cb_tmux new-window -dP -F '#{window_id}' -t "$exact:" -n "$wname" -c "$cwd" "$start_cmd") || return 1
  else
    wid=$(cb_tmux new-window -dP -F '#{window_id}' -t "$exact:" -n "$wname" "$start_cmd") || return 1
  fi

  # Endpoint must still belong to this exact session under the requested name.
  if ! cb_tmux_has_session_exact "$ses"; then
    echo "cb-tmux: session lost while creating $ses:$wname" >&2
    return 1
  fi
  live_name=$(cb_tmux list-windows -t "$exact" -F '#{window_id} #{window_name}' 2>/dev/null \
    | awk -v id="$wid" '$1 == id { print $2; exit }')
  if [ "$live_name" != "$wname" ]; then
    cb_tmux kill-window -t "$wid" 2>/dev/null || true
    echo "cb-tmux: window ownership check failed for $ses:$wname" >&2
    return 1
  fi
  pane_dead=$(cb_tmux display-message -p -t "$wid" '#{pane_dead}' 2>/dev/null || printf '1')
  if [ "$pane_dead" = 1 ]; then
    cb_tmux kill-window -t "$wid" 2>/dev/null || true
    echo "cb-tmux: pane dead after create for $ses:$wname" >&2
    return 1
  fi

  cb_tmux set-window-option -t "$wid" automatic-rename off 2>/dev/null || true
  cb_tmux set-window-option -t "$wid" allow-rename off 2>/dev/null || true

  # Drop the disposable boot window once at least one real agent window exists.
  if cb_tmux list-windows -t "$exact" -F '#{window_name}' 2>/dev/null | grep -qx "$CB_TMUX_BOOT_WINDOW"; then
    boot_id=$(cb_tmux list-windows -t "$exact" -F '#{window_name} #{window_id}' 2>/dev/null \
      | awk -v n="$CB_TMUX_BOOT_WINDOW" '$1 == n { print $2; exit }')
    if [ -n "$boot_id" ] && [ "$boot_id" != "$wid" ]; then
      cb_tmux kill-window -t "$boot_id" 2>/dev/null || true
    fi
  fi

  # Re-verify after boot cleanup; never return a dead id.
  if ! cb_tmux_has_session_exact "$ses"; then
    echo "cb-tmux: session lost after window create: $ses" >&2
    return 1
  fi
  live_name=$(cb_tmux list-windows -t "$exact" -F '#{window_id} #{window_name}' 2>/dev/null \
    | awk -v id="$wid" '$1 == id { print $2; exit }')
  if [ "$live_name" != "$wname" ]; then
    echo "cb-tmux: endpoint dead after create: $ses:$wname" >&2
    return 1
  fi

  printf '%s\n' "$wid"
}

cb_tmux_send_line() {
  # <target> <text>  — literal text then Enter (never key-token interpretation)
  cb_tmux_send_literal "$1" "$2" || return 1
  cb_tmux send-keys -t "$1" Enter
}

cb_tmux_send_literal() {
  # <target> <text>
  cb_tmux send-keys -t "$1" -l "$2"
}

cb_tmux_capture() {
  # <target> <lines>  — humans/debug ONLY
  cb_tmux capture-pane -p -t "$1" -S "-$2"
}

cb_tmux_current_command() {
  # <target> — advisory liveness hint only
  cb_tmux display-message -p -t "$1" '#{pane_current_command}' 2>/dev/null || true
}

cb_tmux_kill() {
  # <target>
  cb_tmux kill-window -t "$1" 2>/dev/null || true
}

cb_tmux_kill_session() {
  # <session-name> — exact match only
  cb_tmux kill-session -t "$(cb_tmux_exact_session "$1")" 2>/dev/null || true
}

cb_tmux_meta_get() {
  # <meta-file> <key>
  meta=$1
  key=$2
  [ -f "$meta" ] || return 1
  # Prefer the last matching key= line.
  awk -F= -v k="$key" '$1 == k { v=substr($0, length(k) + 2) } END { if (v != "") print v; else exit 1 }' "$meta"
}

# Positive "composer still holds payload" check for verified Enter.
# Returns 0 only for an explicit held composer line. Prompt-prefixed shell
# input is unknown (not pending). Fail only on a positively held composer.
cb_tmux_composer_pending() {
  # <target> <text>
  target=$1
  text=$2
  pane=
  last=
  pane=$(cb_tmux_capture "$target" 30 2>/dev/null) || return 1
  last=$(printf '%s\n' "$pane" | sed '/^[[:space:]]*$/d' | tail -n 1)
  [ -n "$last" ] || return 1
  # Explicit composer glyphs (fake TUI / bordered prompts).
  [ "$last" = "> $text" ] || [ "$last" = ">$text" ] || [ "$last" = "│ $text │" ] || [ "$last" = "| $text |" ]
}

cb_tmux_send_verified() {
  # <target> <text>
  # Type once; retry Enter only until composer clears or retries exhaust.
  # Non-zero only on positively detected swallowed Enter (still pending).
  # Unknown/non-pending shapes are success (fm-send lenient policy): only a
  # still-held payload after Enter retries is a hard failure.
  target=$1
  text=$2
  retries=${CB_SEND_RETRIES:-3}
  sleep_s=${CB_SEND_SLEEP:-0.4}
  settle=${CB_SEND_SETTLE:-0.1}
  i=0

  case "$retries" in ''|*[!0-9]*|0) retries=3 ;; esac
  cb_tmux_send_literal "$target" "$text" || {
    echo "cb-tmux: failed to type payload" >&2
    return 1
  }
  sleep "$settle"

  while [ "$i" -lt "$retries" ]; do
    i=$((i + 1))
    cb_tmux send-keys -t "$target" Enter || {
      echo "cb-tmux: failed to send Enter" >&2
      return 1
    }
    sleep "$sleep_s"
    if ! cb_tmux_composer_pending "$target" "$text"; then
      return 0
    fi
  done

  if cb_tmux_composer_pending "$target" "$text"; then
    echo "cb-send: enter swallowed; composer still holds payload" >&2
    return 1
  fi
  return 0
}

cb_tmux_resolve_agent() {
  # <runId> <agent> [<runs_dir>] -> prints a session-local target
  # Prefers immutable window_id when it still lives in exact combo-<runId>; else
  # falls back to the recorded window name inside that same exact session only.
  run=$1
  agent=$2
  runs_dir=${3:-${CB_RUNS_DIR:-$HOME/.combo-chen/runs}}
  meta=$runs_dir/$run/agents/$agent.meta
  ses=$(cb_tmux_session_name "$run")
  exact=$(cb_tmux_exact_session "$ses")

  if [ ! -f "$meta" ]; then
    echo "cb-tmux: no metadata for $run/$agent" >&2
    return 1
  fi
  if ! cb_tmux_has_session_exact "$ses"; then
    echo "cb-tmux: session missing: $ses" >&2
    return 1
  fi

  meta_run=$(cb_tmux_meta_get "$meta" run 2>/dev/null || true)
  meta_agent=$(cb_tmux_meta_get "$meta" agent 2>/dev/null || true)
  if [ -n "$meta_run" ] && [ "$meta_run" != "$run" ]; then
    echo "cb-tmux: meta run mismatch for $run/$agent" >&2
    return 1
  fi
  if [ -n "$meta_agent" ] && [ "$meta_agent" != "$agent" ]; then
    echo "cb-tmux: meta agent mismatch for $run/$agent" >&2
    return 1
  fi

  wid=$(cb_tmux_meta_get "$meta" window_id 2>/dev/null || true)
  if [ -n "$wid" ] && cb_tmux list-windows -t "$exact" -F '#{window_id}' 2>/dev/null | grep -qx "$wid"; then
    printf '%s\n' "$wid"
    return 0
  fi

  wname=$(cb_tmux_meta_get "$meta" window 2>/dev/null || true)
  case "$wname" in
    "$ses":*)
      short=${wname#"$ses":}
      if cb_tmux list-windows -t "$exact" -F '#{window_name}' 2>/dev/null | grep -qx "$short"; then
        # Exact session + window name target.
        printf '%s:%s\n' "$exact" "$short"
        return 0
      fi
      ;;
  esac

  expected=$(cb_tmux_window_name "$run" "$agent")
  if cb_tmux list-windows -t "$exact" -F '#{window_name}' 2>/dev/null | grep -qx "$expected"; then
    printf '%s:%s\n' "$exact" "$expected"
    return 0
  fi

  echo "cb-tmux: unresolved target for $run/$agent inside $ses" >&2
  return 1
}
