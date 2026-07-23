#!/bin/sh
# Human/debug pane capture. Never a 0/1 product source.
set -eu

usage() { echo "usage: cb-peek <runId> <agent> [lines]" >&2; exit 64; }
[ "$#" -ge 2 ] || usage
run=$1 agent=$2 lines=${3:-40}
case "$run" in ''|-*|*[!a-z0-9-]*) usage ;; esac
case "$agent" in launcher|coder|reviewer|gate|cleaner) ;; *) usage ;; esac
case "$lines" in ''|*[!0-9]*) usage ;; esac

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname "$0")" && pwd)
# shellcheck source=bin/cb-tmux.sh
. "$SCRIPT_DIR/cb-tmux.sh"

target=$(cb_tmux_resolve_agent "$run" "$agent") || exit 1
cb_tmux_capture "$target" "$lines"
