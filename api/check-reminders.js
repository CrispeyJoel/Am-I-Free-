const admin = require("firebase-admin");
const { DateTime } = require("luxon");


// ------------------------------------------------------------
// FIREBASE
// ------------------------------------------------------------

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(
    process.env.FIREBASE_SERVICE_ACCOUNT
  );

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();


// ------------------------------------------------------------
// RECURRENCE
// ------------------------------------------------------------

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


// ------------------------------------------------------------
// EVENT TIMES
// ------------------------------------------------------------

function getEventTimes(
  ev,
  occurrenceDateStr,
  timezone
) {
  const startMinutes =
    Number(ev.start) || 0;

  const bufferBefore =
    Number(ev.bufferBefore) || 0;

  const eventLocal = DateTime
    .fromISO(occurrenceDateStr, {
      zone: timezone
    })
    .plus({
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


// ------------------------------------------------------------
// REMINDER TIME
// ------------------------------------------------------------

function reminderDateTime(
  ev,
  occurrenceDateStr,
  timezone
) {
  const { leaveLocal } =
    getEventTimes(
      ev,
      occurrenceDateStr,
      timezone
    );

  const reminder =
    ev.reminder || "30m";

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


// ------------------------------------------------------------
// API
// ------------------------------------------------------------

module.exports = async (req, res) => {
  try {

    // ----------------------------------------------------------
    // SECURITY
    // ----------------------------------------------------------

    if (
      req.query.secret !==
      process.env.CRON_SECRET
    ) {
      return res.status(401).json({
        ok: false,
        error: "unauthorized"
      });
    }


    // ----------------------------------------------------------
    // CURRENT TIME
    // ----------------------------------------------------------

    const nowUtc = DateTime.utc();

    let sent = 0;
    let checked = 0;
    let skipped = 0;
    let failed = 0;


    // ----------------------------------------------------------
    // GET USERS
    // ----------------------------------------------------------

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


    // ----------------------------------------------------------
    // LOOP USERS
    // ----------------------------------------------------------

    for (const userDoc of usersSnap.docs) {

      const user = userDoc.data();

      if (
        !user.pushToken ||
        !user.timezone
      ) {
        console.log(
          "USER SKIPPED",
          userDoc.id,
          {
            hasPushToken: !!user.pushToken,
            timezone: user.timezone || null
          }
        );

        continue;
      }


      // --------------------------------------------------------
      // USER LOCAL TIME
      // --------------------------------------------------------

      const localNow =
        nowUtc.setZone(user.timezone);


      // --------------------------------------------------------
      // GET EVENTS
      // --------------------------------------------------------

      const dataDoc = await db
        .collection("users")
        .doc(userDoc.id)
        .collection("data")
        .doc("events")
        .get();

      if (!dataDoc.exists) {
        console.log(
          "NO EVENTS DOCUMENT",
          userDoc.id
        );

        continue;
      }

      const events =
        dataDoc.data().list || [];


      // --------------------------------------------------------
      // DATE RANGE
      // --------------------------------------------------------

      const firstDate =
        localNow
          .startOf("day")
          .minus({
            days: 1
          });

      const lastDate =
        localNow
          .startOf("day")
          .plus({
            days: 35
          });


      // --------------------------------------------------------
      // LOOP EVENTS
      // --------------------------------------------------------

      for (const ev of events) {

        if (
          !ev.dateISO ||
          ev.start == null
        ) {
          continue;
        }


        // ------------------------------------------------------
        // CHECK EACH DATE
        // ------------------------------------------------------

        let cursor = firstDate;

        while (cursor <= lastDate) {

          const occurrenceDateStr =
            cursor.toISODate();


          // ----------------------------------------------------
          // DOES EVENT OCCUR ON THIS DATE?
          // ----------------------------------------------------

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


          // ----------------------------------------------------
          // CALCULATE EVENT / LEAVING TIMES
          // ----------------------------------------------------

          const {
            eventLocal,
            leaveLocal
          } = getEventTimes(
            ev,
            occurrenceDateStr,
            user.timezone
          );


          // ----------------------------------------------------
          // CALCULATE NOTIFICATION TIME
          // ----------------------------------------------------

          const notifyLocal =
            reminderDateTime(
              ev,
              occurrenceDateStr,
              user.timezone
            );

          if (!notifyLocal) {

            skipped++;

            cursor = cursor.plus({
              days: 1
            });

            continue;
          }


          // ----------------------------------------------------
          // HOW CLOSE ARE WE TO REMINDER TIME?
          // ----------------------------------------------------

          const diffMin =
            notifyLocal.diff(
              localNow,
              "minutes"
            ).minutes;


          // ----------------------------------------------------
          // DIAGNOSTIC LOG
          // ----------------------------------------------------

          console.log(
            "REMINDER CHECK",
            {
              event: ev.title,
              eventId: ev.id,
              occurrence: occurrenceDateStr,
              timezone: user.timezone,
              reminder: ev.reminder || "30m",

              eventStart:
                eventLocal.toFormat(
                  "yyyy-MM-dd HH:mm:ss"
                ),

              leaveAt:
                leaveLocal.toFormat(
                  "yyyy-MM-dd HH:mm:ss"
                ),

              notifyAt:
                notifyLocal.toFormat(
                  "yyyy-MM-dd HH:mm:ss"
                ),

              localNow:
                localNow.toFormat(
                  "yyyy-MM-dd HH:mm:ss"
                ),

              diffMin:
                Number(
                  diffMin.toFixed(2)
                )
            }
          );


          // ----------------------------------------------------
          // REMINDER IS STILL IN THE FUTURE
          // ----------------------------------------------------

          if (diffMin > 0) {

            skipped++;

            cursor = cursor.plus({
              days: 1
            });

            continue;
          }


          // ----------------------------------------------------
          // REMINDER WAS MORE THAN 5 MINUTES AGO
          // ----------------------------------------------------

          if (diffMin < -5) {

            skipped++;

            cursor = cursor.plus({
              days: 1
            });

            continue;
          }


          // ----------------------------------------------------
          // REMINDER IS DUE
          // ----------------------------------------------------

          console.log(
            "REMINDER DUE",
            {
              event: ev.title,
              eventId: ev.id,
              occurrence: occurrenceDateStr,
              diffMin
            }
          );


          // ----------------------------------------------------
          // PREVENT DUPLICATE NOTIFICATIONS
          // ----------------------------------------------------

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


          // ----------------------------------------------------
          // SEND PUSH
          // ----------------------------------------------------

          try {

            console.log(
              "SENDING PUSH",
              ev.title
            );


            const title =
              ev.title ||
              "Actually Free";

            const body =
              `Leave at ${leaveLocal.toFormat(
                "h:mm a"
              )} for ${eventLocal.toFormat(
                "h:mm a"
              )}.`;


            await admin.messaging().send({
              token: user.pushToken,
              data: {
                title,
                body
              },
              webpush: {
                notification: {
                  icon: "https://am-i-free-eta.vercel.app/icon-192.png"
                }
              }
            });


            // --------------------------------------------------
            // MARK AS NOTIFIED
            // --------------------------------------------------

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
                eventId: ev.id,
                code: err.code,
                message: err.message
              }
            );
          }


          // ----------------------------------------------------
          // NEXT DATE
          // ----------------------------------------------------

          cursor = cursor.plus({
            days: 1
          });
        }
      }
    }


    // ----------------------------------------------------------
    // COMPLETE
    // ----------------------------------------------------------

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