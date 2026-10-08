// Talks to the existing Express backend without requiring any backend changes.
// The backend's /api/generate-schedule only accepts a single `prompt`, so the
// conversation history and formatting instructions are packed into it here.

export const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3000'

export const USER_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone

function buildPrompt(messages) {
  const today = new Date().toLocaleDateString('en-CA') // YYYY-MM-DD
  const fence = '```'

  const instructions = `You help the user turn a goal into a concrete plan of calendar events.
Today is ${today}. The user's time zone is ${USER_TIME_ZONE}.

If you are missing important details (start date, preferred time of day, session length, experience level), ask at most 2-3 short clarifying questions and do not produce a plan yet.

When you have enough information, reply with one short sentence, followed by exactly one fenced code block tagged json in this shape:
${fence}json
{"events":[{"summary":"Short title","description":"Concrete tasks for this session","start":"YYYY-MM-DDTHH:mm:ss","end":"YYYY-MM-DDTHH:mm:ss","timeZone":"${USER_TIME_ZONE}"}]}
${fence}
Rules: use local times without UTC offsets, end must be after start, and put the specific tasks or exercises in description.
If the user asks to change an existing plan, return the full updated plan in the same format.`

  const transcript = messages
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n\n')

  return `${instructions}\n\nConversation so far:\n${transcript}\n\nReply as the Assistant to the last User message.`
}

export async function sendChat(messages) {
  const res = await fetch('/api/generate-schedule', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: buildPrompt(messages) }),
  })
  const data = await res.json()
  if (!res.ok || data.error) {
    throw new Error(data.error?.message || data.error || 'The AI request failed.')
  }
  return data.choices?.[0]?.message?.content ?? ''
}

// "2026-10-08T19:00:00" -> "2026-10-08T19:00" (the format <input type="datetime-local"> uses)
const toInputValue = (value) => (typeof value === 'string' ? value.slice(0, 16) : '')

/**
 * Pulls the JSON plan out of an AI reply.
 * Returns { text, events } where `text` is the reply without the code block and
 * `events` is null when the reply contains no plan (e.g. a clarifying question).
 */
export function parseReply(content) {
  const match = content.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (!match) return { text: content.trim(), events: null }

  let parsed
  try {
    parsed = JSON.parse(match[1])
  } catch {
    return { text: content.trim(), events: null }
  }

  const rawEvents = Array.isArray(parsed) ? parsed : parsed.events
  if (!Array.isArray(rawEvents)) return { text: content.trim(), events: null }

  const events = rawEvents.map((e) => ({
    id: crypto.randomUUID(),
    summary: e.summary ?? '',
    description: e.description ?? '',
    start: toInputValue(e.start),
    end: toInputValue(e.end),
    timeZone: e.timeZone || USER_TIME_ZONE,
    status: 'draft', // draft | importing | imported | error
    error: null,
  }))

  return { text: content.replace(match[0], '').trim(), events }
}

export async function fetchAuthStatus() {
  const res = await fetch('/auth/status')
  if (!res.ok) throw new Error(`Auth status failed (${res.status})`)
  const data = await res.json()
  return data.connected
}

/**
 * Opens Google sign-in in a popup and resolves once the popup closes, so the
 * chat and plan in this tab are kept. Falls back to a new tab if popups are blocked.
 */
export function openGoogleSignIn() {
  const url = `${BACKEND_URL}/auth`
  const popup = window.open(url, 'google-auth', 'width=520,height=680')
  if (!popup) {
    window.open(url, '_blank')
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (popup.closed) {
        clearInterval(timer)
        resolve()
      }
    }, 500)
  })
}

export class NotLoggedInError extends Error {}

// Reads a backend response; the backend replies with plain text on errors and
// with a 200 "Not logged in" text when there is no session.
async function readBackendResponse(res) {
  const text = await res.text()
  if (text.includes('Not logged in')) throw new NotLoggedInError('Not connected to Google Calendar.')
  let data
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error(text || `Request failed (${res.status})`)
  }
  if (!res.ok) throw new Error(data.message || `Request failed (${res.status})`)
  return data
}

// Creates the "ChatGPT Schedule" calendar if it does not exist yet (idempotent).
export async function ensureCalendar() {
  const res = await fetch('/create-calendar')
  return readBackendResponse(res)
}

export async function addEvent(event) {
  const res = await fetch('/add-event', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      summary: event.summary,
      description: event.description,
      // Google expects seconds in RFC 3339 date-times.
      start: `${event.start}:00`,
      end: `${event.end}:00`,
      timeZone: event.timeZone,
    }),
  })
  return readBackendResponse(res)
}
