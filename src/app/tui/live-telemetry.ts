/**
 * @overview Live-actor telemetry pure folds: format raw observable facts (gnhf
 *   iteration, token counts, commit count, gate steps) into compact render
 *   strings. Every function is pure given its inputs — time is passed as `now`
 *   so the renderer re-evaluates deterministically on each animation tick. The
 *   renderer holds NO state the run dir + worktree observables cannot provide;
 *   these folds never read files or run commands.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at types                <- CoderTelemetryFact, GateTelemetryFact.
 *   2. Then token + time formatting  <- compact human counts + mm:ss.
 *   3. Then coder hint + live line   <- compact (fleet) + full (dive-in).
 *   4. Then gate step bar            <- per-step checkmarks + step counter.
 *   5. Then dot train + spinner      <- mock-faithful animation primitives.
 *
 *   MAIN FLOW
 *   ---------
 *   facts -> formatCoderHint / formatCoderLiveLine / formatGateStepBar -> string
 *   now -> dotTrain / spinFrame -> animated glyph string
 *
 *   PUBLIC API
 *   ----------
 *   CoderTelemetryFact    Raw coder observables (iteration, tokens, commits).
 *   GateStepFact          One gate step name + done/live/pending state.
 *   GateTelemetryFact     Ordered gate steps for the step bar.
 *   LiveTelemetryFacts    Coder + gate facts bundle.
 *   formatTokenCount      6200000 -> "6.2M".
 *   formatMmss            65000 -> "01:05".
 *   formatCoderHint       Compact coder telemetry for fleet rows.
 *   formatCoderDetail     Coder hint + last commit subject (for dive-in).
 *   formatCoderLiveLine   Full coder line (note · timer · detail).
 *   formatGateStepBar     Per-step checkmarks + "step X/N" counter.
 *   dotTrain              Travelling-dot string (mock dotcontent).
 *   spinFrame             Braille spinner frame for a given now.
 *
 *   INTERNALS
 *   ---------
 *   SPIN_FRAMES.
 *
 * @exports CoderTelemetryFact, GateStepFact, GateTelemetryFact, LiveTelemetryFacts, formatTokenCount, formatMmss, formatCoderHint, formatCoderDetail, formatCoderLiveLine, formatGateStepBar, dotTrain, spinFrame
 * @deps none
 */

// -- 1/5 CORE · types <- START HERE --
export interface CoderTelemetryFact {
  readonly mode?: "gnhf";
  readonly iteration?: number;
  readonly maxIterations?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly commitCount?: number;
  readonly lastCommitSubject?: string;
  readonly currentFile?: string;
}

export interface GateStepFact {
  readonly name: string;
  readonly state: "done" | "live" | "pending";
}

export interface GateTelemetryFact {
  readonly steps: readonly GateStepFact[];
}

export interface LiveTelemetryFacts {
  readonly coder?: CoderTelemetryFact;
  readonly gate?: GateTelemetryFact;
}
// -/ 1/5

// -- 2/5 HELPER · token + time formatting --
export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

export function formatMmss(ms: number): string {
  const secs = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor(secs / 60)).padStart(2, "0");
  const ss = String(secs % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}
// -/ 2/5

// -- 3/5 CORE · coder hint (compact, fleet) + live line (full, dive-in) --
export function formatCoderHint(fact: CoderTelemetryFact): string | undefined {
  const parts: string[] = [];
  if (fact.iteration !== undefined) {
    parts.push(
      fact.maxIterations !== undefined
        ? `iter ${fact.iteration}/${fact.maxIterations}`
        : `iter ${fact.iteration}`,
    );
  }
  if (fact.inputTokens !== undefined || fact.outputTokens !== undefined) {
    const inStr = fact.inputTokens !== undefined ? formatTokenCount(fact.inputTokens) : "?";
    const outStr = fact.outputTokens !== undefined ? formatTokenCount(fact.outputTokens) : "?";
    parts.push(`${inStr} in/${outStr} out`);
  }
  if (fact.commitCount !== undefined) {
    parts.push(`${fact.commitCount} commit${fact.commitCount === 1 ? "" : "s"}`);
  }
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

export function formatCoderLiveLine(fact: CoderTelemetryFact, note: string, sinceMs: number): string {
  const detail = formatCoderDetail(fact);
  const segments = [note, formatMmss(sinceMs)];
  if (detail !== undefined) segments.push(detail);
  return segments.join(" · ");
}

export function formatCoderDetail(fact: CoderTelemetryFact): string | undefined {
  const hint = formatCoderHint(fact);
  if (hint === undefined) return undefined;
  return fact.lastCommitSubject !== undefined ? `${hint} · last: ${fact.lastCommitSubject}` : hint;
}
// -/ 3/5

// -- 4/5 CORE · gate step bar (per-step checkmarks + step counter) --
export function formatGateStepBar(fact: GateTelemetryFact): string {
  const parts = fact.steps.map((step) => {
    if (step.state === "done") return `${step.name} ✓`;
    if (step.state === "live") return `${step.name} ●`;
    return `${step.name} ·`;
  });
  const doneCount = fact.steps.filter((s) => s.state === "done").length;
  const hasLive = fact.steps.some((s) => s.state === "live");
  const current = hasLive ? doneCount + 1 : doneCount;
  const total = fact.steps.length;
  return `${parts.join(" · ")}   step ${Math.max(1, current)}/${total}`;
}
// -/ 4/5

// -- 5/5 CORE · dot train + spinner (mock-faithful animation) --
export function dotTrain(now: number, startMs: number, durMs: number, cells: number, rtl = false): string {
  const f = ((((now - startMs) / durMs) % 1) + 1) % 1;
  let pos = Math.min(cells - 1, Math.floor(f * cells));
  if (rtl) pos = cells - 1 - pos;
  let s = "";
  for (let i = 0; i < cells; i += 1) s += i === pos ? "●" : "·";
  return s;
}

const SPIN_FRAMES = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

export function spinFrame(now: number): string {
  return SPIN_FRAMES[Math.floor(now / 120) % SPIN_FRAMES.length]!;
}
// -/ 5/5
