/**
 * @overview Whole-range changeset patch-id primitive (captain decision D3 for
 *   the v1 READY contract): equivalence is `git patch-id --stable` over the
 *   complete base..head diff, never per-commit. A pure gate rebase preserves
 *   the id, so a local lgtm carries over; gate-added autofix commits change
 *   the changeset and correctly break it. ~110 lines, injected process runner
 *   keeps core spawn-free (gh-api precedent).
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at computeChangesetPatchId <- the resolution rules, in order.
 *   2. Then patchIdEquals               <- equivalence incl. empty changesets.
 *
 *   MAIN FLOW
 *   ---------
 *   rev-parse --verify head^{commit} -> merge-base baseRef head
 *     -> git diff base head | git patch-id --stable -> {base, head, patchId}
 *
 *   PUBLIC API
 *   ----------
 *   PatchIdError             Thrown when a range cannot be resolved or diffed.
 *   PatchIdProcessRequest    Injected process invocation shape.
 *   PatchIdProcessResult     Injected process outcome shape.
 *   PatchIdProcessRunner     Async runner; app/gate's GateProcessRunner satisfies it.
 *   ChangesetPatchId         Resolved {base, head, patchId}; undefined id = empty diff.
 *   computeChangesetPatchId  Resolve the range and compute its stable patch-id.
 *   patchIdEquals            D3 equivalence over two computed patch-ids.
 *
 *   INTERNALS
 *   ---------
 *   requireProcess
 *
 * @exports PatchIdError, PatchIdProcessRequest, PatchIdProcessResult, PatchIdProcessRunner, ChangesetPatchId, computeChangesetPatchId, patchIdEquals
 * @deps ./shell-quote
 */
import { shellQuote } from "./shell-quote.js";

// -- 1/2 CORE · computeChangesetPatchId <- START HERE --
export class PatchIdError extends Error {}

export interface PatchIdProcessRequest {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string | undefined>;
}

export interface PatchIdProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type PatchIdProcessRunner = (request: PatchIdProcessRequest) => Promise<PatchIdProcessResult>;

/**
 * A resolved changeset range. `patchId` is undefined when base..head has an
 * empty diff (git patch-id emits nothing for empty input).
 */
export interface ChangesetPatchId {
  base: string;
  head: string;
  patchId: string | undefined;
}

async function requireProcess(
  run: PatchIdProcessRunner,
  request: PatchIdProcessRequest,
  defect: string,
): Promise<string> {
  const result = await run(request);
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new PatchIdError(detail === "" ? defect : `${defect}: ${detail}`);
  }
  return result.stdout;
}

/**
 * Resolution rules, in order:
 * 1. head must resolve to a commit (`rev-parse --verify <head>^{commit}`);
 * 2. base is `merge-base <baseRef> <resolved head>` — the range is always
 *    anchored at the fork point, so an advanced baseRef never drags unrelated
 *    base commits into the diff;
 * 3. the id is `git patch-id --stable` over the whole `git diff base head`.
 */
export async function computeChangesetPatchId(input: {
  run: PatchIdProcessRunner;
  cwd: string;
  baseRef: string;
  head: string;
  env?: Record<string, string | undefined>;
}): Promise<ChangesetPatchId> {
  const { run, cwd, baseRef, head, env } = input;
  const request = (command: string, args: string[]): PatchIdProcessRequest => ({
    command,
    args,
    cwd,
    ...(env === undefined ? {} : { env }),
  });
  const resolvedHead = (
    await requireProcess(
      run,
      request("git", ["rev-parse", "--verify", `${head}^{commit}`]),
      `unresolvable head "${head}"`,
    )
  ).trim();
  const base = (
    await requireProcess(
      run,
      request("git", ["merge-base", baseRef, resolvedHead]),
      `no merge base between "${baseRef}" and "${resolvedHead}"`,
    )
  ).trim();
  const pipe = `git diff ${shellQuote(base)} ${shellQuote(resolvedHead)} | git patch-id --stable`;
  const output = await requireProcess(
    run,
    request("sh", ["-c", pipe]),
    `patch-id pipe failed for ${base}..${resolvedHead}`,
  );
  const patchId = output.trim().split(/\s+/, 1)[0];
  return { base, head: resolvedHead, patchId: patchId === "" || patchId === undefined ? undefined : patchId };
}
// -/ 1/2

// -- 2/2 CORE · patchIdEquals --
/**
 * D3 equivalence: two changesets are the same iff their whole-range stable
 * patch-ids match. Two empty changesets are trivially equivalent; an empty
 * changeset never matches a non-empty one.
 */
export function patchIdEquals(
  a: Pick<ChangesetPatchId, "patchId">,
  b: Pick<ChangesetPatchId, "patchId">,
): boolean {
  if (a.patchId === undefined || b.patchId === undefined) {
    return a.patchId === undefined && b.patchId === undefined;
  }
  return a.patchId === b.patchId;
}
// -/ 2/2
