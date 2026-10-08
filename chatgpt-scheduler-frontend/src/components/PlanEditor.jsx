import EventCard from './EventCard.jsx'
import { blankEvent, changedFields, validateEvent } from '../eventUtils.js'

export default function PlanEditor({ events, setEvents, snapshot, disabled, importing, onImportClick }) {
  const invalidCount = events.filter((e) => validateEvent(e)).length
  const canImport = !disabled && events.length > 0 && invalidCount === 0

  // Editing an event clears its previous import error.
  const updateEvent = (updated) =>
    setEvents((prev) => prev.map((e) => (e.id === updated.id ? { ...updated, status: 'draft', error: null } : e)))
  const removeEvent = (id) => setEvents((prev) => prev.filter((e) => e.id !== id))
  const addEvent = () => setEvents((prev) => [...prev, blankEvent(prev[prev.length - 1])])

  return (
    <section className="panel plan">
      <header className="panel-header">
        <h2>Your plan</h2>
        <p className="muted">
          {events.length === 0
            ? 'Events the assistant suggests will show up here for you to review and edit.'
            : `${events.length} event${events.length === 1 ? '' : 's'} · edit anything; the assistant sees your edits.`}
        </p>
      </header>

      <div className="event-list">
        {events.map((event, i) => {
          const changed = changedFields(event, snapshot)
          return (
            <EventCard
              key={event.id}
              event={event}
              index={i}
              edited={changed === null ? Boolean(snapshot) : changed.length > 0}
              disabled={disabled}
              onChange={updateEvent}
              onRemove={() => removeEvent(event.id)}
            />
          )
        })}
        {events.length > 0 && (
          <button type="button" className="secondary add-event" onClick={addEvent} disabled={disabled}>
            + Add event
          </button>
        )}
      </div>

      {events.length > 0 && (
        <footer className="import-bar">
          {invalidCount > 0 && (
            <p className="field-error">
              Fix {invalidCount} event{invalidCount === 1 ? '' : 's'} before importing.
            </p>
          )}
          <button type="button" className="primary import-button" onClick={onImportClick} disabled={!canImport}>
            {importing ? 'Importing…' : `Import ${events.length} event${events.length === 1 ? '' : 's'} to Google Calendar`}
          </button>
        </footer>
      )}
    </section>
  )
}
