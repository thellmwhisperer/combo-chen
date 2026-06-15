function coerceEventFieldValue(value: string): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+$/.test(value)) return Number(value);
  return value;
}

export function parseEventFields(fields: string[]): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const field of fields) {
    const eq = field.indexOf("=");
    if (eq === -1) throw new Error(`--field expects key=value, got "${field}"`);
    payload[field.slice(0, eq)] = coerceEventFieldValue(field.slice(eq + 1));
  }
  return payload;
}
