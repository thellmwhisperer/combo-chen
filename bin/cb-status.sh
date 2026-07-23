#!/bin/sh
# Advisory run/agent status. Journal phase is truth; pane command is a hint only.
# Usage: cb-status <runId> [agent]
set -eu

usage() {
  echo "usage: cb-status <runId> [agent]" >&2
  exit 64
}

[ "$#" -ge 1 ] || usage
run=$1
only=${2:-}

case "$run" in ''|-*|*[!a-z0-9-]*) usage ;; esac
if [ -n "$only" ]; then
  case "$only" in launcher|coder|reviewer|gate|cleaner) ;; *) usage ;; esac
fi

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname "$0")" && pwd)
# shellcheck source=bin/cb-tmux.sh
. "$SCRIPT_DIR/cb-tmux.sh"

runs_dir=${CB_RUNS_DIR:-$HOME/.combo-chen/runs}
run_dir=$runs_dir/$run
ses=$(cb_tmux_session_name "$run")

phase=created
if [ -x "$SCRIPT_DIR/cb-run-state.sh" ] || [ -f "$SCRIPT_DIR/cb-run-state.sh" ]; then
  phase=$(CB_RUNS_DIR=$runs_dir sh "$SCRIPT_DIR/cb-run-state.sh" "$run" 2>/dev/null || printf 'created')
fi

session_live=0
if cb_tmux has-session -t "$ses" 2>/dev/null; then
  session_live=1
fi

printf 'run=%s\n' "$run"
printf 'phase=%s\n' "$phase"
printf 'session=%s\n' "$ses"
printf 'session_live=%s\n' "$session_live"

agents=$only
if [ -z "$agents" ]; then
  agents='launcher coder reviewer gate cleaner'
fi

for agent in $agents; do
  meta=$run_dir/agents/$agent.meta
  if [ ! -f "$meta" ]; then
    printf 'agent.%s=missing\n' "$agent"
    continue
  fi
  window=$(cb_tmux_meta_get "$meta" window 2>/dev/null || true)
  wid=$(cb_tmux_meta_get "$meta" window_id 2>/dev/null || true)
  mode=$(cb_tmux_meta_get "$meta" mode 2>/dev/null || true)
  bin=$(cb_tmux_meta_get "$meta" bin 2>/dev/null || true)
  started=$(cb_tmux_meta_get "$meta" started 2>/dev/null || true)
  command=''
  resolved=''
  if [ "$session_live" -eq 1 ]; then
    if resolved=$(cb_tmux_resolve_agent "$run" "$agent" 2>/dev/null); then
      command=$(cb_tmux_current_command "$resolved" || true)
    fi
  fi
  printf 'agent.%s.window=%s\n' "$agent" "$window"
  printf 'agent.%s.window_id=%s\n' "$agent" "$wid"
  printf 'agent.%s.mode=%s\n' "$agent" "$mode"
  printf 'agent.%s.bin=%s\n' "$agent" "$bin"
  printf 'agent.%s.started=%s\n' "$agent" "$started"
  printf 'agent.%s.resolved=%s\n' "$agent" "$resolved"
  printf 'agent.%s.command=%s\n' "$agent" "$command"
done
