/**
 * @overview CLI-facing branch-scoped no-mistakes gate lease actions.
 *   Turns persisted lease states into shell-friendly exit codes and journal facts.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at acquireGateLeaseForCombo <- generated gate scripts call this.
 *   2. Then releaseGateLeaseForCombo     <- trap-safe lease cleanup.
 *
 *   MAIN FLOW
 *   ---------
 *   generated gate script -> gate-lease action -> core lease store + journal status
 *
 *   PUBLIC API
 *   ----------
 *   GATE_LEASE_CONFLICT_EXIT_CODE
 *   GateLeaseActionResult, acquireGateLeaseForCombo, releaseGateLeaseForCombo
 *
 * @exports GATE_LEASE_CONFLICT_EXIT_CODE, GateLeaseActionResult, acquireGateLeaseForCombo, releaseGateLeaseForCombo
 * @deps ../core/{events,gate-lease,state}
 */
import { appendEvent } from "../core/events.js";
import { acquireGateLease, releaseGateLease, type GateLeaseOwner } from "../core/gate-lease.js";
import { ComboStateError, readCombo, runDirFor } from "../core/state.js";

// -- 1/2 HELPER · types and owner resolution --
export const GATE_LEASE_CONFLICT_EXIT_CODE = 76;

export interface GateLeaseActionResult {
  state: string;
  exitCode: number;
}

interface GateLeaseActionDeps {
  out: (line: string) => void;
}

function ownerForCombo(
  home: string,
  comboId: string,
  headSha?: string,
): {
  owner: GateLeaseOwner;
  runDir: string;
} {
  const runDir = runDirFor(home, comboId);
  const combo = readCombo(runDir);
  return {
    runDir,
    owner: {
      comboId: combo.id,
      branch: combo.branch,
      worktree: combo.worktree,
      runDir,
      ...(headSha !== undefined && headSha !== "" ? { headSha } : {}),
    },
  };
}

function leaseOwnerPayload(lease: GateLeaseOwner): Record<string, string> {
  return {
    lease_combo_id: lease.comboId,
    lease_branch: lease.branch,
    lease_worktree: lease.worktree,
    ...(lease.runDir !== undefined ? { lease_run_dir: lease.runDir } : {}),
    ...(lease.headSha !== undefined ? { lease_head_sha: lease.headSha } : {}),
  };
}
// -/ 1/2

// -- 2/2 CORE · acquire/release actions <- START HERE --
export function acquireGateLeaseForCombo(input: {
  home: string;
  comboId: string;
  headSha?: string;
  out: GateLeaseActionDeps["out"];
}): GateLeaseActionResult {
  const { owner, runDir } = ownerForCombo(input.home, input.comboId, input.headSha);
  const result = acquireGateLease({ home: input.home, owner });

  if (result.state === "same_branch_conflict") {
    appendEvent(runDir, "needs_human", {
      reason: "gate_lease_conflict",
      ...leaseOwnerPayload(result.lease),
    });
    input.out(
      `gate lease conflict for ${owner.comboId}; branch ${owner.branch} already owned by ${result.lease.comboId}`,
    );
    return { state: result.state, exitCode: GATE_LEASE_CONFLICT_EXIT_CODE };
  }

  if (result.state === "recovered") {
    input.out(`gate lease recovered for ${owner.comboId}; stale owner ${result.staleLease.comboId}`);
    return { state: result.state, exitCode: 0 };
  }

  input.out(`gate lease acquired for ${owner.comboId}`);
  return { state: result.state, exitCode: 0 };
}

export function releaseGateLeaseForCombo(input: {
  home: string;
  comboId: string;
  out: GateLeaseActionDeps["out"];
}): GateLeaseActionResult {
  let comboIdLabel: string;
  let owner: Pick<GateLeaseOwner, "comboId">;
  try {
    const resolved = ownerForCombo(input.home, input.comboId);
    owner = resolved.owner;
    comboIdLabel = resolved.owner.comboId;
  } catch (error) {
    if (!(error instanceof ComboStateError)) throw error;
    owner = { comboId: input.comboId };
    comboIdLabel = input.comboId;
  }
  const result = releaseGateLease({ home: input.home, owner });
  if (result.state === "released") {
    input.out(`gate lease released for ${comboIdLabel}`);
    return { state: result.state, exitCode: 0 };
  }
  if (result.state === "not_owner") {
    input.out(`gate lease not released for ${comboIdLabel}; active owner ${result.lease.comboId}`);
    return { state: result.state, exitCode: 0 };
  }
  input.out(`gate lease already absent for ${comboIdLabel}`);
  return { state: result.state, exitCode: 0 };
}
// -/ 2/2
