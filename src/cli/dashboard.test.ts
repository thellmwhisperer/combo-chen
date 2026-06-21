/**
 * @overview Unit tests for the read-only dashboard row model and HTML renderer.
 *   ~180 lines, fixture-driven active/parked/PR/stalled rows.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at describe("dashboard rows") <- core row collection contract.
 *   2. Then render test                     <- static browser artifact shape.
 *   3. Fixture helpers                      <- combo records and fake deps.
 *
 *   MAIN FLOW
 *   ---------
 *   temp combo home -> collectDashboardRows -> renderDashboardHtml
 *
 *   PUBLIC API
 *   ----------
 *   none (test file)
 *
 *   INTERNALS
 *   ---------
 *   writeFixtureCombo, fakeDashboardDeps
 *
 * @exports none
 * @deps vitest, node:{fs,os,path}, ../core/{events,state}, ./dashboard
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { appendEvent } from "../core/events.js";
import { runDirFor, writeCombo, type ComboRecord } from "../core/state.js";
import { collectDashboardRows, renderDashboardHtml, type DashboardDeps } from "./dashboard.js";

// -- 1/2 HELPER · Fixtures --
function home(): string {
  return mkdtempSync(join(tmpdir(), "combo-chen-dashboard-"));
}

function combo(overrides: Partial<ComboRecord> & Pick<ComboRecord, "id" | "createdAt">): ComboRecord {
  const { id, createdAt, ...rest } = overrides;
  const suffix = id.replace(/^o-r-/, "");
  return {
    id,
    issueUrl: `https://github.com/o/r/issues/${suffix}`,
    workItemTitle: `Issue ${suffix}`,
    workItemSourceType: "github_issue",
    workItemSourceReference: `https://github.com/o/r/issues/${suffix}`,
    repoDir: "/repos/r",
    worktree: `/repos/r/.worktrees/issue-${suffix}`,
    branch: `combo/issue-${suffix}`,
    tmuxSession: `combo-chen-${id}`,
    createdAt,
    ...rest,
  };
}

function writeFixtureCombo(h: string, record: ComboRecord): string {
  const dir = runDirFor(h, record.id);
  writeCombo(dir, record);
  return dir;
}

function fakeDashboardDeps(): DashboardDeps {
  return {
    env: {},
    tmux: (args) => {
      const target = args[args.indexOf("-t") + 1] ?? "";
      if (args[0] === "has-session") {
        return target.includes("active") || target.includes("pr")
          ? { status: 0, stdout: "", stderr: "" }
          : { status: 1, stdout: "", stderr: "no such session" };
      }
      if (args[0] === "list-windows") {
        return target.includes("pr")
          ? { status: 0, stdout: "coder\ngatekeeper\nreviewer\n", stderr: "" }
          : { status: 0, stdout: "coder\ngatekeeper\n", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    },
    noMistakes: (args, cwd) => {
      expect(args).toEqual(["axi", "status"]);
      if (cwd.endsWith("issue-pr")) {
        return {
          status: 0,
          stdout: [
            "run:",
            "  branch: combo/issue-pr",
            "  status: running",
            "  steps[1]{step,status,findings,duration_ms}:",
            "    ci,running,0,0",
          ].join("\n"),
          stderr: "",
        };
      }
      return { status: 1, stdout: "No active run.\n", stderr: "" };
    },
    gh: () => ({ status: 1, stdout: "", stderr: "GitHub should not be needed for this fixture" }),
  };
}
// -/ 1/2

// -- 2/2 CORE · dashboard rows <- START HERE --
describe("dashboard rows", () => {
  it("collects active, parked, PR-open, and pre-PR stalled rows without mutating journals", () => {
    const h = home();

    const active = combo({ id: "o-r-active", createdAt: "2026-06-21T10:00:00.000Z" });
    const activeDir = writeFixtureCombo(h, active);
    appendEvent(activeDir, "coder_started", {});

    const parked = combo({ id: "o-r-parked", createdAt: "2026-06-21T10:01:00.000Z" });
    const parkedDir = writeFixtureCombo(h, parked);
    appendEvent(parkedDir, "coder_started", {});
    appendEvent(parkedDir, "parked", { by: "operator", summary_path: "/repos/r/.worktrees/issue-parked/park.md" });

    const pr = combo({ id: "o-r-pr", createdAt: "2026-06-21T10:02:00.000Z" });
    const prDir = writeFixtureCombo(h, pr);
    appendEvent(prDir, "gate_started", {});
    appendEvent(prDir, "pr_opened", { url: "https://github.com/o/r/pull/9" });

    const stalled = combo({ id: "o-r-stalled", createdAt: "2026-06-21T10:03:00.000Z" });
    const stalledDir = writeFixtureCombo(h, stalled);
    appendEvent(stalledDir, "gate_started", {});
    appendEvent(stalledDir, "gate_failed", { exit_code: 1 });

    const rows = collectDashboardRows(h, fakeDashboardDeps());

    expect(rows).toHaveLength(4);
    expect(rows.map((row) => row.comboId)).toEqual(["o-r-active", "o-r-parked", "o-r-pr", "o-r-stalled"]);
    expect(rows[0]).toMatchObject({
      comboId: "o-r-active",
      phase: "CODING",
      parked: false,
      lastEvent: { event: "coder_started" },
      tmux: { session: "combo-chen-o-r-active", exists: true, windows: ["coder", "gatekeeper"] },
    });
    expect(rows[1]).toMatchObject({
      comboId: "o-r-parked",
      parked: true,
      lastEvent: { event: "parked" },
      tmux: { session: "combo-chen-o-r-parked", exists: false, windows: [] },
    });
    expect(rows[2]).toMatchObject({
      comboId: "o-r-pr",
      phase: "REVIEWING",
      prUrl: "https://github.com/o/r/pull/9",
      downstreamStatus: "no-mistakes running ci",
      tmux: { exists: true, windows: ["coder", "gatekeeper", "reviewer"] },
    });
    expect(rows[3]).toMatchObject({
      comboId: "o-r-stalled",
      phase: "STALLED",
      needsHumanReason: "gate_failed",
      prUrl: undefined,
      tmux: { exists: false },
    });
  });

  it("renders a browser-readable static HTML table with escaped row values", () => {
    const html = renderDashboardHtml([
      {
        comboId: "combo-1",
        workItem: { sourceType: "github_issue", label: "Fix <unsafe> (github_issue:https://github.com/o/r/issues/1)" },
        phase: "CODING",
        parked: false,
        prUrl: undefined,
        needsHumanReason: undefined,
        downstreamStatus: "no-mistakes unavailable: <offline>",
        lastEvent: { event: "coder_started", t: "2026-06-21T10:00:00.000Z" },
        tmux: { session: "combo-chen-combo-1", exists: true, windows: ["coder"] },
      },
    ], { generatedAt: "2026-06-21T10:05:00.000Z" });

    expect(html).toContain("<!doctype html>");
    expect(html).toContain("<title>combo-chen dashboard</title>");
    expect(html).toContain("<th>combo</th>");
    expect(html).toContain("Fix &lt;unsafe&gt;");
    expect(html).toContain("no-mistakes unavailable: &lt;offline&gt;");
    expect(html).toContain("combo-chen-combo-1");
  });
});
// -/ 2/2
