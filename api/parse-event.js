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
      description:
        "The shortest useful name for the event. Use 2 to 8 words. Describe only the activity, task, place, or person. Never include the date, weekday, time, duration, reminder, travel information, or conversational filler. Never copy the user's whole sentence."
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
      description: "Travel/preparation buffer before the event in minutes."
    },
    bufferAfter: {
      type: "integer",
      description: "Travel/recovery buffer after the event in minutes."
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

function cleanTitle(title, input) {
  let value = String(title || "").trim();
  const original = String(input || "").trim();

  value = value
    .replace(/^[\s"'`]+|[\s"'`]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  const words = value.split(/\s+/).filter(Boolean);
  const originalWords = original.split(/\s+/).filter(Boolean);

  // Gemini occasionally returns the entire spoken sentence despite the schema.
  // Reject that output and derive a short fallback from the input.
  const looksLikeWholeSentence =
    !value ||
    words.length > 8 ||
    (originalWords.length >= 8 && words.length >= originalWords.length * 0.75);

  if (looksLikeWholeSentence) {
    value = original
      .replace(/\b(?:please|could you|can you|would you|i want to|i need to|remind me to|remind me|schedule|add|create|book|put|set up)\b/gi, "")
      .replace(/\b(?:today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)\b/gi, "")
      .replace(/\b(?:at|around|by)\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/gi, "")
      .replace(/\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/gi, "")
      .replace(/\s+/g, " ")
      .replace(/^[,\-–:;\s]+|[,\-–:;\s]+$/g, "")
      .trim();
  }

  // Remove conversational fragments that sometimes survive transcription.
  value = value
    .replace(/^(?:okay|ok|uh|um|er|so|yeah|yep|please)[,:]?\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();

  const finalWords = value.split(/\s+/).filter(Boolean);
  if (finalWords.length > 8) {
    value = finalWords.slice(0, 8).join(" ");
  }

  return value || "Untitled";
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

  const prompt = `You are the event parser for a personal calendar app.

Convert the user's spoken or typed sentence into exactly one calendar event.

Today's date is ${today} in timezone ${tz}.
Resolve relative dates such as "tomorrow", "next Tuesday", and "Friday" from that date. A bare weekday means the next occurrence.

Available categories: ${catDescriptions}.
Choose the closest category. Use Personal if nothing fits.

Defaults:
- duration: 60 minutes
- bufferBefore: 30 minutes
- bufferAfter: 30 minutes
- mandatory: true
- reminder: 30m
- recurrence: none

TITLE RULES ARE CRITICAL:
- title must be ONLY the core event name.
- title must contain 2 to 8 words where possible.
- NEVER include a time, date, weekday, duration, reminder, buffer, or travel instruction.
- NEVER include words such as schedule, add, create, book, remind me, at, on, tomorrow, today, next, or o'clock when they are only instructions.
- NEVER copy the whole user sentence into title.
- Ignore speech-to-text filler such as "um", "uh", "okay", "so", and "please".
- If the user says "Schedule piano lesson with Zach next Tuesday at 4pm", title must be "Piano lesson with Zach".
- If the user says "Can you put dentist appointment tomorrow at nine", title must be "Dentist appointment".
- If the user says "I have tutoring with Sarah at 5", title must be "Tutoring with Sarah".
- If the user says "Go to the gym Friday at 6", title must be "Gym".

Return only the structured JSON matching the response schema.

User sentence: ${JSON.stringify(input)}`;

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
        error:
          (data.error && data.error.message) ||
          "Gemini request failed"
      });
    }

    const raw =
      data.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!raw) {
      return res.status(502).json({
        error: "No content returned from Gemini"
      });
    }

    const parsed = JSON.parse(raw);
    parsed.title = cleanTitle(parsed.title, input);

    // Clamp obviously broken numeric values before returning them to the app.
    parsed.duration = Math.min(
      1440,
      Math.max(5, Number(parsed.duration) || 60)
    );

    parsed.bufferBefore = Math.min(
      180,
      Math.max(0, Number(parsed.bufferBefore) || 0)
    );

    parsed.bufferAfter = Math.min(
      180,
      Math.max(0, Number(parsed.bufferAfter) || 0)
    );

    return res.status(200).json(parsed);
  } catch (error) {
    console.error("Gemini event parsing failed:", error);
    return res.status(500).json({ error: error.message });
  }
};
