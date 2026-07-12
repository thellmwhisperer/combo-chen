/**
 * @overview v1 capsule READY contract: the patch-id lgtm carry-over fold and
 *   the four-leg deterministic READY agreement for capsule runs (PRD s3/s11,
 *   captain decision D3). Local lgtm is the code-0 verdict pinned to the
 *   reviewed changeset's whole-range patch-id; a pure gate rebase carries it,
 *   gate autofix commits break it and route a local re-review round, never
 *   needs_human. Built alongside the v0 sha-equality fold (livePinnedLgtmSha,
 *   canonicalLgtmShaForHead), which stays untouched until the contract flip.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at capsuleReadyAgreement <- the four READY legs, in order.
 *   2. Then applyLgtmCarryOver        <- what happens after the gate publishes.
 *   3. livePinnedLocalLgtm            <- the patch-id-aware pin fold.
 *
 *   MAIN FLOW
 *   ---------
 *   code-0 verdict -> pinLocalLgtm (lgtm + patch_id)
 *   gate publishes -> applyLgtmCarryOver -> carried | lgtm_stale + re-review round
 *   observer -> capsuleReadyAgreement(journal, head facts, evidence) -> decision
 *
 *   PUBLIC API
 *   ----------
 *   LocalLgtmPin           Live pin: reviewed sha plus its changeset patch-id.
 *   livePinnedLocalLgtm    Fold lgtm/lgtm_stale into the live patch-id pin.
 *   nextLocalReviewRound   One past the highest requested review round.
 *   pinLocalLgtm           Journal the code-0 pin with its patch-id.
 *   LgtmCarryOverResult    carried | already_current | re_review_requested | no_pin.
 *   applyLgtmCarryOver     Re-pin, or invalidate and request the next round.
 *   CapsuleReadyDecision   ready + precise blockers for the journal/operator.
 *   capsuleReadyAgreement  Pure four-leg agreement; no LLM, no login pinning.
 *
 *   INTERNALS
 *   ---------
 *   publishedPatchIdOrUndefined, gateLegHolds, lgtmLegHolds
 *
 * @exports LocalLgtmPin, livePinnedLocalLgtm, nextLocalReviewRound, pinLocalLgtm, LgtmCarryOverResult, applyLgtmCarryOver, CapsuleReadyDecision, capsuleReadyAgreement
 * @deps ../../core/{events,patch-id}, ../gate/gate, ../github/{checks,review-evidence}
 */
import { appendEvent, appendEvents, readEvents, type ComboEvent } from "../../core/events.js";
import {
  computeChangesetPatchId,
  patchIdEquals,
  PatchIdError,
  type ChangesetPatchId,
  type PatchIdProcessRunner,
} from "../../core/patch-id.js";
import { latestGateStatus, latestPublishedGateSha, shaMatchesHead } from "../gate/gate.js";
import { checkRollupSucceeded, requiredChecksSucceeded } from "../github/checks.js";
import {
  externalReviewEvidenceClean,
  type ExternalReviewEvidence,
} from "../github/review-evidence.js";

// -- 1/4 CORE · patch-id-aware lgtm pin fold <- START HERE --
export interface LocalLgtmPin {
  sha: string;
  patchId?: string;
}

/**
 * The capsule-run successor of the v0 livePinnedLgtmSha fold: same
 * lgtm/lgtm_stale semantics, but the pin carries the reviewed changeset's
 * whole-range patch-id so equivalence can outlive gate rebases.
 */
export function livePinnedLocalLgtm(events: ComboEvent[]): LocalLgtmPin | undefined {
  let pin: LocalLgtmPin | undefined;
  for (const event of events) {
    if (event.event === "lgtm" && typeof event["sha"] === "string") {
      pin = {
        sha: event["sha"],
        ...(typeof event["patch_id"] === "string" ? { patchId: event["patch_id"] } : {}),
      };
    }
    if (event.event === "lgtm_stale" && event["old_sha"] === pin?.sha) {
      pin = undefined;
    }
  }
  return pin;
}

