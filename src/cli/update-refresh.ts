/**
 * @overview Post-update local daemon refresh and live runner reporting.
 *   ~120 lines, 3 exports, keeps automatic refresh narrow and operator output explicit.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at refreshPostUpdateLocalState <- decision matrix for post-install state.
 *   2. Helpers format daemon failures and sanitized combo ids.
 *
 *   MAIN FLOW
 *   ---------
 *   active-runtime detection -> idle/uncertain no-op or no-mistakes daemon start -> runner manual-control lines
 *
 *   PUBLIC API
 *   ----------
 *   PostUpdateRefreshInput    Dependencies and active-runtime facts for the refresh pass.
 *   PostUpdateRefreshResult   Operator-facing refresh outcome.
 *   refreshPostUpdateLocalState  Run safe post-update refresh and return explicit output lines.
 *
 *   INTERNALS
 *   ---------
 *   uncertainRuntimeLine, commandFailureText, plural, errorMessage
 *
 * @exports PostUpdateRefreshInput, PostUpdateRefreshResult, refreshPostUpdateLocalState
 * @deps ../core/active-runtime, ./display
 */
import type { ActiveComboRuntimeDetection } from "../core/active-runtime.js";
import { errorMessage } from "../core/guards.js";
import { formatComboList, sanitizeToken } from "./display.js";

// -- 1/2 HELPER · refresh result contract --
export interface PostUpdateRefreshInput {
  detection: ActiveComboRuntimeDetection;
  noMistakes: (args: string[]) => { status: number; stdout: string; stderr: string };
}

export interface PostUpdateRefreshResult {
  ok: boolean;
  attemptedDaemonRefresh: boolean;
  lines: string[];
}
// -/ 1/2

// -- 2/2 CORE · refreshPostUpdateLocalState <- START HERE --
export function refreshPostUpdateLocalState(input: PostUpdateRefreshInput): PostUpdateRefreshResult {
  if (input.detection.status === "idle") {
    return {
      ok: true,
      attemptedDaemonRefresh: false,
      lines: ["post-update refresh: no active combo runtime detected; no daemon or runner refresh needed"],
    };
  }

  if (input.detection.status !== "active") {
    return {
      ok: true,
      attemptedDaemonRefresh: false,
      lines: [uncertainRuntimeLine(input.detection)],
    };
  }

  const activeLines = [
    `post-update refresh: live combo runners unchanged: ${formatComboList(input.detection, false)}`,
    "post-update refresh: manual runner refresh remains human-controlled; use combo-chen park -n <combo-id> then combo-chen resume -n <combo-id>",
  ];

  try {
    const refreshed = input.noMistakes(["daemon", "start"]);
    if (refreshed.status === 0) {
      return {
        ok: true,
        attemptedDaemonRefresh: true,
        lines: [
          "post-update refresh: no-mistakes daemon refreshed with no-mistakes daemon start",
          ...activeLines,
        ],
      };
    }
    return {
      ok: false,
      attemptedDaemonRefresh: true,
      lines: [
        `post-update refresh failed: no-mistakes daemon start failed: ${commandFailureText(refreshed)}`,
        "post-update refresh: installed target remains replaced; manual recovery: no-mistakes daemon start",
        ...activeLines,
      ],
    };
  } catch (error) {
    return {
      ok: false,
      attemptedDaemonRefresh: true,
      lines: [
        `post-update refresh failed: no-mistakes daemon start failed: ${errorMessage(error)}`,
        "post-update refresh: installed target remains replaced; manual recovery: no-mistakes daemon start",
        ...activeLines,
      ],
    };
  }
}

function uncertainRuntimeLine(detection: ActiveComboRuntimeDetection): string {
  const staleCount = detection.staleCombos.length;
  const errorCount = detection.errors.length;
  return `post-update refresh: runtime state uncertain (${staleCount} ${plural("stale run", staleCount)}, ${errorCount} ${plural("detection error", errorCount)}); no daemon or runner refresh attempted`;
}

function commandFailureText(result: { stdout: string; stderr: string }): string {
  return sanitizeToken(result.stderr.trim() || result.stdout.trim() || "unknown error");
}

function plural(label: string, count: number): string {
  return count === 1 ? label : `${label}s`;
}

// -/ 2/2
