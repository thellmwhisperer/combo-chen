#!/usr/bin/env bash
#
# @overview Native Bash duplication gate. ~520 lines, one CLI; validates the
#   committed zero-tolerance policy and durable tombstones, extracts normalized
#   multiline function bodies, and blocks on every exact duplicate.
#
#   READING GUIDE
#   -------------
#   1. Start at scan_functions             <- detector core
#   2. Read validate_policy/tombstones     <- fail-closed inputs
#   3. Read compare_bodies                 <- zero-tolerance enforcement
#
#   MAIN FLOW
#   ---------
#   parse_args -> validate_policy -> validate_tombstones -> scan_functions
#     -> compare_bodies -> clean report or blocking findings
#
#   PUBLIC API
#   ----------
#   cb-slopslint.sh [--root PATH]    Validate one combo-chen checkout
#
#   INTERNALS
#   ---------
#   die, scalar, nested_scalar, nested_field_has_content, validate_policy,
#   validate_tombstone, validate_tombstones, scan_functions, compare_bodies,
#   cleanup
#
# @exports none
# @deps bash 3.2+, POSIX awk/find/sort/grep/cmp/cksum/mktemp, .slop/*.yml
set -u

LC_ALL=C
export LC_ALL

ROOT=
CONFIG=
CEILINGS=
TOMBSTONES=
MIN_LINES=
MIN_TOKENS=
SCAN_PATHS=()
WORK_DIR=
MANIFEST=
FINDINGS=0

# -- 1/5 HELPER · diagnostics, scalar readers, and cleanup --
die() {
  printf 'slopslint: config error: %s\n' "$1" >&2
  exit 2
}

scalar() {
  local file=$1 key=$2
  awk -v key="$key" '
    BEGIN { count = 0; value = "" }
    $0 ~ ("^" key ":[[:space:]]*") {
      count++
      value = $0
      sub("^[^:]+:[[:space:]]*", "", value)
    }
    END {
      if (count != 1 || value == "") exit 2
      print value
    }
  ' "$file"
}

nested_scalar() {
  local file=$1 section=$2 key=$3
  awk -v section="$section" -v key="$key" '
    BEGIN { inside = 0; sections = 0; count = 0; value = "" }
    $0 ~ ("^" section ":[[:space:]]*$") {
      inside = 1
      sections++
      next
    }
    inside && /^[^[:space:]]/ { inside = 0 }
    inside && $0 ~ ("^  " key ":[[:space:]]*") {
      count++
      value = $0
      sub("^  [^:]+:[[:space:]]*", "", value)
    }
    END {
      if (sections != 1 || count != 1 || value == "") exit 2
      print value
    }
  ' "$file"
}

