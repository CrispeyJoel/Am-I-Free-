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

## Phase 2 — Google Calendar sync + push notifications
Both are genuinely possible, but they need a small backend and your own credentials — not something that can live in static files alone:

**Google Calendar sync**
1. Create a Google Cloud project → enable the Calendar API → create an OAuth 2.0 Client ID (type: Web application).
2. Add sign-in with Google in the app, request the `calendar.events` scope.
3. On sign-in, fetch/push events via the Calendar API instead of (or alongside) local storage.

**Push notifications**
1. Generate a VAPID key pair (`web-push generate-vapid-keys`).
2. Add a "Subscribe to notifications" button that calls `PushManager.subscribe()` and sends the subscription to a small backend endpoint (a single Vercel serverless function is enough).
3. That backend stores subscriptions and calls the Web Push API on a schedule (e.g. "notify 30 min before an event's buffer starts").
4. On iPhone, this only works once the app is added to the home screen and iOS is 16.4+.

Happy to build either of these next — just say the word and whether you'd rather start with Calendar sync or notifications first.
