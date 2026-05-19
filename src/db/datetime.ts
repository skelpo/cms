// @perryts/mysql returns DATETIME/TIMESTAMP columns as structured
// MyDateTime objects ({year, month, day, hour, minute, second,
// microsecond, raw}). Public APIs need ISO 8601 strings. This helper
// normalizes any object that has a `raw` field — both walking nested
// objects on output and inverting for input.

interface MyDateTimeLike {
  raw: string;
}

function isMyDateTime(v: unknown): v is MyDateTimeLike {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as Record<string, unknown>).raw === 'string'
  );
}

/** Convert one MyDateTime to ISO 8601 UTC. Returns null for invalid input. */
export function dateToIso(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') {
    // 'YYYY-MM-DD HH:MM:SS' → ISO
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(v)) {
      return v.replace(' ', 'T') + 'Z';
    }
    return v;
  }
  if (isMyDateTime(v)) {
    const raw = v.raw;
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(raw)) {
      return raw.replace(' ', 'T') + 'Z';
    }
    return raw;
  }
  return null;
}

/**
 * Walk an object recursively, replacing every MyDateTime shape with its
 * ISO string. Returns a new object. Arrays handled; cycles not expected
 * (DB rows don't have them).
 */
export function normalizeDates<T>(input: T): T {
  if (input === null || input === undefined) return input;
  if (Array.isArray(input)) {
    return input.map((v) => normalizeDates(v)) as unknown as T;
  }
  if (typeof input === 'object') {
    if (isMyDateTime(input)) {
      return (dateToIso(input) ?? null) as unknown as T;
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      out[k] = normalizeDates(v);
    }
    return out as T;
  }
  return input;
}