nested_field_has_content() {
  local file=$1 section=$2 key=$3
  awk -v section="$section" -v key="$key" '
    BEGIN { inside = 0; field = 0; content = 0 }
    $0 ~ ("^" section ":[[:space:]]*$") { inside = 1; next }
    inside && /^[^[:space:]]/ { inside = 0; field = 0 }
    inside && $0 ~ ("^  " key ":[[:space:]]*[>|][[:space:]]*$") {
      field = 1
      next
    }
    field && /^  [A-Za-z_][A-Za-z0-9_]*:/ { field = 0 }
    field && /^    [^[:space:]#]/ { content = 1 }
    END { exit !content }
  ' "$file"
}

cleanup() {
  if [ -n "$WORK_DIR" ] && [ -d "$WORK_DIR" ]; then
    rm -rf -- "$WORK_DIR"
  fi
}
# -/ 1/5

# -- 2/5 CORE · validate_policy and validate_tombstones --
validate_policy() {
  local schema detector ceiling paths path seen=
  [ -f "$CONFIG" ] || die "missing $CONFIG"
  [ -f "$CEILINGS" ] || die "missing $CEILINGS"

  schema=$(scalar "$CONFIG" schema) || die "$CONFIG must define schema exactly once"
  [ "$schema" = 1 ] || die "$CONFIG schema must be 1"
  detector=$(scalar "$CONFIG" detector) \
    || die "$CONFIG must define detector exactly once"
  [ "$detector" = bash-function-body ] \
    || die "$CONFIG detector must be bash-function-body"
  MIN_LINES=$(scalar "$CONFIG" min_lines) \
    || die "$CONFIG must define min_lines exactly once"
  MIN_TOKENS=$(scalar "$CONFIG" min_tokens) \
    || die "$CONFIG must define min_tokens exactly once"
  case "$MIN_LINES" in
    ''|*[!0-9]*|0) die "$CONFIG min_lines must be a positive integer" ;;
  esac
  case "$MIN_TOKENS" in
    ''|*[!0-9]*|0) die "$CONFIG min_tokens must be a positive integer" ;;
  esac
  awk '
    /^[A-Za-z_][A-Za-z0-9_]*:/ {
      key = $0
      sub(":.*$", "", key)
      if (key != "schema" && key != "detector" && key != "min_lines" &&
          key != "min_tokens" && key != "paths") exit 2
    }
  ' "$CONFIG" || die "$CONFIG contains an unknown top-level field"

  paths=$(awk '
    BEGIN { inside = 0; sections = 0; count = 0 }
    /^paths:[[:space:]]*$/ { inside = 1; sections++; next }
    inside && /^  -[[:space:]]+/ {
      value = $0
      sub("^  -[[:space:]]+", "", value)
      if (value == "") exit 2
      print value
      count++
      next
    }
    inside && /^[^[:space:]]/ { inside = 0 }
    END { if (sections != 1 || count == 0) exit 2 }
  ' "$CONFIG") || die "$CONFIG paths must be one non-empty YAML list"

  while IFS= read -r path; do
    case "$path" in
      ''|/*|.|..|../*|*/../*|*/..) die "scan path must stay below root: $path" ;;
      *$'\t'*|*$'\n'*) die "scan path contains unsupported whitespace: $path" ;;
    esac
    case " $seen " in
      *" $path "*) die "duplicate scan path in $CONFIG: $path" ;;
    esac
    [ -d "$ROOT/$path" ] || die "scan path does not exist: $path"
    seen="${seen}${seen:+ }$path"
    SCAN_PATHS+=("$path")
  done <<<"$paths"

  schema=$(scalar "$CEILINGS" schema) \
    || die "$CEILINGS must define schema exactly once"
  [ "$schema" = 1 ] || die "$CEILINGS schema must be 1"
  ceiling=$(scalar "$CEILINGS" active_duplicates_ceiling) \
    || die "$CEILINGS must define active_duplicates_ceiling exactly once"
  [ "$ceiling" = 0 ] \
    || die "$CEILINGS active_duplicates_ceiling must be 0; findings always block"
  awk '
    /^[A-Za-z_][A-Za-z0-9_]*:/ {
      key = $0
      sub(":.*$", "", key)
      if (key != "schema" && key != "active_duplicates_ceiling") exit 2
    }
  ' "$CEILINGS" || die "$CEILINGS contains an unknown top-level field"
}

