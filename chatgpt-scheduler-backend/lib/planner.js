// AI planning: builds the prompt on the server, asks for structured JSON, then validates it.
const OpenAI = require("openai");
const {
  DEFAULT_TIME_ZONE,
  canonicalTimeZone,
  normalizeAiEvent,
  nowIn,
  describeNow,
} = require("./dates");

// The OpenAI SDK works with any OpenAI-compatible API (Google Gemini, OpenAI, Groq…).
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

const hasApiKey = () => Boolean(process.env.AI_API_KEY || process.env.OPENAI_API_KEY);

const isCapacityError = (e) =>
  e instanceof OpenAI.InternalServerError || e instanceof OpenAI.RateLimitError ||
  e instanceof OpenAI.APIConnectionTimeoutError;

// If the device clock is further off than this from the server, the server's time is used.
const CLOCK_TOLERANCE_MS = 5 * 60 * 1000;

// Structured output: the model must answer with exactly this JSON shape.
const PLAN_SCHEMA = {
  type: "object",
  properties: {
    reply: { type: "string", description: "Message shown to the user. Plain text, no JSON." },
    events: {
      type: "array",
      description: "The FULL plan when proposing or changing it; empty when asking questions or just chatting.",
      items: {
        type: "object",
        properties: {
          summary: { type: "string" },
          description: { type: "string" },
          start: { type: "string", description: "Local time YYYY-MM-DDTHH:mm:ss, no offset" },
          end: { type: "string", description: "Local time YYYY-MM-DDTHH:mm:ss, no offset" },
          timeZone: { type: "string", description: "IANA time zone, e.g. America/Los_Angeles" },
        },
        required: ["summary", "description", "start", "end", "timeZone"],
        additionalProperties: false,
      },
    },
  },
  required: ["reply", "events"],
  additionalProperties: false,
};

function systemPrompt({ timeZone, now, currentPlan, edits }) {
  let text = `You are a planning assistant that turns the user's goal into a concrete schedule of calendar events.

Current date and time: ${describeNow(timeZone, now)} (${nowIn(timeZone, now)} in ${timeZone}).

Always answer with JSON: {"reply": string, "events": [...]}.
- reply: what you say to the user, in plain text (no JSON, no code blocks). Keep it short and friendly.
- If important details are missing (start date, preferred time of day, session length, level), ask at most 2-3 short questions in reply and return "events": [].
- When you have enough information, return the FULL plan in events (not only the changed events) and summarize it in one or two sentences in reply.
- If the user only asks a question and does not want the plan changed, return "events": [].

Event rules:
- start and end: local wall-clock time "YYYY-MM-DDTHH:mm:ss" with no "Z" and no UTC offset, in the event's timeZone.
- timeZone: an IANA name such as "America/Los_Angeles", never an abbreviation like "PST". Use ${timeZone} unless the user asks for another one.
- Every event must start after the current date and time above, and end after it starts.
- summary: a short title. description: the concrete tasks or exercises for that session.`;

  if (Array.isArray(currentPlan) && currentPlan.length > 0) {
    text += `

The user's current plan is below. It is the source of truth and already includes their manual edits:
${JSON.stringify(currentPlan.map(({ summary, description, start, end, timeZone }) => ({ summary, description, start, end, timeZone })), null, 1)}`;
  }

  if (Array.isArray(edits) && edits.length > 0) {
    text += `

Manual edits the user made to your last plan:
${edits.map((e) => `- ${describeEdit(e)}`).join("\n")}
Keep these edits when you return an updated plan, unless the user asks you to change them.`;
  }
  return text;
}

function describeEdit(edit) {
  const name = `"${String(edit.title || "Untitled").slice(0, 120)}"`;
  if (edit.type === "added") return `Added event ${name}.`;
  if (edit.type === "removed") return `Removed event ${name}.`;
  const changes = (edit.changes || [])
    .map((c) => `${c.field} changed from ${JSON.stringify(String(c.from ?? "").slice(0, 300))} to ${JSON.stringify(String(c.to ?? "").slice(0, 300))}`)
    .join("; ");
  return `Edited event ${name}: ${changes}.`;
}

/** Chat history as proper chat messages; assistant turns carry only their reply text. */
function historyMessages(messages) {
  return (messages || [])
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map((m) => ({
      role: m.role,
      content: m.role === "assistant" && m.planSize
        ? `${m.content}\n(I proposed a plan with ${m.planSize} events.)`
        : m.content,
    }));
}

