// Google auth + calendar helpers.
const { google } = require("googleapis");
const { DEFAULT_TIME_ZONE, canonicalTimeZone } = require("./dates");

const CALENDAR_NAME = "ChatGPT Schedule";

// `redirectUri` defaults to GOOGLE_REDIRECT_URI; the sign-in routes pass the frontend's own one.
function createOAuthClient(redirectUri = process.env.GOOGLE_REDIRECT_URI) {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    redirectUri
  );
}

/** Thrown when the session has no usable Google credentials; routes answer 401. */
class AuthRequiredError extends Error {
  constructor(message = "Google Calendar is not connected. Please connect it again.") {
    super(message);
  }
}

const statusOf = (err) => err?.response?.status ?? err?.status ?? (typeof err?.code === "number" ? err.code : undefined);

/** Expired/revoked refresh token, invalid access token, or missing calendar permission. */
function isAuthError(err) {
  const status = statusOf(err);
  const reason = err?.response?.data?.error || err?.errors?.[0]?.reason || "";
  return (
    status === 401 ||
    reason === "invalid_grant" || reason === "invalid_token" || reason === "insufficientPermissions" ||
    /invalid_grant|invalid_token|No refresh token|No access, refresh token/i.test(err?.message || "")
  );
}

/**
 * A fresh OAuth client per request, so concurrent users never share credentials.
 * Access tokens that googleapis refreshes automatically are saved back into the session.
 */
function authForSession(req) {
  if (!req.session.tokens) throw new AuthRequiredError();
  const auth = createOAuthClient();
  auth.setCredentials(req.session.tokens);
  auth.on("tokens", (tokens) => {
    req.session.tokens = { ...req.session.tokens, ...tokens };
  });
  return auth;
}

function calendarForSession(req) {
  return google.calendar({ version: "v3", auth: authForSession(req) });
}

/** Clears credentials Google no longer accepts, and converts the error to AuthRequiredError. */
function rethrowIfAuthError(req, err) {
  if (err instanceof AuthRequiredError) throw err;
  if (isAuthError(err)) {
    req.session.tokens = null;
    req.session.googleAccount = null;
    throw new AuthRequiredError("Your Google Calendar access expired or was revoked. Please connect it again.");
  }
}

/**
 * Checks with Google that the stored credentials still work (not just that they exist).
 * Revoked or expired credentials are cleared from the session.
 */
async function verifyConnection(req) {
  if (!req.session.tokens) return false;
  try {
    const auth = authForSession(req);
    const { token } = await auth.getAccessToken(); // refreshes if expired
    await auth.getTokenInfo(token); // fails if the user revoked access
    return true;
  } catch (err) {
    const status = statusOf(err);
    if (isAuthError(err) || status === 400) {
      req.session.tokens = null;
      req.session.googleAccount = null;
      return false;
    }
    throw err;
  }
}

/** Reads every page of the user's calendar list, including hidden calendars. */
async function listAllCalendars(calendar) {
  const items = [];
  let pageToken;
  do {
    const { data } = await calendar.calendarList.list({ pageToken, showHidden: true, maxResults: 250 });
    items.push(...(data.items || []));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return items;
}

// The name the user sees: their own rename (summaryOverride) wins over the calendar's title.
const displayName = (cal) => cal.summaryOverride || cal.summary;
const canWrite = (cal) => cal.accessRole === "owner" || cal.accessRole === "writer";

// One find-or-create at a time per Google account, so simultaneous imports (two tabs,
// double clicks) can't both see "no calendar" and create two. Works within this server
// process; running several servers would need a shared lock (e.g. Redis).
const locks = new Map();
async function withLock(key, fn) {
  const previous = locks.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => (release = resolve));
  const tail = previous.then(() => current);
  locks.set(key, tail);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(key) === tail) locks.delete(key);
  }
}

/** The signed-in Google account (the primary calendar's id is the account email). */
async function accountId(req, calendar) {
  if (!req.session.googleAccount) {
    const { data } = await calendar.calendars.get({ calendarId: "primary" });
    req.session.googleAccount = data.id;
  }
  return req.session.googleAccount;
}

/**
 * Finds the "ChatGPT Schedule" calendar by reading the full calendar list, or creates it.
 * - Safe to call repeatedly or concurrently (idempotent).
 * - If the user renamed the old one, it no longer matches and a new one is created.
 * - New calendars use the device time zone sent by the client (default America/Los_Angeles).
 */
async function ensureScheduleCalendar(req, calendar, deviceTimeZone) {
  const account = await accountId(req, calendar);
  return withLock(account, async () => {
    const matches = (await listAllCalendars(calendar)).filter(
      (cal) => displayName(cal) === CALENDAR_NAME && canWrite(cal)
    );
    if (matches.length > 0) {
      const chosen = matches.find((cal) => cal.id === req.session.calendarId) || matches[0];
      req.session.calendarId = chosen.id;
      return { calendar: chosen, created: false };
    }

    const timeZone = canonicalTimeZone(deviceTimeZone) || DEFAULT_TIME_ZONE;
    const { data } = await calendar.calendars.insert({
      requestBody: { summary: CALENDAR_NAME, timeZone, description: "Plans created by ChatGPT Scheduler." },
    });
    req.session.calendarId = data.id;
    return { calendar: data, created: true };
  });
}

/**
 * Inserts one event. `clientId` (lowercase hex/base32hex) becomes the Google event id,
 * so retrying the same import can never create a duplicate: Google answers 409 instead.
 */
async function insertEvent(calendar, calendarId, event, clientId) {
  const body = {
    summary: event.summary,
    description: event.description,
    start: { dateTime: event.start, timeZone: event.timeZone },
    end: { dateTime: event.end, timeZone: event.timeZone },
  };
  if (clientId) body.id = clientId;
  try {
    const { data } = await calendar.events.insert({ calendarId, requestBody: body });
    return { ok: true, id: data.id, htmlLink: data.htmlLink };
  } catch (err) {
    if (clientId && statusOf(err) === 409) return { ok: true, id: clientId, alreadyExisted: true };
    throw err;
  }
}

const isValidClientId = (id) => typeof id === "string" && /^[a-v0-9]{5,1024}$/.test(id);

module.exports = {
  CALENDAR_NAME,
  AuthRequiredError,
  createOAuthClient,
  calendarForSession,
  rethrowIfAuthError,
  verifyConnection,
  listAllCalendars,
  ensureScheduleCalendar,
  insertEvent,
  isValidClientId,
};
