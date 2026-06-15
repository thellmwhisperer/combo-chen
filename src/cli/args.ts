/**
 * @overview CLI argument helpers — ~45 lines, 1 export, emit payload parsing.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at parseEventFields      <- converts repeated --field key=value args.
 *   2. coerceEventFieldValue          <- scalar coercion rules.
 *
 *   MAIN FLOW
 *   ---------
 *   parseEventFields -> coerceEventFieldValue -> event payload object
 *
 *   PUBLIC API
 *   ----------
 *   parseEventFields     Parse command-line event fields into a payload object.
 *
 *   INTERNALS
 *   ---------
 *   coerceEventFieldValue
 *
 * @exports parseEventFields
 * @deps none
 */

// -- 1/2 HELPER · Scalar coercion --
function coerceEventFieldValue(value: string): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return value;
}
// -/ 1/2

// -- 2/2 CORE · parseEventFields <- START HERE --
export function parseEventFields(fields: string[]): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const field of fields) {
    const eq = field.indexOf("=");
    if (eq === -1) throw new Error(`--field expects key=value, got "${field}"`);
    payload[field.slice(0, eq)] = coerceEventFieldValue(field.slice(eq + 1));
  }
  return payload;
}
// -/ 2/2
