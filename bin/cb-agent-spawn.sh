#!/bin/sh
# Spawn one agent window in combo-<runId> and publish atomic agents/<agent>.meta.
# Run-scoped lock covers duplicate check, create, live verify, and meta publish.
set -eu

usage() {
  echo "usage: cb-agent-spawn <runId> <agent> [--mode shell|tui|bin] [--bin <name>] [--cmd <text>] [--cwd <path>]" >&2
  exit 64
}

[ "$#" -ge 2 ] || usage
run=$1 agent=$2
shift 2
case "$run" in ''|-*|*[!a-z0-9-]*) echo "cb-agent-spawn: invalid run id" >&2; exit 64 ;; esac
case "$agent" in launcher|coder|reviewer|gate|cleaner) ;; *) echo "cb-agent-spawn: invalid agent" >&2; exit 64 ;; esac

mode='' bin_name='' cmd='' cwd=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --mode|--bin|--cmd|--cwd)
      [ "$#" -ge 2 ] || usage
      case "$1" in
        --mode) mode=$2 ;;
        --bin) bin_name=$2 ;;
        --cmd) cmd=$2 ;;
        --cwd) cwd=$2 ;;
      esac
      shift 2
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

# Resolve and prove run/agents stay physically inside this run (no symlink escape).
cb_spawn_contain() {
  runs_root=$(realpath "$runs_dir" 2>/dev/null) || return 1
  run_root=$(realpath "$run_dir" 2>/dev/null) || return 1
  case "$run_root" in "$runs_root"/"$run") ;; *) return 1 ;; esac
  [ ! -L "$run_dir" ] || return 1
  agents_dir=$run_dir/agents
  [ ! -L "$agents_dir" ] || return 1
  if [ -e "$agents_dir" ] && [ ! -d "$agents_dir" ]; then return 1; fi
  mkdir -p "$agents_dir" || return 1
  [ ! -L "$agents_dir" ] || return 1
  agents_root=$(realpath "$agents_dir" 2>/dev/null) || return 1
  case "$agents_root" in "$run_root"/agents) ;; *) return 1 ;; esac
  printf '%s\n' "$agents_root"
}

cb_spawn_fail() {
  # <msg> [exit] — drop temp/window, keep lock cleanup via trap
  echo "cb-agent-spawn: $1" >&2
  [ -n "${tmp:-}" ] && [ -f "$tmp" ] && rm -f "$tmp"
  [ -n "${wid:-}" ] && cb_tmux_kill "$wid" 2>/dev/null || true
  exit "${2:-75}"
}

# Containment before any run-local shell content (config.env must not run first).
agents_root=$(cb_spawn_contain) || { echo "cb-agent-spawn: agents path escapes run or is a symlink" >&2; exit 73; }
agents_dir=$run_dir/agents
meta=$agents_dir/$agent.meta
[ ! -L "$meta" ] || { echo "cb-agent-spawn: meta path must not be a symlink" >&2; exit 73; }
run_root=$(realpath "$run_dir" 2>/dev/null) || { echo "cb-agent-spawn: cannot resolve run dir" >&2; exit 73; }

if [ -f "$run_dir/config.env" ] || [ -L "$run_dir/config.env" ]; then
  [ ! -L "$run_dir/config.env" ] || { echo "cb-agent-spawn: config.env must not be a symlink" >&2; exit 73; }
  cfg_real=$(realpath "$run_dir/config.env" 2>/dev/null) || { echo "cb-agent-spawn: cannot resolve config.env" >&2; exit 73; }
  case "$cfg_real" in
    "$run_root"/config.env) ;;
    *) echo "cb-agent-spawn: config.env escapes run dir" >&2; exit 73 ;;
  esac
  # shellcheck disable=SC1090
  . "$run_dir/config.env"
fi
if [ -z "$mode" ]; then
  case "$agent" in launcher|cleaner|gate) mode=shell ;; coder|reviewer) mode=tui ;; esac
fi
[ "$mode" != bin ] || [ -n "$cmd" ] || { echo "cb-agent-spawn: mode=bin requires --cmd" >&2; exit 64; }
[ -n "$cwd" ] || cwd=${CB_WORKTREE:-$run_dir}
[ -d "$cwd" ] || { echo "cb-agent-spawn: cwd missing: $cwd" >&2; exit 73; }