async function complete(messages) {
  let lastError;
  for (const model of [AI_MODEL, ...AI_FALLBACK_MODELS]) {
    try {
      const completion = await ai.chat.completions.create({
        model,
        messages,
        response_format: { type: "json_schema", json_schema: { name: "plan", schema: PLAN_SCHEMA, strict: true } },
      });
      if (model !== AI_MODEL) console.warn(`[ai] answered by fallback model ${model}`);
      return completion.choices?.[0]?.message?.content || "";
    } catch (err) {
      lastError = err;
      if (isCapacityError(err)) {
        console.warn(`[ai] ${model} unavailable (${err.message.slice(0, 120)}); trying the next model`);
        continue;
      }
      break;
    }
  }
  throw lastError;
}

/** Parses the model's JSON, tolerating stray code fences or text around it. */
function parsePlanJson(content) {
  const candidates = [content, content.replace(/^```(?:json)?\s*|\s*```$/g, "")];
  const first = content.indexOf("{");
  const last = content.lastIndexOf("}");
  if (first !== -1 && last > first) candidates.push(content.slice(first, last + 1));
  for (const text of candidates) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object") {
        return {
          reply: typeof parsed.reply === "string" ? parsed.reply : "",
          events: Array.isArray(parsed.events) ? parsed.events : [],
        };
      }
    } catch {
      // try the next candidate
    }
  }
  return null;
}

function normalizeEvents(rawEvents, timeZone) {
  const events = [];
  const warnings = [];
  for (const raw of rawEvents) {
    const result = normalizeAiEvent(raw, timeZone);
    warnings.push(...result.warnings);
    if (result.event) events.push(result.event);
  }
  return { events, warnings };
}

const pastEvents = (events, now) => events.filter((e) => e.start < nowIn(e.timeZone, now));

/**
 * Main entry: returns { reply, events (array or null when the plan is unchanged), warnings }.
 * Re-asks the model once if its JSON is invalid, and once if it scheduled events in the past.
 */
async function generatePlan({ messages, currentPlan, edits, client }) {
  const warnings = [];

  // Use the device's time zone, and its clock unless it disagrees with the server's.
  const timeZone = canonicalTimeZone(client?.timeZone) || DEFAULT_TIME_ZONE;
  const serverNow = new Date();
  let now = serverNow;
  const clientNow = client?.now ? new Date(client.now) : null;
  if (clientNow && !isNaN(clientNow) && Math.abs(clientNow - serverNow) > CLOCK_TOLERANCE_MS) {
    const minutes = Math.round((clientNow - serverNow) / 60000);
    warnings.push(`Your device clock is ${Math.abs(minutes)} minutes ${minutes > 0 ? "ahead" : "behind"}; the plan uses the correct current time.`);
  } else if (clientNow && !isNaN(clientNow)) {
    now = clientNow;
  }

  const conversation = [
    { role: "system", content: systemPrompt({ timeZone, now, currentPlan, edits }) },
    ...historyMessages(messages),
  ];

  let content = await complete(conversation);
  let parsed = parsePlanJson(content);
  if (!parsed) {
    conversation.push(
      { role: "assistant", content },
      { role: "user", content: 'Your last answer was not valid JSON. Answer again with only {"reply": string, "events": [...]}.' }
    );
    content = await complete(conversation);
    parsed = parsePlanJson(content);
    if (!parsed) throw new Error("The AI returned a reply that couldn't be read. Please try again.");
  }

  let { events, warnings: eventWarnings } = normalizeEvents(parsed.events, timeZone);

  // Timestamp check: if anything is scheduled before "now", ask the model to fix it once.
  const late = pastEvents(events, now);
  if (late.length > 0) {
    conversation.push(
      { role: "assistant", content },
      {
        role: "user",
        content: `These events start in the past (the current time is ${nowIn(timeZone, now)} in ${timeZone}): ${late
          .map((e) => `"${e.summary}" at ${e.start}`)
          .join(", ")}. Move them to future times and return the full corrected plan in the same JSON format.`,
      }
    );
    const retry = parsePlanJson(await complete(conversation));
    if (retry && retry.events.length > 0) {
      parsed = { reply: retry.reply || parsed.reply, events: retry.events };
      ({ events, warnings: eventWarnings } = normalizeEvents(retry.events, timeZone));
    }
    const stillLate = pastEvents(events, now);
    if (stillLate.length > 0) {
      warnings.push(`${stillLate.length} event${stillLate.length === 1 ? " is" : "s are"} still in the past; please adjust ${stillLate.length === 1 ? "its" : "their"} time before importing.`);
    }
  }

  warnings.push(...eventWarnings);
  return {
    reply: parsed.reply.trim() || (events.length ? "Here's your plan." : "Could you tell me a bit more?"),
    events: events.length > 0 ? events : null,
    warnings,
  };
}

module.exports = { generatePlan, hasApiKey };
