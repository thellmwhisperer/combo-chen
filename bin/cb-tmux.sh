#!/bin/sh
# Combo v1 tmux primitives (sourceable). Exact `=session` targets only; pane
# capture is never a product decision path.
set -eu

CB_TMUX_BOOT_WINDOW=${CB_TMUX_BOOT_WINDOW:-_cb_boot}

cb_tmux() {
  if [ -n "${CB_TMUX_SOCKET:-}" ]; then
    command tmux -L "$CB_TMUX_SOCKET" -f "${CB_TMUX_CONF:-/dev/null}" "$@"
  elif [ -n "${CB_TMUX_CONF:-}" ]; then
    command tmux -f "$CB_TMUX_CONF" "$@"
  else
    command tmux "$@"
  fi
}

cb_tmux_session_name() { printf 'combo-%s\n' "$1"; }
cb_tmux_window_name() { printf 'cb-%s-%s\n' "$1" "$2"; }
cb_tmux_exact_session() { printf '=%s\n' "$1"; }
cb_tmux_has_session_exact() { cb_tmux has-session -t "$(cb_tmux_exact_session "$1")" 2>/dev/null; }

cb_tmux_shell() {
  shell=${SHELL:-/bin/sh}
  [ -x "$shell" ] || { echo "cb-tmux: shell not executable: $shell" >&2; return 1; }
  printf '%s\n' "$shell"
}

cb_tmux_window_name_of() {
  # <exact-session> <window_id>
  cb_tmux list-windows -t "$1" -F '#{window_id} #{window_name}' 2>/dev/null \
    | awk -v id="$2" '$1 == id { print $2; exit }'
}

cb_tmux_endpoint_ok() {
  # <session> <wname> <wid> — exact session owns wid under wname and pane is live
  ses=$1 wname=$2 wid=$3
  exact=$(cb_tmux_exact_session "$ses")
  cb_tmux_has_session_exact "$ses" || return 1
  [ "$(cb_tmux_window_name_of "$exact" "$wid")" = "$wname" ] || return 1
  [ "$(cb_tmux display-message -p -t "$wid" '#{pane_dead}' 2>/dev/null || printf 1)" != 1 ]
}

cb_tmux_pin_window() {
  cb_tmux set-window-option -t "$1" automatic-rename off 2>/dev/null || true
  cb_tmux set-window-option -t "$1" allow-rename off 2>/dev/null || true
}

cb_tmux_session_ensure() {
  # <runId> -> session name. Boot window is disposable, never an agent endpoint.
  run=$1
  ses=$(cb_tmux_session_name "$run")
  exact=$(cb_tmux_exact_session "$ses")
  if ! cb_tmux_has_session_exact "$ses"; then
    shell=$(cb_tmux_shell) || return 1
    cb_tmux new-session -d -s "$ses" -n "$CB_TMUX_BOOT_WINDOW" "$shell" || return 1
    cb_tmux_has_session_exact "$ses" || { echo "cb-tmux: session vanished after create: $ses" >&2; return 1; }
    cb_tmux_pin_window "$exact:$CB_TMUX_BOOT_WINDOW"
  fi
  printf '%s\n' "$ses"
}

cb_tmux_window_create() {
  # <session> <name> <cwd> [command] -> window id via new-window -c only.
  ses=$1 wname=$2 cwd=$3 command=${4:-}
  exact=$(cb_tmux_exact_session "$ses")
  cb_tmux_has_session_exact "$ses" || { echo "cb-tmux: session missing: $ses" >&2; return 1; }
  if cb_tmux list-windows -t "$exact" -F '#{window_name}' 2>/dev/null | grep -qx "$wname"; then
    echo "error: window $ses:$wname already exists" >&2
    return 1
  fi
  if [ -n "$command" ]; then start_cmd=$command; else start_cmd=$(cb_tmux_shell) || return 1; fi
  if [ -n "$cwd" ]; then
    [ -d "$cwd" ] || { echo "cb-tmux: cwd missing: $cwd" >&2; return 1; }
    wid=$(cb_tmux new-window -dP -F '#{window_id}' -t "$exact:" -n "$wname" -c "$cwd" "$start_cmd") || return 1
  else
    wid=$(cb_tmux new-window -dP -F '#{window_id}' -t "$exact:" -n "$wname" "$start_cmd") || return 1
  fi
  if ! cb_tmux_endpoint_ok "$ses" "$wname" "$wid"; then
    cb_tmux kill-window -t "$wid" 2>/dev/null || true
    echo "cb-tmux: window ownership check failed for $ses:$wname" >&2
    return 1
  fi
  cb_tmux_pin_window "$wid"
  if cb_tmux list-windows -t "$exact" -F '#{window_name}' 2>/dev/null | grep -qx "$CB_TMUX_BOOT_WINDOW"; then
    boot_id=$(cb_tmux list-windows -t "$exact" -F '#{window_name} #{window_id}' 2>/dev/null \
      | awk -v n="$CB_TMUX_BOOT_WINDOW" '$1 == n { print $2; exit }')
    if [ -n "$boot_id" ] && [ "$boot_id" != "$wid" ]; then
      cb_tmux kill-window -t "$boot_id" 2>/dev/null || true
    fi
  fi
  if ! cb_tmux_endpoint_ok "$ses" "$wname" "$wid"; then
    echo "cb-tmux: endpoint dead after create: $ses:$wname" >&2
    return 1
  fi
  printf '%s\n' "$wid"
}

