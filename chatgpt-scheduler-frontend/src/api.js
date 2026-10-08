// Calls to the Express backend. In development Vite proxies these paths to it (see vite.config.js).
import { USER_TIME_ZONE } from './dates.js'
import { toApiEvent } from './eventUtils.js'

export const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3000'

/** Google credentials are missing, expired or revoked: the user has to connect again. */
export class AuthRequiredError extends Error {
  constructor(message, data) {
    super(message || 'Google Calendar is not connected. Please connect it again.')
    this.data = data
  }
}

async function readJson(res) {
  let data = {}
  try {
    data = await res.json()
  } catch {
    // non-JSON body (e.g. proxy error page)
  }
  if (res.status === 401) throw new AuthRequiredError(data.message, data)
  if (!res.ok) {
    const err = new Error(data.message || data.error?.message || `Request failed (${res.status})`)
    err.data = data
    throw err
  }
  return data
}

/**
 * Sends the chat plus the current plan and the user's manual edits; the backend builds the
 * AI prompt. Returns { reply, events (null when the plan is unchanged), warnings }.
 */
export async function sendChat({ messages, currentPlan, edits }) {
  const res = await fetch('/api/generate-schedule', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages,
      currentPlan,
      edits,
      client: { now: new Date().toISOString(), timeZone: USER_TIME_ZONE },
    }),
  })
  return readJson(res)
}

/** Asks the backend to verify with Google that the stored credentials still work. */
export async function fetchAuthStatus() {
  const res = await fetch('/auth/status')
  const data = await readJson(res)
  return Boolean(data.connected)
}

/**
 * Opens Google sign-in in a popup, so the chat and plan in this tab are kept.
 * Resolves with { ok, message } reported by the popup, or null if it was just closed.
 * Falls back to a new tab if popups are blocked (the app re-checks when the tab regains focus).
 */
export function openGoogleSignIn() {
  const url = `${BACKEND_URL}/auth`
  const popup = window.open(url, 'google-auth', 'width=520,height=680')
  if (!popup) {
    window.open(url, '_blank')
    return Promise.resolve(null)
  }
  popup.focus()

  return new Promise((resolve) => {
    const backendOrigin = new URL(BACKEND_URL).origin
    const finish = (result) => {
      clearInterval(timer)
      window.removeEventListener('message', onMessage)
      resolve(result)
    }
    const onMessage = (event) => {
      if (event.origin !== backendOrigin || event.data?.source !== 'chatgpt-scheduler-auth') return
      try {
        popup.close()
      } catch {
        // already closed
      }
      finish({ ok: Boolean(event.data.ok), message: String(event.data.message || '') })
    }
    window.addEventListener('message', onMessage)
    const timer = setInterval(() => {
      if (popup.closed) finish(null)
    }, 500)
  })
}

/**
 * Imports events into the "ChatGPT Schedule" calendar in one request.
 * Returns { calendar, results: [{ clientId, ok, error? }] }.
 * Throws AuthRequiredError (with data.results = events already added) if access was lost.
 */
export async function importEvents(events) {
  const res = await fetch('/import-events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ events: events.map(toApiEvent), timeZone: USER_TIME_ZONE }),
  })
  return readJson(res)
}
