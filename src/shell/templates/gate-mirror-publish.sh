# Publish HEAD to the no-mistakes gate mirror with the push intent, aborting
# any previous run on the branch first. force-with-lease replaces an existing
# mirror branch; a fresh branch pushes plain.
__AXI_STATUS_LIB__
if git remote get-url no-mistakes >/dev/null 2>&1; then
  mirror_branch=__MIRROR_BRANCH__
  mirror_ref=__MIRROR_REF__
  # Single quotes: the intent value is base64 (never contains a quote) and
  # must not be exposed to $/backtick expansion.
  mirror_intent='no-mistakes.intent=__MIRROR_INTENT__'
  no-mistakes daemon start 2>/dev/null || no-mistakes status 2>/dev/null | grep -Eq 'daemon:.*running' || exit 1
  export COMBO_CHEN_NO_MISTAKES_DAEMON_STARTED=1
__ABORT_PREVIOUS_RUN__
  export COMBO_CHEN_NO_MISTAKES_PREVIOUS_RUN_ABORTED=1
  if mirror_line=$(git ls-remote --heads no-mistakes "$mirror_branch" 2>/dev/null); then
    mirror_sha=
    if [ -n "$mirror_line" ]; then
      # shellcheck disable=SC2086
      set -- $mirror_line
      mirror_sha=${1:-}
    fi
    if [ -n "$mirror_sha" ]; then
      git push -o "$mirror_intent" no-mistakes --force-with-lease="$mirror_ref:$mirror_sha" "HEAD:$mirror_ref" || exit 1
    else
      git push -o "$mirror_intent" no-mistakes "HEAD:$mirror_ref" || exit 1
    fi
  else
    printf '%s\n' "no-mistakes mirror lookup failed for $mirror_branch" >&2
    exit 1
  fi
fi