export function nextLocalReviewRound(events: ComboEvent[]): number {
  let highest = 0;
  for (const event of events) {
    if (event.event !== "local_review_requested" && event.event !== "local_verdict") continue;
    const round = event["round"];
    if (typeof round === "number" && Number.isInteger(round) && round > highest) highest = round;
  }
  return highest + 1;
}
// -/ 1/4

// -- 2/4 CORE · pinLocalLgtm --
/**
 * Journals the local lgtm for a code-0 verdict: pinned to the reviewed sha
 * and to the whole-range patch-id of its changeset. Capsule engine only; the
 * v0 GitHub-comment lgtm path never emits patch ids.
 */
export async function pinLocalLgtm(input: {
  git: PatchIdProcessRunner;
  cwd: string;
  runDir: string;
  baseRef: string;
  sha: string;
  round: number;
  env?: Record<string, string | undefined>;
}): Promise<LocalLgtmPin> {
  const changeset = await computeChangesetPatchId({
    run: input.git,
    cwd: input.cwd,
    baseRef: input.baseRef,
    head: input.sha,
    ...(input.env === undefined ? {} : { env: input.env }),
  });
  appendEvent(input.runDir, "lgtm", {
    sha: changeset.head,
    ...(changeset.patchId === undefined ? {} : { patch_id: changeset.patchId }),
    round: input.round,
    source: "local_verdict",
  });
  return {
    sha: changeset.head,
    ...(changeset.patchId === undefined ? {} : { patchId: changeset.patchId }),
  };
}
// -/ 2/4

// -- 3/4 CORE · applyLgtmCarryOver --
export type LgtmCarryOverResult =
  | { outcome: "no_pin" }
  | { outcome: "already_current"; pin: LocalLgtmPin }
  | { outcome: "carried"; pin: LocalLgtmPin }
  | { outcome: "re_review_requested"; round: number; reason: "patch_id_mismatch" | "patch_id_unavailable" };

async function publishedPatchIdOrUndefined(input: {
  git: PatchIdProcessRunner;
  cwd: string;
  baseRef: string;
  head: string;
  env?: Record<string, string | undefined>;
}): Promise<ChangesetPatchId | undefined> {
  try {
    return await computeChangesetPatchId({
      run: input.git,
      cwd: input.cwd,
      baseRef: input.baseRef,
      head: input.head,
      ...(input.env === undefined ? {} : { env: input.env }),
    });
  } catch (error) {
    if (error instanceof PatchIdError) return undefined;
    throw error;
  }
}

/**
 * After the gate publishes a (possibly rebased) head, decide the fate of the
 * local lgtm by D3 patch-id equivalence:
 * - published head equals the pinned sha -> nothing to do;
 * - same whole-range patch-id -> re-pin the lgtm to the published head;
 * - different or uncomputable patch-id -> journal lgtm_stale and request the
 *   next local review round. The changed changeset routes back to the local
 *   review loop (the code-1-style path), never to needs_human.
 */
