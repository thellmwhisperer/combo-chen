/**
 * @overview Read-only dashboard rows and static HTML rendering for combo capsules.
 *   ~350 lines, 6 exports, no journal writes.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at collectDashboardRows  <- reads combo records and journals.
 *   2. Then dashboardRowFromFacts     <- maps combo/event/probe facts to a row.
 *   3. Then renderDashboardHtml       <- browser-readable static artifact.
 *
 *   MAIN FLOW
 *   ---------
 *   combo home -> listCombos/readEvents -> tmux/downstream probes -> rows -> HTML
 *
 *   PUBLIC API
 *   ----------
 *   DashboardDeps       Read-only command adapters used by collection.
 *   DashboardTmuxFacts  Session/window facts for one combo.
 *   DashboardEventSummary Last journal event display shape.
 *   DashboardRow        Browser-ready dashboard row shape.
 *   collectDashboardRows Read combo records, journals, tmux, and downstream facts.
 *   renderDashboardHtml Render rows as a standalone static HTML page.
 *
 *   INTERNALS
 *   ---------
 *   collectDashboardTmuxFacts, collectDashboardDownstreamStatus, eventSummary, htmlEscape
 *
 * @exports DashboardDeps, DashboardTmuxFacts, DashboardEventSummary, DashboardRow, collectDashboardRows, renderDashboardHtml
 * @deps ../core/{combo,events,state}, ../infra/{config-snapshot,tmux}, ./status
 */
import { deriveStatus, type Phase } from "../core/combo.js";
import { latestPrUrlFromEvents, readEvents, type ComboEvent } from "../core/events.js";
import {
  describeWorkItem,
  listCombos,
  runDirFor,
  type ComboRecord,
  type WorkItemDescriptor,
} from "../core/state.js";
import { loadRuntimeConfig } from "../infra/config-snapshot.js";
import { hasSessionArgs, listWindowsArgs, type TmuxResult } from "../infra/tmux.js";
import { deepComboStatus, type CommandResult } from "./status.js";

// -- 1/3 HELPER · Public types --
export interface DashboardDeps {
  env?: Record<string, string | undefined>;
  tmux: (args: string[]) => TmuxResult;
  gh: (args: string[]) => CommandResult;
  noMistakes: (args: string[], cwd: string) => CommandResult;
}

export interface DashboardTmuxFacts {
  session: string;
  exists: boolean | "unknown";
  windows: string[];
  detail?: string;
}

export interface DashboardEventSummary {
  event: string;
  t: string;
}

export interface DashboardRow {
  comboId: string;
  workItem: WorkItemDescriptor;
  phase: Phase;
  needsHumanReason: string | undefined;
  prUrl: string | undefined;
  downstreamStatus: string | undefined;
  lastEvent: DashboardEventSummary | undefined;
  tmux: DashboardTmuxFacts;
  parked: boolean;
}

interface DashboardRowFacts {
  combo: ComboRecord;
  events: ComboEvent[];
  tmux: DashboardTmuxFacts;
  downstreamStatus?: string;
}

interface RenderDashboardOptions {
  generatedAt?: string;
}
// -/ 1/3

// -- 2/3 CORE · collectDashboardRows <- START HERE --
export function collectDashboardRows(home: string, deps: DashboardDeps): DashboardRow[] {
  return listCombos(home).map((combo) => {
    const runDir = runDirFor(home, combo.id);
    const events = readEvents(runDir);
    return dashboardRowFromFacts({
      combo,
      events,
      tmux: collectDashboardTmuxFacts(combo, deps),
      downstreamStatus: collectDashboardDownstreamStatus(combo, runDir, events, deps),
    });
  });
}

function dashboardRowFromFacts(facts: DashboardRowFacts): DashboardRow {
  const status = deriveStatus(facts.events);
  return {
    comboId: facts.combo.id,
    workItem: describeWorkItem(facts.combo),
    phase: status.phase,
    needsHumanReason: status.needsHuman ? status.reason ?? "yes" : undefined,
    prUrl: status.pr ?? latestPrUrlFromEvents(facts.events),
    downstreamStatus: facts.downstreamStatus,
    lastEvent: eventSummary(facts.events.at(-1)),
    tmux: facts.tmux,
    parked: isParked(facts.events),
  };
}

