#!/bin/sh
# @overview Compile one validated Combo config into an immutable per-run plan.
#   The compiler knows only adapter ids, compatible roles, argv arrays, opaque
#   config slices, and ordered Coder invocations; it binds no provider,
#   runtime, model, or tool.
#
#   READING GUIDE
#   -------------
#   1. Run containment          <- establish the only allowed publication root.
#   2. Config snapshot          <- read caller input once into run-local storage.
#   3. validate_config          <- strict registry and role-binding contract.
#   4. Plan publication        <- fixed order and collision-safe read-only link.
#
#   MAIN FLOW
#   ---------
#   config path -> contained snapshot -> schema validation -> plan.json
#
#   PUBLIC API
#   ----------
#   cb-plan.sh <runId> --config <path>  Print the immutable plan path.
#
#   INTERNALS
#   ---------
#   usage, fail_config, fail_io, validate_config
#
# @exports none
# @deps sh, jq, realpath, ln
set -eu

usage() {
  echo "usage: cb-plan <runId> --config <path>" >&2
  exit 64
}

fail_config() {
  echo "cb-plan: invalid config: $1" >&2
  exit 64
}

fail_io() {
  echo "cb-plan: $1" >&2
  exit 73
}

[ "$#" -eq 3 ] || usage
run=$1
[ "$2" = --config ] || usage
config=$3
case "$run" in ''|-*|*[!a-z0-9-]*) usage ;; esac
command -v jq >/dev/null 2>&1 || fail_io "jq is required"

# -- 1/4 CORE · Establish run containment -- <- START HERE
runs_dir=${CB_RUNS_DIR:-"$HOME/.combo-chen/runs"}
run_dir=$runs_dir/$run
[ -d "$runs_dir" ] && [ ! -L "$runs_dir" ] \
  || fail_io "runs directory is missing or unsafe"
[ -d "$run_dir" ] && [ ! -L "$run_dir" ] \
  || fail_io "run directory is missing or unsafe"
runs_root=$(realpath "$runs_dir" 2>/dev/null) \
  || fail_io "cannot resolve runs directory"
run_root=$(realpath "$run_dir" 2>/dev/null) \
  || fail_io "cannot resolve run directory"
case "$run_root" in
  "$runs_root"/"$run") ;;
  *) fail_io "run directory escapes runs root" ;;
esac

plan=$run_dir/plan.json
if [ -e "$plan" ] || [ -L "$plan" ]; then
  fail_io "plan already exists: $plan"
fi
# -/ 1/4

# -- 2/4 CORE · Snapshot caller config once inside the run --
[ -f "$config" ] && [ ! -L "$config" ] \
  || fail_io "config is missing or unsafe"
config_real=$(realpath "$config" 2>/dev/null) \
  || fail_io "cannot resolve config"
[ -f "$config_real" ] || fail_io "config is not a regular file"

config_tmp=$run_dir/.config.snapshot.tmp
plan_tmp=$run_dir/.plan.json.tmp.$$
config_tmp_owned=0
plan_tmp_owned=0
cleanup() {
  [ "$config_tmp_owned" -eq 0 ] || rm -f "$config_tmp"
  [ "$plan_tmp_owned" -eq 0 ] || rm -f "$plan_tmp"
}
trap cleanup 0
trap 'exit 130' 1 2 15

if (set -C; cat "$config_real" >"$config_tmp") 2>/dev/null; then
  config_tmp_owned=1
else
  fail_io "config snapshot path already exists or cannot be created"
fi
# -/ 2/4