export async function applyLgtmCarryOver(input: {
  git: PatchIdProcessRunner;
  cwd: string;
  runDir: string;
  baseRef: string;
  publishedSha: string;
  env?: Record<string, string | undefined>;
}): Promise<LgtmCarryOverResult> {
  const events = readEvents(input.runDir);
  const pin = livePinnedLocalLgtm(events);
  if (pin === undefined) return { outcome: "no_pin" };
  if (pin.sha === input.publishedSha) return { outcome: "already_current", pin };

  const patchIdInput = {
    git: input.git,
    cwd: input.cwd,
    baseRef: input.baseRef,
    ...(input.env === undefined ? {} : { env: input.env }),
  };
  const published = await publishedPatchIdOrUndefined({ ...patchIdInput, head: input.publishedSha });
  const reviewed: Pick<ChangesetPatchId, "patchId"> | undefined =
    pin.patchId !== undefined
      ? { patchId: pin.patchId }
      : await publishedPatchIdOrUndefined({ ...patchIdInput, head: pin.sha });

  if (published !== undefined && reviewed !== undefined && patchIdEquals(reviewed, published)) {
    appendEvent(input.runDir, "lgtm", {
      sha: input.publishedSha,
      ...(published.patchId === undefined ? {} : { patch_id: published.patchId }),
      carried_from: pin.sha,
      source: "patch_id_carry_over",
    });
    return {
      outcome: "carried",
      pin: {
        sha: input.publishedSha,
        ...(published.patchId === undefined ? {} : { patchId: published.patchId }),
      },
    };
  }

  const reason = published === undefined || reviewed === undefined
    ? ("patch_id_unavailable" as const)
    : ("patch_id_mismatch" as const);
  const round = nextLocalReviewRound(events);
  appendEvents(input.runDir, [
    {
      event: "lgtm_stale",
      payload: { old_sha: pin.sha, new_sha: input.publishedSha, reason },
    },
    {
      event: "local_review_requested",
      payload: { round, sha: input.publishedSha, reason: "lgtm_carry_over" },
    },
  ]);
  return { outcome: "re_review_requested", round, reason };
}
// -/ 3/4

// -- 4/4 CORE · capsuleReadyAgreement --
export interface CapsuleReadyDecision {
  ready: boolean;
  blockers: string[];
}

function gateLegHolds(events: ComboEvent[], headSha: string): boolean {
  const status = latestGateStatus(events);
  if (status?.state === "fix_inflight" || status?.state === "failed" || status?.state === "awaiting_approval") {
    return false;
  }
  return shaMatchesHead(latestPublishedGateSha(events), headSha);
}

function lgtmLegHolds(pin: LocalLgtmPin | undefined, headSha: string, headPatchId: string | undefined): boolean {
  if (pin === undefined) return false;
  if (pin.sha === headSha) return true;
  return (
    pin.patchId !== undefined &&
    headPatchId !== undefined &&
    patchIdEquals({ patchId: pin.patchId }, { patchId: headPatchId })
  );
}

/**
 * The capsule-run READY agreement: deterministic, journal-fed, no LLM
 * consultation, no GitHub-login pinning. All four legs must agree on the
 * current head:
 * 1. the gate validated the published head and is not in a blocking state;
 * 2. the local lgtm holds at head by sha or by patch-id equivalence;
 * 3. the check rollup and every required READY check are green;
 * 4. the findings-aware external review evidence is clean (#295 slice B:
 *    a SUCCESS check alone is not review evidence).
 */
export function capsuleReadyAgreement(input: {
  events: ComboEvent[];
  headSha: string;
  headPatchId?: string;
  statusCheckRollup?: unknown[];
  requiredCheckNames: string[];
  ambientCheckNames: string[];
  externalEvidence: Pick<ExternalReviewEvidence, "state">;
}): CapsuleReadyDecision {
  const blockers: string[] = [];
  if (!gateLegHolds(input.events, input.headSha)) {
    blockers.push(`gate has not validated head ${input.headSha} or is in a blocking state`);
  }
  const pin = livePinnedLocalLgtm(input.events);
  if (!lgtmLegHolds(pin, input.headSha, input.headPatchId)) {
    blockers.push(`no live local lgtm holds at head ${input.headSha} by sha or patch-id`);
  }
  if (
    !checkRollupSucceeded(input.statusCheckRollup, {
      requiredCheckNames: input.requiredCheckNames,
      ambientCheckNames: input.ambientCheckNames,
    })
  ) {
    blockers.push("check rollup is not green for the current head");
  } else if (!requiredChecksSucceeded(input.statusCheckRollup, input.requiredCheckNames)) {
    blockers.push("a required READY check is missing or not SUCCESS");
  }
  if (!externalReviewEvidenceClean(input.externalEvidence)) {
    blockers.push(`external review evidence is ${input.externalEvidence.state}, not clean`);
  }
  return { ready: blockers.length === 0, blockers };
}
// -/ 4/4
