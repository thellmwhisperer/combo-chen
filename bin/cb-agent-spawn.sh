#!/bin/sh
# Spawn one Combo v1 agent window inside combo-<runId> and write agent meta.
# Usage: cb-agent-spawn <runId> <agent> [--mode shell|tui|bin] [--bin <name>] [--cmd <text>] [--cwd <path>]
set -eu

usage() {
  echo "usage: cb-agent-spawn <runId> <agent> [--mode shell|tui|bin] [--bin <name>] [--cmd <text>] [--cwd <path>]" >&2
  exit 64
}

[ "$#" -ge 2 ] || usage
run=$1
agent=$2
shift 2

case "$run" in ''|-*|*[!a-z0-9-]*) echo "cb-agent-spawn: invalid run id" >&2; exit 64 ;; esac
case "$agent" in launcher|coder|reviewer|gate|cleaner) ;; *) echo "cb-agent-spawn: invalid agent" >&2; exit 64 ;; esac

mode=''
bin_name=''
cmd=''
cwd=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --mode|--bin|--cmd|--cwd)
      [ "$#" -ge 2 ] || usage
      key=$1
      value=$2
      shift 2
      case "$key" in
        --mode) mode=$value ;;
        --bin) bin_name=$value ;;
        --cmd) cmd=$value ;;
        --cwd) cwd=$value ;;
      esac
      ;;
    *) usage ;;
  esac
done

case "$mode" in ''|shell|tui|bin) ;; *) echo "cb-agent-spawn: invalid mode" >&2; exit 64 ;; esac

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname "$0")" && pwd)
# shellcheck source=bin/cb-tmux.sh
. "$SCRIPT_DIR/cb-tmux.sh"

runs_dir=${CB_RUNS_DIR:-$HOME/.combo-chen/runs}
run_dir=$runs_dir/$run
[ -d "$run_dir" ] || { echo "cb-agent-spawn: run directory missing: $run_dir" >&2; exit 73; }

if [ -f "$run_dir/config.env" ]; then
  # config.env is the run's trusted launch snapshot when present.
  # shellcheck disable=SC1090
  . "$run_dir/config.env"
fi

if [ -z "$mode" ]; then
  case "$agent" in
    launcher|cleaner|gate) mode=shell ;;
    coder|reviewer) mode=tui ;;
  esac
fi

if [ -z "$cwd" ]; then
  cwd=${CB_WORKTREE:-$run_dir}
fi
[ -d "$cwd" ] || { echo "cb-agent-spawn: cwd missing: $cwd" >&2; exit 73; }

agents_dir=$run_dir/agents
mkdir -p "$agents_dir"

ses=$(cb_tmux_session_ensure "$run") || {
  echo "cb-agent-spawn: failed to ensure session for $run" >&2
  exit 75
}
wname=$(cb_tmux_window_name "$run" "$agent")
wid=$(cb_tmux_window_create "$ses" "$wname" "$cwd") || {
  echo "cb-agent-spawn: window create failed for $run/$agent" >&2
  exit 75
}

started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
window_target=$ses:$wname
meta=$agents_dir/$agent.meta
tmp=$meta.tmp.$$
{
  printf 'run=%s\n' "$run"
  printf 'agent=%s\n' "$agent"
  printf 'window=%s\n' "$window_target"
  printf 'window_id=%s\n' "$wid"
  printf 'mode=%s\n' "$mode"
  printf 'bin=%s\n' "$bin_name"
  printf 'started=%s\n' "$started"
} >"$tmp"
mv -f "$tmp" "$meta"

# Optional launch: P2 creates the endpoint; later phases supply real wrappers.
if [ -n "$cmd" ]; then
  case "$mode" in
    tui)
      cb_tmux_send_literal "$wid" "$cmd" || true
      cb_tmux_send_line "$wid" "" || true
      ;;
    *)
      cb_tmux_send_line "$wid" "$cmd" || true
      ;;
  esac
elif [ -n "$bin_name" ] && [ "$mode" = tui ]; then
  cb_tmux_send_literal "$wid" "$bin_name" || true
  cb_tmux_send_line "$wid" "" || true
fi

printf '%s\n' "$wid"
