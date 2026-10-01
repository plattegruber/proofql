/**
 * Cell-value parsers for the CSV import (issue #38): ratings and dates in
 * the shapes vendor exports actually use, plus the SHA-1 used to mint an
 * `external_id` for exports that carry none. Pure, synchronous, no I/O —
 * the mapping step runs them in the browser for the live preview and the
 * import runs the same code on Workers, so they must agree to the byte.
 */

// ---------------------------------------------------------------------------
// Ratings
// ---------------------------------------------------------------------------

const RATING_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  "1": 1,
  "2": 2,
  "3": 3,
  "4": 4,
  "5": 5,
};

/**
 * `"5"`, `"5.0"`, `"4.5"` (rounded half up), `"5/5"`, `"8/10"` (rescaled),
 * `"★★★★☆"`, `"5 stars"`, `"5 out of 5"`, `"FIVE"` (Google Takeout's
 * `starRating`). Returns an integer 1–5, or `null` when the cell is not a
 * rating. An empty cell is `null` too — callers decide whether that is
 * allowed (it is: unrated reviews are a real thing).
 */
export function parseRating(raw: string): number | null {
  const value = raw.trim();
  if (value === "") return null;

  // Star glyphs: count the filled ones.
  if (/^[★☆⭐✩✭✮✯*]+$/.test(value)) {
    const filled = (value.match(/[★⭐✭*]/g) ?? []).length;
    return clampRating(filled);
  }

  const lower = value.toLowerCase();
  const word = RATING_WORDS[lower.replace(/[\s_-]*stars?$/, "")];
  if (word !== undefined) return clampRating(word);

  // "4/5", "8 / 10", "4 out of 5", "4.5 of 5"
  const fraction =
    /^(\d+(?:[.,]\d+)?)\s*(?:\/|out of|of)\s*(\d+(?:\.\d+)?)/.exec(lower);
  if (fraction) {
    const num = Number(fraction[1]?.replace(",", "."));
    const den = Number(fraction[2]);
    if (!Number.isFinite(num) || !Number.isFinite(den) || den <= 0) return null;
    return clampRating(Math.round((num / den) * 5));
  }

  // "4", "4.0", "4,5", "4.5 stars", "Rated 4"
  const numeric =
    /^(?:rated\s*)?(\d+(?:[.,]\d+)?)(?:\s*(?:stars?|\/5|★))?$/.exec(lower);
  if (numeric) {
    const n = Number(numeric[1]?.replace(",", "."));
    if (!Number.isFinite(n)) return null;
    // 10-point scales show up as "8.5"/"10"; anything above 5 rescales.
    const scaled = n > 5 && n <= 10 ? n / 2 : n;
    return clampRating(Math.round(scaled));
  }

  return null;
}

function clampRating(n: number): number | null {
  if (!Number.isFinite(n) || n < 1 || n > 5) return null;
  return n;
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

const ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?\s*(Z|z|UTC|[+-]\d{2}(?::?\d{2})?)?)?$/;
const US_RE =
  /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})(?:[ ,T]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]\.?m\.?)?)?$/i;
const EU_DOTTED_RE = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/;
const WORDY_RE =
  /^(?:[a-z]+,?\s+)?([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})(?:,?\s+(?:at\s+)?(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]\.?m\.?)?)?$/i;