validate_tombstone() {
  local file=$1 filename stem schema id status category title created commit field
  filename=${file##*/}
  stem=${filename%.yml}

  schema=$(scalar "$file" schema) || die "$filename must define schema exactly once"
  [ "$schema" = 1 ] || die "$filename schema must be 1"
  id=$(scalar "$file" id) || die "$filename must define id exactly once"
  [ "$id" = "$stem" ] || die "$filename id $id must match filename stem $stem"
  case "$id" in
    T-[A-Z0-9]*)
      case "$id" in *[!A-Z0-9-]*) die "$filename id has invalid characters" ;; esac
      ;;
    *) die "$filename id must use T-UPPERCASE-ID form" ;;
  esac
  status=$(scalar "$file" status) || die "$filename must define status exactly once"
  [ "$status" = resolved ] || die "$filename status must be resolved"
  category=$(scalar "$file" category) \
    || die "$filename must define category exactly once"
  [ "$category" = duplication ] || die "$filename category must be duplication"
  title=$(scalar "$file" title) || die "$filename title must be non-empty"
  [ -n "$title" ] || die "$filename title must be non-empty"
  created=$(scalar "$file" created_at) || die "$filename created_at must be non-empty"
  case "$created" in
    [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) ;;
    *) die "$filename created_at must use YYYY-MM-DD" ;;
  esac

  commit=$(nested_scalar "$file" incident commit) \
    || die "$filename incident.commit must be non-empty"
  case "$commit" in
    *[!0-9a-f]*|'') die "$filename incident.commit must be 40 lowercase hex chars" ;;
  esac
  [ "${#commit}" -eq 40 ] \
    || die "$filename incident.commit must be 40 lowercase hex chars"
  for field in pattern what_went_wrong root_cause rule_established; do
    nested_scalar "$file" incident "$field" >/dev/null \
      || die "$filename incident.$field must be non-empty"
    nested_field_has_content "$file" incident "$field" \
      || die "$filename incident.$field folded block must contain text"
  done

  awk '
    BEGIN { incident = 0 }
    /^incident:[[:space:]]*$/ { incident = 1; next }
    incident && /^[^[:space:]]/ { incident = 0 }
    incident && /^  [A-Za-z_][A-Za-z0-9_]*:/ {
      nested = $0
      sub("^[[:space:]]*", "", nested)
      sub(":.*$", "", nested)
      if (nested != "commit" && nested != "pattern" &&
          nested != "what_went_wrong" && nested != "root_cause" &&
          nested != "rule_established") exit 2
    }
    /^[A-Za-z_][A-Za-z0-9_]*:/ {
      key = $0
      sub(":.*$", "", key)
      if (key != "schema" && key != "id" && key != "status" &&
          key != "category" && key != "title" && key != "created_at" &&
          key != "incident") exit 2
    }
  ' "$file" || die "$filename contains an unknown top-level field"
}

validate_tombstones() {
  local count=0 file
  [ -d "$TOMBSTONES" ] || die "missing tombstone directory $TOMBSTONES"
  if find "$TOMBSTONES" -maxdepth 1 -type f -name '*.yaml' | grep . >/dev/null 2>&1; then
    die "tombstones must use one T-*.yml file per record, not .yaml"
  fi
  while IFS= read -r file; do
    [ -n "$file" ] || continue
    validate_tombstone "$file"
    count=$((count + 1))
  done < <(find "$TOMBSTONES" -maxdepth 1 -type f -name '*.yml' -print | sort)
  [ "$count" -gt 0 ] || die "$TOMBSTONES must contain at least one tombstone"
}
# -/ 2/5

