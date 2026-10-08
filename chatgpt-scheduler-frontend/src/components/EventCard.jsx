import { KNOWN_TIME_ZONES, TIME_ZONE_GROUPS, formatRange } from '../dates.js'
import { validateEvent } from '../eventUtils.js'

const STATUS_LABELS = {
  importing: 'Importing…',
  error: 'Failed',
}

export default function EventCard({ event, index, edited, onChange, onRemove, disabled }) {
  const problem = validateEvent(event)
  const locked = disabled || event.status === 'importing'
  const update = (field) => (e) => onChange({ ...event, [field]: e.target.value })

  return (
    <article className={`event-card ${event.status}`}>
      <div className="event-card-top">
        <span className="event-index">{index + 1}</span>
        <span className="event-when">{formatRange(event.start, event.end)}</span>
        {edited && <span className="status edited">Edited</span>}
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
          <select value={event.timeZone} onChange={update('timeZone')} disabled={locked}>
            {!KNOWN_TIME_ZONES.has(event.timeZone) && (
              <option value={event.timeZone}>{event.timeZone || 'Choose a time zone'}</option>
            )}
            {TIME_ZONE_GROUPS.map((group) => (
              <optgroup key={group.area} label={group.area}>
                {group.zones.map((zone) => (
                  <option key={zone.value} value={zone.value}>
                    {zone.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
      </div>

      <label className="field">
        <span>Description</span>
        <textarea rows={3} value={event.description} onChange={update('description')} disabled={locked} />
      </label>

      {problem && <p className="field-error">{problem}</p>}
      {event.error && <p className="field-error">{event.error}</p>}
    </article>
  )
}
