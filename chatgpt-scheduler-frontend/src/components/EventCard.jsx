const TIME_ZONES = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : []

// "Wed, Oct 8 · 7:00 PM – 8:30 PM"
function formatRange(start, end) {
  if (!start || !end) return 'Set a start and end time'
  const s = new Date(start)
  const e = new Date(end)
  if (isNaN(s) || isNaN(e)) return 'Invalid date'
  const day = s.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
  const time = (d) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  return `${day} · ${time(s)} – ${time(e)}`
}

export function validateEvent(event) {
  if (!event.summary.trim()) return 'Title is required.'
  if (!event.start || !event.end) return 'Start and end are required.'
  if (event.end <= event.start) return 'End must be after start.'
  if (!event.timeZone) return 'Time zone is required.'
  return null
}

const STATUS_LABELS = {
  importing: 'Importing…',
  imported: '✓ Added to calendar',
  error: 'Failed',
}

export default function EventCard({ event, index, onChange, onRemove, disabled }) {
  const problem = validateEvent(event)
  const locked = disabled || event.status === 'imported' || event.status === 'importing'
  const update = (field) => (e) => onChange({ ...event, [field]: e.target.value })

  return (
    <article className={`event-card ${event.status}`}>
      <div className="event-card-top">
        <span className="event-index">{index + 1}</span>
        <span className="event-when">{formatRange(event.start, event.end)}</span>
        {STATUS_LABELS[event.status] && (
          <span className={`status ${event.status}`}>{STATUS_LABELS[event.status]}</span>
        )}
        <button
          type="button"
          className="icon-button"
          onClick={onRemove}
          disabled={locked}
          aria-label="Remove event"
          title="Remove event"
        >
          ×
        </button>
      </div>

      <label className="field">
        <span>Title</span>
        <input type="text" value={event.summary} onChange={update('summary')} disabled={locked} />
      </label>

      <div className="field-row">
        <label className="field">
          <span>Start</span>
          <input type="datetime-local" value={event.start} onChange={update('start')} disabled={locked} />
        </label>
        <label className="field">
          <span>End</span>
          <input type="datetime-local" value={event.end} onChange={update('end')} disabled={locked} />
        </label>
        <label className="field">
          <span>Time zone</span>
          <input
            type="text"
            list="time-zones"
            value={event.timeZone}
            onChange={update('timeZone')}
            disabled={locked}
          />
        </label>
      </div>

      <label className="field">
        <span>Description</span>
        <textarea rows={3} value={event.description} onChange={update('description')} disabled={locked} />
      </label>

      {problem && event.status !== 'imported' && <p className="field-error">{problem}</p>}
      {event.error && <p className="field-error">{event.error}</p>}
    </article>
  )
}

export function TimeZoneOptions() {
  return (
    <datalist id="time-zones">
      {TIME_ZONES.map((tz) => (
        <option key={tz} value={tz} />
      ))}
    </datalist>
  )
}
