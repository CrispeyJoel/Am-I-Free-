import { GoogleGenAI, Type } from "@google/genai";

const DEFAULT_CATEGORIES = [
  { name: "Work", earnsDefault: true },
  { name: "Tutoring", earnsDefault: true },
  { name: "Friends", earnsDefault: false },
  { name: "Family", earnsDefault: false },
  { name: "Personal", earnsDefault: false }
];

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    title: {
      type: Type.STRING,
      description: "A short, clean, human-readable event name — just the activity/person, e.g. 'Piano lesson with Zach', 'Team meeting', 'Dentist appointment'. NEVER include times, dates, day names, or filler/connector words like 'schedule', 'at', 'for', 'on', 'o'clock'."
    },
    date: { type: Type.STRING, description: "YYYY-MM-DD" },
    time: { type: Type.STRING, description: "24-hour HH:MM, best guess if not stated" },
    duration: { type: Type.INTEGER, description: "minutes" },
    category: { type: Type.STRING },
    bufferBefore: { type: Type.INTEGER, description: "minutes of travel buffer before the event" },
    bufferAfter: { type: Type.INTEGER, description: "minutes of travel buffer after the event" },
    mandatory: { type: Type.BOOLEAN },
    earnsMoney: { type: Type.BOOLEAN },
    recurrence: { type: Type.STRING, enum: ["none", "weekly", "fortnightly"] },
    reminder: { type: Type.STRING, enum: ["none", "30m", "1h", "6h", "12h", "1d", "1w", "1mo"] }
  },
  required: [
    "title", "date", "time", "duration", "category",
    "bufferBefore", "bufferAfter", "mandatory", "earnsMoney", "recurrence", "reminder"
  ]
};

export default async function handler(req, res) {
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

Sentence:
"${text.trim()}"`;

  try {
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const response = await ai.models.generateContent({
      model: "gemini-1.5-flash",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: RESPONSE_SCHEMA
      }
    });

    const raw = response.text;
    if (!raw) {
      return res.status(502).json({ error: "No content returned from Gemini" });
    }

    const parsed = JSON.parse(raw);
    return res.status(200).json(parsed);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}