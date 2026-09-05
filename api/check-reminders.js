const admin = require("firebase-admin");
const { DateTime } = require("luxon");

// ---------- Firebase ----------

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(
    process.env.FIREBASE_SERVICE_ACCOUNT
  );

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();

// ---------- Recurrence ----------

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

// ---------- Reminder calculation ----------

function reminderDateTime(
  event,
  occurrenceDateStr,
  timezone
) {
  // Event start
  const eventLocal = DateTime
    .fromISO(occurrenceDateStr, {
      zone: timezone
    })
    .plus({
      minutes: Number(event.start) || 0
    });

  // Leaving time
  const leaveLocal = eventLocal.minus({
    minutes: Number(event.bufferBefore) || 0
  });

  // Old events without a reminder default to 30 minutes
  const reminder = event.reminder || "30m";

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

// ---------- Cron ----------

module.exports = async (req, res) => {
  try {
    // ---------- Security ----------

    if (
      req.query.secret !==
      process.env.CRON_SECRET
    ) {
      return res.status(401).json({
        ok: false,
        error: "unauthorized"
      });
    }

    // ---------- Current time ----------

    const nowUtc = DateTime.utc();

    let sent = 0;
    let checked = 0;
    let skipped = 0;
    let failed = 0;

    // ---------- Get users ----------

    const usersSnap = await db
      .collection("users")
      .get();

    console.log(
      `Checking ${usersSnap.size} users`
    );

    // ---------- Check each user ----------

    for (const userDoc of usersSnap.docs) {
      const user = userDoc.data();

      if (!user.pushToken) {
        console.log(
          "Skipping user with no push token:",
          userDoc.id
        );
        continue;
      }

      if (!user.timezone) {
        console.log(
          "Skipping user with no timezone:",
          userDoc.id
        );
        continue;
      }

      const localNow = nowUtc.setZone(
        user.timezone
      );

      console.log("User:", {
        id: userDoc.id,
        timezone: user.timezone,
        localNow: localNow.toISO()
      });

      // ---------- Get events ----------

      const dataDoc = await db
        .collection("users")
        .doc(userDoc.id)
        .collection("data")
        .doc("events")
        .get();

      if (!dataDoc.exists) {
        console.log(
          "No events document for:",
          userDoc.id
        );
        continue;
      }

      const events =
        dataDoc.data().list || [];

      console.log(
        `Found ${events.length} events for ${userDoc.id}`
      );

      // ---------- Date range ----------

      // We check from yesterday through 35 days ahead
      // because reminders can happen before an event.

      const firstDate = localNow
        .startOf("day")
        .minus({
          days: 1
        });

      const lastDate = localNow
        .startOf("day")
        .plus({
          days: 35
        });

      // ---------- Check events ----------

      for (const ev of events) {
        if (
          !ev.dateISO ||
          ev.start == null
        ) {
          console.log(
            "Skipping malformed event:",
            ev
          );
          continue;
        }

        let cursor = firstDate;

        while (cursor <= lastDate) {
          const occurrenceDateStr =
            cursor.toISODate();

          // Is the event occurring on this date?
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

          // ---------- Calculate event time ----------

          const eventLocal = DateTime
            .fromISO(
              occurrenceDateStr,
              {
                zone: user.timezone
              }
            )
            .plus({
              minutes:
                Number(ev.start) || 0
            });

          // ---------- Calculate leaving time ----------

          const leaveLocal =
            eventLocal.minus({
              minutes:
                Number(
                  ev.bufferBefore
                ) || 0
            });

          // ---------- Calculate reminder time ----------

          const notifyLocal =
            reminderDateTime(
              ev,
              occurrenceDateStr,
              user.timezone
            );

          // No reminder
          if (!notifyLocal) {
            console.log(
              "No reminder:",
              ev.title
            );

            cursor = cursor.plus({
              days: 1
            });

            continue;
          }

          // ---------- Calculate difference ----------

          const diffMin =
            notifyLocal.diff(
              localNow,
              "minutes"
            ).minutes;

          // ---------- Diagnostic logging ----------

          console.log(
            "REMINDER CHECK",
            {
              user: userDoc.id,
              event: ev.title,
              eventId: ev.id,
              occurrence:
                occurrenceDateStr,
              reminder:
                ev.reminder || "30m",
              now:
                localNow.toISO(),
              eventStart:
                eventLocal.toISO(),
              leaveAt:
                leaveLocal.toISO(),
              notifyAt:
                notifyLocal.toISO(),
              diffMin:
                Number(
                  diffMin.toFixed(2)
                )
            }
          );

          // ---------- Is reminder due? ----------

          // Send if reminder time is now
          // or happened within the last 5 minutes.

          if (
            diffMin > 0 ||
            diffMin < -5
          ) {
            skipped++;

            cursor = cursor.plus({
              days: 1
            });

            continue;
          }

          // ---------- Prevent duplicate notifications ----------

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
              "Already notified:",
              key
            );

            cursor = cursor.plus({
              days: 1
            });

            continue;
          }

          // ---------- Send notification ----------

          try {
            console.log(
              "SENDING PUSH:",
              {
                user: userDoc.id,
                event: ev.title,
                token:
                  user.pushToken
                    ? "present"
                    : "missing"
              }
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

            // Only mark as notified AFTER
            // Firebase successfully accepts the message.

            await notifiedRef.set({
              sentAt:
                nowUtc.toISO(),

              occurrenceDate:
                occurrenceDateStr
            });

            sent++;

            console.log(
              "PUSH SENT SUCCESSFULLY:",
              ev.title
            );

          } catch (err) {
            failed++;

            console.error(
              "PUSH SEND FAILED:",
              {
                user:
                  userDoc.id,
                event:
                  ev.title,
                error:
                  err.message,
                code:
                  err.code
              }
            );

            // Do NOT create notifiedRef.
            // The next cron run can retry.
          }

          cursor = cursor.plus({
            days: 1
          });
        }
      }
    }

    // ---------- Response ----------

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
      "NOTIFICATION CRON FAILED:",
      err
    );

    return res.status(500).json({
      ok: false,
      error:
        err.message
    });
  }
};