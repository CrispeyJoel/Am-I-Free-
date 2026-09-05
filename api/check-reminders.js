const admin = require("firebase-admin");
const { DateTime } = require("luxon");

// ------------------------------------------------------------
// FIREBASE INITIALIZATION
// ------------------------------------------------------------

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();

// ------------------------------------------------------------
// RECURRENCE HELPERS
// ------------------------------------------------------------

function occursOn(ev, dateStr) {
  if (!ev.dateISO) return false;

  // Extract purely the YYYY-MM-DD portion to avoid UTC offset shifts
  const anchorStr = ev.dateISO.split("T")[0];
  const anchor = DateTime.fromISO(anchorStr, { zone: "UTC" });
  const target = DateTime.fromISO(dateStr, { zone: "UTC" });

  const diff = Math.round(target.diff(anchor, "days").days);

  if (diff < 0) {
    return false;
  }

  if (ev.recurrence === "weekly") {
    return diff % 7 === 0;
  }

  if (ev.recurrence === "fortnightly") {
    return diff % 14 === 0;
  }

  return diff === 0;
}

// ------------------------------------------------------------
// EVENT TIMES HELPERS
// ------------------------------------------------------------

function getEventTimes(ev, occurrenceDateStr, timezone) {
  const startMinutes = Number(ev.start) || 0;
  const bufferBefore = Number(ev.bufferBefore) || 0;

  const eventLocal = DateTime.fromISO(occurrenceDateStr, {
    zone: timezone
  }).plus({
    minutes: startMinutes
  });

  const leaveLocal = eventLocal.minus({
    minutes: bufferBefore
  });

  return {
    eventLocal,
    leaveLocal
  };
}

function reminderDateTime(ev, occurrenceDateStr, timezone) {
  const { leaveLocal } = getEventTimes(ev, occurrenceDateStr, timezone);
  const reminder = ev.reminder || "30m";

  switch (reminder) {
    case "30m":
      return leaveLocal.minus({ minutes: 30 });
    case "1h":
      return leaveLocal.minus({ hours: 1 });
    case "6h":
      return leaveLocal.minus({ hours: 6 });
    case "12h":
      return leaveLocal.minus({ hours: 12 });
    case "1d":
      return leaveLocal.minus({ days: 1 });
    case "1w":
      return leaveLocal.minus({ weeks: 1 });
    case "1mo":
      return leaveLocal.minus({ months: 1 });
    case "none":
      return null;
    default:
      return leaveLocal.minus({ minutes: 30 });
  }
}

// ------------------------------------------------------------
// HANDLER
// ------------------------------------------------------------

module.exports = async (req, res) => {
  try {
    // Security verification
    if (req.query.secret !== process.env.CRON_SECRET) {
      return res.status(401).json({
        ok: false,
        error: "unauthorized"
      });
    }

    const nowUtc = DateTime.utc();
    console.log("CRON START", nowUtc.toISO());

    const usersSnap = await db.collection("users").get();
    console.log("Users found:", usersSnap.size);

    let totalSent = 0;
    let totalChecked = 0;
    let totalSkipped = 0;
    let totalFailed = 0;

    // Process all users concurrently using Promise.all to avoid serverless timeouts
    const userResults = await Promise.all(
      usersSnap.docs.map(async (userDoc) => {
        let sent = 0;
        let checked = 0;
        let skipped = 0;
        let failed = 0;

        const user = userDoc.data();

        if (!user.pushToken || !user.timezone) {
          console.log("USER SKIPPED", userDoc.id, {
            hasPushToken: !!user.pushToken,
            timezone: user.timezone || null
          });
          return { sent, checked, skipped, failed };
        }

        const localNow = nowUtc.setZone(user.timezone);

        const dataDoc = await db
          .collection("users")
          .doc(userDoc.id)
          .collection("data")
          .doc("events")
          .get();

        if (!dataDoc.exists) {
          console.log("NO EVENTS DOCUMENT", userDoc.id);
          return { sent, checked, skipped, failed };
        }

        const events = dataDoc.data().list || [];

        // Check 1 day in the past up to 35 days into the future
        const firstDate = localNow.startOf("day").minus({ days: 1 });
        const lastDate = localNow.startOf("day").plus({ days: 35 });

        for (const ev of events) {
          if (!ev.dateISO || ev.start == null) continue;

          let cursor = firstDate;

          while (cursor <= lastDate) {
            const occurrenceDateStr = cursor.toISODate();

            if (!occursOn(ev, occurrenceDateStr)) {
              cursor = cursor.plus({ days: 1 });
              continue;
            }

            checked++;

            const { eventLocal, leaveLocal } = getEventTimes(
              ev,
              occurrenceDateStr,
              user.timezone
            );

            const notifyLocal = reminderDateTime(
              ev,
              occurrenceDateStr,
              user.timezone
            );

            if (!notifyLocal) {
              skipped++;
              cursor = cursor.plus({ days: 1 });
              continue;
            }

            const diffMin = notifyLocal.diff(localNow, "minutes").minutes;

            // Skip if reminder is in the future (>0) or due more than 10 minutes ago
            if (diffMin > 0 || diffMin < -10) {
              skipped++;
              cursor = cursor.plus({ days: 1 });
              continue;
            }

            // Check if already notified
            const key = `${ev.id}_${occurrenceDateStr}`;
            const notifiedRef = db
              .collection("users")
              .doc(userDoc.id)
              .collection("notified")
              .doc(key);

            const already = await notifiedRef.get();

            if (already.exists) {
              console.log("ALREADY NOTIFIED", key);
              cursor = cursor.plus({ days: 1 });
              continue;
            }

            // Send FCM Push Notification
            try {
              console.log("SENDING PUSH", ev.title);

              const title = ev.title || "Actually Free";
              const body = `Leave at ${leaveLocal.toFormat("h:mm a")} for ${eventLocal.toFormat("h:mm a")}.`;

              await admin.messaging().send({
                token: user.pushToken,
                notification: {
                  title,
                  body
                },
                webpush: {
                  notification: {
                    title,
                    body,
                    icon: "https://am-i-free-eta.vercel.app/icon-192.png"
                  }
                },
                data: {
                  eventId: String(ev.id || ""),
                  occurrenceDate: occurrenceDateStr
                }
              });

              await notifiedRef.set({
                sentAt: nowUtc.toISO(),
                occurrenceDate: occurrenceDateStr
              });

              sent++;
              console.log("PUSH SENT", ev.title);
            } catch (err) {
              failed++;
              console.error("PUSH FAILED", {
                event: ev.title,
                eventId: ev.id,
                code: err.code,
                message: err.message
              });
            }

            cursor = cursor.plus({ days: 1 });
          }
        }

        return { sent, checked, skipped, failed };
      })
    );

    // Aggregate user metrics
    for (const resMetrics of userResults) {
      totalSent += resMetrics.sent;
      totalChecked += resMetrics.checked;
      totalSkipped += resMetrics.skipped;
      totalFailed += resMetrics.failed;
    }

    console.log("CRON COMPLETE", {
      sent: totalSent,
      checked: totalChecked,
      skipped: totalSkipped,
      failed: totalFailed
    });

    return res.status(200).json({
      ok: true,
      sent: totalSent,
      checked: totalChecked,
      skipped: totalSkipped,
      failed: totalFailed
    });
  } catch (err) {
    console.error("CRON ERROR", err);
    return res.status(500).json({
      ok: false,
      error: err.message
    });
  }
};