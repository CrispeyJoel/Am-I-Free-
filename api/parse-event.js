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
      description: "The concise title of the event (1 to 6 words). Omit times, dates, and instructions."
    },
    date: {
      type: "string",
      description: "Event date in YYYY-MM-DD format."
    },
    time: {
      type: "string",
      description: "Event start time in 24-hour HH:MM format."
    },
    duration: {
      type: "integer",
      description: "Event duration in minutes."
    },
    category: {
      type: "string",
      description: "One of the available category names."
    },
    bufferBefore: {
      type: "integer",
      description: "Travel/preparation buffer before event in minutes."
    },
    bufferAfter: {
      type: "integer",
      description: "Travel/recovery buffer after event in minutes."
    },
    mandatory: {
      type: "boolean",
      description: "Whether the event is mandatory."
    },
    earnsMoney: {
      type: "boolean",
      description: "Whether the event earns money."
    },
    recurrence: {
      type: "string",
      enum: ["none", "weekly", "fortnightly"]
    },
    reminder: {
      type: "string",
      enum: ["none", "30m", "1h", "6h", "12h", "1d", "1w", "1mo"]
    }
  },
  required: [
    "title",
    "date",
    "time",
    "duration",
    "category",
    "bufferBefore",
    "bufferAfter",
    "mandatory",
    "earnsMoney",
    "recurrence",
    "reminder"
  ]
};

function cleanTitle(title) {
  if (!title) return "Untitled";

  let value = String(title)
    .replace(/^[\s"'`]+|[\s"'`]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  // Strip leading speech fillers if retained by transcription
  value = value.replace(/^(?:okay|ok|uh|um|er|so|yeah|yep|please)[,:]?\s*/i, "").trim();

  // Enforce word count limit as safety guardrail
  const words = value.split(/\s+/);
  if (words.length > 7) {
    value = words.slice(0, 7).join(" ");
  }

  // Capitalize first character
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : "Untitled";
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method not allowed" });
  }

  const { text, timezone, todayISO, categories } = req.body || {};

  if (!text || !String(text).trim()) {
    return res.status(400).json({ error: "missing text" });
  }

  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: "GEMINI_API_KEY is not set" });
  }

  const catList =
    Array.isArray(categories) && categories.length
      ? categories
      : DEFAULT_CATEGORIES;

  const catDescriptions = catList
    .map(c => `${c.name} (earns money by default: ${!!c.earnsDefault})`)
    .join(", ");

  const input = String(text).trim();
  const today = todayISO || new Date().toISOString().slice(0, 10);
  const tz = timezone || "Australia/Sydney";

  const prompt = `You are a calendar event parser. Extract event details from the user text into structured JSON.

Context:
- Today's Date: ${today} (${tz})
- Available Categories: ${catDescriptions}

Title Extraction Examples:
- "Schedule piano lesson with Zach next Tuesday at 4pm" -> "Piano Lesson with Zach"
- "Can you put dentist appointment tomorrow at nine" -> "Dentist Appointment"
- "Go to the gym Friday at 6" -> "Gym"
- "Remind me to do tutoring with Sarah at 5pm" -> "Tutoring with Sarah"
- "Work shift at the hospital from 8am to 4pm" -> "Work Shift"

Rules:
1. Title must be 1 to 6 words naming only the activity, person, or place.
2. Strip dates, times, days of the week, and setup phrasing (e.g. "remind me to", "schedule").
3. Default duration is 60 mins. Default buffers are 30 mins before/after. Default category is Personal if unclear.

User text: ${JSON.stringify(input)}`;

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
            responseSchema: RESPONSE_SCHEMA,
            temperature: 0.1
          }
        })
      }
    );

    const data = await geminiRes.json();

    if (!geminiRes.ok) {
      return res.status(502).json({
        error: (data.error && data.error.message) || "Gemini request failed"
      });
    }

    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!raw) {
      return res.status(502).json({
        error: "No content returned from Gemini"
      });
    }

    const parsed = JSON.parse(raw);

    // Format & clean output
    parsed.title = cleanTitle(parsed.title);

    parsed.duration = Math.min(
      1440,
      Math.max(5, Number(parsed.duration) || 60)
    );

    parsed.bufferBefore = Math.min(
      180,
      Math.max(0, Number(parsed.bufferBefore) ?? 30)
    );

    parsed.bufferAfter = Math.min(
      180,
      Math.max(0, Number(parsed.bufferAfter) ?? 30)
    );

    return res.status(200).json(parsed);
  } catch (error) {
    console.error("Gemini event parsing failed:", error);
    return res.status(500).json({ error: error.message });
  }
};