import EventCard, { TimeZoneOptions, validateEvent } from './EventCard.jsx'
import { USER_TIME_ZONE } from '../api.js'

function blankEvent(after) {
  // Default a new event to the day after the last one, same time, or tomorrow 9–10 AM.
  const base = after?.start ? new Date(after.start) : new Date()
  base.setDate(base.getDate() + 1)
  if (!after?.start) base.setHours(9, 0, 0, 0)
  const end = new Date(base)
  if (after?.start && after?.end) end.setTime(base.getTime() + (new Date(after.end) - new Date(after.start)))
  else end.setHours(base.getHours() + 1)

  const fmt = (d) => {
    const pad = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
  }

  return {
    id: crypto.randomUUID(),
    summary: '',
    description: '',
    start: fmt(base),
    end: fmt(end),
    timeZone: after?.timeZone || USER_TIME_ZONE,
    status: 'draft',
    error: null,
  }
}

export default function PlanEditor({ events, setEvents, importing, importMessage, onImport, onConnect }) {
  const pending = events.filter((e) => e.status !== 'imported')
  const invalidCount = pending.filter((e) => validateEvent(e)).length
  const canImport = !importing && pending.length > 0 && invalidCount === 0

  const updateEvent = (updated) =>
    setEvents((prev) => prev.map((e) => (e.id === updated.id ? { ...updated, status: e.status === 'error' ? 'draft' : e.status, error: null } : e)))
  const removeEvent = (id) => setEvents((prev) => prev.filter((e) => e.id !== id))
  const addEvent = () => setEvents((prev) => [...prev, blankEvent(prev[prev.length - 1])])

  return (
    <section className="panel plan">
      <header className="panel-header">
        <h2>Your plan</h2>
        <p className="muted">
          {events.length === 0
            ? 'Events the assistant suggests will show up here for you to review and edit.'
            : `${events.length} event${events.length === 1 ? '' : 's'} · review and edit before importing.`}
        </p>
      </header>

      <div className="event-list">
        <TimeZoneOptions />
        {events.map((event, i) => (
          <EventCard
            key={event.id}
            event={event}
            index={i}
            disabled={importing}
            onChange={updateEvent}
            onRemove={() => removeEvent(event.id)}
          />
        ))}
        {events.length > 0 && (
          <button type="button" className="secondary add-event" onClick={addEvent} disabled={importing}>
            + Add event
          </button>
        )}
      </div>

      {events.length > 0 && (
        <footer className="import-bar">
          {importMessage && (
            <div className={`alert ${importMessage.type}`}>
              {importMessage.text}
              {importMessage.needsLogin && (
                <>
                  {' '}
                  <button type="button" className="link-button" onClick={onConnect}>
                    Connect Google Calendar
                  </button>
                  , then try again.
                </>
              )}
            </div>
          )}
          {invalidCount > 0 && (
            <p className="field-error">
              Fix {invalidCount} event{invalidCount === 1 ? '' : 's'} before importing.
            </p>
          )}
          <button type="button" className="primary import-button" onClick={onImport} disabled={!canImport}>
            {importing
              ? 'Importing…'
              : pending.length === 0
                ? 'All events imported'
                : `Import ${pending.length} event${pending.length === 1 ? '' : 's'} to Google Calendar`}
          </button>
        </footer>
      )}
    </section>
  )
}
