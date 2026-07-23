#!/bin/sh
# Spawn one Combo v1 agent window inside combo-<runId> and write agent meta.
# Usage: cb-agent-spawn <runId> <agent> [--mode shell|tui|bin] [--bin <name>] [--cmd <text>] [--cwd <path>]
# Custody: a run-scoped lock serializes duplicate check, window create, ownership
# verification, and atomic metadata publication.
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

# Physical containment: run/agents/meta must stay inside this run, never via symlink escape.
cb_spawn_paths_prepare() {
  runs_root=
  run_root=
  agents_dir=
  agents_root=

  runs_root=$(realpath "$runs_dir" 2>/dev/null) || {
    echo "cb-agent-spawn: cannot resolve runs dir" >&2
    return 1
  }
  run_root=$(realpath "$run_dir" 2>/dev/null) || {
    echo "cb-agent-spawn: cannot resolve run dir" >&2
    return 1
  }
  case "$run_root" in
    "$runs_root"/"$run") ;;
    *)
      echo "cb-agent-spawn: run directory escapes runs root" >&2
      return 1
      ;;
  esac
  if [ -L "$run_dir" ]; then
    echo "cb-agent-spawn: run directory must not be a symlink" >&2
    return 1
  fi

  agents_dir=$run_dir/agents
  if [ -L "$agents_dir" ]; then
    echo "cb-agent-spawn: agents directory must not be a symlink" >&2
    return 1
  fi
  if [ -e "$agents_dir" ] && [ ! -d "$agents_dir" ]; then
    echo "cb-agent-spawn: agents path is not a directory" >&2
    return 1
  fi
  mkdir -p "$agents_dir" || {
    echo "cb-agent-spawn: cannot create agents dir" >&2
    return 1
  }
  if [ -L "$agents_dir" ]; then
    echo "cb-agent-spawn: agents directory must not be a symlink" >&2
    return 1
  fi
  agents_root=$(realpath "$agents_dir" 2>/dev/null) || {
    echo "cb-agent-spawn: cannot resolve agents dir" >&2
    return 1
  }
  case "$agents_root" in
    "$run_root"/agents)
      ;;
    *)
      echo "cb-agent-spawn: agents directory escapes run dir" >&2
      return 1
      ;;
  esac
  printf '%s\n' "$agents_root"
}

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

# mode=bin requires an explicit command in P2 (no silent no-op launch).
if [ "$mode" = bin ] && [ -z "$cmd" ]; then
  echo "cb-agent-spawn: mode=bin requires --cmd" >&2
  exit 64
fi

if [ -z "$cwd" ]; then
  cwd=${CB_WORKTREE:-$run_dir}
fi
[ -d "$cwd" ] || { echo "cb-agent-spawn: cwd missing: $cwd" >&2; exit 73; }

agents_root=$(cb_spawn_paths_prepare) || exit 73
agents_dir=$run_dir/agents
meta=$agents_dir/$agent.meta
if [ -L "$meta" ]; then
  echo "cb-agent-spawn: meta path must not be a symlink" >&2
  exit 73
fi

# Run-scoped custody lock (mkdir spinlock; dead-owner reclaim).
lock=$run_dir/.spawn.lock
lock_owner=$lock/owner
lock_token=$$-$(od -An -N8 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n')
[ -n "$lock_token" ] || lock_token=$$-$(date +%s)
started=$(date +%s)
lock_timeout=${CB_SPAWN_LOCK_TIMEOUT_SECONDS:-5}
stale_after=${CB_SPAWN_LOCK_STALE_SECONDS:-30}

reclaim_dead_lock() {
  owner_pid=''
  owner_token=''
  IFS=' ' read -r owner_pid owner_token <"$lock_owner" 2>/dev/null || return 0
  case "$owner_pid" in ''|*[!0-9]*) return 0 ;; esac
  kill -0 "$owner_pid" 2>/dev/null && return 0
  mkdir "$lock/.reap" 2>/dev/null || return 0
  current=$(cat "$lock_owner" 2>/dev/null || true)
  if [ "$current" = "$owner_pid $owner_token" ] && ! kill -0 "$owner_pid" 2>/dev/null; then
    rm -f "$lock_owner"
    rmdir "$lock/.reap" 2>/dev/null || true
    rmdir "$lock" 2>/dev/null || true
  else
    rmdir "$lock/.reap" 2>/dev/null || true
  fi
}

while ! mkdir "$lock" 2>/dev/null; do
  now=$(date +%s)
  mtime=$(stat -f %m "$lock" 2>/dev/null || stat -c %Y "$lock" 2>/dev/null || printf '%s' "$now")
  case "$mtime" in *[!0-9]*) mtime=$now ;; esac
  if [ $((now - mtime)) -ge "$stale_after" ]; then reclaim_dead_lock; fi
  if [ $((now - started)) -ge "$lock_timeout" ]; then
    echo "cb-agent-spawn: spawn lock timeout" >&2
    exit 75
  fi
  sleep 0.01