cb_tmux_send_literal() { cb_tmux send-keys -t "$1" -l "$2"; }
cb_tmux_send_line() { cb_tmux_send_literal "$1" "$2" || return 1; cb_tmux send-keys -t "$1" Enter; }
cb_tmux_capture() { cb_tmux capture-pane -p -t "$1" -S "-$2"; }
cb_tmux_current_command() { cb_tmux display-message -p -t "$1" '#{pane_current_command}' 2>/dev/null || true; }
cb_tmux_kill() { cb_tmux kill-window -t "$1" 2>/dev/null || true; }
cb_tmux_kill_session() { cb_tmux kill-session -t "$(cb_tmux_exact_session "$1")" 2>/dev/null || true; }

cb_tmux_meta_get() {
  meta=$1 key=$2
  [ -f "$meta" ] || return 1
  awk -F= -v k="$key" '$1 == k { v=substr($0, length(k) + 2) } END { if (v != "") print v; else exit 1 }' "$meta"
}

cb_tmux_target_live() {
  # <target> — pane still addressable and not dead.
  dead=$(cb_tmux display-message -p -t "$1" '#{pane_dead}' 2>/dev/null) || return 1
  [ "$dead" != 1 ]
}

# Positive held-composer only ("> text"); prompt-prefixed shell input is unknown.
# Requires a live target; capture failure is not "cleared".
cb_tmux_composer_pending() {
  target=$1 text=$2
  cb_tmux_target_live "$target" || return 1
  pane=$(cb_tmux_capture "$target" 30 2>/dev/null) || return 1
  last=$(printf '%s\n' "$pane" | sed '/^[[:space:]]*$/d' | tail -n 1)
  [ -n "$last" ] || return 1
  [ "$last" = "> $text" ] || [ "$last" = ">$text" ] || [ "$last" = "│ $text │" ] || [ "$last" = "| $text |" ]
}

cb_tmux_send_verified() {
  # Type once; Enter-only retries.
  # live + not pending → success; dead/missing → error; live + pending → retry/fail.
  target=$1 text=$2
  retries=${CB_SEND_RETRIES:-3}
  sleep_s=${CB_SEND_SLEEP:-0.4}
  settle=${CB_SEND_SETTLE:-0.1}
  case "$retries" in ''|*[!0-9]*|0) retries=3 ;; esac
  cb_tmux_target_live "$target" || { echo "cb-send: target pane dead or missing" >&2; return 1; }
  cb_tmux_send_literal "$target" "$text" || { echo "cb-tmux: failed to type payload" >&2; return 1; }
  sleep "$settle"
  cb_tmux_target_live "$target" || { echo "cb-send: target pane dead or missing" >&2; return 1; }
  i=0
  while [ "$i" -lt "$retries" ]; do
    i=$((i + 1))
    cb_tmux send-keys -t "$target" Enter || { echo "cb-tmux: failed to send Enter" >&2; return 1; }
    sleep "$sleep_s"
    if ! cb_tmux_target_live "$target"; then
      echo "cb-send: target pane dead or missing" >&2
      return 1
    fi
    cb_tmux_composer_pending "$target" "$text" || return 0
  done
  if ! cb_tmux_target_live "$target"; then
    echo "cb-send: target pane dead or missing" >&2
    return 1
  fi
  if cb_tmux_composer_pending "$target" "$text"; then
    echo "cb-send: enter swallowed; composer still holds payload" >&2
    return 1
  fi
  return 0
}

cb_tmux_resolve_agent() {
  # <runId> <agent> [runs_dir] — exact combo-<runId> only.
  # Accept recorded window_id only when that id is still the expected
  # cb-<runId>-<agent> live endpoint (cb_tmux_endpoint_ok). Stale ids that
  # were reused by another role after a server restart are ignored.
  run=$1 agent=$2
  runs_dir=${3:-${CB_RUNS_DIR:-$HOME/.combo-chen/runs}}
  meta=$runs_dir/$run/agents/$agent.meta
  ses=$(cb_tmux_session_name "$run")
  exact=$(cb_tmux_exact_session "$ses")
  expected=$(cb_tmux_window_name "$run" "$agent")
  [ -f "$meta" ] || { echo "cb-tmux: no metadata for $run/$agent" >&2; return 1; }
  cb_tmux_has_session_exact "$ses" || { echo "cb-tmux: session missing: $ses" >&2; return 1; }
  meta_run=$(cb_tmux_meta_get "$meta" run 2>/dev/null || true)
  meta_agent=$(cb_tmux_meta_get "$meta" agent 2>/dev/null || true)
  [ -z "$meta_run" ] || [ "$meta_run" = "$run" ] || { echo "cb-tmux: meta run mismatch for $run/$agent" >&2; return 1; }
  [ -z "$meta_agent" ] || [ "$meta_agent" = "$agent" ] || { echo "cb-tmux: meta agent mismatch for $run/$agent" >&2; return 1; }

  wid=$(cb_tmux_meta_get "$meta" window_id 2>/dev/null || true)
  if [ -n "$wid" ] && cb_tmux_endpoint_ok "$ses" "$expected" "$wid"; then
    printf '%s\n' "$wid"
    return 0
  fi

  # Name fallback is only the expected agent window — never a differently named pane.
  if cb_tmux list-windows -t "$exact" -F '#{window_name}' 2>/dev/null | grep -qx "$expected"; then
    live_wid=$(cb_tmux list-windows -t "$exact" -F '#{window_name} #{window_id}' 2>/dev/null \
      | awk -v n="$expected" '$1 == n { print $2; exit }')
    if [ -n "$live_wid" ] && cb_tmux_endpoint_ok "$ses" "$expected" "$live_wid"; then
      printf '%s\n' "$live_wid"
      return 0
    fi
  fi

  echo "cb-tmux: unresolved target for $run/$agent inside $ses" >&2
  return 1
}
