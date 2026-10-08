import { useEffect, useRef, useState } from 'react'

const SUGGESTIONS = [
  'Create a 7-day tech interview preparation plan',
  'Make me a 3-day beginner workout plan',
  'Plan 2 weeks of learning React, 1 hour each evening',
]

export default function ChatBox({ messages, loading, error, onSend }) {
  const [input, setInput] = useState('')
  const listRef = useRef(null)

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, loading])

  const submit = (text) => {
    const value = text.trim()
    if (!value || loading) return
    onSend(value)
    setInput('')
  }

  const handleKeyDown = (e) => {
    // Enter sends, Shift+Enter adds a new line.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit(input)
    }
  }

  return (
    <section className="panel chat">
      <header className="panel-header">
        <h2>Chat</h2>
        <p className="muted">Tell the assistant your goal. It may ask a few questions before drafting a plan.</p>
      </header>

      <div className="messages" ref={listRef}>
        {messages.length === 0 && (
          <div className="empty">
            <p>What do you want to work towards?</p>
            <div className="suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s} type="button" className="chip" onClick={() => submit(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} className={`bubble ${m.role}`}>
            {m.display ?? m.content}
          </div>
        ))}

        {loading && <div className="bubble assistant typing">Thinking…</div>}
        {error && <div className="alert error">{error}</div>}
      </div>

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault()
          submit(input)
        }}
      >
        <textarea
          rows={2}
          value={input}
          placeholder="e.g. I have a Google interview in a week, help me prepare"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <button type="submit" className="primary" disabled={loading || !input.trim()}>
          Send
        </button>
      </form>
    </section>
  )
}
