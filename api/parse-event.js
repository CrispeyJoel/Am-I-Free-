// Turns a typed or spoken sentence into a structured event using Google's
// free Gemini API. The key lives only in this server-side function (env var
// GEMINI_API_KEY) — it never reaches the browser.

const DEFAULT_CATEGORIES = [
  { name: "Work", earnsDefault: true },
  { name: "Tutoring", earnsDefault: true },
  { name: "Friends", earnsDefault: false },
  { name: "Family", earnsDefault: false },
  { name: "Personal", earnsDefault: false }
];

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    title: {
      type: "string",
      description: "A short, clean, human-readable event name — just the activity/person, e.g. 'Piano lesson with Zach', 'Team meeting', 'Dentist appointment'. NEVER include times, dates, day names, or filler/connector words like 'schedule', 'at', 'for', 'on', 'o'clock'."
    },
    date: { type: "string", description: "YYYY-MM-DD" },
    time: { type: "string", description: "24-hour HH:MM, best guess if not stated" },
    duration: { type: "integer", description: "minutes" },
    category: { type: "string" },
    bufferBefore: { type: "integer", description: "minutes of travel buffer before the event" },
    bufferAfter: { type: "integer", description: "minutes of travel buffer after the event" },
    mandatory: { type: "boolean" },
    earnsMoney: { type: "boolean" },
    recurrence: { type: "string", enum: ["none", "weekly", "fortnightly"] },
    reminder: { type: "string", enum: ["none", "30m", "1h", "6h", "12h", "1d", "1w", "1mo"] }
  },
  required: [
    "title", "date", "time", "duration", "category",
    "bufferBefore", "bufferAfter", "mandatory", "earnsMoney", "recurrence", "reminder"
  ]
};

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method not allowed" });
  }

  const { text, timezone, todayISO, categories } = req.body || {};
  if (!text || !text.trim()) {
    return res.status(400).json({ error: "missing text" });
  }
  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: "GEMINI_API_KEY is not set" });
  }

  const catList = Array.isArray(categories) && categories.length ? categories : DEFAULT_CATEGORIES;
  const catDescriptions = catList
    .map(c => `${c.name} (earns money by default: ${!!c.earnsDefault})`)
    .join(", ");

    const prompt = `You turn a spoken or typed sentence into a calendar event for a personal scheduling app.

    Today's date is ${todayISO || new Date().toISOString().slice(0, 10)} in timezone ${timezone || "Australia/Sydney"}.

    Resolve relative dates such as "tomorrow", "next Tuesday", and "Friday" against today's date.

    Categories available: ${catDescriptions}.
    Pick the closest matching category.
    Default to "Personal" if nothing fits.

    DEFAULTS:
    - Duration: 60 minutes unless stated.
    - Travel buffer: 30 minutes before and 30 minutes after.
    - If the user says "no buffer", "no travel time", etc., use 0.
    - Mandatory: true unless the user clearly says it is optional or flexible.
    - Reminder: 30m unless another reminder time is explicitly stated.

    TITLE EXTRACTION IS EXTREMELY IMPORTANT.

    The title must contain ONLY the actual activity, appointment, task, or person involved.

    The title must NEVER contain:
    - dates
    - days of the week
    - times
    - "at"
    - "on"
    - "for"
    - "tomorrow"
    - "today"
    - "next week"
    - "schedule"
    - "calendar"
    - "remind me"
    - "put in"
    - "add"
    - "book"
    - "please"
    - "can you"
    - "I need to"
    - "I have to"
    - conversational filler
    - instructions to the assistant
    - the entire original sentence

    Treat the input as a voice transcription, not as text that should be copied.

    Extract the smallest natural phrase that describes the event.

    For example:

    "can you put piano lesson with Zach into my calendar tomorrow at four"
    TITLE = "Piano lesson with Zach"

    "hey can you add work Friday at 9am"
    TITLE = "Work"

    "please remind me that I have a dentist appointment next Tuesday at 10"
    TITLE = "Dentist appointment"

    "uh can you put dinner with Sarah in for Saturday at seven"
    TITLE = "Dinner with Sarah"

    "I need to pick up the dry cleaning tomorrow at five"
    TITLE = "Pick up dry cleaning"

    "schedule my tutoring session with James at 4pm"
    TITLE = "Tutoring session with James"

    "can you add a meeting with John from work at 2"
    TITLE = "Meeting with John"

    If the sentence contains a long conversational introduction, completely ignore that introduction.

    Do NOT copy the sentence into the title.

    Do NOT include more information than necessary.

    If you are uncertain, prefer a short title over a long title.

    Sentence:
    "${text.trim()}"`

  try {
    const geminiRes = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": process.env.GEMINI_API_KEY
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: RESPONSE_SCHEMA
          }
        })
      }
    );

    const data = await geminiRes.json();
    if (!geminiRes.ok) {
      return res.status(502).json({ error: (data.error && data.error.message) || "Gemini request failed" });
    }

    const raw = data.candidates && data.candidates[0] && data.candidates[0].content
      && data.candidates[0].content.parts && data.candidates[0].content.parts[0]
      && data.candidates[0].content.parts[0].text;

    if (!raw) {
      return res.status(502).json({ error: "No content returned from Gemini" });
    }

    const parsed = JSON.parse(raw);
    return res.status(200).json(parsed);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};