# -- 3/4 CORE · validate_config --
validate_config() {
  jq -e '
    def valid_id:
      type == "string" and test("^[a-z][a-z0-9._-]*$");
    def distinct:
      length == (unique | length);
    def valid_role:
      . == "launcher" or . == "coder" or . == "reviewer" or
      . == "gate" or . == "cleaner";
    def valid_adapter:
      type == "object" and
      keys == ["argv","roles"] and
      (.argv |
        type == "array" and length > 0 and
        all(.[]; type == "string" and length > 0)) and
      (.roles |
        type == "array" and length > 0 and distinct and
        all(.[]; valid_role));
    def valid_binding:
      type == "object" and
      keys == ["adapter","config"] and
      (.adapter | valid_id) and
      (.config | type == "object");
    def valid_coder:
      if type == "object" and keys == ["invocations"] then
        (.invocations |
          type == "array" and length > 0 and
          all(.[]; valid_binding))
      else
        valid_binding
      end;
    def coder_bindings:
      if type == "object" and keys == ["invocations"] then
        .invocations
      else
        [.]
      end;
    def valid_reviewer:
      type == "object" and
      keys == ["adapter","config","id"] and
      (.id | valid_id) and
      (.adapter | valid_id) and
      (.config | type == "object");
    def compatible($cfg; $binding; $role):
      ($cfg.adapters[$binding.adapter] != null) and
      (($cfg.adapters[$binding.adapter].roles | index($role)) != null);

    try (
      . as $cfg |
      type == "object" and
      keys == ["adapters","roles","schema"] and
      .schema == "combo.config/v1" and
      (.adapters |
        type == "object" and length > 0 and
        all(to_entries[]; (.key | valid_id) and (.value | valid_adapter))) and
      (.roles |
        type == "object" and
        keys == ["cleaner","coder","gate","launcher","reviewers"] and
        (.launcher | valid_binding) and
        (.coder | valid_coder) and
        (.reviewers |
          type == "array" and
          all(.[]; valid_reviewer) and
          ([.[].id] | distinct)) and
        (.gate | valid_binding) and
        (.cleaner | valid_binding)) and
      compatible($cfg; $cfg.roles.launcher; "launcher") and
      (($cfg.roles.coder | coder_bindings) as $coders |
        all($coders[]; compatible($cfg; .; "coder")) and
        all($cfg.roles.reviewers[];
          .adapter as $reviewer_adapter |
          all($coders[]; .adapter != $reviewer_adapter))) and
      all($cfg.roles.reviewers[]; compatible($cfg; .; "reviewer")) and
      compatible($cfg; $cfg.roles.gate; "gate") and
      compatible($cfg; $cfg.roles.cleaner; "cleaner")
    ) catch false
  ' "$config_tmp" >/dev/null 2>&1
}

validate_config || fail_config "schema or adapter binding"
# -/ 3/4

# -- 4/4 CORE · Build fixed-order plan and publish without replacement --
if (set -C; jq -c \
  --arg run "$run" \
  --arg run_dir "$run_root" \
  --arg artifacts_dir "$run_root/artifacts" \
  --arg steps_dir "$run_root/steps" '
    . as $cfg |
    def step($id; $role; $binding):
      {
        id: $id,
        role: $role,
        adapter_id: $binding.adapter,
        argv: $cfg.adapters[$binding.adapter].argv,
        config: $binding.config
      };
    def invocation($binding):
      {
        adapter_id: $binding.adapter,
        argv: $cfg.adapters[$binding.adapter].argv,
        config: $binding.config
      };
    def coder_step($binding):
      if $binding | keys == ["invocations"] then
        {
          id: "coder",
          role: "coder",
          invocations: [$binding.invocations[] | invocation(.)]
        }
      else
        step("coder"; "coder"; $binding)
      end;
    (
      [
        step("launcher"; "launcher"; $cfg.roles.launcher),
        coder_step($cfg.roles.coder)
      ] +
      [
        $cfg.roles.reviewers[] |
        . as $binding |
        step(("reviewer/" + $binding.id); "reviewer"; $binding) +
          {member_id:$binding.id}
      ] +
      [
        step("gate"; "gate"; $cfg.roles.gate),
        step("cleaner"; "cleaner"; $cfg.roles.cleaner)
      ]
    ) as $steps |
    {
      schema: "combo.run-plan/v1",
      run_id: $run,
      paths: {
        run_dir: $run_dir,
        artifacts_dir: $artifacts_dir,
        steps_dir: $steps_dir
      },
      reviewer_count: ($cfg.roles.reviewers | length),
      steps: $steps
    }
  ' "$config_tmp" >"$plan_tmp") 2>/dev/null; then
  plan_tmp_owned=1
else
  fail_io "plan staging path already exists or cannot be built"
fi

chmod 0444 "$plan_tmp" || fail_io "cannot make plan read-only"
if ! ln "$plan_tmp" "$plan" 2>/dev/null; then
  fail_io "plan publication collision"
fi
rm -f "$plan_tmp"
plan_tmp_owned=0
printf '%s\n' "$plan"
# -/ 4/4
