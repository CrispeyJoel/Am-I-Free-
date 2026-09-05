const admin = require("firebase-admin");
const { DateTime } = require("luxon");

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(
    process.env.FIREBASE_SERVICE_ACCOUNT
  );

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();

function occursOn(ev, dateStr) {
  const anchor = DateTime.fromISO(ev.dateISO, {
    zone: "UTC"
  });

  const target = DateTime.fromISO(dateStr, {
    zone: "UTC"
  });

  const diff = Math.round(
    target.diff(anchor, "days").days
  );

  if (diff < 0) return false;

  if (ev.recurrence === "weekly") {
    return diff % 7 === 0;
  }

  if (ev.recurrence === "fortnightly") {
    return diff % 14 === 0;
  }

  return diff === 0;
}

function getEventTimes(ev, occurrenceDateStr, timezone) {
  const eventLocal = DateTime
    .fromISO(occurrenceDateStr, {
      zone: timezone
    })
    .plus({
      minutes: Number(ev.start) || 0
    });

  const leaveLocal = eventLocal.minus({
    minutes: Number(ev.bufferBefore) || 0
  });

  return {
    eventLocal,
    leaveLocal
  };
}

function reminderDateTime(
  ev,
  occurrenceDateStr,
  timezone
) {
  const {
    leaveLocal
  } = getEventTimes(
    ev,
    occurrenceDateStr,
    timezone
  );

  const reminder = ev.reminder || "30m";

  switch (reminder) {
    case "30m":
      return leaveLocal.minus({
        minutes: 30
      });

    case "1h":
      return leaveLocal.minus({
        hours: 1
      });

    case "6h":
      return leaveLocal.minus({
        hours: 6
      });

    case "12h":
      return leaveLocal.minus({
        hours: 12
      });

    case "1d":
      return leaveLocal.minus({
        days: 1
      });

    case "1w":
      return leaveLocal.minus({
        weeks: 1
      });

    case "1mo":
      return leaveLocal.minus({
        months: 1
      });

    case "none":
      return null;

    default:
      return leaveLocal.minus({
        minutes: 30
      });
  }
}

module.exports = async (req, res) => {
  try {
    if (
      req.query.secret !==
      process.env.CRON_SECRET
    ) {
      return res.status(401).json({
        ok: false,
        error: "unauthorized"
      });
    }

    const nowUtc = DateTime.utc();

    let sent = 0;
    let checked = 0;
    let skipped = 0;
    let failed = 0;

    const usersSnap = await db
      .collection("users")
      .get();

    console.log(
      "CRON START",
      nowUtc.toISO()
    );

    console.log(
      "Users found:",
      usersSnap.size
    );

    for (const userDoc of usersSnap.docs) {
      const user = userDoc.data();

      if (
        !user.pushToken ||
        !user.timezone
      ) {
        continue;
      }

      const localNow =
        nowUtc.setZone(user.timezone);

      const dataDoc = await db
        .collection("users")
        .doc(userDoc.id)
        .collection("data")
        .doc("events")
        .get();

      if (!dataDoc.exists) {
        continue;
      }

      const events =
        dataDoc.data().list || [];

      const firstDate =
        localNow
          .startOf("day")
          .minus({ days: 1 });

      const lastDate =
        localNow
          .startOf("day")
          .plus({ days: 35 });

      for (const ev of events) {
        if (
          !ev.dateISO ||
          ev.start == null
        ) {
          continue;
        }

        let cursor = firstDate;

        while (cursor <= lastDate) {
          const occurrenceDateStr =
            cursor.toISODate();

          if (
            !occursOn(
              ev,
              occurrenceDateStr
            )
          ) {
            cursor = cursor.plus({
              days: 1
            });

            continue;
          }

          checked++;

          const {
            eventLocal,
            leaveLocal
          } = getEventTimes(
            ev,
            occurrenceDateStr,
            user.timezone
          );

          const notifyLocal =
            reminderDateTime(
              ev,
              occurrenceDateStr,
              user.timezone
            );

          if (!notifyLocal) {
            cursor = cursor.plus({
              days: 1
            });

            continue;
          }

          const diffMin =
            notifyLocal.diff(
              localNow,
              "minutes"
            ).minutes;

          console.log("REMINDER CHECK", {
            event: ev.title,
            eventId: ev.id,
            occurrence: occurrenceDateStr,
            timezone: user.timezone,
            reminder: ev.reminder,
            eventStart: eventLocal.toFormat("yyyy-MM-dd HH:mm:ss"),
            leaveAt: leaveLocal.toFormat("yyyy-MM-dd HH:mm:ss"),
            notifyAt: notifyLocal.toFormat("yyyy-MM-dd HH:mm:ss"),
            localNow: localNow.toFormat("yyyy-MM-dd HH:mm:ss"),
            diffMin: Number(diffMin.toFixed(2))
          });

          if (diffMin > 0) {
            skipped++;

            cursor = cursor.plus({
              days: 1
            });

            continue;
          }

          if (diffMin < -5) {
            skipped++;

            cursor = cursor.plus({
              days: 1
            });

            continue;
          }

          console.log(
            "REMINDER DUE",
            {
              event: ev.title,
              occurrence: occurrenceDateStr,
              diffMin
            }
          );

          const key =
            `${ev.id}_${occurrenceDateStr}`;

          const notifiedRef = db
            .collection("users")
            .doc(userDoc.id)
            .collection("notified")
            .doc(key);

          const already =
            await notifiedRef.get();

          if (already.exists) {
            console.log(
              "ALREADY NOTIFIED",
              key
            );

            cursor = cursor.plus({
              days: 1
            });

            continue;
          }

          try {
            console.log(
              "SENDING PUSH",
              ev.title
            );

            // ... Firebase send code ...

          } catch (err) {
            failed++;

            console.error(
              "PUSH FAILED",
              {
                event: ev.title,
                code: err.code,
                message: err.message
              }
            );
          }

          cursor = cursor.plus({
            days: 1
          });

            continue;
          }

          try {
            console.log(
              "SENDING PUSH",
              ev.title
            );

            await admin
              .messaging()
              .send({
                token:
                  user.pushToken,

                notification: {
                  title:
                    ev.title ||
                    "Actually Free",

                  body:
                    `Leave at ${leaveLocal.toFormat(
                      "h:mm a"
                    )} for ${eventLocal.toFormat(
                      "h:mm a"
                    )}.`
                },

                webpush: {
                  notification: {
                    title:
                      ev.title ||
                      "Actually Free",

                    body:
                      `Leave at ${leaveLocal.toFormat(
                        "h:mm a"
                      )} for ${eventLocal.toFormat(
                        "h:mm a"
                      )}.`,

                    icon:
                      "https://am-i-free-eta.vercel.app/icon-192.png"
                  }
                }
              });

            await notifiedRef.set({
              sentAt:
                nowUtc.toISO(),

              occurrenceDate:
                occurrenceDateStr
            });

            sent++;

            console.log(
              "PUSH SENT",
              ev.title
            );

          } catch (err) {
            failed++;

            console.error(
              "PUSH FAILED",
              {
                event: ev.title,
                code: err.code,
                message: err.message
              }
            );
          }

          cursor = cursor.plus({
            days: 1
          });
        }
      }
    }

    console.log(
      "CRON COMPLETE",
      {
        sent,
        checked,
        skipped,
        failed
      }
    );

    return res.status(200).json({
      ok: true,
      sent,
      checked,
      skipped,
      failed
    });

  } catch (err) {
    console.error(
      "CRON ERROR",
      err
    );

    return res.status(500).json({
      ok: false,
      error: err.message
    });
  }
};