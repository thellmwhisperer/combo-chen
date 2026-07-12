/**
 * @overview Live-actor telemetry pure-fold tests. The formatter holds no state;
 *   it folds raw observable facts (gnhf iteration, token counts, commit count,
 *   gate steps) into compact render strings. All functions are pure given
 *   their inputs (time is passed as `now`).
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at token formatting      <- compact human counts.
 *   2. Then coder hint + live line    <- compact + full coder telemetry.
 *   3. Then gate step bar             <- per-step checkmarks + step counter.
 *   4. Then dot train + spinner       <- mock-faithful animation primitives.
 *
 *   MAIN FLOW
 *   ---------
 *   facts -> formatCoderHint / formatCoderLiveLine / formatGateStepBar -> string
 *
 *   PUBLIC API
 *   ----------
 *   None (test file).
 *
 * @exports none
 * @deps ./live-telemetry, vitest
 */
import { describe, expect, it } from "vitest";

import {
  dotTrain,
  formatCoderDetail,
  formatCoderHint,
  formatCoderLiveLine,
  formatGateStepBar,
  formatMmss,
  formatTokenCount,
  spinFrame,
} from "./live-telemetry.js";

// -- 1/5 HELPER · token + time formatting --
describe("formatTokenCount", () => {
  it("formats millions with one decimal", () => {
    expect(formatTokenCount(6_200_000)).toBe("6.2M");
    expect(formatTokenCount(1_000_000)).toBe("1.0M");
  });

  it("formats thousands rounded", () => {
    expect(formatTokenCount(40_000)).toBe("40K");
    expect(formatTokenCount(1_000)).toBe("1K");
  });

  it("formats sub-thousand as the raw number", () => {
    expect(formatTokenCount(500)).toBe("500");
    expect(formatTokenCount(0)).toBe("0");
  });
});

describe("formatMmss", () => {
  it("formats elapsed milliseconds as mm:ss", () => {
    expect(formatMmss(0)).toBe("00:00");
    expect(formatMmss(65_000)).toBe("01:05");
    expect(formatMmss(25 * 60_000 + 25_000)).toBe("25:25");
  });
});
// -/ 1/5

// -- 2/5 CORE · coder hint (compact, for fleet rows) --
describe("formatCoderHint", () => {
  it("joins iteration, tokens, and commits with · separators", () => {
    const hint = formatCoderHint({
      iteration: 3,
      maxIterations: 24,
      inputTokens: 6_200_000,
      outputTokens: 40_000,
      commitCount: 8,
    });
    expect(hint).toBe("iter 3/24 · 6.2M in/40K out · 8 commits");
  });

  it("omits max iterations when not provided", () => {
    const hint = formatCoderHint({ iteration: 3, commitCount: 1 });
    expect(hint).toBe("iter 3 · 1 commit");
  });

  it("uses singular 'commit' for one commit", () => {
    const hint = formatCoderHint({ commitCount: 1 });
    expect(hint).toBe("1 commit");
  });

  it("uses plural 'commits' for zero or many", () => {
    expect(formatCoderHint({ commitCount: 0 })).toBe("0 commits");
    expect(formatCoderHint({ commitCount: 5 })).toBe("5 commits");
  });

  it("renders tokens with ? when one side is missing", () => {
    const hint = formatCoderHint({ inputTokens: 6_200_000 });
    expect(hint).toBe("6.2M in/? out");
  });

  it("returns undefined when no facts are present", () => {
    expect(formatCoderHint({})).toBeUndefined();
  });
});
// -/ 2/5

// -- 3/5 CORE · coder live line (full, for dive-in) --
describe("formatCoderLiveLine", () => {
  it("combines note, elapsed timer, and full telemetry including last commit", () => {
    const line = formatCoderLiveLine(
      {
        iteration: 3,
        inputTokens: 6_200_000,
        outputTokens: 40_000,
        commitCount: 8,
        lastCommitSubject: "docs(direct-combos): journal-first supervision",
      },
      "coder working",
      25 * 60_000 + 25_000,
    );
    expect(line).toBe(
      "coder working · 25:25 · iter 3 · 6.2M in/40K out · 8 commits · last: docs(direct-combos): journal-first supervision",
    );
  });

  it("omits the last-commit segment when absent", () => {
    const line = formatCoderLiveLine({ iteration: 1, commitCount: 2 }, "coder fixing", 5_000);
    expect(line).toBe("coder fixing · 00:05 · iter 1 · 2 commits");
  });

  it("renders just the note and timer when telemetry is empty", () => {
    const line = formatCoderLiveLine({}, "coder working", 3_000);
    expect(line).toBe("coder working · 00:03");
  });
});

