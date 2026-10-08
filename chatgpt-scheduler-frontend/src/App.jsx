import { useCallback, useEffect, useRef, useState } from 'react'
import ChatBox from './components/ChatBox.jsx'
import Modal from './components/Modal.jsx'
import PlanEditor from './components/PlanEditor.jsx'
import { AuthRequiredError, fetchAuthStatus, importEvents, openGoogleSignIn, sendChat } from './api.js'
import { computeEdits, fromApiEvent, snapshotOf, toApiEvent } from './eventUtils.js'

const STORAGE_KEY = 'chatgpt-scheduler-state-v2'

// Chat, plan and the AI's last plan are kept in sessionStorage so a reload (or a sign-in
// that had to open in a new tab) never loses them. Storage can be unavailable; then it's skipped.
function loadSaved() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null')
    if (!saved) return null
    return {
      messages: Array.isArray(saved.messages) ? saved.messages : [],
      events: Array.isArray(saved.events) ? saved.events.map((e) => ({ ...e, status: e.status === 'error' ? 'error' : 'draft' })) : [],
      snapshot: saved.snapshot || null,
    }
  } catch {
    return null
  }
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

export default function App() {
  const [saved] = useState(loadSaved)

  // Each message: { role: 'user' | 'assistant', content, display?, planSize? }
  // `content` is what goes back to the AI; `display` is what the user sees.
  const [messages, setMessages] = useState(saved?.messages ?? [])
  const [chatLoading, setChatLoading] = useState(false)
  const [chatError, setChatError] = useState(null)

  const [events, setEvents] = useState(saved?.events ?? [])
  // The AI's last proposed plan, used to work out which fields the user edited by hand.
  const [snapshot, setSnapshot] = useState(saved?.snapshot ?? null)

  const [importing, setImporting] = useState(false)
  const [notice, setNotice] = useState(null) // { type: 'success' | 'error' | 'info', text, link? }
  const [dialog, setDialog] = useState(null) // null | 'confirm-import' | 'reconnect'
  const [reconnectError, setReconnectError] = useState(null)
  const importedSoFar = useRef(0) // events added before access was lost, for the final message

  // null = still checking, true/false once the backend has answered.
  const [googleConnected, setGoogleConnected] = useState(null)
  const [connecting, setConnecting] = useState(false)

  useEffect(() => {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ messages, events, snapshot }))
    } catch {
      // storage unavailable (private mode, quota): state just won't survive a reload
    }
  }, [messages, events, snapshot])

  const checkAuth = useCallback(async () => {
    try {
      const connected = await fetchAuthStatus()
      setGoogleConnected(connected)
      return connected
    } catch {
      setGoogleConnected(false)
      return false
    }
  }, [])

  // Check on load, and again whenever the user comes back to this tab
  // (e.g. after signing in from a new tab when popups are blocked).
  useEffect(() => {
    checkAuth()
    window.addEventListener('focus', checkAuth)
    return () => window.removeEventListener('focus', checkAuth)
  }, [checkAuth])

  /** Opens Google sign-in; returns whether the app is connected afterwards. */
  const handleConnect = async () => {
    setConnecting(true)
    const result = await openGoogleSignIn()
    const connected = await checkAuth()
    setConnecting(false)
    if (!connected && result && !result.ok) setNotice({ type: 'error', text: result.message })
    return { connected, message: result?.message }
  }

  const handleSend = async (text) => {
    const next = [...messages, { role: 'user', content: text }]
    setMessages(next)
    setChatLoading(true)
    setChatError(null)

    try {
      const data = await sendChat({
        messages: next.map(({ role, content, planSize }) => ({ role, content, planSize })),
        currentPlan: events.map(toApiEvent),
        edits: computeEdits(events, snapshot),
      })

      let display = data.reply
      if (data.events) {
        const planEvents = data.events.map(fromApiEvent)
        setEvents(planEvents)
        setSnapshot(snapshotOf(planEvents))
        display += `\n\nI've put ${plural(planEvents.length, 'event')} in your plan. Edit anything you like, or ask me for changes.`
      }
      if (data.warnings?.length) display += `\n\n⚠️ ${data.warnings.join('\n⚠️ ')}`
      setMessages([...next, { role: 'assistant', content: data.reply, display, planSize: data.events?.length }])
    } catch (err) {
      setChatError(err.message)
    } finally {
      setChatLoading(false)
    }
  }

  const clearAll = () => {
    setMessages([])
    setEvents([])
    setSnapshot(null)
    setChatError(null)
  }

  /**
   * Applies per-event results from the backend: events that were added leave the plan
   * (they can only be edited in Google Calendar now); failed ones stay with their error.
   */
  const applyResults = (results = []) => {
    const byId = new Map(results.map((r) => [r.clientId, r]))
    const added = results.filter((r) => r.ok).length
    importedSoFar.current += added
    setEvents((prev) =>
      prev
        .filter((e) => !byId.get(e.id)?.ok)
        .map((e) => {
          const r = byId.get(e.id)
          return r ? { ...e, status: 'error', error: r.error } : { ...e, status: 'draft', error: null }
        })
    )
    return { added, failed: results.length - added }
  }

  const runImport = async () => {
    setDialog(null)
    setNotice(null)
    setImporting(true)

    // Make sure Google still accepts our credentials before sending anything.
    if (!(await checkAuth())) {
      setImporting(false)
      setReconnectError(null)
      setDialog('reconnect')
      return
    }

    const toImport = events
    setEvents((prev) => prev.map((e) => ({ ...e, status: 'importing', error: null })))

    try {
      const { results } = await importEvents(toImport)
      const { failed } = applyResults(results)
      if (failed === 0) {
        const total = importedSoFar.current
        importedSoFar.current = 0
        clearAll()
        setNotice({
          type: 'success',
          text: `Added ${plural(total, 'event')} to your "ChatGPT Schedule" calendar. To change them, edit them in Google Calendar.`,
          link: { href: 'https://calendar.google.com/calendar/r', label: 'Open Google Calendar' },
        })
      } else {
        setNotice({
          type: 'error',
          text: `${plural(importedSoFar.current, 'event')} added, ${failed} failed. Fix the events below and import again.`,
        })
      }
    } catch (err) {
      if (err instanceof AuthRequiredError) {
        // Lost access part-way: keep what's left, then ask to reconnect and resume.
        applyResults(err.data?.results)
        setGoogleConnected(false)
        setReconnectError(null)
        setDialog('reconnect')
      } else if (err.data?.results) {
        applyResults(err.data.results)
        setNotice({ type: 'error', text: err.message })
      } else {
        setEvents((prev) => prev.map((e) => ({ ...e, status: 'draft' })))
        setNotice({ type: 'error', text: err.message })
      }
    } finally {
      setImporting(false)
    }
  }

  const handleReconnect = async () => {
    setReconnectError(null)
    const { connected, message } = await handleConnect()
    if (connected) {
      runImport() // the user already confirmed the import; carry on with what's left
    } else {
      setReconnectError(message || 'Still not connected. Please try again.')
    }
  }

  const handleReset = () => {
    clearAll()
    setNotice(null)
    importedSoFar.current = 0
  }

  const busy = chatLoading || importing

  return (
    <div className="app">
      <header className="app-header">
        <div>
          <h1>AI Goal Scheduler</h1>
          <p className="muted">Chat about a goal, review the plan, add it to Google Calendar.</p>
        </div>
        <div className="header-actions">
          <button type="button" className="secondary" onClick={handleReset} disabled={busy}>
            New plan
          </button>
          {googleConnected ? (
            <span className="connected-badge" title="Signed in to Google Calendar">
              <span className="connected-dot" aria-hidden="true" />
              Google Calendar connected
            </span>
          ) : (
            <button
              type="button"
              className="secondary"
              onClick={handleConnect}
              disabled={connecting || googleConnected === null}
            >
              {connecting ? 'Waiting for Google…' : googleConnected === null ? 'Checking…' : 'Connect Google Calendar'}
            </button>
          )}
        </div>
      </header>

      {notice && (
        <div className={`alert ${notice.type} notice`} role="status">
          <span>
            {notice.text}
            {notice.link && (
              <>
                {' '}
                <a href={notice.link.href} target="_blank" rel="noreferrer">
                  {notice.link.label}
                </a>
              </>
            )}
          </span>
          <button type="button" className="icon-button" onClick={() => setNotice(null)} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}

      <main className="layout">
        <ChatBox messages={messages} loading={chatLoading} error={chatError} onSend={handleSend} />
        <PlanEditor
          events={events}
          setEvents={setEvents}
          snapshot={snapshot}
          disabled={busy}
          importing={importing}
          onImportClick={() => setDialog('confirm-import')}
        />
      </main>

      {dialog === 'confirm-import' && (
        <Modal
          title={`Import ${plural(events.length, 'event')}?`}
          onClose={() => setDialog(null)}
          actions={
            <>
              <button type="button" className="secondary" onClick={() => setDialog(null)}>
                Cancel
              </button>
              <button type="button" className="primary" onClick={runImport} data-autofocus>
                Confirm import
              </button>
            </>
          }
        >
          <p>
            The events will be added to your <strong>ChatGPT Schedule</strong> calendar.
          </p>
          <p>
            Once imported, you won't be able to edit them here; edit them in Google Calendar instead. This chat and
            plan will be cleared so you can start a new one.
          </p>
        </Modal>
      )}

      {dialog === 'reconnect' && (
        <Modal
          title="Reconnect Google Calendar"
          onClose={() => setDialog(null)}
          actions={
            <>
              <button type="button" className="secondary" onClick={() => setDialog(null)} disabled={connecting}>
                Cancel
              </button>
              <button type="button" className="primary" onClick={handleReconnect} disabled={connecting} data-autofocus>
                {connecting ? 'Waiting for Google…' : 'Reconnect and import'}
              </button>
            </>
          }
        >
          <p>Your Google Calendar access expired or was revoked, so nothing more can be imported right now.</p>
          <p>Reconnect to continue. Your chat and plan are kept, and the import picks up where it left off.</p>
          {reconnectError && <p className="field-error">{reconnectError}</p>}
        </Modal>
      )}
    </div>
  )
}
