#!/bin/sh
# Inject one line of text into a Combo v1 agent pane via run-local meta resolution.
# Usage: cb-send <runId> <agent> <text...>
# Resolution stays inside combo-<runId>; never searches other sessions by name.
set -eu

usage() {
  echo "usage: cb-send <runId> <agent> <text...>" >&2
  exit 64
}

[ "$#" -ge 3 ] || usage
run=$1
agent=$2
shift 2
text=$*

case "$run" in ''|-*|*[!a-z0-9-]*) usage ;; esac
case "$agent" in launcher|coder|reviewer|gate|cleaner) ;; *) usage ;; esac
[ -n "$text" ] || usage

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname "$0")" && pwd)
# shellcheck source=bin/cb-tmux.sh
. "$SCRIPT_DIR/cb-tmux.sh"

target=$(cb_tmux_resolve_agent "$run" "$agent") || exit 1
cb_tmux_send_literal "$target" "$text"
# Enter is a separate key so TUI composers receive literal text then submit.
cb_tmux send-keys -t "$target" Enter
