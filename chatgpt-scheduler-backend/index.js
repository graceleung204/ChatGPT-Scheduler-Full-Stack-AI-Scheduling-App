
require("dotenv").config();

const express = require("express");
const { google } = require("googleapis");
const cookieSession = require("cookie-session");
const OpenAI = require("openai");

const app = express();
app.use(express.json());
app.use(
  cookieSession({
    name: "session",
    keys: ["secretkey123"], // replace with something secure
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
  })
);

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

const PORT = 3000;

app.get("/", (req, res) => {
  res.send("Server is running 🚀");
});

app.get("/auth", (req, res) => {
    const scopes = ["https://www.googleapis.com/auth/calendar"];
    const url = oauth2Client.generateAuthUrl({
      access_type: "offline", // so you get a refresh token
      scope: scopes,
      prompt: "consent", // force asking for consent to get refresh token
    });
    res.redirect(url);
});

// Lets the frontend know whether this session has signed in to Google.
app.get("/auth/status", (req, res) => {
    res.json({ connected: Boolean(req.session.tokens) });
});

app.get("/oauth2callback", async (req, res) => {
    const code = req.query.code;
    if (!code) return res.send("No code provided ❌");
  
    try {
      // Exchange code for tokens
      const { tokens } = await oauth2Client.getToken(code);
      oauth2Client.setCredentials(tokens);
  
      // Store tokens in session (so we can use later)
      req.session.tokens = tokens;
  
      // Closes itself when opened as a popup by the frontend; the frontend then re-checks /auth/status.
      res.send(`<p>✅ Google Calendar connected! You can close this window and return to the app.</p>
        <script>if (window.opener) setTimeout(() => window.close(), 1000);</script>`);
    } catch (err) {
      console.error("Error retrieving tokens:", err);
      res.send("❌ Error retrieving access token.");
    }
});

app.get("/list-calendars", async (req, res) => {
    if (!req.session.tokens) return res.send("Not logged in ❌");
  
    oauth2Client.setCredentials(req.session.tokens);
    const calendar = google.calendar({ version: "v3", auth: oauth2Client });
  
    try {
      const response = await calendar.calendarList.list();
      res.json(response.data.items);
    } catch (err) {
      console.error("Calendar API error:", err);
      res.send("❌ Failed to fetch calendars.");
    }
});

app.get("/create-calendar", async (req, res) => {
    if (!req.session.tokens) return res.send("Not logged in ❌");
  
    oauth2Client.setCredentials(req.session.tokens);
    const calendar = google.calendar({ version: "v3", auth: oauth2Client });
  
    try {
      // 1️⃣ Get existing calendars
      const listResponse = await calendar.calendarList.list();
      const calendars = listResponse.data.items;
  
      // 2️⃣ Check if "ChatGPT Schedule" already exists
      const existing = calendars.find(cal => cal.summary === "ChatGPT Schedule");
  
      if (existing) {
        return res.json({
          message: "✅ Calendar already exists",
          calendar: existing
        });
      }
  
      // 3️⃣ Create new calendar if not found
      const newCalendar = await calendar.calendars.insert({
        requestBody: {
          summary: "ChatGPT Schedule",
          timeZone: "America/Los_Angeles", // You can change this to your timezone
        },
      });
  
      // 4️⃣ Return new calendar
      res.json({
        message: "🆕 New calendar created",
        calendar: newCalendar.data
      });
  
    } catch (err) {
      console.error("Error creating calendar:", err);
      res.status(500).send("❌ Failed to create calendar.");
    }
});

app.use(express.json()); // make sure you can parse JSON body

app.post("/add-event", async (req, res) => {
  if (!req.session.tokens) return res.send("Not logged in ❌");

  oauth2Client.setCredentials(req.session.tokens);
  const calendar = google.calendar({ version: "v3", auth: oauth2Client });

  try {
    // 1️⃣ Get calendar list
    const listResponse = await calendar.calendarList.list();
    const calendars = listResponse.data.items;

    // 2️⃣ Find "ChatGPT Schedule" calendar
    const targetCalendar = calendars.find(cal => cal.summary === "ChatGPT Schedule");
    if (!targetCalendar) {
      return res.status(404).send("❌ ChatGPT Schedule calendar not found. Run /create-calendar first.");
    }

    // 3️⃣ Read event details from request body
    const { summary, description, start, end, timeZone } = req.body;

    if (!summary || !start || !end) {
      return res.status(400).send("❌ Missing required fields: summary, start, end");
    }

    // 4️⃣ Build event
    const event = {
      summary,
      description: description || "",
      start: {
        dateTime: start,
        timeZone: timeZone || "America/Los_Angeles",
      },
      end: {
        dateTime: end,
        timeZone: timeZone || "America/Los_Angeles",
      },
    };

    // 5️⃣ Insert event
    const response = await calendar.events.insert({
      calendarId: targetCalendar.id,
      requestBody: event,
    });

    res.json({
      message: "✅ Event created",
      event: response.data,
    });

  } catch (err) {
    console.error("Error adding event:", err);
    res.status(500).send("❌ Failed to add event.");
  }
});

// AI client: the OpenAI SDK works with any OpenAI-compatible API (Google Gemini, OpenAI, Groq…).
// Configured in .env with AI_BASE_URL, AI_API_KEY and AI_MODEL.
const ai = new OpenAI({
  apiKey: process.env.AI_API_KEY || process.env.OPENAI_API_KEY || "missing",
  baseURL: process.env.AI_BASE_URL || undefined, // undefined = OpenAI
  maxRetries: 1,
});
const AI_MODEL = process.env.AI_MODEL || "gemini-3.5-flash";
// Backup models tried in order when the main one is overloaded or rate-limited.
const AI_FALLBACK_MODELS = (process.env.AI_FALLBACK_MODELS || "")
  .split(",").map((m) => m.trim()).filter((m) => m && m !== AI_MODEL);

const isCapacityError = (e) =>
  e instanceof OpenAI.InternalServerError || e instanceof OpenAI.RateLimitError ||
  e instanceof OpenAI.APIConnectionTimeoutError;

// Endpoint to call the AI
app.post("/api/generate-schedule", async (req, res) => {
  const { prompt } = req.body;
  if (!process.env.AI_API_KEY && !process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: { message: "No AI API key configured. Set AI_API_KEY in .env and restart the server." } });
  }

  let lastError;
  for (const model of [AI_MODEL, ...AI_FALLBACK_MODELS]) {
    try {
      const completion = await ai.chat.completions.create({
        model,
        messages: [
          { role: "system", content: "You are a helpful scheduling assistant." },
          { role: "user", content: prompt },
        ],
      });
      if (model !== AI_MODEL) console.warn(`[ai] answered by fallback model ${model}`);
      return res.json(completion);
    } catch (err) {
      lastError = err;
      if (isCapacityError(err)) {
        console.warn(`[ai] ${model} unavailable (${err.message.slice(0, 120)}); trying the next model`);
        continue;
      }
      break;
    }
  }

  console.error("AI error:", lastError);
  res.status(lastError?.status || 500).json({ error: { message: lastError?.message || "Something went wrong" } });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});


