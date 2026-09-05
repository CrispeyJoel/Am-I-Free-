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
Today's date is ${todayISO || new Date().toISOString().slice(0, 10)} in timezone ${timezone || "Australia/Sydney"}. Resolve relative dates ("tomorrow", "next Tuesday", "Friday") against that date — pick the NEXT occurrence of a named weekday if today isn't that day.
Categories available: ${catDescriptions}. Pick the closest matching one; default to "Personal" if nothing fits.
Default duration is 60 minutes unless stated.
Default travel buffer is 30 minutes before and 30 minutes after, unless the sentence specifies a different amount or says something like "no buffer" (then use 0).
Default "mandatory" to true unless the sentence implies it's optional or flexible (e.g. "if I have time", "maybe").
Default "reminder" to "30m" unless the sentence names a different lead time.

The "title" must be a clean, short event name only — the activity or who it's with. Strip out everything else: no "schedule", "at", "for", "on", "o'clock", times, dates, or day names. If the input is messy voice-transcription filler, extract just the core activity.

Examples:
- "Schedule work for four o'clock" → title: "Work"
- "Piano lesson with Zach next Tuesday at 4pm" → title: "Piano lesson with Zach"
- "Remind me to pick up dry cleaning tomorrow at 5" → title: "Pick up dry cleaning"
- "Dentist appointment Friday 9am no buffer" → title: "Dentist appointment"

Sentence: "${text.trim()}"`;

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