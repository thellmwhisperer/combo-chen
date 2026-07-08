/**
 * @overview Shared display helpers for sanitizing combo tokens and formatting active combo lists.
 *   ~50 lines, 3 exports, keeps bidirectional-char stripping and fallback logic in one place.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at sanitizeToken <- shared bidirectional-char stripper.
 *   2. Then formatComboList  <- shared active combo list formatter (with or without phase).
 *   3. yesNo                 <- canonical boolean-to-"yes"/"no" formatter.
 *
 *   PUBLIC API
 *   ----------
 *   sanitizeToken  Strip bidirectional control chars, return trimmed single-line or "unknown".
 *   formatComboList Format active combo IDs from a runtime detection, optionally with phase.
 *   yesNo          Format a boolean as "yes"/"no" for operator-facing lines.
 *
 * @exports sanitizeToken, formatComboList, yesNo
 * @deps ../core/active-runtime
 */
import type { ActiveComboRuntimeDetection } from "../core/active-runtime.js";

export function sanitizeToken(value: string): string {
  //    Unicode categories: Cc = control chars, Cf = format chars (bidi
  //    overrides, zero-width invisibles). Both are hostile in operator-facing
  //    single-line output.
  const singleLine = value.replace(/[\p{Cc}\p{Cf}]+/gu, " ").trim();
  return singleLine.length > 0 ? singleLine : "unknown";
}

export function yesNo(value: boolean): "yes" | "no" {
  return value ? "yes" : "no";
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
