
require("dotenv").config();

const express = require("express");
const cookieSession = require("cookie-session");
const {
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
} = require("./lib/googleCalendar");
const { validateImportEvent } = require("./lib/dates");
const { generatePlan, hasApiKey } = require("./lib/planner");

const isProduction = process.env.NODE_ENV === "production" || Boolean(process.env.VERCEL);

// Signs the session cookie. Set SESSION_SECRET in production (e.g. a long random string).
const SESSION_SECRET = process.env.SESSION_SECRET || "secretkey123";
if (isProduction && !process.env.SESSION_SECRET) {
  console.warn("[config] SESSION_SECRET is not set; using an insecure default.");
}

const app = express();
// Behind Vercel's proxy: trust X-Forwarded-Proto so secure cookies can be set over HTTPS.
app.set("trust proxy", 1);
app.use(express.json());
app.use(
  cookieSession({
    name: "session",
    keys: [SESSION_SECRET],
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    httpOnly: true,
    sameSite: "lax", // the frontend proxies to this API, so the cookie is first-party
    secure: isProduction, // HTTPS only in production; plain http://localhost in development
  })
);

const PORT = process.env.PORT || 3000;

// Runs a Google route: 401 when credentials are missing/expired/revoked, 500 otherwise.
const googleRoute = (label, handler) => async (req, res) => {
  try {
    await handler(req, res);
  } catch (err) {
    try {
      rethrowIfAuthError(req, err);
    } catch (authErr) {
      return res.status(401).json({ code: "GOOGLE_AUTH_REQUIRED", message: authErr.message });
    }
    console.error(`Error in ${label}:`, err);
    res.status(500).json({ message: `❌ Failed to ${label}.` });
  }
};

app.get("/", (req, res) => {
  res.send("Server is running 🚀");
});

// Where Google sends the user back after sign-in. The deployed frontend passes its own origin
// (?origin=https://app.example.com) because it proxies this API, so the callback and the session
// cookie stay on its domain. Google itself only accepts redirect URIs registered on the OAuth
// client; ALLOWED_ORIGINS (comma-separated) can restrict it further. Otherwise GOOGLE_REDIRECT_URI.
const ORIGIN_RE = /^https?:\/\/[a-z0-9.-]+(?::\d{1,5})?$/i;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",").map((o) => o.trim().replace(/\/$/, "")).filter(Boolean);

function redirectUriFor(origin) {
  if (typeof origin !== "string" || !ORIGIN_RE.test(origin)) return process.env.GOOGLE_REDIRECT_URI;
  if (ALLOWED_ORIGINS.length > 0 && !ALLOWED_ORIGINS.includes(origin)) return process.env.GOOGLE_REDIRECT_URI;
  return `${origin}/oauth2callback`;
}

app.get("/auth", (req, res) => {
    const scopes = ["https://www.googleapis.com/auth/calendar"];
    // Remembered so the callback exchanges the code with the same redirect URI.
    const redirectUri = redirectUriFor(req.query.origin);
    req.session.oauthRedirectUri = redirectUri;
    const url = createOAuthClient(redirectUri).generateAuthUrl({
      access_type: "offline", // so you get a refresh token
      scope: scopes,
      prompt: "consent", // force asking for consent to get refresh token
    });
    res.redirect(url);
});

// Asks Google whether the stored credentials still work (not only whether they exist).
app.get("/auth/status", async (req, res) => {
    try {
      res.json({ connected: await verifyConnection(req) });
    } catch (err) {
      console.error("Error checking Google connection:", err);
      res.status(502).json({ message: "Couldn't reach Google to check the connection." });
    }
});

// Page shown in the sign-in popup: reports the result to the app window, then always closes.
function authResultPage(ok, message) {
  const payload = JSON.stringify({ source: "chatgpt-scheduler-auth", ok, message }).replace(/</g, "\\u003c");
  return `<!doctype html><meta charset="utf-8"><title>Google Calendar</title>
<body style="font-family: system-ui, sans-serif; padding: 2rem;">
<p>${ok ? "✅" : "❌"} ${message}</p><p>This window closes automatically.</p>
<script>
  try { if (window.opener) window.opener.postMessage(${payload}, "*"); } catch (e) {}
  setTimeout(function () { window.close(); }, ${ok ? 300 : 1500});
</script></body>`;
}

