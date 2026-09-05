# Actually Free — week-first scheduler

A no-login, installable PWA. Data lives in your phone's local storage for now (see "Phase 2" below for syncing).

## What's in this MVP
- Week view, landing on today, swipe left/right between days, prev/next week buttons, "back to today" button
- Month glance view (tap a day to jump into it)
- Add/edit/delete events, quick-add bar (try: `Piano - Zach, Tue 4pm`)
- Per-event travel buffer before/after (defaults to 30 min, fully overridable per event)
- Category colours (Work/Tutoring/Friends/Family/Personal — edit the `DEFAULT_CATEGORIES` array at the top of `app.js` to change names/colours)
- `$` badge for money-earning events (auto-ticks based on the category's default, editable per event)
- Mandatory events show full colour; optional events show grey with a coloured left edge
- Recurring events: weekly / fortnightly
- "Free now / free until / busy until" banner on the home screen, live-updating

## Deploy it (free, ~10 minutes)
1. Create a new GitHub repo (public or private both work), e.g. `actually-free`.
2. Upload these files to the repo root: `index.html`, `styles.css`, `app.js`, `manifest.json`, `sw.js`, `icon-192.png`, `icon-512.png`, this `README.md`.
3. Go to [vercel.com](https://vercel.com), sign in with GitHub, "Add New Project", pick the repo. No build settings needed — leave everything default and deploy.
4. Vercel gives you a URL like `actually-free.vercel.app`. Open it on your phone.
5. **iPhone**: open in Safari → Share button → "Add to Home Screen".
   **Android**: open in Chrome → menu (⋮) → "Add to Home screen" / "Install app".
6. Open it from the home screen icon — it now runs full-screen, like a real app.

Every time you push a change to the GitHub repo, Vercel redeploys automatically.

## Cloud sync + notifications (Firebase) — setup

This backs up your events to the cloud (so they survive a reinstall or new phone) and sends real push notifications, without touching Google Calendar or needing Google's app-review process.

### 1. Create the Firebase project
1. Go to [console.firebase.google.com](https://console.firebase.google.com) → "Add project" → name it anything (e.g. `actually-free`). Free "Spark" plan, no credit card needed.
2. Inside the project, click the `</>` (web app) icon → register an app (no need for Firebase Hosting) → copy the `firebaseConfig` object it shows you.
3. Paste that object into **two places**:
   - Top of `app.js`, replacing `FIREBASE_CONFIG`
   - Top of `sw.js`, replacing the `firebase.initializeApp({...})` block

### 2. Turn on the pieces you need
- **Authentication** → Sign-in method → enable **Google**.
- **Firestore Database** → Create database → start in production mode.
- **Cloud Messaging** → Project settings → Cloud Messaging tab → "Web Push certificates" → Generate key pair → copy the key into `VAPID_PUBLIC_KEY` in `app.js`.

### 3. Lock down Firestore
In Firestore → Rules, replace the contents with:
```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{uid} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
      match /data/{docId} {
        allow read, write: if request.auth != null && request.auth.uid == uid;
      }
      match /notified/{docId} {
        allow read, write: if false; // only the server (admin SDK) touches this
      }
    }
  }
}
```

### 4. Set up the reminder backend
1. Project settings → Service accounts → "Generate new private key" → downloads a JSON file. Open it and copy the entire contents.
2. In your Vercel project → Settings → Environment Variables, add:
   - `FIREBASE_SERVICE_ACCOUNT` = paste the whole JSON file content (as one value)
   - `CRON_SECRET` = any random string you make up (e.g. `af-9f3k2m...`)
3. Push all the files (including the new `api/` folder and `package.json`) to your GitHub repo — Vercel will redeploy and install `firebase-admin`/`luxon` automatically.

### 5. Schedule the reminder check
Vercel's Hobby plan only runs its own Cron feature once a day, which is too infrequent for 30-minute reminders. Use a free external pinger instead:
1. Go to [cron-job.org](https://cron-job.org) → free account → create a job.
2. URL: `https://YOUR-APP.vercel.app/api/check-reminders?secret=YOUR_CRON_SECRET`
3. Interval: every 5 minutes.

That's it — save that job and reminders will fire automatically.

### Using it
Open the app → tap the cloud icon (top right) → sign in with Google → it'll ask for notification permission. From then on, your events sync to the cloud automatically every time you add/edit/delete, and you'll get a push notification when each event's travel-buffer window starts — even if the app isn't open.