# Run-scoped custody lock (mkdir spinlock + dead-owner reclaim).
lock=$run_dir/.spawn.lock
lock_owner=$lock/owner
lock_token=$$-$(od -An -N8 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n')
[ -n "$lock_token" ] || lock_token=$$-$(date +%s)
started=$(date +%s)
lock_timeout=${CB_SPAWN_LOCK_TIMEOUT_SECONDS:-5}
stale_after=${CB_SPAWN_LOCK_STALE_SECONDS:-30}

reclaim_dead_lock() {
  owner_pid='' owner_token=''
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
  [ $((now - mtime)) -lt "$stale_after" ] || reclaim_dead_lock
  [ $((now - started)) -lt "$lock_timeout" ] || { echo "cb-agent-spawn: spawn lock timeout" >&2; exit 75; }
  sleep 0.01
done
printf '%s %s\n' "$$" "$lock_token" >"$lock_owner" || { rmdir "$lock" 2>/dev/null || true; echo "cb-agent-spawn: cannot record spawn lock owner" >&2; exit 73; }

tmp='' wid=''
cleanup() {
  [ -n "$tmp" ] && [ -f "$tmp" ] && rm -f "$tmp"
  current=$(cat "$lock_owner" 2>/dev/null || true)
  [ "$current" = "$$ $lock_token" ] || return 0
  rm -f "$lock_owner"
  rmdir "$lock" 2>/dev/null || true
}
trap cleanup 0
trap 'exit 130' 1 2 15

if [ -f "$meta" ] && existing=$(cb_tmux_resolve_agent "$run" "$agent" 2>/dev/null); then
  echo "cb-agent-spawn: agent endpoint already exists for $run/$agent ($existing)" >&2
  exit 75
fi

ses=$(cb_tmux_session_ensure "$run") || cb_spawn_fail "failed to ensure session for $run"
wname=$(cb_tmux_window_name "$run" "$agent")
launch_cmd=$cmd
[ -n "$launch_cmd" ] || { [ -n "$bin_name" ] && [ "$mode" = tui ] && launch_cmd=$bin_name || true; }
wid=$(cb_tmux_window_create "$ses" "$wname" "$cwd" "$launch_cmd") || cb_spawn_fail "window create failed for $run/$agent"
cb_tmux_endpoint_ok "$ses" "$wname" "$wid" || cb_spawn_fail "endpoint not live before meta publish"

started_ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
tmp=$agents_dir/.$agent.meta.tmp.$$
{
  printf 'run=%s\n' "$run"
  printf 'agent=%s\n' "$agent"
  printf 'window=%s\n' "$ses:$wname"
  printf 'window_id=%s\n' "$wid"
  printf 'mode=%s\n' "$mode"
  printf 'bin=%s\n' "$bin_name"
  printf 'started=%s\n' "$started_ts"
} >"$tmp" || cb_spawn_fail "meta temp write failed" 73

tmp_real=$(realpath "$tmp" 2>/dev/null) || cb_spawn_fail "cannot resolve meta temp path" 73
case "$tmp_real" in "$agents_root"/*) ;; *) cb_spawn_fail "meta temp escapes agents dir" 73 ;; esac
[ ! -L "$meta" ] || cb_spawn_fail "meta path must not be a symlink" 73
mv -f "$tmp" "$meta" || cb_spawn_fail "meta publish failed" 73
tmp=''

meta_real=$(realpath "$meta" 2>/dev/null) || cb_spawn_fail "cannot resolve published meta" 73
case "$meta_real" in "$agents_root"/"$agent".meta) ;; *) rm -f "$meta"; cb_spawn_fail "published meta escapes agents dir" 73 ;; esac

# Final liveness after publish; strip meta if the endpoint died under us.
if ! cb_tmux_endpoint_ok "$ses" "$wname" "$wid"; then
  rm -f "$meta"
  cb_spawn_fail "endpoint died after meta publish"
fi

printf '%s\n' "$wid"
