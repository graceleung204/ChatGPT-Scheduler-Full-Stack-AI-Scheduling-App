// Date/time helpers.
// The API always uses "YYYY-MM-DDTHH:mm:ss" (wall-clock time in an IANA time zone).
// Inside the app we keep "YYYY-MM-DDTHH:mm", the format <input type="datetime-local"> uses.

// The device's time zone (from the OS settings), used as the default everywhere.
export const USER_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Los_Angeles'

// IANA "Area/City" names or UTC only; abbreviations like "PST" are ambiguous and rejected.
const TZ_NAME_RE = /^(?:UTC|[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)+)$/i

export function isValidTimeZone(tz) {
  if (typeof tz !== 'string' || !TZ_NAME_RE.test(tz)) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/** API -> input: "2026-10-08T19:00:00" -> "2026-10-08T19:00" */
export const fromApi = (value) => (typeof value === 'string' ? value.slice(0, 16) : '')
/** input -> API: "2026-10-08T19:00" -> "2026-10-08T19:00:00" */
export const toApi = (value) => (value ? `${value.slice(0, 16)}:00` : '')

/** Current wall-clock time in a time zone, as "YYYY-MM-DDTHH:mm". */
export function nowInTimeZone(timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    })
      .formatToParts(new Date())
      .map((p) => [p.type, p.value])
  )
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`
}

// Reads "YYYY-MM-DDTHH:mm" as plain calendar values (no time zone conversion) for display.
function parseLocal(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value || '')
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5])) : null
}

/** "Wed, Oct 8 · 7:00 PM – 8:30 PM" (adds the end date when it is on another day). */
export function formatRange(start, end) {
  const s = parseLocal(start)
  const e = parseLocal(end)
  if (!s || !e) return 'Set a start and end time'
  const day = (d) => d.toLocaleDateString(undefined, { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' })
  const time = (d) => d.toLocaleTimeString(undefined, { timeZone: 'UTC', hour: 'numeric', minute: '2-digit' })
  const sameDay = start.slice(0, 10) === end.slice(0, 10)
  return `${day(s)} · ${time(s)} – ${sameDay ? '' : `${day(e)} `}${time(e)}`
}

function offsetLabel(timeZone) {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'shortOffset' })
      .formatToParts(new Date())
      .find((p) => p.type === 'timeZoneName')
    return part ? part.value : ''
  } catch {
    return ''
  }
}

/** Time zones grouped by area (America, Europe, Asia…) for the picker, with current UTC offsets. */
export const TIME_ZONE_GROUPS = (() => {
  const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [USER_TIME_ZONE]
  const groups = new Map()
  for (const tz of zones) {
    if (!tz.includes('/')) continue
    const [area, ...rest] = tz.split('/')
    if (!groups.has(area)) groups.set(area, [])
    groups.get(area).push({ value: tz, label: `${rest.join(' / ').replace(/_/g, ' ')} (${offsetLabel(tz)})` })
  }
  const result = [...groups.entries()].map(([area, items]) => ({ area, zones: items }))
  result.push({ area: 'Other', zones: [{ value: 'UTC', label: 'UTC (GMT)' }] })
  return result
})()

export const KNOWN_TIME_ZONES = new Set(TIME_ZONE_GROUPS.flatMap((g) => g.zones.map((z) => z.value)))