done
if ! printf '%s %s\n' "$$" "$lock_token" >"$lock_owner"; then
  rmdir "$lock" 2>/dev/null || true
  echo "cb-agent-spawn: cannot record spawn lock owner" >&2
  exit 73
fi

tmp=''
wid=''
cleanup() {
  [ -n "$tmp" ] && [ -f "$tmp" ] && rm -f "$tmp"
  current=$(cat "$lock_owner" 2>/dev/null || true)
  [ "$current" = "$$ $lock_token" ] || return 0
  rm -f "$lock_owner"
  rmdir "$lock" 2>/dev/null || true
}
trap cleanup 0
trap 'exit 130' 1 2 15

# Refuse publish if meta already exists for a live endpoint (duplicate under lock).
if [ -f "$meta" ]; then
  if existing=$(cb_tmux_resolve_agent "$run" "$agent" 2>/dev/null); then
    echo "cb-agent-spawn: agent endpoint already exists for $run/$agent ($existing)" >&2
    exit 75
  fi
fi

ses=$(cb_tmux_session_ensure "$run") || {
  echo "cb-agent-spawn: failed to ensure session for $run" >&2
  exit 75
}
wname=$(cb_tmux_window_name "$run" "$agent")

# Prefer an argv launch command at window create time. TUI bins without --cmd
# still start a shell; later phases inject the harness via cb-send.
launch_cmd=$cmd
if [ -z "$launch_cmd" ] && [ -n "$bin_name" ] && [ "$mode" = tui ]; then
  # Keep as a single argv token for tmux shell-command.
  launch_cmd=$bin_name
fi

wid=$(cb_tmux_window_create "$ses" "$wname" "$cwd" "$launch_cmd") || {
  echo "cb-agent-spawn: window create failed for $run/$agent" >&2
  exit 75
}

# Final exact-session ownership check before any durable metadata.
exact=$(cb_tmux_exact_session "$ses")
if ! cb_tmux_has_session_exact "$ses"; then
  echo "cb-agent-spawn: session missing before meta publish" >&2
  cb_tmux_kill "$wid" 2>/dev/null || true
  exit 75
fi
live_name=$(cb_tmux list-windows -t "$exact" -F '#{window_id} #{window_name}' 2>/dev/null \
  | awk -v id="$wid" '$1 == id { print $2; exit }')
if [ "$live_name" != "$wname" ]; then
  echo "cb-agent-spawn: endpoint ownership lost before meta publish" >&2
  cb_tmux_kill "$wid" 2>/dev/null || true
  exit 75
fi
pane_dead=$(cb_tmux display-message -p -t "$wid" '#{pane_dead}' 2>/dev/null || printf '1')
if [ "$pane_dead" = 1 ]; then
  echo "cb-agent-spawn: endpoint pane is dead before meta publish" >&2
  cb_tmux_kill "$wid" 2>/dev/null || true
  exit 75
fi

started_ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
window_target=$ses:$wname
tmp=$agents_dir/.$agent.meta.tmp.$$
{
  printf 'run=%s\n' "$run"
  printf 'agent=%s\n' "$agent"
  printf 'window=%s\n' "$window_target"
  printf 'window_id=%s\n' "$wid"
  printf 'mode=%s\n' "$mode"
  printf 'bin=%s\n' "$bin_name"
  printf 'started=%s\n' "$started_ts"
} >"$tmp" || {
  echo "cb-agent-spawn: meta temp write failed" >&2
  cb_tmux_kill "$wid" 2>/dev/null || true
  exit 73
}

tmp_real=$(realpath "$tmp" 2>/dev/null) || {
  echo "cb-agent-spawn: cannot resolve meta temp path" >&2
  rm -f "$tmp"
  cb_tmux_kill "$wid" 2>/dev/null || true
  exit 73
}
case "$tmp_real" in
  "$agents_root"/*) ;;
  *)
    echo "cb-agent-spawn: meta temp escapes agents dir" >&2
    rm -f "$tmp"
    cb_tmux_kill "$wid" 2>/dev/null || true
    exit 73
    ;;
esac
if [ -L "$meta" ]; then
  echo "cb-agent-spawn: meta path must not be a symlink" >&2
  rm -f "$tmp"
  cb_tmux_kill "$wid" 2>/dev/null || true
  exit 73
fi

mv -f "$tmp" "$meta" || {
  echo "cb-agent-spawn: meta publish failed" >&2
  rm -f "$tmp"
  cb_tmux_kill "$wid" 2>/dev/null || true
  exit 73
}
tmp=''

meta_real=$(realpath "$meta" 2>/dev/null) || {
  echo "cb-agent-spawn: cannot resolve published meta" >&2
  rm -f "$meta"
  cb_tmux_kill "$wid" 2>/dev/null || true
  exit 73
}
case "$meta_real" in
  "$agents_root"/"$agent".meta) ;;
  *)
    echo "cb-agent-spawn: published meta escapes agents dir" >&2
    rm -f "$meta"
    cb_tmux_kill "$wid" 2>/dev/null || true
    exit 73
    ;;
esac

printf '%s\n' "$wid"
