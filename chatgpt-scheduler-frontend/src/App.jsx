import { useCallback, useEffect, useState } from 'react'
import ChatBox from './components/ChatBox.jsx'
import PlanEditor from './components/PlanEditor.jsx'
import {
  NotLoggedInError,
  addEvent,
  ensureCalendar,
  fetchAuthStatus,
  openGoogleSignIn,
  parseReply,
  sendChat,
} from './api.js'

export default function App() {
  // Each message: { role: 'user' | 'assistant', content, display? }
  // `content` is what goes back to the AI; `display` is what the user sees.
  const [messages, setMessages] = useState([])
  const [chatLoading, setChatLoading] = useState(false)
  const [chatError, setChatError] = useState(null)

  const [events, setEvents] = useState([])
  const [importing, setImporting] = useState(false)
  const [importMessage, setImportMessage] = useState(null)

  // null = still checking, true/false once the backend has answered.
  const [googleConnected, setGoogleConnected] = useState(null)
  const [connecting, setConnecting] = useState(false)

  const checkAuth = useCallback(async () => {
    try {
      setGoogleConnected(await fetchAuthStatus())
    } catch {
      setGoogleConnected(false)
    }
  }, [])

  // Check on load, and again whenever the user comes back to this tab
  // (e.g. after signing in from a new tab when popups are blocked).
  useEffect(() => {
    checkAuth()
    window.addEventListener('focus', checkAuth)
    return () => window.removeEventListener('focus', checkAuth)
  }, [checkAuth])

  const handleConnect = async () => {
    setConnecting(true)
    await openGoogleSignIn()
    await checkAuth()
    setConnecting(false)
  }

  const handleSend = async (text) => {
    const next = [...messages, { role: 'user', content: text }]
    setMessages(next)
    setChatLoading(true)
    setChatError(null)

    try {
      const reply = await sendChat(next)
      const { text: replyText, events: planEvents } = parseReply(reply)

      let display = replyText
      if (planEvents) {
        setEvents(planEvents)
        setImportMessage(null)
        const note = `I've drafted ${planEvents.length} event${planEvents.length === 1 ? '' : 's'} in your plan. Edit anything you like, or ask me for changes.`
        display = replyText ? `${replyText}\n\n${note}` : note
      }
      setMessages([...next, { role: 'assistant', content: reply, display }])
    } catch (err) {
      setChatError(err.message)
    } finally {
      setChatLoading(false)
    }
  }

  const setEventStatus = (id, status, error = null) =>
    setEvents((prev) => prev.map((e) => (e.id === id ? { ...e, status, error } : e)))

  const handleImport = async () => {
    setImporting(true)
    setImportMessage(null)

    try {
      await ensureCalendar()
    } catch (err) {
      if (err instanceof NotLoggedInError) setGoogleConnected(false)
      setImportMessage({ type: 'error', text: err.message, needsLogin: err instanceof NotLoggedInError })
      setImporting(false)
      return
    }

    // Skip events already imported so clicking again never creates duplicates.
    const toImport = events.filter((e) => e.status !== 'imported')
    let failed = 0
    for (const event of toImport) {
      setEventStatus(event.id, 'importing')
      try {
        await addEvent(event)
        setEventStatus(event.id, 'imported')
      } catch (err) {
        failed++
        setEventStatus(event.id, 'error', err.message)
        if (err instanceof NotLoggedInError) {
          setGoogleConnected(false)
          setImportMessage({ type: 'error', text: err.message, needsLogin: true })
          setImporting(false)
          return
        }
      }
    }

    setImportMessage(
      failed === 0
        ? { type: 'success', text: `Added ${toImport.length} event${toImport.length === 1 ? '' : 's'} to your "ChatGPT Schedule" calendar.` }
        : { type: 'error', text: `${failed} of ${toImport.length} events failed. Fix them and import again.` }
    )
    setImporting(false)
  }

  const handleReset = () => {
    setMessages([])
    setEvents([])
    setChatError(null)
    setImportMessage(null)
  }

  return (
    <div className="app">
      <header className="app-header">
        <div>
          <h1>AI Goal Scheduler</h1>
          <p className="muted">Chat about a goal, review the plan, add it to Google Calendar.</p>
        </div>
        <div className="header-actions">
          <button type="button" className="secondary" onClick={handleReset} disabled={chatLoading || importing}>
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

      <main className="layout">
        <ChatBox messages={messages} loading={chatLoading} error={chatError} onSend={handleSend} />
        <PlanEditor
          events={events}
          setEvents={setEvents}
          importing={importing}
          importMessage={importMessage}
          onImport={handleImport}
          onConnect={handleConnect}
        />
      </main>
    </div>
  )
}