describe("formatCoderDetail", () => {
  it("appends the last commit subject to the compact hint", () => {
    const detail = formatCoderDetail({
      iteration: 3,
      commitCount: 8,
      lastCommitSubject: "docs(direct-combos): journal-first supervision",
    });
    expect(detail).toBe("iter 3 · 8 commits · last: docs(direct-combos): journal-first supervision");
  });

  it("returns just the hint when no last commit subject", () => {
    const detail = formatCoderDetail({ iteration: 1, commitCount: 2 });
    expect(detail).toBe("iter 1 · 2 commits");
  });

  it("returns undefined when no facts are present", () => {
    expect(formatCoderDetail({})).toBeUndefined();
  });
});
// -/ 3/5

// -- 4/5 CORE · gate step bar (per-step checkmarks + step counter) --
describe("formatGateStepBar", () => {
  it("renders done steps with checkmark, live step with spinner, pending dim", () => {
    const bar = formatGateStepBar({
      steps: [
        { name: "review", state: "done" },
        { name: "test", state: "live" },
        { name: "lint", state: "pending" },
      ],
    });
    expect(bar).toContain("review ✓");
    expect(bar).toContain("test");
    expect(bar).toContain("lint");
    expect(bar).toContain("step 2/3");
  });

  it("counts the live step as the current step number", () => {
    const bar = formatGateStepBar({
      steps: [
        { name: "review", state: "done" },
        { name: "test", state: "done" },
        { name: "lint", state: "live" },
      ],
    });
    expect(bar).toContain("step 3/3");
  });

  it("reports the final step when all done", () => {
    const bar = formatGateStepBar({
      steps: [
        { name: "review", state: "done" },
        { name: "test", state: "done" },
      ],
    });
    expect(bar).toContain("step 2/2");
  });

  it("reports step 1 when nothing is done yet", () => {
    const bar = formatGateStepBar({
      steps: [
        { name: "review", state: "pending" },
        { name: "test", state: "pending" },
      ],
    });
    expect(bar).toContain("step 1/2");
  });
});
// -/ 4/5

// -- 5/5 CORE · dot train + spinner (mock-faithful animation primitives) --
describe("dotTrain", () => {
  const START = 1_000_000;
  const DUR = 1_000;
  const CELLS = 5;

  it("places the dot at position 0 at the start of the cycle", () => {
    const train = dotTrain(START, START, DUR, CELLS);
    expect(train).toBe("●····");
  });

  it("advances the dot forward as time progresses (ltr)", () => {
    const train = dotTrain(START + 900, START, DUR, CELLS);
    expect(train).toBe("····●");
  });

  it("wraps around after the cycle duration", () => {
    const train = dotTrain(START + DUR, START, DUR, CELLS);
    expect(train).toBe("●····");
  });

  it("reverses direction when rtl is true", () => {
    const train = dotTrain(START + 900, START, DUR, CELLS, true);
    expect(train).toBe("●····");
  });

  it("uses the mock glyphs (· for empty, ● for the dot)", () => {
    const train = dotTrain(START, START, DUR, CELLS);
    for (const ch of train) {
      expect(ch === "·" || ch === "●").toBe(true);
    }
  });
});

describe("spinFrame", () => {
  it("returns a braille spinner character", () => {
    const frame = spinFrame(0);
    expect(frame).toBe("⠋");
  });

  it("advances through braille frames over time", () => {
    const f0 = spinFrame(0);
    const f1 = spinFrame(120);
    expect(f0).not.toBe(f1);
  });
});
// -/ 5/5
