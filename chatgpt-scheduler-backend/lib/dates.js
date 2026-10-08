// Date/time helpers.
// One canonical format is used everywhere: "YYYY-MM-DDTHH:mm:ss" as wall-clock time in an
// IANA time zone (e.g. "America/Los_Angeles"). That is exactly what Google Calendar expects
// in `start.dateTime` / `end.dateTime` together with `timeZone`.

const DEFAULT_TIME_ZONE = "America/Los_Angeles";

// "2026-10-08", "2026-10-08T19:00", "2026-10-08 19:00:00", "2026-10-08T19:00:00.000"
const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/;
// Ends with "Z", "+08:00", "-0700"…
const OFFSET_RE = /(?:Z|[+-]\d{2}:?\d{2})$/i;
// IANA "Area/City" names or UTC only. Rejects offsets like "+08:00" (Google doesn't accept them)
// and abbreviations like "PST"/"EST", which are ambiguous (Intl maps "EST" to Panama, no DST).
const TZ_NAME_RE = /^(?:UTC|[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)+)$/i;

const pad = (n) => String(n).padStart(2, "0");

/** Returns the canonical IANA name ("us/pacific" -> "America/Los_Angeles"), or null if invalid. */
function canonicalTimeZone(tz) {
  if (typeof tz !== "string" || !TZ_NAME_RE.test(tz.trim())) return null;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: tz.trim() }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/** Wall-clock time of an instant in a time zone, as "YYYY-MM-DDTHH:mm:ss". */
function wallTimeIn(date, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(date).map((p) => [p.type, p.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}

const nowIn = (timeZone, now = new Date()) => wallTimeIn(now, timeZone);

/**
 * Parses the many shapes an AI or client may send into the canonical format.
 * Returns { value, dateOnly } or null if it can't be understood.
 * Times with a UTC offset are converted to wall-clock time in `timeZone`.
 */
function normalizeDateTime(input, timeZone) {
  if (typeof input !== "string") return null;
  const value = input.trim();

  if (OFFSET_RE.test(value)) {
    const date = new Date(value);
    return isNaN(date) ? null : { value: wallTimeIn(date, timeZone), dateOnly: false };
  }

  const m = value.match(LOCAL_RE);
  if (!m) return null;
  const [, y, mo, d, h = "00", mi = "00", s = "00"] = m;
  // Reject impossible dates such as 2026-02-30 or 25:00.
  const check = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
  if (
    check.getUTCFullYear() !== +y || check.getUTCMonth() !== +mo - 1 || check.getUTCDate() !== +d ||
    check.getUTCHours() !== +h || check.getUTCMinutes() !== +mi || check.getUTCSeconds() !== +s
  ) return null;

  return { value: `${y}-${mo}-${d}T${h}:${mi}:${s}`, dateOnly: m[4] === undefined };
}

/** Adds minutes to a canonical wall-clock time (calendar arithmetic, no time zone involved). */
function addMinutes(local, minutes) {
  const [date, time] = local.split("T");
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi, s] = time.split(":").map(Number);
  const t = new Date(Date.UTC(y, mo - 1, d, h, mi + minutes, s));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}T${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}`;
}

/** Human-friendly "Wed, Oct 7, 2026, 6:30 PM" for prompts. */
function describeNow(timeZone, now = new Date()) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone, weekday: "short", year: "numeric", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit",
  }).format(now);
}

/**
 * Lenient normalization for AI output: fixes what can be fixed and reports it.
 * Returns { event, warnings }, or { event: null, warnings } when it can't be used.
 */
function normalizeAiEvent(raw, defaultTimeZone) {
  const warnings = [];
  const title = String(raw?.summary || "").trim() || "Untitled";

  let timeZone = canonicalTimeZone(raw?.timeZone);
  if (!timeZone) {
    timeZone = defaultTimeZone;
    if (raw?.timeZone) warnings.push(`"${title}": unknown time zone "${raw.timeZone}", used ${defaultTimeZone}.`);
  }

  const start = normalizeDateTime(raw?.start, timeZone);
  if (!start) {
    warnings.push(`"${title}": couldn't read the start time "${raw?.start}", so it was skipped.`);
    return { event: null, warnings };
  }
  // A date without a time becomes a 9 AM session.
  const startValue = start.dateOnly ? start.value.replace("T00:00:00", "T09:00:00") : start.value;

  const end = normalizeDateTime(raw?.end, timeZone);
  let endValue = end && !end.dateOnly ? end.value : null;
  if (!endValue || endValue <= startValue) {
    if (raw?.end && !(end && end.dateOnly)) warnings.push(`"${title}": end time was missing or before the start, set to 1 hour.`);
    endValue = addMinutes(startValue, 60);
  }

  return {
    event: {
      summary: title,
      description: String(raw?.description || "").trim(),
      start: startValue,
      end: endValue,
      timeZone,
    },
    warnings,
  };
}

/**
 * Strict validation for events the user approved for import (nothing is silently changed).
 * Returns { event } or { error }.
 */
function validateImportEvent(raw) {
  if (!raw || typeof raw !== "object") return { error: "Event must be an object." };
  const summary = String(raw.summary || "").trim();
  if (!summary) return { error: "Title is required." };

  const timeZone = canonicalTimeZone(raw.timeZone);
  if (!timeZone) return { error: `"${raw.timeZone || ""}" is not a valid time zone (use a name like America/Los_Angeles).` };

  const start = normalizeDateTime(raw.start, timeZone);
  const end = normalizeDateTime(raw.end, timeZone);
  if (!start || start.dateOnly) return { error: "Start must be a date and time (YYYY-MM-DDTHH:mm:ss)." };
  if (!end || end.dateOnly) return { error: "End must be a date and time (YYYY-MM-DDTHH:mm:ss)." };
  if (end.value <= start.value) return { error: "End must be after start." };

  return {
    event: { summary, description: String(raw.description || ""), start: start.value, end: end.value, timeZone },
  };
}

module.exports = {
  DEFAULT_TIME_ZONE,
  canonicalTimeZone,
  normalizeDateTime,
  normalizeAiEvent,
  validateImportEvent,
  wallTimeIn,
  nowIn,
  describeNow,
  addMinutes,
};