# -- 3/5 CORE · scan_functions normalized body extraction -- <- START HERE
scan_functions() {
  local path source rel source_index=0
  for path in "${SCAN_PATHS[@]}"; do
    while IFS= read -r source; do
      [ -n "$source" ] || continue
      source_index=$((source_index + 1))
      rel=${source#"$ROOT/"}
      case "$rel" in *$'\t'*|*$'\n'*) die "source path contains tab/newline: $rel" ;; esac
      awk \
        -v out="$WORK_DIR" \
        -v manifest="$MANIFEST" \
        -v rel="$rel" \
        -v source_id="$source_index" \
        -v min_lines="$MIN_LINES" \
        -v min_tokens="$MIN_TOKENS" '
        function reset() {
          active = 0
          name = ""
          start = 0
          kept = 0
          tokens = 0
          body = ""
          heredoc = ""
          heredoc_strip = 0
          quote = ""
        }
        function add_body(raw, literal, line, copy, count, i) {
          line = raw
          if (!literal && (line ~ /^[[:space:]]*#/ || line ~ /^[[:space:]]*$/)) return
          if (literal && line ~ /^[[:space:]]*$/) return
          gsub(/^[[:space:]]+/, "", line)
          gsub(/[[:space:]]+$/, "", line)
          gsub(/[[:space:]]+/, " ", line)
          body = body line "\n"
          kept++
          copy = line
          count = split(copy, words, /[^A-Za-z0-9_]+/)
          for (i = 1; i <= count; i++) if (words[i] != "") tokens++
        }
        function quote_after(raw, state, i, ch) {
          for (i = 1; i <= length(raw); i++) {
            ch = substr(raw, i, 1)
            if (state == "\047") {
              if (ch == "\047") state = ""
              continue
            }
            if (state == "\"") {
              if (ch == "\\") {
                i++
                continue
              }
              if (ch == "\"") state = ""
              continue
            }
            if (ch == "\\") {
              i++
              continue
            }
            if (ch == "\047" || ch == "\"") {
              state = ch
              continue
            }
            if (ch == "#" && (i == 1 || substr(raw, i - 1, 1) ~ /[[:space:]]/)) break
          }
          return state
        }
        function start_heredoc(raw, i, ch, state, rest, token) {
          state = ""
          for (i = 1; i <= length(raw); i++) {
            ch = substr(raw, i, 1)
            if (state == "\047") {
              if (ch == "\047") state = ""
              continue
            }
            if (state == "\"") {
              if (ch == "\\") {
                i++
                continue
              }
              if (ch == "\"") state = ""
              continue
            }
            if (ch == "\\") {
              i++
              continue
            }
            if (ch == "\047" || ch == "\"") {
              state = ch
              continue
            }
            if (ch == "#" && (i == 1 || substr(raw, i - 1, 1) ~ /[[:space:]]/)) return ""
            if (ch == "<" && substr(raw, i + 1, 1) == "<" &&
                substr(raw, i + 2, 1) != "<") {
              rest = substr(raw, i)
              if (!match(rest, /^<<-?[[:space:]]*[\047"]?[A-Za-z0-9_]+[\047"]?/)) return ""
              token = substr(rest, RSTART, RLENGTH)
              heredoc_strip = (token ~ /^<<-/)
              sub(/^<<-?[[:space:]]*/, "", token)
              gsub(/[\047"]/, "", token)
              return token
            }
          }
          return ""
        }
        BEGIN { reset() }
        (!active && ($0 ~ /^[A-Za-z_][A-Za-z0-9_]*[[:space:]]*\(\)[[:space:]]*\{[[:space:]]*(#.*)?$/ || $0 ~ /^function[[:space:]]+[A-Za-z_][A-Za-z0-9_]*([[:space:]]*\(\))?[[:space:]]*\{[[:space:]]*(#.*)?$/)) {
          name = $0
          sub(/^function[[:space:]]+/, "", name)
          sub(/[[:space:]]*\(\).*/, "", name)
          sub(/[[:space:]]*\{.*/, "", name)
          start = NR
          active = 1
          next
        }
        active && heredoc != "" {
          add_body($0, 1)
          delimiter = $0
          if (heredoc_strip) sub(/^\t+/, "", delimiter)
          if (delimiter == heredoc) {
            heredoc = ""
            heredoc_strip = 0
          }
          next
        }
        active && quote != "" {
          add_body($0, 1)
          quote = quote_after($0, quote)
          next
        }
        active && /^}[[:space:]]*(#.*)?$/ {
          if (kept >= min_lines && tokens >= min_tokens) {
            serial++
            id = source_id "-" serial
            body_file = out "/" id ".body"
            printf "%s", body > body_file
            close(body_file)
            printf "%s\t%s\t%s\t%d\t%d\t%d\t%d\t%s\n",
              body_file, rel, name, start, NR, kept, tokens, id >> manifest
            close(manifest)
          }
          reset()
          next
        }
        active {
          add_body($0, 0)
          heredoc = start_heredoc($0)
          if (heredoc == "") quote = quote_after($0, "")
        }
        END {
          if (active) {
            printf "slopslint: parser ended inside %s:%d (%s; heredoc=%s quote=%s)\n",
              rel, start, name, heredoc, quote > "/dev/stderr"
            exit 3
          }
        }
      ' "$source" || die "failed to parse Bash functions in $rel"
    done < <(find "$ROOT/$path" -type f -name '*.sh' -print | sort)
  done
}
# -/ 3/5

# -- 4/5 CORE · compare_bodies and zero-tolerance report --
compare_bodies() {
  local body rel name start end lines tokens id
  local i j fingerprint
  local bodies=() paths=() names=() starts=() ends=() line_counts=() token_counts=()
  local fingerprints=()

  [ -f "$MANIFEST" ] || {
    printf 'slopslint: 0 active duplicates (0 eligible function bodies)\n'
    return 0
  }
  while IFS=$'\t' read -r body rel name start end lines tokens id; do
    [ -n "$id" ] || die "detector emitted a malformed manifest row"
    bodies+=("$body")
    paths+=("$rel")
    names+=("$name")
    starts+=("$start")
    ends+=("$end")
    line_counts+=("$lines")
    token_counts+=("$tokens")
    fingerprint=$(cksum "$body" | awk '{print $1 "-" $2}') \
      || die "cannot fingerprint normalized body for $rel:$start"
    [ -n "$fingerprint" ] || die "empty normalized body fingerprint for $rel:$start"
    fingerprints+=("$fingerprint")
  done <"$MANIFEST"

  for ((i = 0; i < ${#bodies[@]}; i++)); do
    for ((j = i + 1; j < ${#bodies[@]}; j++)); do
      [ "${fingerprints[$i]}" = "${fingerprints[$j]}" ] || continue
      if cmp -s -- "${bodies[$i]}" "${bodies[$j]}"; then
        fingerprint=${fingerprints[$i]}
        printf 'slopslint: duplicate function body %s:%s-%s (%s) == %s:%s-%s (%s) [body=%s lines=%s tokens=%s]\n' \
          "${paths[$i]}" "${starts[$i]}" "${ends[$i]}" "${names[$i]}" \
          "${paths[$j]}" "${starts[$j]}" "${ends[$j]}" "${names[$j]}" \
          "$fingerprint" "${line_counts[$i]}" "${token_counts[$i]}" >&2
        FINDINGS=$((FINDINGS + 1))
      fi
    done
  done

  if [ "$FINDINGS" -gt 0 ]; then
    printf 'slopslint: %d active duplicate(s); ceiling is 0\n' "$FINDINGS" >&2
    return 1
  fi
  printf 'slopslint: 0 active duplicates (%d eligible function bodies)\n' "${#bodies[@]}"
  return 0
}
# -/ 4/5

# -- 5/5 CORE · CLI orchestration --
while [ "$#" -gt 0 ]; do
  case "$1" in
    --root)
      [ "$#" -ge 2 ] || die "--root requires a path"
      ROOT=$2
      shift 2
      ;;
    -h|--help)
      printf 'Usage: %s [--root PATH]\n' "${0##*/}"
      exit 0
      ;;
    *) die "unknown argument: $1" ;;
  esac
done

if [ -z "$ROOT" ]; then
  ROOT=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd -P) \
    || die "cannot resolve repository root"
else
  ROOT=$(CDPATH='' cd -- "$ROOT" && pwd -P) || die "cannot resolve --root path"
fi
CONFIG="$ROOT/.slop/config.yml"
CEILINGS="$ROOT/.slop/ceilings.yml"
TOMBSTONES="$ROOT/.slop/tombstones"

validate_policy
validate_tombstones

[ ! -L "$ROOT/.tmp" ] || die "$ROOT/.tmp must not be a symlink"
mkdir -p "$ROOT/.tmp" || die "cannot create project-local .tmp"
WORK_DIR=$(mktemp -d "$ROOT/.tmp/slopslint.XXXXXX") \
  || die "cannot allocate project-local detector workspace"
MANIFEST="$WORK_DIR/manifest.tsv"
trap cleanup EXIT
trap 'cleanup; exit 130' HUP INT TERM

scan_functions
compare_bodies
exit $?
# -/ 5/5
