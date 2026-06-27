/**
 * @overview Shared display helpers for sanitizing combo tokens and formatting active combo lists.
 *   ~45 lines, 2 exports, keeps bidirectional-char stripping and fallback logic in one place.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at sanitizeToken <- shared bidirectional-char stripper.
 *   2. Then formatComboList  <- shared active combo list formatter (with or without phase).
 *
 *   PUBLIC API
 *   ----------
 *   sanitizeToken  Strip bidirectional control chars, return trimmed single-line or "unknown".
 *   formatComboList Format active combo IDs from a runtime detection, optionally with phase.
 *
 * @exports sanitizeToken, formatComboList
 * @deps ../core/active-runtime
 */
import type { ActiveComboRuntimeDetection } from "../core/active-runtime.js";

export function sanitizeToken(value: string): string {
  const singleLine = value
    .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]+/g, " ")
    .trim();
  return singleLine.length > 0 ? singleLine : "unknown";
}

// -- 1/1 CORE · formatComboList <- START HERE --
export function formatComboList(detection: ActiveComboRuntimeDetection, withPhase: boolean): string {
  if (withPhase) {
    const activeCombos = detection.activeCombos.map(
      (combo) => `${sanitizeToken(combo.comboId)}(${sanitizeToken(combo.phase)})`,
    );
    if (activeCombos.length > 0) return activeCombos.join(", ");
  } else {
    const comboIds = detection.activeCombos.map((combo) => sanitizeToken(combo.comboId));
    if (comboIds.length > 0) return comboIds.join(", ");
  }
  if (detection.comboIds.length > 0) {
    return detection.comboIds.map(sanitizeToken).join(", ");
  }
  return "unknown";
}
// -/ 1/1
