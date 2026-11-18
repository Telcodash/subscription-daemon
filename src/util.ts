/** Small, dependency-free helpers: ids, calendar dates, deterministic randomness. */

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32

export type IdPrefix = "trf" | "lin";

/** Prefixed ULID (`lin_01JD…`): globally unique, sortable by creation time. */
export function newId(prefix: IdPrefix, timeMs = Date.now(), random: () => number = Math.random): string {
  let time = "";
  let t = Math.floor(timeMs);

  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }

  let rand = "";
  for (let i = 0; i < 16; i++) rand += ALPHABET[Math.floor(random() * 32)];

  return `${prefix}_${time}${rand}`;
}

export const idPattern = (prefix: IdPrefix | "acc" | "cus") => new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`);

// ── Calendar dates ("YYYY-MM-DD"), always handled as UTC midnights to avoid DST drift ──

export type IsoDate = string;

const toDate = (d: IsoDate) => new Date(`${d}T00:00:00Z`);
const fromDate = (d: Date): IsoDate => d.toISOString().slice(0, 10);

export function addDays(date: IsoDate, days: number): IsoDate {
  const d = toDate(date);
  d.setUTCDate(d.getUTCDate() + days);
  return fromDate(d);
}

/** Safe for days 1–28, which is all billing days can be. */
export function addMonths(date: IsoDate, months: number): IsoDate {
  const d = toDate(date);
  d.setUTCMonth(d.getUTCMonth() + months);
  return fromDate(d);
}

export const dayOfMonth = (date: IsoDate): number => toDate(date).getUTCDate();

export function daysBetween(from: IsoDate, to: IsoDate): number {
  return Math.round((toDate(to).getTime() - toDate(from).getTime()) / 864e5);
}

/** Today's calendar date in the business time zone. */
export function today(timeZone: string, now = new Date()): IsoDate {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** Next date (on or after `from`) falling on day-of-month `day`. */
export function nextOccurrence(from: IsoDate, day: number): IsoDate {
  const d = toDate(from);
  if (d.getUTCDate() > day) d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(day);
  return fromDate(d);
}

// ── Deterministic randomness ──

/**
 * A stable number in [0, 1) derived from a string. The billing engine uses it for every
 * "random" outcome, so replaying a day always gives the same invoices and payment results.
 */
export function chance(key: string): number {
  let h = 2166136261; // FNV-1a
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // Final avalanche (murmur3 fmix32) so similar keys spread evenly.
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** A deterministic random stream for one key, e.g. to give an entity a stable id. */
export function seededRandom(key: string): () => number {
  let i = 0;
  return () => chance(`${key}:${i++}`);
}

/** Short stable hex reference from a key, e.g. for fake processor references. */
export const reference = (key: string, length = 12): string =>
  Array.from({ length: Math.ceil(length / 6) }, (_, i) => Math.floor(chance(`${key}#${i}`) * 0xffffff).toString(16).padStart(6, "0"))
    .join("")
    .slice(0, length)
    .toUpperCase();

/** Serialise async work: the daily run must never execute twice at once. */
export function createMutex() {
  let tail: Promise<unknown> = Promise.resolve();

  return <T>(fn: () => Promise<T> | T): Promise<T> => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => undefined);
    return run;
  };
}
