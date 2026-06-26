/**
 * @overview Unit tests for post-update daemon and runner refresh reporting.
 *   ~180 lines, no exports, pins no-op, daemon refresh, and failure behavior.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at refreshPostUpdateLocalState tests <- decision matrix.
 *   2. Helpers build active/idle detector fixtures.
 *
 *   MAIN FLOW
 *   ---------
 *   active-runtime detection -> refreshPostUpdateLocalState -> explicit operator lines
 *
 * @exports none
 * @deps vitest, ../core/active-runtime, ./update-refresh
 */
import { describe, expect, it } from "vitest";

import type { ActiveComboRuntimeDetection } from "../core/active-runtime.js";
import { refreshPostUpdateLocalState } from "./update-refresh.js";

// -- 1/2 CORE · refreshPostUpdateLocalState decision matrix <- START HERE --
describe("refreshPostUpdateLocalState", () => {
  it("reports an idle no-op without touching the daemon", () => {
    const commands: string[][] = [];

    const result = refreshPostUpdateLocalState({
      detection: idleDetection(),
      noMistakes: (args) => {
        commands.push(args);
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    expect(commands).toEqual([]);
    expect(result).toEqual({
      ok: true,
      attemptedDaemonRefresh: false,
      lines: ["post-update refresh: no active combo runtime detected; no daemon or runner refresh needed"],
    });
  });

  it("refreshes the no-mistakes daemon and leaves live combo runners under human control", () => {
    const commands: string[][] = [];

    const result = refreshPostUpdateLocalState({
      detection: activeDetection("o-r-7\u061c\n$(touch .tmp/update-refresh-pwn)"),
      noMistakes: (args) => {
        commands.push(args);
        return { status: 0, stdout: "daemon: running\n", stderr: "" };
      },
    });

    expect(commands).toEqual([["daemon", "start"]]);
    expect(result.ok).toBe(true);
    expect(result.attemptedDaemonRefresh).toBe(true);
    expect(result.lines).toEqual([
      "post-update refresh: no-mistakes daemon refreshed with no-mistakes daemon start",
      "post-update refresh: live combo runners unchanged: o-r-7 $(touch .tmp/update-refresh-pwn)",
      "post-update refresh: manual runner refresh remains human-controlled; use combo-chen park -n <combo-id> then combo-chen resume -n <combo-id>",
    ]);
    expect(result.lines.every((line) => !line.includes("\n"))).toBe(true);
    expect(result.lines.join("\n")).not.toMatch(/[\u061c\u200e\u200f\u2066-\u2069]/u);
  });

  it("keeps shell-looking combo ids out of generated commands", () => {
    const hostileIds = [
      `"quoted"`,
      "`touch .tmp/update-refresh-pwn`",
      "$(touch .tmp/update-refresh-pwn)",
      "line\nbreak",
      "",
      "--leading-dash",
    ];

    for (const comboId of hostileIds) {
      const commands: string[][] = [];
      const result = refreshPostUpdateLocalState({
        detection: activeDetection(comboId),
        noMistakes: (args) => {
          commands.push(args);
          return { status: 0, stdout: "daemon: running\n", stderr: "" };
        },
      });

      expect(commands).toEqual([["daemon", "start"]]);
      expect(result.lines.every((line) => !line.includes("\n"))).toBe(true);
      expect(result.lines.at(-1)).toBe(
        "post-update refresh: manual runner refresh remains human-controlled; use combo-chen park -n <combo-id> then combo-chen resume -n <combo-id>",
      );
    }
  });

  it("reports daemon refresh failures without throwing", () => {
    const result = refreshPostUpdateLocalState({
      detection: activeDetection("o-r-7"),
      noMistakes: () => ({ status: 1, stdout: "", stderr: "permission denied\n" }),
    });

    expect(result).toEqual({
      ok: false,
      attemptedDaemonRefresh: true,
      lines: [
        "post-update refresh failed: no-mistakes daemon start failed: permission denied",
        "post-update refresh: installed target remains replaced; manual recovery: no-mistakes daemon start",
        "post-update refresh: live combo runners unchanged: o-r-7",
        "post-update refresh: manual runner refresh remains human-controlled; use combo-chen park -n <combo-id> then combo-chen resume -n <combo-id>",
      ],
    });
  });

  it("treats uncertain runtime state as an explicit no-op", () => {
    const commands: string[][] = [];

    const result = refreshPostUpdateLocalState({
      detection: {
        ...idleDetection(),
        status: "stale",
        staleCombos: [
          {
            comboId: "orphaned",
            runDir: "/combo/runs/orphaned",
            reason: "missing_combo_record",
            message: "run directory has no combo.json",
          },
        ],
      },
      noMistakes: (args) => {
        commands.push(args);
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    expect(commands).toEqual([]);
    expect(result).toEqual({
      ok: true,
      attemptedDaemonRefresh: false,
      lines: [
        "post-update refresh: runtime state uncertain (1 stale run, 0 detection errors); no daemon or runner refresh attempted",
      ],
    });
  });
});
// -/ 1/2

// -- 2/2 HELPER · detector fixtures --
function idleDetection(): ActiveComboRuntimeDetection {
  return {
    status: "idle",
    active: false,
    comboIds: [],
    inspectedRunDirs: [],
    activeCombos: [],
    staleCombos: [],
    errors: [],
  };
}

function activeDetection(comboId: string): ActiveComboRuntimeDetection {
  return {
    status: "active",
    active: true,
    comboIds: [comboId],
    inspectedRunDirs: ["/combo/runs/o-r-7"],
    activeCombos: [
      {
        comboId,
        runDir: "/combo/runs/o-r-7",
        phase: "REVIEWING",
        needsHuman: false,
        branch: "combo/issue-7",
        worktree: "/repo/.worktrees/issue-7",
        tmuxSession: "combo-chen-o-r-7",
        repoDir: "/repo",
        roleWindows: { coder: "coder", gatekeeper: "gatekeeper", directorWatch: "director-watch" },
        createdAt: "2026-06-25T10:00:00.000Z",
        updatedAt: "2026-06-25T10:05:00.000Z",
        lastEvent: "pr_opened",
      },
    ],
    staleCombos: [],
    errors: [],
  };
}
// -/ 2/2
