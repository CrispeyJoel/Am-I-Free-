const DEFAULT_CATEGORIES = [
  { name: "Work", earnsDefault: true },
  { name: "Tutoring", earnsDefault: true },
  { name: "Friends", earnsDefault: false },
  { name: "Family", earnsDefault: false },
  { name: "Personal", earnsDefault: false }
];

const TOOLS = [{
  functionDeclarations: [
    {
      name: "createEvent",
      description: "Create a new calendar event for the user.",
      parameters: {
        type: "OBJECT",
        properties: {
          title: { type: "STRING" },
          date: { type: "STRING", description: "YYYY-MM-DD" },
          time: { type: "STRING", description: "24-hour HH:MM" },
          duration: { type: "INTEGER", description: "minutes, default 60" },
          category: { type: "STRING" },
          bufferBefore: { type: "INTEGER", description: "Minutes of buffer before the event. Default 30 unless the user says otherwise. If the user explicitly says 'no buffer' or similar, use 0. ALWAYS include this field explicitly." },
          bufferAfter: { type: "INTEGER", description: "Minutes of buffer after the event. Default 30 unless the user says otherwise. If the user explicitly says 'no buffer' or similar, use 0. ALWAYS include this field explicitly." },
          mandatory: { type: "BOOLEAN" },
          earnsMoney: { type: "BOOLEAN" },
          allDay: { type: "BOOLEAN" },
          recurrenceDays: { type: "INTEGER", description: "0 = no repeat, 1 = daily, 7 = weekly" },
          reminder: { type: "STRING", enum: ["none", "30m", "1h", "6h", "12h", "1d", "1w", "1mo"] }
        },
        required: ["title", "date", "time", "bufferBefore", "bufferAfter"]
      }
    },
    {
      name: "deleteEvent",
      description: "Delete an existing event. Call this once per event if the user wants to delete more than one.",
      parameters: {
        type: "OBJECT",
        properties: {
          matchTitle: { type: "STRING" },
          matchDate: { type: "STRING", description: "YYYY-MM-DD, if known" },
          matchTime: { type: "STRING", description: "HH:MM, if known" }
        },
        required: ["matchTitle"]
      }
    },
    {
      name: "moveEvent",
      description: "Reschedule an existing event to a new date/time.",
      parameters: {
        type: "OBJECT",
        properties: {
          matchTitle: { type: "STRING" },
          matchDate: { type: "STRING" },
          matchTime: { type: "STRING" },
          newDate: { type: "STRING" },
          newTime: { type: "STRING" }
        },
        required: ["matchTitle", "newDate", "newTime"]
      }
    },
        {
      name: "editEvent",
      description: "Edit an existing event's details — category, buffers, title, mandatory status, earns-money flag, or reminder. Do NOT use this for date/time changes — use moveEvent for those. Only include the fields actually being changed.",
      parameters: {
        type: "OBJECT",
        properties: {
          matchTitle: { type: "STRING" },
          matchDate: { type: "STRING", description: "YYYY-MM-DD, if known" },
          matchTime: { type: "STRING", description: "HH:MM, if known" },
          newTitle: { type: "STRING" },
          category: { type: "STRING" },
          bufferBefore: { type: "INTEGER" },
          bufferAfter: { type: "INTEGER" },
          mandatory: { type: "BOOLEAN" },
          earnsMoney: { type: "BOOLEAN" },
          reminder: { type: "STRING", enum: ["none", "30m", "1h", "6h", "12h", "1d", "1w", "1mo"] },
          duration: { type: "INTEGER", description: "New length of the event in minutes, e.g. 120 for 'make it 2 hours long'." }
        },
        required: ["matchTitle"]
      }
    },
  ]
}];

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method not allowed" });
  if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: "GEMINI_API_KEY is not set" });

  const { message, history, events, categories, timezone, todayISO } = req.body || {};
  if (!message || !String(message).trim()) return res.status(400).json({ error: "missing message" });

  const catList = Array.isArray(categories) && categories.length ? categories : DEFAULT_CATEGORIES;
  const catDescriptions = catList.map(c => `${c.name} (earns money by default: ${!!c.earnsDefault})`).join(", ");
  const eventsJson = JSON.stringify(Array.isArray(events) ? events : []);

  const systemInstruction = `You are a helpful, concise calendar assistant inside a personal scheduling app.
Today's date is ${todayISO || new Date().toISOString().slice(0,10)} in timezone ${timezone || "Australia/Sydney"}.
Categories available: ${catDescriptions}.

Here is the user's events for the next ~45 days (and last 3), as JSON - each has id, title, date, start (minutes after midnight), duration (minutes), bufferBefore, bufferAfter, mandatory, allDay, category:
${eventsJson}

Behavior:
- If the user wants to CREATE, DELETE, or MOVE an event, call the matching tool. You can call multiple tools in one turn (e.g. deleting several events).
- If the user asks a QUESTION (e.g. "what's on Thursday", "am I free at 3pm", "do I have anything with Sarah this week"), answer directly and conversationally using the event data above — do not call a tool for pure questions. Compute free time by finding gaps between (start - bufferBefore) and (start + duration + bufferAfter) for each event on that day.
- ALWAYS include a short natural-language reply alongside any tool call — never call a tool with no accompanying text. Even one short sentence, e.g. "Done, no buffer either side."
- Keep responses SHORT and conversational, like a quick text to a friend — one sentence is often enough. Never use formal report language, bullet points, or headers in your replies.
- Refer to events by their plain name only (e.g. "your dentist appointment" or "piano lesson"), never with technical framing like "the event titled X" or "Event: X".
- In your reply text, always say dates naturally - "today", "tomorrow", "Sep 13" - never raw ISO format like 2026-09-13.
- When confirming an action, be brief: "Done — dinner's on Friday at 7." not "I have successfully created an event titled 'Dinner' on 2026-09-12 at 19:00."
- Only call a tool when the user is asking you to DO something. A question about something that already happened (e.g. "why did you...", "did that work?", "what category is that in?") is NEVER itself a reason to call a tool — just answer honestly in text, including saying so if you're not sure why something happened.
- To change details of an event you already created (buffers, category, title, etc.), prefer editEvent over deleting and recreating it — only delete+recreate if the user explicitly asks to delete it or reschedule it to a very different time.
- Buffers: when the user says "no buffer", "no buffers needed", or similar, you MUST set bufferBefore and bufferAfter to exactly 0 - this instruction overrides the normal 30-minute default completely. Do not default to 30 when the user has said this.
- Use editEvent for any change to an EXISTING event that isn't a date/time change (category, buffers, title, mandatory, earns money, reminder, DURATION — e.g. "make it 2 hours long"). Use moveEvent only when the user wants to change WHEN the event starts, not how long it runs.
- If a request is ambiguous (e.g. multiple events could match "delete my meeting"), ask a brief clarifying question instead of guessing.
- Never invent events that aren't in the data above.
- for example: "study session 9-10am, no buffer" → createEvent with bufferBefore: 0, bufferAfter: 0 — NOT 30.
- NEVER use em-dashes.
- CRITICAL: only ever claim you did something if you actually called the matching tool in this same turn. If a request isn't something any available tool can do, say so honestly instead of pretending it's done.
- Never invent events that aren't in the data above.`;

  const contents = [];
  if (Array.isArray(history)) {
    for (const turn of history) {
      contents.push({ role: turn.role === "model" ? "model" : "user", parts: [{ text: turn.text }] });
    }
  }
  contents.push({ role: "user", parts: [{ text: message }] });

  try {
    const geminiRes = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemInstruction }] },
          contents,
          tools: TOOLS,
          generationConfig: { temperature: 0.3 }
        })
      }
    );

    const data = await geminiRes.json();
    if (!geminiRes.ok) {
      return res.status(502).json({ error: (data.error && data.error.message) || "Gemini request failed" });
    }

    const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
    const actions = parts.filter(p => p.functionCall).map(p => ({ name: p.functionCall.name, args: p.functionCall.args || {} }));
    const textParts = parts.filter(p => p.text).map(p => p.text).join(" ").trim();

    if (actions.length) {
      return res.status(200).json({ type: "actions", actions, text: textParts || null });
    }
    return res.status(200).json({ type: "text", text: textParts || "..." });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}