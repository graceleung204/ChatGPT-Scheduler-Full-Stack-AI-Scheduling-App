import { USER_TIME_ZONE, fromApi, isValidTimeZone, nowInTimeZone, toApi } from './dates.js'

export const EDITABLE_FIELDS = ['summary', 'description', 'start', 'end', 'timeZone']

const FIELD_LABELS = { summary: 'title', description: 'description', start: 'start', end: 'end', timeZone: 'time zone' }

// Hex without dashes: also a valid Google Calendar event id, which makes imports retry-safe.
export const newEventId = () => crypto.randomUUID().replace(/-/g, '')

/** Event from the API -> event in app state. */
export function fromApiEvent(e) {
  return {
    id: newEventId(),
    summary: e.summary ?? '',
    description: e.description ?? '',
    start: fromApi(e.start),
    end: fromApi(e.end),
    timeZone: e.timeZone || USER_TIME_ZONE,
    status: 'draft', // draft | importing | error
    error: null,
  }
}

/** Event in app state -> event for the API. */
export function toApiEvent(e) {
  return {
    clientId: e.id,
    summary: e.summary,
    description: e.description,
    start: toApi(e.start),
    end: toApi(e.end),
    timeZone: e.timeZone,
  }
}

const pickFields = (e) => Object.fromEntries(EDITABLE_FIELDS.map((f) => [f, e[f]]))

/** What the AI last proposed, keyed by event id, so manual edits can be detected. */
export const snapshotOf = (events) => Object.fromEntries(events.map((e) => [e.id, pickFields(e)]))

export function changedFields(event, snapshot) {
  const original = snapshot?.[event.id]
  if (!original) return null // added by the user
  return EDITABLE_FIELDS.filter((f) => (event[f] ?? '') !== (original[f] ?? ''))
}

/** The user's manual edits since the AI's last plan, sent to the backend with each chat message. */
export function computeEdits(events, snapshot) {
  if (!snapshot) return []
  const edits = []
  for (const event of events) {
    const changed = changedFields(event, snapshot)
    if (changed === null) {
      edits.push({ type: 'added', title: event.summary })
    } else if (changed.length > 0) {
      const original = snapshot[event.id]
      edits.push({
        type: 'modified',
        title: event.summary || original.summary,
        changes: changed.map((f) => ({
          field: FIELD_LABELS[f],
          from: f === 'start' || f === 'end' ? toApi(original[f]) : original[f],
          to: f === 'start' || f === 'end' ? toApi(event[f]) : event[f],
        })),
      })
    }
  }
  const currentIds = new Set(events.map((e) => e.id))
  for (const [id, original] of Object.entries(snapshot)) {
    if (!currentIds.has(id)) edits.push({ type: 'removed', title: original.summary })
  }
  return edits
}

/** Returns a message describing the first problem, or null if the event can be imported. */
export function validateEvent(event) {
  if (!event.summary.trim()) return 'Title is required.'
  if (!event.start || !event.end) return 'Start and end are required.'
  if (event.end <= event.start) return 'End must be after start.'
  if (!isValidTimeZone(event.timeZone)) return `"${event.timeZone}" is not a valid time zone.`
  if (event.start < nowInTimeZone(event.timeZone)) return `Start time is in the past (in ${event.timeZone}).`
  return null
}

const pad = (n) => String(n).padStart(2, '0')
const formatLocal = (d) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`

/** A new event the day after `after` at the same time, or tomorrow 9–10 AM. */
export function blankEvent(after) {
  const base = after?.start ? new Date(after.start) : new Date()
  base.setDate(base.getDate() + 1)
  if (!after?.start) base.setHours(9, 0, 0, 0)
  const end = new Date(base)
  if (after?.start && after?.end) end.setTime(base.getTime() + (new Date(after.end) - new Date(after.start)))
  else end.setHours(base.getHours() + 1)

  return {
    id: newEventId(),
    summary: '',
    description: '',
    start: formatLocal(base),
    end: formatLocal(end),
    timeZone: after?.timeZone || USER_TIME_ZONE,
    status: 'draft',
    error: null,
  }
}
