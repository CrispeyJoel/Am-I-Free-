const admin = require("firebase-admin");
const { DateTime } = require("luxon");

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();


// ---------- Recurrence ----------

function occursOn(ev, dateStr) {
  const anchor = DateTime.fromISO(ev.dateISO, { zone: "UTC" });
  const target = DateTime.fromISO(dateStr, { zone: "UTC" });

  const diff = Math.round(target.diff(anchor, "days").days);

  if (diff < 0) return false;

  if (ev.recurrence === "weekly") {
    return diff % 7 === 0;
  }

  if (ev.recurrence === "fortnightly") {
    return diff % 14 === 0;
  }

  return diff === 0;
}


// ---------- Reminder calculation ----------

function reminderDateTime(event, occurrenceDateStr, timezone) {

  // Event start
  const eventLocal = DateTime
    .fromISO(occurrenceDateStr, { zone: timezone })
    .plus({
      minutes: event.start
    });

  // Leaving time = event start - buffer before
  const leaveLocal = eventLocal.minus({
    minutes: event.bufferBefore || 0
  });

  // Old events without a reminder get 30 minutes by default
  const reminder = event.reminder || "30m";

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
    default:
      return null;
  }
}


// ---------- Cron ----------

module.exports = async (req, res) => {

  try {

    // Security check
    if (req.query.secret !== process.env.CRON_SECRET) {
      return res.status(401).json({
        error: "unauthorized"
      });
    }

    const usersSnap = await db
      .collection("users")
      .get();

    const nowUtc = DateTime.utc();

    let sent = 0;
    let checked = 0;

    for (const userDoc of usersSnap.docs) {

      const user = userDoc.data();

      if (!user.pushToken || !user.timezone) {
        continue;
      }

      const localNow = nowUtc.setZone(user.timezone);

      const dataDoc = await db
        .collection("users")
        .doc(userDoc.id)
        .collection("data")
        .doc("events")
        .get();

      if (!dataDoc.exists) {
        continue;
      }

      const events = dataDoc.data().list || [];


      /*
       * Look at occurrence dates from yesterday
       * through roughly 1 month in the future.
       *
       * This is necessary because a reminder can happen
       * days or weeks before the actual event.
       */
      const firstDate = localNow
        .startOf("day")
        .minus({ days: 1 });

      const lastDate = localNow
        .startOf("day")
        .plus({ days: 35 });


      for (const ev of events) {

        if (!ev.dateISO || ev.start == null) {
          continue;
        }


        let cursor = firstDate;


        while (cursor <= lastDate) {

          const occurrenceDateStr = cursor.toISODate();


          // Is this event occurring on this date?
          if (!occursOn(ev, occurrenceDateStr)) {

            cursor = cursor.plus({
              days: 1
            });

            continue;
          }


          checked++;


          // Calculate the actual reminder time
          const notifyLocal = reminderDateTime(
            ev,
            occurrenceDateStr,
            user.timezone
          );


          // No reminder selected
          if (!notifyLocal) {

            cursor = cursor.plus({
              days: 1
            });

            continue;
          }


          /*
           * How many minutes until the reminder?
           *
           * Example:
           * current time = 2:29
           * reminder = 2:30
           * diff = +1
           */
          const diffMin = notifyLocal.diff(
            localNow,
            "minutes"
          ).minutes;


          /*
           * Only send reminders that are due.
           *
           * The -5 allows for a cron running slightly late.
           */
          if (diffMin > 0 || diffMin < -5) {

            cursor = cursor.plus({
              days: 1
            });

            continue;
          }


          /*
           * One notification per event occurrence.
           *
           * For recurring events:
           * September 5 and September 12
           * get separate notification records.
           */
          const key = `${ev.id}_${occurrenceDateStr}`;

          const notifiedRef = db
            .collection("users")
            .doc(userDoc.id)
            .collection("notified")
            .doc(key);


          const already = await notifiedRef.get();

          if (already.exists) {

            cursor = cursor.plus({
              days: 1
            });

            continue;
          }


          // Calculate event and leaving times for notification text
          const eventLocal = DateTime
            .fromISO(occurrenceDateStr, {
              zone: user.timezone
            })
            .plus({
              minutes: ev.start
            });


          const leaveLocal = eventLocal.minus({
            minutes: ev.bufferBefore || 0
          });


          try {

            await admin.messaging().send({

              token: user.pushToken,

              notification: {

                title: ev.title || "Reminder",

                body:
                  `Leave at ${leaveLocal.toFormat("h:mm a")} for ` +
                  `${eventLocal.toFormat("h:mm a")}.`
              }

            });


            // ONLY mark as notified after successful send
            await notifiedRef.set({

              sentAt: nowUtc.toISO(),

              occurrenceDate: occurrenceDateStr

            });


            sent++;

          } catch (err) {

            console.error(
              "Push send failed for",
              userDoc.id,
              ev.id,
              err
            );

            // Do NOT create notifiedRef here.
            // The next cron run can retry it.
          }


          cursor = cursor.plus({
            days: 1
          });
        }
      }
    }


    return res.status(200).json({

      ok: true,
      sent,
      checked

    });


  } catch (err) {

    console.error(
      "Notification cron failed:",
      err
    );

    return res.status(500).json({

      ok: false,
      error: err.message

    });
  }
};