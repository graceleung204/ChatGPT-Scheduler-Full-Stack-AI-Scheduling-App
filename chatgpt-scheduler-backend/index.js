
require("dotenv").config();

const express = require("express");
const { google } = require("googleapis");
const cookieSession = require("cookie-session");

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

app.get("/oauth2callback", async (req, res) => {
    const code = req.query.code;
    if (!code) return res.send("No code provided ❌");
  
    try {
      // Exchange code for tokens
      const { tokens } = await oauth2Client.getToken(code);
      oauth2Client.setCredentials(tokens);
  
      // Store tokens in session (so we can use later)
      req.session.tokens = tokens;
  
      res.send("✅ Google OAuth successful! You can now use Calendar API. Go to /list-calendars to test.");
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

// Endpoint to call OpenAI
app.post("/api/generate-schedule", async (req, res) => {
  try {
    const { prompt } = req.body;

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`, // ✅ from .env
      },
      body: JSON.stringify({
        model: "gpt-4o-mini", // or whichever model you use
        messages: [
          { role: "system", content: "You are a helpful scheduling assistant." },
          { role: "user", content: prompt }
        ],
      }),
    });

    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong" });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});


