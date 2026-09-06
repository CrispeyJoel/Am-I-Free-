export default async function handler(req, res) {
  if (!process.env.GEMINI_API_KEY) {
    return res.status(200).json({ status: "busy", detail: "GEMINI_API_KEY not set" });
  }

  const tryOnce = async () => {
    const r = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": process.env.GEMINI_API_KEY
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: "Reply with the word OK." }] }],
          generationConfig: { maxOutputTokens: 20 }
        })
      }
    );
    if (r.ok) return { ok: true };
    const data = await r.json().catch(() => ({}));
    return { ok: false, detail: (data.error && data.error.message) || `HTTP ${r.status}` };
  };

  try {
    let result = await tryOnce();
    if (!result.ok) {
      // one retry before declaring it actually down — avoids flagging one-off blips
      await new Promise(r => setTimeout(r, 600));
      result = await tryOnce();
    }
    return res.status(200).json(
      result.ok ? { status: "good" } : { status: "busy", detail: result.detail }
    );
  } catch (err) {
    return res.status(200).json({ status: "busy", detail: err.message });
  }
}