function collectDashboardTmuxFacts(combo: ComboRecord, deps: DashboardDeps): DashboardTmuxFacts {
  try {
    const session = deps.tmux(hasSessionArgs(combo.tmuxSession));
    if (session.status !== 0) {
      return {
        session: combo.tmuxSession,
        exists: false,
        windows: [],
        ...optionalDetail(session),
      };
    }

    const listed = deps.tmux(listWindowsArgs(combo.tmuxSession));
    if (listed.status !== 0) {
      return {
        session: combo.tmuxSession,
        exists: true,
        windows: [],
        ...optionalDetail(listed),
      };
    }

    return {
      session: combo.tmuxSession,
      exists: true,
      windows: listed.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0),
    };
  } catch (error) {
    return {
      session: combo.tmuxSession,
      exists: "unknown",
      windows: [],
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function collectDashboardDownstreamStatus(
  combo: ComboRecord,
  runDir: string,
  events: ComboEvent[],
  deps: DashboardDeps,
): string | undefined {
  try {
    const config = loadRuntimeConfig(runDir, { repoDir: combo.repoDir, env: deps.env });
    return deepComboStatus(combo, events, deps.noMistakes, deps.gh, {
      requiredCheckNames: config.readyRequiredChecks,
      ambientCheckNames: config.externalCommentAgents,
      reviewerLogins: config.reviewerLogins,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return `downstream unavailable: ${firstLine(detail)}`;
  }
}

function optionalDetail(result: CommandResult): { detail?: string } {
  const detail = firstLine(result.stderr) || firstLine(result.stdout);
  return detail.length === 0 ? {} : { detail };
}

function firstLine(value: string): string {
  return value.trim().split(/\r?\n/)[0]?.trim() ?? "";
}

function eventSummary(event: ComboEvent | undefined): DashboardEventSummary | undefined {
  return event === undefined ? undefined : { event: event.event, t: event.t };
}

function isParked(events: ComboEvent[]): boolean {
  return events.at(-1)?.event === "parked";
}
// -/ 2/3

// -- 3/3 CORE · renderDashboardHtml --
export function renderDashboardHtml(
  rows: DashboardRow[],
  options: RenderDashboardOptions = {},
): string {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const bodyRows = rows.map(renderRow).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>combo-chen dashboard</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #f7f8fa;
      --fg: #1f2933;
      --muted: #65727f;
      --line: #cfd6dd;
      --header: #e8edf2;
      --surface: #ffffff;
      --accent: #176f75;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #11161b;
        --fg: #e7ecef;
        --muted: #9aa8b5;
        --line: #34414c;
        --header: #1b2730;
        --surface: #141c23;
        --accent: #53b8bd;
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--fg);
      font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    main {
      max-width: 1440px;
      margin: 0 auto;
      padding: 24px;
    }
    header {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: end;
      margin-bottom: 18px;
    }
    h1 {
      margin: 0;
      font-size: 24px;
      letter-spacing: 0;
    }
    .meta {
      color: var(--muted);
      white-space: nowrap;
    }
    .table-wrap {
      overflow-x: auto;
      border: 1px solid var(--line);
      background: var(--surface);
    }
    table {
      width: 100%;
      border-collapse: collapse;
      min-width: 1160px;
    }
    th, td {
      padding: 10px 12px;
      border-bottom: 1px solid var(--line);
      text-align: left;
      vertical-align: top;
    }
    th {
      background: var(--header);
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0;
    }
    tr:last-child td { border-bottom: 0; }
    code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
      font-size: 12px;
    }
    .muted { color: var(--muted); }
    .phase { color: var(--accent); font-weight: 700; }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>combo-chen dashboard</h1>
      <div class="meta">Generated ${htmlEscape(generatedAt)} - ${rows.length} combo${rows.length === 1 ? "" : "s"}</div>
    </header>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>combo</th>
            <th>work item</th>
            <th>phase</th>
            <th>needs human</th>
            <th>PR</th>
            <th>downstream</th>
            <th>last event</th>
            <th>tmux</th>
          </tr>
        </thead>
        <tbody>
${bodyRows || "          <tr><td colspan=\"8\" class=\"muted\">No combos found.</td></tr>"}
        </tbody>
      </table>
    </div>
  </main>
</body>
</html>
`;
}

function renderRow(row: DashboardRow): string {
  const pr = row.prUrl === undefined ? `<span class="muted">none</span>` : link(row.prUrl, row.prUrl);
  const downstream = row.downstreamStatus ?? "none";
  const lastEvent = row.lastEvent === undefined
    ? "none"
    : `${htmlEscape(row.lastEvent.event)} <span class="muted">${htmlEscape(row.lastEvent.t)}</span>`;
  const tmux = [
    `${htmlEscape(row.tmux.session)}: ${row.tmux.exists === true ? "running" : row.tmux.exists === false ? "missing" : "unknown"}`,
    row.tmux.windows.length === 0 ? undefined : `windows ${row.tmux.windows.map(htmlEscape).join(", ")}`,
    row.tmux.detail === undefined ? undefined : htmlEscape(row.tmux.detail),
    row.parked ? "parked" : undefined,
  ].filter((part): part is string => part !== undefined).join("<br>");

  return `          <tr>
            <td><code>${htmlEscape(row.comboId)}</code></td>
            <td>${htmlEscape(row.workItem.label)}</td>
            <td><span class="phase">${htmlEscape(row.phase)}</span></td>
            <td>${htmlEscape(row.needsHumanReason ?? "none")}</td>
            <td>${pr}</td>
            <td>${htmlEscape(downstream)}</td>
            <td>${lastEvent}</td>
            <td>${tmux}</td>
          </tr>`;
}

function link(href: string, label: string): string {
  return `<a href="${htmlEscape(href)}">${htmlEscape(label)}</a>`;
}

function htmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
}
// -/ 3/3