const WORDY_DAY_FIRST_RE =
  /^(\d{1,2})\.?\s+([a-z]{3,9})\.?,?\s+(\d{4})(?:,?\s+(?:at\s+)?(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/i;

/**
 * Parse a date cell to a canonical UTC ISO string (`2026-03-14T18:20:00.000Z`).
 *
 * Accepted: ISO 8601 (date only, or date-time with/without zone), US
 * `m/d/y` and `m/d/yy` (with optional time, optional am/pm), dotted
 * `d.m.yyyy`, `Jan 5, 2026` / `January 5th 2026 at 3:04 PM` /
 * `5 Jan 2026`, epoch seconds (10 digits) and milliseconds (13 digits).
 * Values without zone information are read as UTC: an export carries no
 * zone and a stable instant beats a server-local one. Returns `null` for
 * anything else, including impossible calendar dates (Feb 30).
 */
export function parseDate(raw: string): string | null {
  const value = raw.trim();
  if (value === "") return null;

  if (/^\d{13}$/.test(value)) return fromMs(Number(value));
  if (/^\d{9,10}$/.test(value)) return fromMs(Number(value) * 1000);

  let m = ISO_RE.exec(value);
  if (m) {
    const [, y, mo, d, h, mi, s, frac, zone] = m;
    const date = utc(
      Number(y),
      Number(mo),
      Number(d),
      Number(h ?? 0),
      Number(mi ?? 0),
      Number(s ?? 0),
      frac ? Math.round(Number(`0.${frac}`) * 1000) : 0,
    );
    if (date === null) return null;
    return applyZone(date, zone);
  }

  m = US_RE.exec(value);
  if (m) {
    const [, mo, d, y, h, mi, s, ampm] = m;
    const year = Number(y) < 100 ? 2000 + Number(y) : Number(y);
    const date = utc(
      year,
      Number(mo),
      Number(d),
      hour(h, ampm),
      Number(mi ?? 0),
      Number(s ?? 0),
    );
    return date?.toISOString() ?? null;
  }

  m = EU_DOTTED_RE.exec(value);
  if (m) {
    const [, d, mo, y] = m;
    return utc(Number(y), Number(mo), Number(d))?.toISOString() ?? null;
  }

  m = WORDY_RE.exec(value);
  if (m) {
    const [, monthName, d, y, h, mi, s, ampm] = m;
    const month = MONTHS[(monthName ?? "").toLowerCase()];
    if (month === undefined) return null;
    const date = utc(
      Number(y),
      month,
      Number(d),
      hour(h, ampm),
      Number(mi ?? 0),
      Number(s ?? 0),
    );
    return date?.toISOString() ?? null;
  }

  m = WORDY_DAY_FIRST_RE.exec(value);
  if (m) {
    const [, d, monthName, y, h, mi, s] = m;
    const month = MONTHS[(monthName ?? "").toLowerCase()];
    if (month === undefined) return null;
    const date = utc(
      Number(y),
      month,
      Number(d),
      Number(h ?? 0),
      Number(mi ?? 0),
      Number(s ?? 0),
    );
    return date?.toISOString() ?? null;
  }

  return null;
}

function hour(h: string | undefined, ampm: string | undefined): number {
  let n = Number(h ?? 0);
  if (ampm) {
    const pm = ampm.toLowerCase().startsWith("p");
    if (n === 12) n = pm ? 12 : 0;
    else if (pm) n += 12;
  }
  return n;
}

function fromMs(ms: number): string | null {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return null;
  // Plausibility window: 1990–2100. Anything else is a row id, not a date.
  const y = date.getUTCFullYear();
  return y >= 1990 && y <= 2100 ? date.toISOString() : null;
}

function utc(
  year: number,
  month: number,
  day: number,
  h = 0,
  mi = 0,
  s = 0,
  ms = 0,
): Date | null {
  if (h > 23 || mi > 59 || s > 60) return null;
  const date = new Date(Date.UTC(year, month - 1, day, h, mi, s, ms));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}

function applyZone(date: Date, zone: string | undefined): string {
  if (zone === undefined || /^(z|utc)$/i.test(zone)) return date.toISOString();
  const m = /^([+-])(\d{2}):?(\d{2})?$/.exec(zone);
  if (!m) return date.toISOString();
  const sign = m[1] === "-" ? -1 : 1;
  const offsetMinutes = sign * (Number(m[2]) * 60 + Number(m[3] ?? 0));
  return new Date(date.getTime() - offsetMinutes * 60_000).toISOString();
}

// ---------------------------------------------------------------------------
// SHA-1 (synchronous)
// ---------------------------------------------------------------------------

/**
 * Hex SHA-1 of a UTF-8 string. Synchronous on purpose: `normalizeRow` must
 * stay synchronous so the mapping preview can validate rows as the user
 * changes a select. SHA-1 is an identity here, not a security boundary —
 * the fallback `external_id` only has to be stable across re-imports of
 * the same export.
 */
export function sha1Hex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const length = bytes.length;
  const padded = new Uint8Array((((length + 8) >> 6) << 6) + 64);
  padded.set(bytes);
  padded[length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 4, (length * 8) >>> 0);
  view.setUint32(padded.length - 8, Math.floor((length * 8) / 0x100000000));

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 80; i++) {
      const x =
        (w[i - 3] as number) ^
        (w[i - 8] as number) ^
        (w[i - 14] as number) ^
        (w[i - 16] as number);
      w[i] = (x << 1) | (x >>> 31);
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let i = 0; i < 80; i++) {
      let f: number;
      let k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const temp =
        (((a << 5) | (a >>> 27)) + f + e + k + (w[i] as number)) >>> 0;
      e = d;
      d = c;
      c = (b << 30) | (b >>> 2);
      b = a;
      a = temp;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }
  return [h0, h1, h2, h3, h4]
    .map((n) => n.toString(16).padStart(8, "0"))
    .join("");
}
