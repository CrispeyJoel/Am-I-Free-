// Called every few minutes by an external cron pinger (see README).
// Requires env vars FIREBASE_SERVICE_ACCOUNT (the JSON key, as a string) and CRON_SECRET.
const admin = require("firebase-admin");
const { DateTime } = require("luxon");

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

function occursOn(ev, dateStr) {
  const anchor = DateTime.fromISO(ev.dateISO);
  const target = DateTime.fromISO(dateStr);
  const diff = Math.round(target.diff(anchor, "days").days);
  if (diff < 0) return false;
  if (ev.recurrence === "weekly") return diff % 7 === 0;
  if (ev.recurrence === "fortnightly") return diff % 14 === 0;
  return diff === 0;
}

module.exports = async (req, res) => {
  if (req.query.secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const usersSnap = await db.collection("users").get();
  const nowUtc = DateTime.utc();
  let sent = 0;

  for (const userDoc of usersSnap.docs) {
    const user = userDoc.data();
    if (!user.pushToken || !user.timezone) continue;

    const localNow = nowUtc.setZone(user.timezone);
    const todayStr = localNow.toISODate();

    const dataDoc = await db.collection("users").doc(userDoc.id).collection("data").doc("events").get();
    if (!dataDoc.exists) continue;
    const events = dataDoc.data().list || [];

    for (const ev of events) {
      if (!occursOn(ev, todayStr)) continue;

      const notifyMinute = ev.start - (ev.bufferBefore || 0) - 30;
      const notifyLocal = DateTime.fromISO(todayStr, { zone: user.timezone }).plus({ minutes: notifyMinute });
      const diffMin = notifyLocal.diff(localNow, "minutes").minutes;

      // Fire once the reminder time has just passed (covers the gap between cron pings, ~5 min)
      if (diffMin > 0 || diffMin < -5) continue;

      const key = `${ev.id}_${todayStr}`;
      const notifiedRef = db.collection("users").doc(userDoc.id).collection("notified").doc(key);
      const already = await notifiedRef.get();
      if (already.exists) continue;

      const startLocal = DateTime.fromISO(todayStr, { zone: user.timezone }).plus({ minutes: ev.start });
      try {
        await admin.messaging().send({
          token: user.pushToken,
          notification: {
            title: ev.title,
            body: `Starts at ${startLocal.toFormat("h:mm a")}${ev.bufferBefore ? ` — build in your ${ev.bufferBefore} min buffer` : ""}`
          }
        });
        sent++;
      } catch (err) {
        console.error("Push send failed for", userDoc.id, err.message);
      }
      await notifiedRef.set({ sentAt: nowUtc.toISO() });
    }
  }

  res.status(200).json({ ok: true, sent });
};