app.get("/oauth2callback", async (req, res) => {
    // The user pressed Cancel / denied access on Google's consent screen.
    if (req.query.error) {
      const message = req.query.error === "access_denied"
        ? "Google sign-in was cancelled."
        : "Google sign-in failed. Please try again.";
      return res.send(authResultPage(false, message));
    }

    const code = req.query.code;
    if (!code) return res.send(authResultPage(false, "No code provided by Google. Please try again."));

    try {
      // Exchange code for tokens
      const redirectUri = req.session.oauthRedirectUri || process.env.GOOGLE_REDIRECT_URI;
      const { tokens } = await createOAuthClient(redirectUri).getToken({ code, redirect_uri: redirectUri });
      req.session.oauthRedirectUri = null;

      // Store tokens in session (so we can use later); a new sign-in may be a different account.
      req.session.tokens = tokens;
      req.session.googleAccount = null;
      req.session.calendarId = null;

      res.send(authResultPage(true, "Google Calendar connected!"));
    } catch (err) {
      console.error("Error retrieving tokens:", err);
      res.send(authResultPage(false, "Error retrieving access token. Please try again."));
    }
});

app.get("/list-calendars", googleRoute("fetch calendars", async (req, res) => {
    const calendar = calendarForSession(req);
    res.json(await listAllCalendars(calendar));
}));

// Finds or creates the "ChatGPT Schedule" calendar (idempotent).
// Optional ?timeZone=Area/City sets the time zone of a newly created calendar.
app.get("/create-calendar", googleRoute("create calendar", async (req, res) => {
    const calendar = calendarForSession(req);
    const result = await ensureScheduleCalendar(req, calendar, req.query.timeZone);
    res.json({
      message: result.created ? "🆕 New calendar created" : "✅ Calendar already exists",
      calendar: result.calendar,
    });
}));

// Adds one event. Body: { summary, description, start, end, timeZone, clientId? }
app.post("/add-event", googleRoute("add event", async (req, res) => {
  const { event, error } = validateImportEvent(req.body);
  if (error) return res.status(400).json({ message: `❌ ${error}` });
  if (req.body.clientId && !isValidClientId(req.body.clientId)) {
    return res.status(400).json({ message: "❌ clientId must be 5+ characters of 0-9 and a-v." });
  }

  const calendar = calendarForSession(req);
  const { calendar: target } = await ensureScheduleCalendar(req, calendar, event.timeZone);
  const result = await insertEvent(calendar, target.id, event, req.body.clientId);
  res.json({ message: "✅ Event created", event: result });
}));

// Imports a whole plan. Body: { events: [{ clientId, summary, description, start, end, timeZone }], timeZone }
// All events are validated first (nothing is written if any is invalid), the calendar is
// found or created once, then each event is inserted. clientId makes retries duplicate-free.
app.post("/import-events", googleRoute("import events", async (req, res) => {
  const input = Array.isArray(req.body.events) ? req.body.events : [];
  if (input.length === 0) return res.status(400).json({ message: "❌ No events to import." });

  const validated = input.map((raw) => {
    if (!isValidClientId(raw?.clientId)) return { clientId: raw?.clientId, error: "Missing or invalid clientId." };
    const { event, error } = validateImportEvent(raw);
    return { clientId: raw.clientId, event, error };
  });
  const invalid = validated.filter((v) => v.error);
  if (invalid.length > 0) {
    return res.status(400).json({
      message: `❌ ${invalid.length} event${invalid.length === 1 ? " is" : "s are"} invalid. Nothing was imported.`,
      results: invalid.map(({ clientId, error }) => ({ clientId, ok: false, error })),
    });
  }

  const calendar = calendarForSession(req);
  const { calendar: target } = await ensureScheduleCalendar(req, calendar, req.body.timeZone);

  const results = [];
  for (const { clientId, event } of validated) {
    try {
      results.push({ clientId, ...(await insertEvent(calendar, target.id, event, clientId)) });
    } catch (err) {
      // Lost access mid-import: report what was already added so the client can resume.
      try {
        rethrowIfAuthError(req, err);
      } catch (authErr) {
        if (authErr instanceof AuthRequiredError) {
          return res.status(401).json({ code: "GOOGLE_AUTH_REQUIRED", message: authErr.message, results });
        }
      }
      console.error("Error adding event:", err);
      results.push({ clientId, ok: false, error: err.response?.data?.error?.message || "Google rejected this event." });
    }
  }

  res.json({ calendar: { id: target.id, name: CALENDAR_NAME }, results });
}));

// Chat with the AI. Body: { messages, currentPlan, edits, client: { now, timeZone } }
// Returns { reply, events | null, warnings }.
app.post("/api/generate-schedule", async (req, res) => {
  if (!hasApiKey()) {
    return res.status(500).json({ error: { message: "No AI API key configured. Set AI_API_KEY in .env and restart the server." } });
  }
  if (!Array.isArray(req.body.messages) || req.body.messages.length === 0) {
    return res.status(400).json({ error: { message: "messages must be a non-empty array." } });
  }

  try {
    res.json(await generatePlan(req.body));
  } catch (err) {
    console.error("AI error:", err);
    res.status(err?.status || 500).json({ error: { message: err?.message || "Something went wrong" } });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

// Vercel runs the exported Express app as a serverless function.
module.exports = app;
