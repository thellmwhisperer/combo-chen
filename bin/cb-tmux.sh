#!/bin/sh
# Combo v1 tmux primitives. Sourceable library (no main).
# All orchestration targets come from run-local agent meta; pane capture is
# never a product decision path.
set -eu

CB_TMUX_INIT_WINDOW=${CB_TMUX_INIT_WINDOW:-_cb_init}

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

cb_tmux_session_ensure() {
  # <runId> -> prints session name
  run=$1
  ses=$(cb_tmux_session_name "$run")
  if ! cb_tmux has-session -t "$ses" 2>/dev/null; then
    cb_tmux new-session -d -s "$ses" -n "$CB_TMUX_INIT_WINDOW" || return 1
    cb_tmux set-window-option -t "$ses:$CB_TMUX_INIT_WINDOW" automatic-rename off 2>/dev/null || true
    cb_tmux set-window-option -t "$ses:$CB_TMUX_INIT_WINDOW" allow-rename off 2>/dev/null || true
  fi
  printf '%s\n' "$ses"
}

cb_tmux_window_create() {
  # <session> <name> <cwd> -> prints stable window id
  ses=$1
  wname=$2
  cwd=$3
  wid=

  if ! cb_tmux has-session -t "$ses" 2>/dev/null; then
    echo "cb-tmux: session missing: $ses" >&2
    return 1
  fi
  if cb_tmux list-windows -t "$ses" -F '#{window_name}' 2>/dev/null | grep -qx "$wname"; then
    echo "error: window $ses:$wname already exists" >&2
    return 1
  fi

  # First real agent window reuses the session boot window so the run ends
  # with exactly the five named agent windows and no leftover init pane.
  if cb_tmux list-windows -t "$ses" -F '#{window_name}' 2>/dev/null | grep -qx "$CB_TMUX_INIT_WINDOW"; then
    wid=$(cb_tmux list-windows -t "$ses" -F '#{window_name} #{window_id}' \
      | awk -v n="$CB_TMUX_INIT_WINDOW" '$1 == n { print $2; exit }')
    [ -n "$wid" ] || return 1
    cb_tmux rename-window -t "$wid" "$wname" || return 1
    if [ -n "$cwd" ]; then
      # Replace the boot shell so the pane starts in the requested cwd.
      cb_tmux respawn-pane -k -t "$wid" -c "$cwd" "${SHELL:-/bin/sh}" 2>/dev/null || true
    fi
  else
    if [ -n "$cwd" ]; then
      wid=$(cb_tmux new-window -dP -F '#{window_id}' -t "$ses:" -n "$wname" -c "$cwd") || return 1
    else
      wid=$(cb_tmux new-window -dP -F '#{window_id}' -t "$ses:" -n "$wname") || return 1
    fi
  fi

  cb_tmux set-window-option -t "$wid" automatic-rename off 2>/dev/null || true
  cb_tmux set-window-option -t "$wid" allow-rename off 2>/dev/null || true
  printf '%s\n' "$wid"
}

cb_tmux_send_line() {
  # <target> <text>
  cb_tmux send-keys -t "$1" "$2" Enter
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
  # <session>
  cb_tmux kill-session -t "$1" 2>/dev/null || true
}

cb_tmux_meta_get() {
  # <meta-file> <key>
  meta=$1
  key=$2
  [ -f "$meta" ] || return 1
  # Prefer the last matching key= line.
  awk -F= -v k="$key" '$1 == k { v=substr($0, length(k) + 2) } END { if (v != "") print v; else exit 1 }' "$meta"
}

cb_tmux_resolve_agent() {
  # <runId> <agent> [<runs_dir>] -> prints a session-local target
  # Prefers immutable window_id when it still lives in combo-<runId>; else
  # falls back to the recorded window name inside that same session only.
  run=$1
  agent=$2
  runs_dir=${3:-${CB_RUNS_DIR:-$HOME/.combo-chen/runs}}
  meta=$runs_dir/$run/agents/$agent.meta
  ses=$(cb_tmux_session_name "$run")

  if [ ! -f "$meta" ]; then
    echo "cb-tmux: no metadata for $run/$agent" >&2
    return 1
  fi
  if ! cb_tmux has-session -t "$ses" 2>/dev/null; then
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
  if [ -n "$wid" ] && cb_tmux list-windows -t "$ses" -F '#{window_id}' 2>/dev/null | grep -qx "$wid"; then
    printf '%s\n' "$wid"
    return 0
  fi

  wname=$(cb_tmux_meta_get "$meta" window 2>/dev/null || true)
  case "$wname" in
    "$ses":*)
      short=${wname#"$ses":}
      if cb_tmux list-windows -t "$ses" -F '#{window_name}' 2>/dev/null | grep -qx "$short"; then
        printf '%s\n' "$wname"
        return 0
      fi
      ;;
  esac

  # Name-only fallback recorded without session prefix still stays in-session.
  expected=$(cb_tmux_window_name "$run" "$agent")
  if cb_tmux list-windows -t "$ses" -F '#{window_name}' 2>/dev/null | grep -qx "$expected"; then
    printf '%s:%s\n' "$ses" "$expected"
    return 0
  fi

  echo "cb-tmux: unresolved target for $run/$agent inside $ses" >&2
  return 1
}
