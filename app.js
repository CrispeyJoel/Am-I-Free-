import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import { STRINGS, VOICE_LOCALE } from "./i18n.js";

import {
  getAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  onAuthStateChanged,
  signOut,
  setPersistence,
  browserLocalPersistence,
  isSignInWithEmailLink,
  signInWithEmailLink
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";

import {
  initializeFirestore,
  persistentLocalCache,
  doc,
  setDoc,
  getDoc,
  onSnapshot
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

import {
  getMessaging,
  getToken,
  deleteToken,
  isSupported as messagingSupported
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-messaging.js";

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyD9GasWarxCefArgzbq2vPgSuYmlkTvPs0",
  authDomain: "amifree-6e5e1.firebaseapp.com",
  projectId: "amifree-6e5e1",
  storageBucket: "amifree-6e5e1.firebasestorage.app",
  messagingSenderId: "592230919079",
  appId: "1:592230919079:web:b01ed6ee1804bf59656482"
};

const VAPID_PUBLIC_KEY =
  "BFXiYQnuOx5YnxnSs_6hbwYScOzo0V8brVdsOAzGNOVBhWh_9XfPn62P5E2ga0RK7ANeeanCZoSZsuLq1ZQjuG8";

const fbApp = initializeApp(FIREBASE_CONFIG);
const auth = getAuth(fbApp);
const db = initializeFirestore(fbApp, {
  localCache: persistentLocalCache()
});

let currentUser = null;
let suppressNextCloudPush = false;
let pushEnabled = false;
let unsubscribeCloudData = null;
let unsubscribeUserDoc = null;
let lastSyncedAt = null;
let syncFailed = false;
let currentLang = localStorage.getItem("af_lang") || "en";
let currentTheme = localStorage.getItem("af_theme") || "light";

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
}

function setTheme(theme) {
  currentTheme = theme;
  localStorage.setItem("af_theme", theme);
  applyTheme(theme);
  refreshSettingsPanel();
}

applyTheme(currentTheme);

function t(key) {
  return (STRINGS[currentLang] && STRINGS[currentLang][key]) || STRINGS.en[key] || key;
}

function setLang(lang) {
  currentLang = lang;
  localStorage.setItem("af_lang", lang);
  render();
  refreshSettingsPanel();
}

setPersistence(auth, browserLocalPersistence).catch(error => {
  console.error("Firebase persistence failed:", error);
});

/* ---------- Config ---------- */
const DAY_START_MIN = 6 * 60;   // 6:00am
const DAY_END_MIN = 23 * 60;    // 11:00pm
const HOUR_PX = 56;
const WINDOW_BEFORE = 7;   // days rendered before the current week's Monday
const WINDOW_TOTAL = 21;   // total days rendered in the scroller (3 weeks' worth)
const LOVE_CATEGORY = { id: "love", name: "Liebe", color: "#FF4FA3", earnsDefault: false, special: "love" };

const DEFAULT_CATEGORIES = [
  { id: "work",     name: "Work",     color: "#3F7D58", earnsDefault: true  },
  { id: "tutoring", name: "Tutoring", color: "#2C6E7F", earnsDefault: true  },
  { id: "friends",  name: "Friends",  color: "#3B5BA5", earnsDefault: false },
  { id: "family",   name: "Family",   color: "#8B5E3C", earnsDefault: false },
  { id: "personal", name: "Personal", color: "#7C5CBF", earnsDefault: false },
  LOVE_CATEGORY
];
const DAY_NAMES = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
const DAY_ALIASES = { sun:0, mon:1, tue:2, tues:2, wed:3, weds:3, thu:4, thur:4, thurs:4, fri:5, sat:6 };

/* ---------- State ---------- */
function ensureLoveCategory(cats) {
  const list = Array.isArray(cats) ? cats : [];
  if (!list.some(c => c.special === "love")) return [...list, LOVE_CATEGORY];
  return list;
}

let categories = ensureLoveCategory(load("af_categories", DEFAULT_CATEGORIES));
let events = load("af_events", []);
let selectedDate = startOfDay(new Date());
let weekStart = startOfWeek(selectedDate);
let view = "day"; // "day" | "month"
let monthCursor = startOfMonth(selectedDate);
let renderedWindowStart = null;
let currentWindowLength = WINDOW_TOTAL;
const MONTH_WINDOW_BEFORE = 6;
const MONTH_WINDOW_TOTAL = 24;
let renderedMonthWindowStart = null;
let currentMonthWindowLength = MONTH_WINDOW_TOTAL;

/* ---------- Storage / util ---------- */
function load(key, fallback) {
  try { const v = JSON.parse(localStorage.getItem(key)); return v || fallback; }
  catch { return fallback; }
}
async function save() {
  const savedAt = Date.now();
  localStorage.setItem("af_events", JSON.stringify(events));
  localStorage.setItem("af_categories", JSON.stringify(categories));
  localStorage.setItem("af_last_local_save", String(savedAt));

  if (currentUser && !suppressNextCloudPush) {
    try {
      await setDoc(
        doc(db, "users", currentUser.uid, "data", "events"),
        { list: events, categories, updatedAt: savedAt },
        { merge: true }
      );
      lastSyncedAt = Date.now();
      syncFailed = false;
      const row = document.getElementById("cloudstatus");
      if (row) row.textContent = `Synced as ${currentUser.displayName || currentUser.email} · last saved ${formatSyncTime(lastSyncedAt)}`;
      refreshSyncTag();
    } catch (error) {
      console.error("Cloud save failed:", error);
      syncFailed = true;
      const row = document.getElementById("cloudstatus");
      if (row) row.textContent = "Cloud save FAILED - check your connection";
      refreshSyncTag();
    }
  }

  suppressNextCloudPush = false;
}
function startOfDay(d) { const x = new Date(d); x.setHours(0,0,0,0); return x; }
function startOfWeek(d) { const x = startOfDay(d); const dow = (x.getDay()+6)%7; x.setDate(x.getDate()-dow); return x; } // Monday start
function startOfMonth(d) { const x = new Date(d); x.setDate(1); x.setHours(0,0,0,0); return x; }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate()+n); return x; }
function addMonths(d, n) { const x = new Date(d); x.setDate(1); x.setMonth(x.getMonth()+n); x.setHours(0,0,0,0); return x; }
function iso(d) {
  const x = new Date(d);
  return `${x.getFullYear()}-${pad2(x.getMonth()+1)}-${pad2(x.getDate())}`;
}

function sameDay(a, b) {
  const x = new Date(a);
  const y = new Date(b);

  return x.getFullYear() === y.getFullYear() &&
         x.getMonth() === y.getMonth() &&
         x.getDate() === y.getDate();
}
function dayDiff(a,b) { return Math.round((startOfDay(a)-startOfDay(b))/86400000); }
function pad2(n){ return n.toString().padStart(2,"0"); }
function minToLabel(min) {
  let h = Math.floor(min/60), m = min%60;
  const ampm = h>=12 ? "pm":"am";
  let h12 = h%12; if (h12===0) h12=12;
  return m===0 ? `${h12}${ampm}` : `${h12}:${pad2(m)}${ampm}`;
}

function formatSyncTime(ts) {
  if (!ts) return "";
  return new Date(ts).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function formatDateReadable(dateISO) {
  const d = dateFromISO(dateISO);
  const today = startOfDay(new Date());
  const diff = dayDiff(d, today);
  if (diff === 0) return "today";
  if (diff === 1) return "tomorrow";
  if (diff === -1) return "yesterday";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
function refreshSyncTag() {
  const tag = document.getElementById("synctag");
  if (tag) {
    tag.textContent = renderSyncTag();
    tag.classList.toggle("fail", syncFailed);
  }
}
function defaultCategory() {
  return categories.find(c => c.id === "personal")
    || categories.find(c => c.special !== "love")
    || categories[0];
}
function categoryOf(id) { return categories.find(c=>c.id===id) || categories[0]; }
function uid() { return Date.now().toString(36)+Math.random().toString(36).slice(2,7); }

/* ---------- Recurrence ---------- */
function dateFromISO(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function getRecurrenceDays(ev) {
  if (Number.isFinite(ev.recurrenceDays)) return ev.recurrenceDays;
  if (ev.recurrence === "weekly") return 7;
  if (ev.recurrence === "fortnightly") return 14;
  return 0;
}

function occursOn(ev, date) {
  const dStr = iso(date);

  if (ev.seriesEndISO && dStr >= ev.seriesEndISO) return false;

  if (ev.allDay && ev.endDateISO) {
    return dStr >= ev.dateISO && dStr <= ev.endDateISO;
  }

  const anchor = dateFromISO(ev.dateISO);
  const diff = dayDiff(date, anchor);

  if (diff < 0) return false;

  let matches;
  if (ev.recurrence === "weekly") matches = diff % 7 === 0;
  else if (ev.recurrence === "fortnightly") matches = diff % 14 === 0;
  else matches = diff === 0;

  if (!matches) return false;

  if (Array.isArray(ev.excludedDates) && ev.excludedDates.includes(dStr)) return false;

  return true;
}
function eventsOnDate(date) { return events.filter(ev => occursOn(ev, date)); }

/* ---------- Free-time calc ---------- */
function busyIntervals(date) {
  return eventsOnDate(date).filter(ev => !ev.allDay).map(ev => ({
    start: ev.start - ev.bufferBefore,
    end: ev.start + ev.duration + ev.bufferAfter,
    ev
  })).sort((a,b)=>a.start-b.start);
}

function layoutOverlaps(evs) {
  // Each event's visual span includes its buffers, since those occupy screen space too.
  const items = evs.map(ev => ({
    ev,
    start: ev.start - ev.bufferBefore,
    end: ev.start + ev.duration + ev.bufferAfter
  })).sort((a, b) => a.start - b.start);

  const clusters = [];
  let current = [];
  let clusterEnd = -Infinity;

  for (const item of items) {
    if (current.length && item.start >= clusterEnd) {
      clusters.push(current);
      current = [];
      clusterEnd = -Infinity;
    }
    current.push(item);
    clusterEnd = Math.max(clusterEnd, item.end);
  }
  if (current.length) clusters.push(current);

  const layout = new Map();

  for (const cluster of clusters) {
    const columns = []; // each entry: the `end` time of the last item placed in that column
    for (const item of cluster) {
      let colIndex = columns.findIndex(colEnd => item.start >= colEnd);
      if (colIndex === -1) { colIndex = columns.length; columns.push(item.end); }
      else { columns[colIndex] = item.end; }
      layout.set(item.ev.id, { col: colIndex, totalCols: 0 }); // totalCols filled in below
    }
    const totalCols = columns.length;
    for (const item of cluster) {
      layout.get(item.ev.id).totalCols = totalCols;
    }
  }

  return layout;
}

function mergedIntervals(date) {
  const iv = busyIntervals(date);
  const out = [];
  for (const cur of iv) {
    if (out.length && cur.start <= out[out.length-1].end) {
      out[out.length-1].end = Math.max(out[out.length-1].end, cur.end);
    } else out.push({start:cur.start, end:cur.end});
  }
  return out;
}
function freeStatusNow() {
  const today = new Date();
  const nowMin = today.getHours()*60 + today.getMinutes();
  const merged = mergedIntervals(today);
  const cur = merged.find(iv => nowMin >= iv.start && nowMin < iv.end);
  if (cur) return { busy:true, text:`${t("busyUntil")} <b>${minToLabel(cur.end)}</b>` };
  const next = merged.find(iv => iv.start > nowMin);
  if (!next) return { busy:false, text: t("freeRest") };
  const mins = next.start - nowMin;
  const hrs = Math.floor(mins/60), rem = mins%60;
  const dur = hrs>0 ? `${hrs}h ${rem}m` : `${rem}m`;
  return { busy:false, text:`${t("freeFor")} <b>${dur}</b> - ${t("nextAt")} ${minToLabel(next.start)}` };
}

/* ---------- Quick add parsing (local fallback) ---------- */
function parseQuickAdd(text) {
  let s = text.trim();
  let dayOffset = null;
  let time = null;

  const lower = s.toLowerCase();
  const isAllDay = /\ball[\s-]?day\b|\bwhole day\b/.test(lower);
  if (isAllDay) {
    s = s.replace(/\ball[\s-]?day\b|\bwhole day\b/gi, "").trim();
  }
  if (/\btoday\b/.test(lower)) { dayOffset = 0; s = s.replace(/\btoday\b/i,""); }
  else if (/\btomorrow\b/.test(lower)) { dayOffset = 1; s = s.replace(/\btomorrow\b/i,""); }
  else {
    for (const key in DAY_ALIASES) {
      const re = new RegExp(`\\b${key}\\b`, "i");
      if (re.test(s)) {
        const target = DAY_ALIASES[key];
        const todayDow = new Date().getDay();
        let diff = (target - todayDow + 7) % 7;
        if (diff === 0) diff = 7;
        dayOffset = diff;
        s = s.replace(re, "");
        break;
      }
    }
  }

  const timeMatch = s.match(/\b(\d{1,2})(?::?(\d{2}))?\s*(am|pm)?\b/i);
  if (timeMatch) {
    let h = parseInt(timeMatch[1],10);
    let m = timeMatch[2] ? parseInt(timeMatch[2],10) : 0;
    const ap = timeMatch[3] ? timeMatch[3].toLowerCase() : null;
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    if (!ap && h <= 7) h += 12;
    time = h*60+m;
    s = s.replace(timeMatch[0], "");
  }

  s = s.replace(/[,\-–]+$/,"").replace(/^[,\-–]+/,"").replace(/\s{2,}/g," ").trim();
  const title = s || "Untitled";
  const date = dayOffset===null ? selectedDate : addDays(startOfDay(new Date()), dayOffset);

  let categoryId = defaultCategory().id;
  for (const c of categories) {
    if (title.toLowerCase().includes(c.name.toLowerCase())) { categoryId = c.id; break; }
  }
  const cat = categoryOf(categoryId);

  return {
    id: uid(), seriesId: uid(),
    title, categoryId,
    dateISO: iso(date),
    allDay: isAllDay,
    start: isAllDay ? 0 : (time===null ? roundToNext30() : time),
    duration: isAllDay ? 0 : 60,
    bufferBefore: 0,
    bufferAfter: 0,
    reminder: isAllDay ? "1d" : "30m",
    mandatory: true,
    earnsMoney: !!cat.earnsDefault,
    recurrence: "none"
  };
}
function roundToNext30() {
  const now = new Date();
  let m = now.getHours()*60 + now.getMinutes();
  return Math.ceil(m/30)*30;
}

function cleanAITitle(aiTitle, originalText) {
  let title = String(aiTitle || "").trim();

  title = title.replace(/^[\s"'`]+|[\s"'`]+$/g, "");

  const original = String(originalText || "").trim();
  const originalWords = original.split(/\s+/).filter(Boolean);
  const titleWords = title.split(/\s+/).filter(Boolean);

  if (!title || titleWords.length > 12 || (originalWords.length > 0 && titleWords.length >= Math.max(12, originalWords.length * 0.8))) {
    title = original
      .replace(/\b(schedule|add|create|put|book|set up|remind me to|remind me|please|can you|could you)\b/gi, "")
      .replace(/\b(today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)\b/gi, "")
      .replace(/\b(?:at|around|by)\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/gi, "")
      .replace(/\s+/g, " ")
      .replace(/^[,\-–:;\s]+|[,\-–:;\s]+$/g, "")
      .trim();
  }

  title = title
    .replace(/^(okay|ok|uh|um|er|so|yeah|yep|please)\b[,:]?\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();

  return title || "Untitled";
}

/* ---------- Quick add parsing (AI) ---------- */
async function parseQuickAddAI(text) {
  const res = await fetch("/api/parse-event", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      todayISO: iso(new Date()),
      defaultDateISO: iso(selectedDate),
      categories: categories.map(c => ({ name: c.name, earnsDefault: !!c.earnsDefault }))
    })
  });
  const data = await res.json().catch(()=>null);
  if (!res.ok || !data || data.error) throw new Error((data && data.error) || "AI parse failed");

  const cat = categories.find(c => c.name.toLowerCase() === (data.category || "").toLowerCase())
    || categories[categories.length - 1];
  const [hh, mm] = (data.time || "12:00").split(":").map(Number);

  const isAllDay = !!data.allDay;

  return {
    id: uid(), seriesId: uid(),
    title: cleanAITitle(data.title, text),
    categoryId: cat.id,
    dateISO: data.date || iso(selectedDate),
    allDay: isAllDay,
    start: isAllDay ? 0 : (isNaN(hh) ? 12 : hh) * 60 + (isNaN(mm) ? 0 : mm),
    duration: isAllDay ? 0 : (Number.isFinite(data.duration) ? data.duration : 60),
    bufferBefore: isAllDay ? 0 : (Number.isFinite(data.bufferBefore) ? data.bufferBefore : 30),
    bufferAfter: isAllDay ? 0 : (Number.isFinite(data.bufferAfter) ? data.bufferAfter : 30),
    reminder: data.reminder || (isAllDay ? "1d" : "30m"),
    mandatory: data.mandatory !== false,
    earnsMoney: !!data.earnsMoney,
    recurrence: data.recurrence || "none"
  };
}

/* ---------- Rendering ---------- */
const app = document.getElementById("app");

function render() {
  app.innerHTML = `
    ${renderTopbar()}
    ${view==="day" ? renderFreeBanner()+renderDayPips()+renderScroller() : renderMonth()}
    ${renderFabs()}
    ${renderTodayCorner()}
  `;
  attachHandlers();
  if (view==="day") {
    scrollToDay(selectedDate, false);
    tickNowLine();
  } else if (view==="month") {
    scrollToMonthCursor(false);
  }
}

function renderTopbar() {
  const label = view === "month" 
    ? monthCursor.toLocaleDateString(undefined, { month: "long", year: "numeric" }) 
    : `${weekStart.toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${addDays(weekStart, 6).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;

  return `
    <div id="topbarWrap">
      <div class="topbar">
        <div class="topbar-side topbar-side-left">
          ${view === "month"
            ? ""
            : `<button class="todaybtn monthbtn-big" data-view="month"><span style="font-size:1.3rem; margin-right:4px; line-height:1;">‹</span>${t("month")}</button>`
          }
        </div>
        <div class="weeklabel">${label}</div>
        <div class="topbar-side topbar-side-right">
          <button class="iconbtn" data-act="agenda" title="Day list">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="8" y1="6" x2="21" y2="6"/>
              <line x1="8" y1="12" x2="21" y2="12"/>
              <line x1="8" y1="18" x2="21" y2="18"/>
              <line x1="3" y1="6" x2="3.01" y2="6"/>
              <line x1="3" y1="12" x2="3.01" y2="12"/>
              <line x1="3" y1="18" x2="3.01" y2="18"/>
            </svg>
          </button>
          <button class="iconbtn" data-act="settings" title="${t("settings")}">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
          </svg>
        </button>
        </div>
      </div>

      <div class="synctag ${syncFailed ? "fail" : ""}" id="synctag">${renderSyncTag()}</div>
    </div>
  `;
}

function renderSyncTag() {
  if (!currentUser) return t("notSignedIn");
  if (syncFailed) return t("cloudSaveFailed");
  return lastSyncedAt ? `${t("syncedAt")} ${formatSyncTime(lastSyncedAt)}` : t("signedIn");
}

function renderTodayCorner() {
  return `<button class="todaybtn today-corner" data-act="today" title="${t("today")}">${t("today")}</button>`;
}

function renderFreeBanner() {
  const st = freeStatusNow();
  return `<div class="freebanner ${st.busy?"busy":""}"><div class="dot"></div><div class="text">${st.text}</div></div>`;
}

function renderDayPips() {
  const today = startOfDay(new Date());
  let html = `<div class="daypips">`;
  for (let i=0;i<7;i++) {
    const d = addDays(weekStart,i);
    const isToday = sameDay(d,today);
    const isSel = sameDay(d,selectedDate);
    html += `<button class="pip ${isToday?"today":""} ${isSel?"selected":""}" data-jump="${i}">
      <span>${DAY_NAMES[d.getDay()]}</span><span class="num">${d.getDate()}</span>
    </button>`;
  }
  return html+`</div>`;
}

function renderScroller() {
  renderedWindowStart = addDays(weekStart, -WINDOW_BEFORE);
  currentWindowLength = WINDOW_TOTAL;
  let html = `<div class="dayscroller" id="scroller">`;
  for (let i=0;i<WINDOW_TOTAL;i++) html += renderDayCol(addDays(renderedWindowStart, i));
  return html + `</div>`;
}

function renderDayCol(date) {
  const evs = eventsOnDate(date);
  const timedEvs = evs.filter(e => !e.allDay);
  const alldayEvs = evs.filter(e => e.allDay);
  let hours = "";
  for (let m=DAY_START_MIN; m<=DAY_END_MIN; m+=60) {
    hours += `<div class="hourrow"><span class="label">${minToLabel(m)}</span></div>`;
  }
  const overlapLayout = layoutOverlaps(timedEvs);
  let blocks = "";
  for (const ev of timedEvs) {
    const cat = categoryOf(ev.categoryId);
    const isLove = cat.special === "love";
    const top = (ev.start - DAY_START_MIN)/60*HOUR_PX;
    const height = Math.max(ev.duration/60*HOUR_PX, 24);
    const bTop = (ev.start - ev.bufferBefore - DAY_START_MIN)/60*HOUR_PX;
    const bHeightBefore = ev.bufferBefore/60*HOUR_PX;
    const bTopAfter = (ev.start + ev.duration - DAY_START_MIN)/60*HOUR_PX;
    const bHeightAfter = ev.bufferAfter/60*HOUR_PX;

    const layout = overlapLayout.get(ev.id) || { col: 0, totalCols: 1 };
    const colWidthPct = 100 / layout.totalCols;
    const leftPct = layout.col * colWidthPct;
    const gapPx = layout.totalCols > 1 ? 3 : 0;
    const positionStyle = `left: calc(${leftPct}% + ${gapPx}px); width: calc(${colWidthPct}% - ${gapPx * 2}px);`;

    if (ev.bufferBefore>0) blocks += `<div class="buffer" style="top:${bTop}px;height:${bHeightBefore}px;color:${cat.color};${positionStyle}"></div>`;
    if (ev.bufferAfter>0) blocks += `<div class="buffer" style="top:${bTopAfter}px;height:${bHeightAfter}px;color:${cat.color};${positionStyle}"></div>`;
    const isCompact = ev.duration <= 45;
    const eventInner = isCompact
      ? `<div class="eventline">
          <span class="title">${escapeHtml(ev.title)}</span>
          <span class="meta">${minToLabel(ev.start)} · ${cat.name}</span>
          ${ev.earnsMoney?`<span class="dollar">$</span>`:""}
        </div>`
      : `<div class="title">${escapeHtml(ev.title)}${ev.earnsMoney?`<span class="dollar">$</span>`:""}</div>
         <div class="meta">${minToLabel(ev.start)} · ${cat.name}</div>`;

        blocks += `<div class="event ${isCompact?"compact":""} ${isLove?"love-cat":""} ${ev.mandatory?"":"optional"}" style="top:${top}px;height:${height}px;background:${cat.color};border-color:${cat.color};${positionStyle}" data-edit="${ev.id}" data-date="${iso(date)}">
      ${eventInner}
    </div>`;
  }
  const nowMin = new Date().getHours()*60+new Date().getMinutes();
  const showNow = sameDay(date,new Date()) && nowMin>=DAY_START_MIN && nowMin<=DAY_END_MIN;
  const nowTop = (nowMin-DAY_START_MIN)/60*HOUR_PX;
  const nowLine = showNow
    ? `<div class="nowline" id="nowline" style="top:${nowTop}px"></div>
       <div class="nowline-label" id="nowlineLabel" style="top:${nowTop}px">${minToLabel(nowMin)}</div>`
    : "";
  const alldayHtml = alldayEvs.length
    ? `<div class="allday-strip">${alldayEvs.map(ev => {
        const cat = categoryOf(ev.categoryId);
        const isLove = cat.special === "love";
        return `<div class="allday-chip ${isLove?"love-cat":""} ${ev.mandatory?"":"optional"}" style="background:${cat.color};border-color:${cat.color}" data-edit="${ev.id}" data-date="${iso(date)}">
          <span>${escapeHtml(ev.title)}</span>
          ${ev.earnsMoney?`<span class="dollar">$</span>`:""}
        </div>`;
      }).join("")}</div>`
    : "";

  return `<div class="daycol" data-date="${iso(date)}">
    ${alldayHtml}
    <div class="timeline" style="height:${((DAY_END_MIN-DAY_START_MIN)/60+1)*HOUR_PX}px">
      ${hours}
      <div class="eventlayer">${blocks}</div>
      ${nowLine}
    </div>
  </div>`;
}

function renderMonthBlock(monthDate) {
  const gridStart = startOfWeek(monthDate);
  const today = startOfDay(new Date());
  const monthLabel = monthDate.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  let head = `<div class="monthhead">${DAY_NAMES.slice(1).concat(DAY_NAMES[0]).map(d=>`<span>${d}</span>`).join("")}</div>`;
  let body = `<div class="monthbody">`;
  for (let i=0;i<42;i++) {
    const d = addDays(gridStart,i);
    const inMonth = d.getMonth()===monthDate.getMonth();
    const evs = eventsOnDate(d);
    const cats = [...new Set(evs.map(e=>e.categoryId))].slice(0,4);
    body += `<button class="monthday ${sameDay(d,today)?"today":""} ${inMonth?"":"other"}" data-goto="${iso(d)}">
      <span>${d.getDate()}</span>
      <span class="dots">${cats.map(c=>`<span style="background:${categoryOf(c).color}"></span>`).join("")}</span>
    </button>`;
  }
  body += `</div>`;
  return `<div class="monthblock" data-month="${iso(monthDate)}">
    <div class="monthblock-label">${monthLabel}</div>
    <div class="monthgrid">${head}${body}</div>
  </div>`;
}

function renderMonth() {
  renderedMonthWindowStart = addMonths(monthCursor, -MONTH_WINDOW_BEFORE);
  currentMonthWindowLength = MONTH_WINDOW_TOTAL;
  let html = `<div class="monthscroller" id="monthScroller">`;
  for (let i=0;i<MONTH_WINDOW_TOTAL;i++) {
    html += renderMonthBlock(addMonths(renderedMonthWindowStart, i));
  }
  return html + `</div>`;
}

function scrollToMonthCursor(smooth=false) {
  const scroller = document.getElementById("monthScroller");
  if (!scroller) return;
  const targetIso = iso(startOfMonth(monthCursor));
  const target = scroller.querySelector(`.monthblock[data-month="${targetIso}"]`);
  if (target) target.scrollIntoView({ block: "start", behavior: smooth ? "smooth" : "auto" });
}

let monthScrollTimer;
function onMonthScrollerScroll(e) {
  clearTimeout(monthScrollTimer);
  monthScrollTimer = setTimeout(() => {
    const scroller = e.target;
    if (!renderedMonthWindowStart) return;

    const blocks = Array.from(scroller.querySelectorAll(".monthblock"));
    const scrollerTop = scroller.getBoundingClientRect().top;
    let closestIdx = 0, closestDist = Infinity;
    blocks.forEach((b, i) => {
      const dist = Math.abs(b.getBoundingClientRect().top - scrollerTop);
      if (dist < closestDist) { closestDist = dist; closestIdx = i; }
    });

    const visibleMonth = startOfMonth(dateFromISO(blocks[closestIdx].dataset.month));
    if (!sameDay(visibleMonth, startOfMonth(monthCursor))) {
      monthCursor = visibleMonth;
      const topbarWrap = document.getElementById("topbarWrap");
      if (topbarWrap) topbarWrap.outerHTML = renderTopbar();
    }

    if (closestIdx < EDGE_THRESHOLD) {
      prependMonths(scroller, 6);
    } else if (closestIdx > currentMonthWindowLength - EDGE_THRESHOLD - 1) {
      appendMonths(scroller, 6);
    }
  }, 100);
}

function prependMonths(scroller, count) {
  let html = "";
  for (let i = count; i >= 1; i--) html += renderMonthBlock(addMonths(renderedMonthWindowStart, -i));
  const prevScrollTop = scroller.scrollTop;
  const prevScrollHeight = scroller.scrollHeight;
  scroller.insertAdjacentHTML("afterbegin", html);
  renderedMonthWindowStart = addMonths(renderedMonthWindowStart, -count);
  currentMonthWindowLength += count;
  scroller.scrollTop = prevScrollTop + (scroller.scrollHeight - prevScrollHeight);
}

function appendMonths(scroller, count) {
  const start = addMonths(renderedMonthWindowStart, currentMonthWindowLength);
  let html = "";
  for (let i = 0; i < count; i++) html += renderMonthBlock(addMonths(start, i));
  scroller.insertAdjacentHTML("beforeend", html);
  currentMonthWindowLength += count;
}


function renderFabs() {
  return `<div class="fab-stack">
    <button id="voicebtn" class="fab fab-voice" type="button" title="${t("voice")}" aria-label="${t("voice")}">
      <svg class="fab-icon fab-icon-mic" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
        <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
        <line x1="12" y1="19" x2="12" y2="23"/>
        <line x1="8" y1="23" x2="16" y2="23"/>
      </svg>
      <svg class="fab-icon fab-icon-spinner" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
        <circle cx="12" cy="12" r="9" stroke-opacity="0.25"/>
        <path d="M21 12a9 9 0 0 0-9-9"/>
      </svg>
      <span id="voiceLabel" class="sr-only">${t("voice")}</span>
      <span id="aiStatusDot" class="ai-status-dot ${aiStatus}"></span>
    </button>
    <button id="addbtn" class="fab fab-main" type="button" title="${t("add")}" aria-label="${t("add")}">+</button>
  </div>`;
}

function escapeHtml(s) { return s.replace(/[&<>"]/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])); }

/* ---------- Scroll / nav handlers ---------- */
function scrollToDay(date, smooth=true) {
  const scroller = document.getElementById("scroller");
  if (!scroller || !renderedWindowStart) return;
  const idx = dayDiff(date, renderedWindowStart);
  scroller.scrollTo({ left: idx*scroller.clientWidth, behavior: smooth?"smooth":"auto" });
}

function attachDayPipsSwipe() {
  const pips = document.querySelector(".daypips");
  if (!pips) return;
  let startX = null, startY = null;

  pips.addEventListener("touchstart", (e) => {
    const touch = e.touches[0];
    startX = touch.clientX;
    startY = touch.clientY;
  }, { passive: true });

  pips.addEventListener("touchend", (e) => {
    if (startX === null) return;
    const touch = e.changedTouches[0];
    const dx = touch.clientX - startX;
    const dy = touch.clientY - startY;
    startX = null; startY = null;

    if (Math.abs(dx) < 40 || Math.abs(dx) < Math.abs(dy) * 1.5) return;

    const direction = dx < 0 ? 1 : -1;
    animateWeekPipsTransition(direction);
  });
}

function animateWeekPipsTransition(direction) {
  const pips = document.querySelector(".daypips");
  if (!pips) { shiftWeek(direction); return; }

  pips.style.transition = "transform 140ms ease-in, opacity 140ms ease-in";
  pips.style.transform = `translateX(${direction < 0 ? "40px" : "-40px"})`;
  pips.style.opacity = "0";

  setTimeout(() => {
    shiftWeek(direction);

    const newPips = document.querySelector(".daypips");
    if (!newPips) return;
    newPips.style.transition = "none";
    newPips.style.transform = `translateX(${direction < 0 ? "-40px" : "40px"})`;
    newPips.style.opacity = "0";

    requestAnimationFrame(() => {
      newPips.style.transition = "transform 160ms ease-out, opacity 160ms ease-out";
      newPips.style.transform = "translateX(0)";
      newPips.style.opacity = "1";
    });
  }, 140);
}


const EDGE_THRESHOLD = 3;   // start extending when within this many columns of an edge
const EXTEND_BY = 7;        // how many days to add each time we extend

let scrollTimer;
function onScrollerScroll(e) {
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(()=>{
    const scroller = e.target;
    if (!renderedWindowStart) return;
    const idx = Math.round(scroller.scrollLeft / scroller.clientWidth);
    const d = addDays(renderedWindowStart, idx);

    if (!sameDay(d, selectedDate)) {
      selectedDate = d;
      const newWeekStart = startOfWeek(d);
      if (!sameDay(newWeekStart, weekStart)) {
        weekStart = newWeekStart;
        const topbarWrap = document.getElementById("topbarWrap");
        if (topbarWrap) topbarWrap.outerHTML = renderTopbar();
        const pipsEl = document.querySelector(".daypips");
        if (pipsEl) pipsEl.outerHTML = renderDayPips();
      } else {
        const pipIdx = dayDiff(d, weekStart);
        document.querySelectorAll(".pip").forEach((p,i)=> p.classList.toggle("selected", i===pipIdx));
      }
      const banner = document.querySelector(".freebanner");
      if (banner) banner.outerHTML = renderFreeBanner();
    }

    if (idx < EDGE_THRESHOLD) {
      prependDays(scroller, EXTEND_BY);
    } else if (idx > currentWindowLength - EDGE_THRESHOLD - 1) {
      appendDays(scroller, EXTEND_BY);
    }
  }, 80);
}

function prependDays(scroller, count) {
  let html = "";
  for (let i=count; i>=1; i--) html += renderDayCol(addDays(renderedWindowStart, -i));
  const prevScrollLeft = scroller.scrollLeft;
  scroller.insertAdjacentHTML("afterbegin", html);
  renderedWindowStart = addDays(renderedWindowStart, -count);
  currentWindowLength += count;
  scroller.scrollLeft = prevScrollLeft + count * scroller.clientWidth;
  bindNewColumns(scroller, count, true);
}

function appendDays(scroller, count) {
  const start = addDays(renderedWindowStart, currentWindowLength);
  let html = "";
  for (let i=0; i<count; i++) html += renderDayCol(addDays(start, i));
  scroller.insertAdjacentHTML("beforeend", html);
  currentWindowLength += count;
  bindNewColumns(scroller, count, false);
}

function bindNewColumns(scroller, count, prepended) {
  const cols = scroller.querySelectorAll(".daycol");
  const target = prepended ? Array.from(cols).slice(0, count) : Array.from(cols).slice(-count);
  target.forEach(el => {
    const d = dateFromISO(el.dataset.date);
    if (view === "day") attachTimelineDragHandlers(el, d);
  });
}

let dragState = null;

function snapToHalfHour(px) {
  const rawMin = DAY_START_MIN + (px / HOUR_PX) * 60;
  return Math.round(rawMin / 30) * 30;
}

function attachTimelineDragHandlers(daycolEl, date) {
  const timeline = daycolEl.querySelector(".timeline");
  if (!timeline) return;

  let ghostEl = null;
  let labelEl = null;
  let longPressTimer = null;
  let dragStarted = false;
  let pendingStart = null;
  let lastTouchPos = null;

  const MOVE_CANCEL_THRESHOLD = 10; // px of movement during the hold that cancels drag-start

  function getPoint(evt) {
    return evt.touches ? evt.touches[0] : evt;
  }

  function getOffsetY(evt) {
    const rect = timeline.getBoundingClientRect();
    const point = getPoint(evt);
    return point.clientY - rect.top;
  }

  function startDrag(evt) {
    if (evt.target.closest(".event") || evt.target.closest(".buffer") || evt.target.closest(".nowline")) return;

    const startY = getOffsetY(evt);
    const startMin = Math.max(DAY_START_MIN, Math.min(DAY_END_MIN, snapToHalfHour(startY)));

    dragState = { date, startMin, currentMin: startMin + 30 };
    dragStarted = true;

    ghostEl = document.createElement("div");
    ghostEl.className = "drag-ghost";
    labelEl = document.createElement("div");
    labelEl.className = "drag-ghost-label";
    ghostEl.appendChild(labelEl);
    timeline.appendChild(ghostEl);

    updateGhost();
  }

  function updateGhost() {
    if (!ghostEl || !dragState) return;
    const top = (dragState.startMin - DAY_START_MIN) / 60 * HOUR_PX;
    const bottom = (dragState.currentMin - DAY_START_MIN) / 60 * HOUR_PX;
    const height = Math.max(bottom - top, HOUR_PX / 4);
    ghostEl.style.top = `${top}px`;
    ghostEl.style.height = `${height}px`;
    labelEl.textContent = `${minToLabel(dragState.startMin)} – ${minToLabel(dragState.currentMin)}`;
  }

  function moveDrag(evt) {
    const point = getPoint(evt);
    lastTouchPos = { x: point.clientX, y: point.clientY };

    if (!dragStarted || !dragState) return;

    evt.preventDefault();
    const y = getOffsetY(evt);
    const minutes = snapToHalfHour(y);
    dragState.currentMin = Math.max(dragState.startMin + 30, Math.min(DAY_END_MIN + 60, minutes));
    updateGhost();
  }

  function endDrag() {
    clearTimeout(longPressTimer);
    if (!dragStarted || !dragState) { dragStarted = false; return; }

    const finalStart = dragState.startMin;
    const finalEnd = dragState.currentMin;
    const finalDate = dragState.date;

    if (ghostEl) ghostEl.remove();
    ghostEl = null; labelEl = null; dragState = null; dragStarted = false;

    const draft = {
      id: uid(), seriesId: uid(),
      title: "",
      categoryId: categories[0].id,
      dateISO: iso(finalDate),
      allDay: false,
      start: finalStart,
      duration: Math.max(30, finalEnd - finalStart),
      bufferBefore: 0,
      bufferAfter: 0,
      reminder: "30m",
      mandatory: true,
      earnsMoney: false,
      recurrence: "none"
    };
    openSheet(draft, true);
  }

  function onPointerDown(evt) {
    if (evt.target.closest(".event") || evt.target.closest(".buffer")) return;

    const point = getPoint(evt);
    pendingStart = { x: point.clientX, y: point.clientY };
    lastTouchPos = pendingStart;

    longPressTimer = setTimeout(() => {
      const dx = Math.abs(lastTouchPos.x - pendingStart.x);
      const dy = Math.abs(lastTouchPos.y - pendingStart.y);
      if (dx > MOVE_CANCEL_THRESHOLD || dy > MOVE_CANCEL_THRESHOLD) return; // finger moved — treat as a scroll, not a hold
      startDrag(evt);
    }, 350);
  }

  function onPointerCancel() {
    clearTimeout(longPressTimer);
    if (dragStarted) endDrag();
  }

  timeline.addEventListener("touchstart", onPointerDown, { passive: true });
  timeline.addEventListener("touchmove", moveDrag, { passive: false });
  timeline.addEventListener("touchend", endDrag);
  timeline.addEventListener("touchcancel", onPointerCancel);

  timeline.addEventListener("mousedown", onPointerDown);
  timeline.addEventListener("mousemove", moveDrag);
  timeline.addEventListener("mouseup", endDrag);
  timeline.addEventListener("mouseleave", onPointerCancel);
}

function tickNowLine() {
  clearInterval(window._nowTick);
  window._nowTick = setInterval(()=>{
    const nowMin = new Date().getHours()*60+new Date().getMinutes();
    const nowTop = (nowMin-DAY_START_MIN)/60*HOUR_PX;
    const line = document.getElementById("nowline");
    if (line) line.style.top = `${nowTop}px`;
    const label = document.getElementById("nowlineLabel");
    if (label) { label.style.top = `${nowTop}px`; label.textContent = minToLabel(nowMin); }
    const banner = document.querySelector(".freebanner");
    if (banner) banner.outerHTML = renderFreeBanner();
  }, 60000);
}

let voiceRecognition = null;
let isRecording = false;

let aiStatus = "unknown"; // "unknown" | "good" | "busy"

function setAiStatus(status) {
  aiStatus = status;
  const dot = document.getElementById("aiStatusDot");
  if (dot) dot.className = "ai-status-dot " + status;
}

function startVoiceInput() {
  const SpeechRecognition =
    window.SpeechRecognition ||
    window.webkitSpeechRecognition;

  if (!SpeechRecognition) {
    alert("Voice input isn't supported on this browser.");
    return;
  }

  if (isRecording) {
    voiceRecognition?.stop();
    return;
  }

  voiceRecognition = new SpeechRecognition();

  voiceRecognition.lang = VOICE_LOCALE[currentLang] || "en-AU";
  voiceRecognition.continuous = false;
  voiceRecognition.interimResults = false;
  voiceRecognition.maxAlternatives = 1;

  isRecording = true;

  const button = document.getElementById("voicebtn");

  if (button) {
      button.classList.add("recording");
      const label = document.getElementById("voiceLabel");
      if (label) label.textContent = t("voice");
    }

  voiceRecognition.onresult = (event) => {
    const transcript = event.results[0][0].transcript.trim();
    processVoiceText(transcript);
  };

  voiceRecognition.onerror = (event) => {
    console.error("Voice recognition error:", event.error);

    if (event.error === "not-allowed") {
      alert("Microphone permission was denied.");
    }
  };

  voiceRecognition.onend = () => {
      isRecording = false;

      const button = document.getElementById("voicebtn");

      if (button) {
        button.classList.remove("recording");
        const label = document.getElementById("voiceLabel");
        if (label) label.textContent = t("voice");
      }

      voiceRecognition = null;
    };

  voiceRecognition.start();
}

/* ---------- Event handlers ---------- */
/* ---------- Event handlers ---------- */
function attachHandlers() {
  const scroller = document.getElementById("scroller");
  if (scroller) scroller.addEventListener("scroll", onScrollerScroll);
  attachDayPipsSwipe();

  const monthScroller = document.getElementById("monthScroller");
  if (monthScroller) monthScroller.addEventListener("scroll", onMonthScrollerScroll);

  document.querySelectorAll(".daycol[data-date]").forEach((el) => {
    if (view === "day") {
      const d = dateFromISO(el.dataset.date);
      attachTimelineDragHandlers(el, d);
    }
  });
}

function setupDelegatedHandlers() {
  app.addEventListener("click", (e) => {
    const actBtn = e.target.closest("[data-act]");
    if (actBtn) {
      const act = actBtn.dataset.act;
      if (act === "today") { weekStart = startOfWeek(new Date()); selectedDate = startOfDay(new Date()); monthCursor = startOfMonth(new Date()); render(); }
      else if (act === "prev") { view === "month" ? shiftMonth(-1) : shiftWeek(-1); }
      else if (act === "next") { view === "month" ? shiftMonth(1) : shiftWeek(1); }
      else if (act === "settings") { openSettingsPanel(); }
      else if (act === "agenda") { openDayAgenda(selectedDate); }
      return;
    }

    const viewBtn = e.target.closest("[data-view]");
    if (viewBtn) { view = viewBtn.dataset.view; render(); return; }

    const jumpBtn = e.target.closest("[data-jump]");
    if (jumpBtn) {
      const idx = parseInt(jumpBtn.dataset.jump, 10);
      selectedDate = addDays(weekStart, idx);
      scrollToDay(selectedDate, true);
      render();
      return;
    }

    const gotoBtn = e.target.closest("[data-goto]");
    if (gotoBtn) {
      const d = dateFromISO(gotoBtn.dataset.goto);
      selectedDate = startOfDay(d); weekStart = startOfWeek(selectedDate); view = "day"; render();
      return;
    }

    const editEl = e.target.closest("[data-edit]");
    if (editEl) {
      openSheet(events.find(ev => ev.id === editEl.dataset.edit), false, editEl.dataset.date);
      return;
    }

    if (e.target.closest("#addbtn")) { openSheet(null, true); return; }
    if (e.target.closest("#voicebtn")) {
      if (!chatOpen) openChatPanel();
      startChatVoiceInput();
      return;
    }
  });
}

// async function submitQuickAdd() {
//   const qi = document.getElementById("quickinput");
//   if (!qi || !qi.value.trim()) return;
//   const text = qi.value.trim();

//   const qa = document.getElementById("quickadd");
//   const originalLabel = qa ? qa.textContent : null;
//   if (qa) { qa.disabled = true; qa.textContent = "…"; }

//   let draft;
//   try {
//     draft = await parseQuickAddAI(text);
//     setAiStatus("good");
//   } catch (e) {
//     console.warn("AI parse unavailable, falling back to local parsing:", e.message);
//     setAiStatus("busy");
//     draft = parseQuickAdd(text);
//   }

//   if (qa) { qa.disabled = false; qa.textContent = originalLabel; }
//   openSheet(draft, true);
// }

async function processVoiceText(text) {
  if (!text || !text.trim()) return;

  const btn = document.getElementById("voicebtn");
  if (btn) btn.classList.add("thinking");

  let draft;
  try {
    draft = await parseQuickAddAI(text);
    setAiStatus("good");
  } catch (e) {
    console.warn("AI parse unavailable, falling back to local parsing:", e.message);
    setAiStatus("busy");
    draft = parseQuickAdd(text);
  }

  if (btn) btn.classList.remove("thinking");
  openSheet(draft, true);
}

function buildDraftFromAIData(data, text) {
  const cat = categories.find(c => c.name.toLowerCase() === (data.category || "").toLowerCase())
    || defaultCategory();
  const [hh, mm] = (data.time || "12:00").split(":").map(Number);
  const isAllDay = !!data.allDay;

  return {
    id: uid(), seriesId: uid(),
    title: cleanAITitle(data.title, text),
    categoryId: cat.id,
    dateISO: data.date || iso(selectedDate),
    allDay: isAllDay,
    start: isAllDay ? 0 : (isNaN(hh) ? 12 : hh) * 60 + (isNaN(mm) ? 0 : mm),
    duration: isAllDay ? 0 : (Number.isFinite(data.duration) ? data.duration : 60),
    bufferBefore: isAllDay ? 0 : (Number.isFinite(data.bufferBefore) ? data.bufferBefore : 30),
    bufferAfter: isAllDay ? 0 : (Number.isFinite(data.bufferAfter) ? data.bufferAfter : 30),
    reminder: data.reminder || (isAllDay ? "1d" : "30m"),
    mandatory: data.mandatory !== false,
    earnsMoney: !!data.earnsMoney,
    recurrence: data.recurrence || "none",
    notes: ""
  };
}

function findMatchingEvent(matchTitle, matchDateISO, matchTime) {
  const title = (matchTitle || "").toLowerCase().trim();
  if (!title) return null;
  const searchDate = matchDateISO ? dateFromISO(matchDateISO) : new Date();
  let candidates = [];
  for (let offset = -1; offset <= 14; offset++) {
    const d = addDays(searchDate, offset);
    candidates = candidates.concat(eventsOnDate(d).map(e => ({ ev: e, date: d })));
  }
  const titleMatches = candidates.filter(c => c.ev.title.toLowerCase().includes(title));
  if (titleMatches.length === 0) return null;
  if (titleMatches.length === 1) return titleMatches[0];
  if (matchTime) {
    const [hh, mm] = matchTime.split(":").map(Number);
    const targetMin = (hh || 0) * 60 + (mm || 0);
    titleMatches.sort((a, b) => Math.abs(a.ev.start - targetMin) - Math.abs(b.ev.start - targetMin));
  } else {
    titleMatches.sort((a, b) => Math.abs(dayDiff(a.date, searchDate)) - Math.abs(dayDiff(b.date, searchDate)));
  }
  return titleMatches[0];
}



let chatOpen = false;
let chatMessages = [];
let chatSending = false;

function openChatPanel() {
  chatOpen = true;
  renderChatPanel();
}

let activeChatRecognition = null;

function closeChatPanel() {
  chatOpen = false;
  if (activeChatRecognition) {
    activeChatRecognition.abort();
    activeChatRecognition = null;
  }
  const el = document.getElementById("chatPanel");
  if (el) el.remove();
}

function renderChatPanel() {
  let el = document.getElementById("chatPanel");
  if (!el) {
    el = document.createElement("div");
    el.id = "chatPanel";
    el.className = "chat-panel";
    document.body.appendChild(el);
  }
  el.innerHTML = `
    <div class="chat-header">
      <span>AI Assistant</span>
      <button id="chatClose" type="button">×</button>
    </div>
    <div class="chat-messages" id="chatMessagesList">
      ${chatMessages.length === 0 ? `<div class="chat-hint">Try: "What's free next Tuesday?" or "Schedule piano Thursday 4pm"</div>` : ""}
      ${chatMessages.map(m => `<div class="chat-bubble ${m.role}">${escapeHtml(m.text)}</div>`).join("")}
      ${chatSending ? `<div class="chat-bubble model chat-typing"><span></span><span></span><span></span></div>` : ""}
    </div>
    <div class="chat-inputrow">
      <button id="chatMic" type="button" class="chat-mic-btn" title="${t("voice")}">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
          <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
          <line x1="12" y1="19" x2="12" y2="23"/>
          <line x1="8" y1="23" x2="16" y2="23"/>
        </svg>
      </button>
      <input id="chatInput" type="text" placeholder="Ask or tell me anything..." autocomplete="off" />
      <button id="chatSend" type="button">➤</button>
    </div>
  `;
  el.querySelector("#chatClose").addEventListener("click", closeChatPanel);
  el.querySelector("#chatSend").addEventListener("click", sendChatFromInput);
  el.querySelector("#chatInput").addEventListener("keydown", (e) => { if (e.key === "Enter") sendChatFromInput(); });
  el.querySelector("#chatMic").addEventListener("click", startChatVoiceInput);

  const list = el.querySelector("#chatMessagesList");
  list.scrollTop = list.scrollHeight;
}

function sendChatFromInput() {
  const input = document.getElementById("chatInput");
  if (!input || !input.value.trim()) return;
  const text = input.value.trim();
  input.value = "";
  sendChatMessage(text);
}

function startChatVoiceInput() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) { alert("Voice input isn't supported on this browser."); return; }
  const recog = new SpeechRecognition();
  activeChatRecognition = recog;
  recog.lang = VOICE_LOCALE[currentLang] || "en-AU";
  recog.continuous = false;
  recog.interimResults = false;
  recog.maxAlternatives = 1;

  const micBtn = document.getElementById("chatMic");
  if (micBtn) micBtn.classList.add("recording");

  recog.onresult = (event) => {
    const transcript = event.results[0][0].transcript.trim();
    sendChatMessage(transcript);
  };
  recog.onerror = (event) => {
    if (event.error === "not-allowed") alert("Microphone permission was denied.");
  };
  recog.onend = () => {
    activeChatRecognition = null;
    const btn = document.getElementById("chatMic");
    if (btn) btn.classList.remove("recording");
  };

  recog.start();
}

function getEventsWindowForChat() {
  const today = startOfDay(new Date());
  const list = [];
  const seen = new Set();
  for (let offset = -3; offset <= 45; offset++) {
    const d = addDays(today, offset);
    for (const ev of eventsOnDate(d)) {
      const key = ev.id + "_" + iso(d);
      if (seen.has(key)) continue;
      seen.add(key);
      const cat = categoryOf(ev.categoryId);
      list.push({
        id: ev.id, title: ev.title, date: iso(d),
        start: ev.start, duration: ev.duration,
        bufferBefore: ev.bufferBefore, bufferAfter: ev.bufferAfter,
        mandatory: ev.mandatory, allDay: !!ev.allDay,
        category: cat.name
      });
    }
  }
  return list;
}

async function sendChatMessage(text) {
  if (!text || !text.trim()) return;
  chatMessages.push({ role: "user", text });
  chatSending = true;
  renderChatPanel();

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: text,
        history: chatMessages.slice(0, -1).map(m => ({ role: m.role, text: m.text })),
        events: getEventsWindowForChat(),
        categories: categories.map(c => ({ name: c.name, earnsDefault: !!c.earnsDefault })),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        todayISO: iso(new Date())
      })
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data) throw new Error((data && data.error) || "Chat request failed");

    if (data.type === "actions" && Array.isArray(data.actions) && data.actions.length) {
      const summaries = data.actions.map(a => executeChatAction(a));
      const summaryText = summaries.filter(Boolean).join(" ");
      chatMessages.push({ role: "model", text: data.text || summaryText || "Done." });
    } else {
      chatMessages.push({ role: "model", text: data.text || "..." });
    }
  } catch (e) {
    console.error("Chat failed:", e);
    chatMessages.push({ role: "model", text: "Sorry, I couldn't process that — try again in a moment." });
  }

  chatSending = false;
  renderChatPanel();
}

function executeChatAction(action) {
  const args = action.args || {};

  if (action.name === "createEvent") {
    const draft = buildDraftFromAIData({
      title: args.title, date: args.date, time: args.time,
      duration: args.duration, category: args.category,
      bufferBefore: args.bufferBefore, bufferAfter: args.bufferAfter,
      mandatory: args.mandatory, earnsMoney: args.earnsMoney,
      recurrence: "none", reminder: args.reminder, allDay: args.allDay
    }, args.title || "");
    if (Number.isFinite(args.recurrenceDays)) draft.recurrenceDays = args.recurrenceDays;

    events.push(draft);
    save(); render();
    return `Added ${draft.title} — ${formatDateReadable(draft.dateISO)}${draft.allDay ? "" : `, ${minToLabel(draft.start)}`}.`;
  }

  if (action.name === "deleteEvent") {
    const match = findMatchingEvent(args.matchTitle, args.matchDate, args.matchTime);
    if (!match) return `Couldn't find an event matching "${args.matchTitle}".`;
    if (getRecurrenceDays(match.ev) > 0) {
      openDeleteChoice(match.ev, null, iso(match.date));
      return `"${match.ev.title}" repeats — check the popup to choose what to delete.`;
    }
    const deletedEvent = match.ev;
    events = events.filter(e => e.id !== deletedEvent.id);
    save(); render();
    showUndoSnackbar(`Deleted "${deletedEvent.title}"`, () => { events.push(deletedEvent); save(); render(); });
    return `Deleted "${deletedEvent.title}".`;
  }

  if (action.name === "moveEvent") {
    const match = findMatchingEvent(args.matchTitle, args.matchDate, args.matchTime);
    if (!match) return `Couldn't find an event matching "${args.matchTitle}" to move.`;
    if (getRecurrenceDays(match.ev) > 0) {
      return `"${match.ev.title}" repeats — please open it manually to move it.`;
    }
    const [hh, mm] = (args.newTime || "12:00").split(":").map(Number);
    const newStart = isNaN(hh) ? match.ev.start : hh * 60 + (isNaN(mm) ? 0 : mm);
    const newDateISO = args.newDate || match.ev.dateISO;
    const updated = { ...match.ev, dateISO: newDateISO, start: newStart };
    events = events.map(e => e.id === updated.id ? updated : e);
    save(); render();
    return `Moved ${updated.title} to ${formatDateReadable(newDateISO)}, ${minToLabel(newStart)}.`;
  }
  if (action.name === "editEvent") {
    const match = findMatchingEvent(args.matchTitle, args.matchDate, args.matchTime);
    if (!match) return `Couldn't find ${args.matchTitle}.`;
    if (getRecurrenceDays(match.ev) > 0) {
      return `${match.ev.title} repeats — please open it manually to edit it.`;
    }

    const updates = {};
    if (typeof args.newTitle === "string" && args.newTitle.trim()) updates.title = args.newTitle.trim();
    if (typeof args.category === "string" && args.category.trim()) {
      const cat = categories.find(c => c.name.toLowerCase() === args.category.toLowerCase());
      if (cat) updates.categoryId = cat.id;
    }
    if (Number.isFinite(args.bufferBefore)) updates.bufferBefore = args.bufferBefore;
    if (Number.isFinite(args.bufferAfter)) updates.bufferAfter = args.bufferAfter;
    if (typeof args.mandatory === "boolean") updates.mandatory = args.mandatory;
    if (typeof args.earnsMoney === "boolean") updates.earnsMoney = args.earnsMoney;
    if (typeof args.reminder === "string" && args.reminder) updates.reminder = args.reminder;
    if (Number.isFinite(args.duration)) updates.duration = Math.max(5, args.duration);

    if (Object.keys(updates).length === 0) return `Not sure what to change about ${match.ev.title}.`;

    const updatedEvent = { ...match.ev, ...updates };
    events = events.map(e => e.id === updatedEvent.id ? updatedEvent : e);
    save(); render();
    return `Updated ${match.ev.title}.`;
  }

  return "";
}

function shiftWeek(n) { weekStart = addDays(weekStart, 7*n); selectedDate = addDays(selectedDate,7*n); render(); }
function shiftMonth(n) { monthCursor = new Date(monthCursor.getFullYear(), monthCursor.getMonth()+n, 1); render(); }

function exportBackup() {
  const payload = { exportedAt: new Date().toISOString(), events, categories };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `actually-free-backup-${iso(new Date())}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function importBackup(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!Array.isArray(data.events)) throw new Error("File doesn't look like a valid backup.");
      const count = data.events.length;
      const when = data.exportedAt ? new Date(data.exportedAt).toLocaleString() : "an unknown date";
      if (!confirm(`This backup has ${count} event(s), exported ${when}. Replace your current calendar with it?`)) return;
      events = data.events;
      if (Array.isArray(data.categories)) categories = data.categories;
      save();
      render();
      alert("Backup restored.");
    } catch (e) {
      alert("Couldn't read that file: " + e.message);
    }
  };
  reader.readAsText(file);
}

let settingsPanelEl = null;
let settingsAuthView = "main"; // "main" | "auth"

function settingsPanelContent() {
  if (settingsAuthView === "auth") return authViewContent();

  return `
    <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:18px;">
      <h2 style="margin:0;">${t("settings")}</h2>
      <button id="settingsClose" style="border:none; background:none; font-size:1.3rem; line-height:1; color:var(--ink-soft); padding:4px;">×</button>
    </div>

    <div class="settings-section">
      <h3>${t("cloudAccount")}</h3>
      <div id="cloudstatus" class="cloudstatus" style="text-align:left; padding:0 0 10px;">
        ${currentUser ? `Synced as ${currentUser.displayName || currentUser.email}${lastSyncedAt ? ` · last saved ${formatSyncTime(lastSyncedAt)}` : ""}` : "Sign in to back up your calendar and enable notifications"}
      </div>
      <button class="settings-btn" id="settingsAuthBtn">
        <span>${currentUser ? t("signOut") : t("signIn")}</span>
        <span>›</span>
      </button>
    </div>

    <div class="settings-section">
      <h3>${t("notifications")}</h3>
      <button class="settings-btn ${pushEnabled ? "active" : ""}" id="settingsPushBtn">
        <span>${pushEnabled ? t("pushOn") : t("pushOff")}</span>
      </button>
    </div>

    <div class="settings-section">
      <h3>Theme</h3>
      <button class="settings-btn ${currentTheme === "dark" ? "active" : ""}" id="settingsThemeBtn">
        <span>${currentTheme === "dark" ? "Dark mode: On" : "Dark mode: Off"}</span>
      </button>
    </div>

    <div class="settings-section">
      <h3>${t("language")}</h3>
      <select id="settingsLangSelect" style="width:100%; min-height:44px; padding:8px 10px; border:1px solid var(--line); border-radius:10px; background:var(--bg); color:var(--ink); font-size:16px;">
        <option value="en" ${currentLang==="en"?"selected":""}>English</option>
        <option value="de" ${currentLang==="de"?"selected":""}>Deutsch</option>
        <option value="mk" ${currentLang==="mk"?"selected":""}>Македонски</option>
        <option value="sr" ${currentLang==="sr"?"selected":""}>Srpski</option>
      </select>
    </div>

    <div class="settings-section">
      <h3>${t("backup")}</h3>
      <button class="settings-btn" id="settingsExportBtn">
        <span>${t("exportBackup")}</span>
      </button>
      <button class="settings-btn" id="settingsImportBtn">
        <span>${t("importBackup")}</span>
      </button>
      <input type="file" id="settingsImportFile" accept="application/json" style="display:none;" />
    </div>

    <div class="settings-section">
      <h3>Help</h3>
      <button class="settings-btn" id="settingsHelpBtn">
        <span>How to use this app</span>
        <span>›</span>
      </button>
    </div>
  `;
}

function authViewContent() {
  return `
    <div style="display:flex; align-items:center; gap:8px; margin-bottom:18px;">
      <button id="authBack" style="border:none; background:none; font-size:1.3rem; line-height:1; color:var(--ink-soft); padding:4px;">‹</button>
      <h2 style="margin:0;">${t("cloudAccount")}</h2>
    </div>

    <div class="field">
      <label>Email</label>
      <input id="authEmail" type="email" autocomplete="email" placeholder="you@example.com" />
    </div>

    <div class="field">
      <label>Password</label>
      <input id="authPassword" type="password" autocomplete="current-password" placeholder="Password" />
    </div>

    <div id="authMessage" style="display:none; margin:10px 0; padding:10px; border-radius:8px; font-size:13px;"></div>

    <button class="btn primary" id="authLogin" style="width:100%;">${t("signIn")}</button>

    <div style="display:flex; justify-content:space-between; margin-top:14px; font-size:13px;">
      <button id="authCreate" style="border:none; background:none; text-decoration:underline; cursor:pointer; padding:0; color:var(--ink);">Create an account</button>
      <button id="authForgot" style="border:none; background:none; text-decoration:underline; cursor:pointer; padding:0; color:var(--ink);">Forgot password?</button>
    </div>
  `;
}

function wireSettingsPanel(panel) {
  if (settingsAuthView === "auth") {
    wireAuthView(panel);
    return;
  }

  panel.querySelector("#settingsClose").addEventListener("click", () => {
    if (settingsPanelEl) { settingsPanelEl.remove(); settingsPanelEl = null; }
  });

  panel.querySelector("#settingsAuthBtn").addEventListener("click", () => {
    if (!currentUser) {
      settingsAuthView = "auth";
      refreshSettingsPanel();
    } else if (confirm(`Synced as ${currentUser.displayName || currentUser.email}. Sign out of cloud backup?`)) {
      signOutCloud();
    }
  });

  panel.querySelector("#settingsPushBtn").addEventListener("click", () => toggleNotifications());
    panel.querySelector("#settingsThemeBtn").addEventListener("click", () => {
    setTheme(currentTheme === "dark" ? "light" : "dark");
  });

  panel.querySelector("#settingsLangSelect").addEventListener("change", (e) => setLang(e.target.value));
  panel.querySelector("#settingsHelpBtn").addEventListener("click", openHelpSheet);

  panel.querySelector("#settingsExportBtn").addEventListener("click", exportBackup);

  const importFile = panel.querySelector("#settingsImportFile");
  panel.querySelector("#settingsImportBtn").addEventListener("click", () => importFile.click());
  importFile.addEventListener("change", (e) => {
    if (e.target.files && e.target.files[0]) importBackup(e.target.files[0]);
    e.target.value = "";
  });
}

function wireAuthView(panel) {
  const emailInput = panel.querySelector("#authEmail");
  const passwordInput = panel.querySelector("#authPassword");
  const messageBox = panel.querySelector("#authMessage");

  const showMessage = (text, isError = true) => {
    messageBox.textContent = text;
    messageBox.style.background = isError ? "#fff0ef" : "#eefaf0";
    messageBox.style.color = isError ? "#b42318" : "#1a7f3c";
    messageBox.style.display = "block";
  };
  const hideMessage = () => { messageBox.style.display = "none"; };

  panel.querySelector("#authBack").addEventListener("click", () => {
    settingsAuthView = "main";
    refreshSettingsPanel();
  });

  panel.querySelector("#authLogin").addEventListener("click", async () => {
    hideMessage();
    const email = emailInput.value.trim().toLowerCase();
    const password = passwordInput.value;

    if (!email) return showMessage("Enter your email address.");
    if (!password) return showMessage("Enter your password.");

    try {
      await signInWithEmailAndPassword(auth, email, password);
      settingsAuthView = "main";
      refreshSettingsPanel();
    } catch (error) {
      console.error("Email sign-in failed:", error);
      const messages = {
        "auth/invalid-credential": "The email or password is incorrect.",
        "auth/user-not-found": "No account exists with this email — try Create an account instead.",
        "auth/wrong-password": "The password is incorrect.",
        "auth/invalid-email": "Enter a valid email address.",
        "auth/too-many-requests": "Too many attempts. Try again later."
      };
      showMessage(messages[error.code] || error.message || "Sign-in failed.");
    }
  });

  panel.querySelector("#authCreate").addEventListener("click", async () => {
    hideMessage();
    const email = emailInput.value.trim().toLowerCase();
    const password = passwordInput.value;

    if (!email) return showMessage("Enter your email address.");
    if (password.length < 6) return showMessage("Password must contain at least 6 characters.");

    try {
      await createUserWithEmailAndPassword(auth, email, password);
      settingsAuthView = "main";
      refreshSettingsPanel();
    } catch (error) {
      console.error("Account creation failed:", error);
      const messages = {
        "auth/email-already-in-use": "An account already exists with this email — try Sign in, or use Forgot password.",
        "auth/invalid-email": "Enter a valid email address.",
        "auth/weak-password": "Password must contain at least 6 characters."
      };
      showMessage(messages[error.code] || error.message || "Could not create account.");
    }
  });

  panel.querySelector("#authForgot").addEventListener("click", async () => {
    hideMessage();
    const email = emailInput.value.trim().toLowerCase();
    if (!email) return showMessage("Enter your email address first, then tap Forgot password.");

    try {
      await sendPasswordResetEmail(auth, email);
      showMessage("Password reset email sent — check your inbox, then come back and sign in.", false);
    } catch (error) {
      console.error("Password reset failed:", error);
      const messages = {
        "auth/user-not-found": "No account exists with this email — try Create an account instead.",
        "auth/invalid-email": "Enter a valid email address."
      };
      showMessage(messages[error.code] || error.message || "Couldn't send reset email.");
    }
  });
}

function openSettingsPanel() {
  if (settingsPanelEl) return;

  const overlay = document.createElement("div");
  overlay.className = "side-panel-overlay";
  overlay.id = "settingsOverlay";
  overlay.innerHTML = `<div class="side-panel" id="settingsPanel">${settingsPanelContent()}</div>`;
  document.body.appendChild(overlay);
  settingsPanelEl = overlay;

  overlay.addEventListener("click", e => { if (e.target === overlay) { overlay.remove(); settingsPanelEl = null; } });
  wireSettingsPanel(overlay.querySelector("#settingsPanel"));
}

function refreshSettingsPanel() {
  if (!settingsPanelEl) return;
  const panel = settingsPanelEl.querySelector("#settingsPanel");
  if (!panel) return;
  panel.innerHTML = settingsPanelContent();
  wireSettingsPanel(panel);
}


function openCategoryManager(onDone) {
  const overlay = document.createElement("div");
  overlay.className = "overlay";

  const rowsHtml = () => categories.map((c, i) => `
    <div class="catrow" data-idx="${i}">
      <input type="color" class="catcolor" value="${c.color}" />
      <input type="text" class="catname" value="${escapeHtml(c.name)}" />
      <button type="button" class="catdelete" title="Delete category">✕</button>
    </div>
  `).join("");

  overlay.innerHTML = `
    <div class="sheet">
      <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:12px;">
        <h2 style="margin:0;">${t("manageCategories")}</h2>
        <button id="catClose" style="border:none; background:none; font-size:1.3rem; line-height:1; color:var(--ink-soft); padding:4px;">×</button>
      </div>
      <div id="catList">${rowsHtml()}</div>
      <button type="button" class="btn ghost" id="catAddNew" style="width:100%; margin-top:10px;">${t("addCategory")}</button>
      <button type="button" class="btn primary" id="catSaveAll" style="width:100%; margin-top:14px;">${t("save")}</button>
    </div>
  `;

  document.body.appendChild(overlay);

  function attachRowHandlers() {
    overlay.querySelectorAll(".catdelete").forEach(btn => {
      btn.addEventListener("click", () => {
        if (categories.length <= 1) { alert("You need at least one category."); return; }
        const idx = parseInt(btn.closest(".catrow").dataset.idx, 10);
        categories.splice(idx, 1);
        overlay.querySelector("#catList").innerHTML = rowsHtml();
        attachRowHandlers();
      });
    });
  }
  attachRowHandlers();

  overlay.querySelector("#catClose").addEventListener("click", () => overlay.remove());
  overlay.addEventListener("click", e => { if (e.target === overlay) overlay.remove(); });

  overlay.querySelector("#catAddNew").addEventListener("click", () => {
    categories.push({ id: uid(), name: "New category", color: "#7C5CBF", earnsDefault: false });
    overlay.querySelector("#catList").innerHTML = rowsHtml();
    attachRowHandlers();
  });

  overlay.querySelector("#catSaveAll").addEventListener("click", () => {
    const updated = [];
    overlay.querySelectorAll(".catrow").forEach(row => {
      const idx = parseInt(row.dataset.idx, 10);
      const name = row.querySelector(".catname").value.trim() || categories[idx].name;
      const color = row.querySelector(".catcolor").value;
      updated.push({ ...categories[idx], name, color });
    });
    categories = updated;
    save();
    overlay.remove();
    if (onDone) onDone();
  });
}

function openHelpSheet() {
  const overlay = document.createElement("div");
  overlay.className = "overlay";
  overlay.style.zIndex = "60";
  overlay.innerHTML = `
    <div class="sheet">
      <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:14px;">
        <h2 style="margin:0;">How to use this app</h2>
        <button id="helpClose" style="border:none; background:none; font-size:1.3rem; line-height:1; color:var(--ink-soft); padding:4px;">×</button>
      </div>

      <div class="help-section">
        <h3>Creating an event</h3>
        <ul>
          <li><b>Plus button</b> - opens a blank event form to fill in manually.</li>
          <li><b>Voice button</b> - tell an AI to schedule an event for you and it fills the form in automatically.</li>
          <li><b>Press and hold</b> on an empty spot in the timeline, then drag down to set the start/end time by feel - release to open the form pre-filled with that time.</li>
        </ul>
      </div>

      <div class="help-section">
        <h3>Deleting events</h3>
        <ul>
          <li>Tap any event to open it, then Delete.</li>
          <li>For a repeating event, you'll be asked: delete just that one date, or the whole series going forward.</li>
          <li><b>View button</b> - shows a simple list of every event on the current day with a quick ✕ to delete</li>
        </ul>
      </div>

      <div class="help-section">
        <h3>Cloud sync & notifications</h3>
        <p>Sign in to back up your calendar and enable push notifications. The small tag under the top bar shows "Synced ✓" with a timestamp, or a warning if a save fails. Notifications can be toggled on/off in Settings.</p>
      </div>

      <div class="help-section">
        <h3>Backup</h3>
        <p>Export downloads a copy of everything as a file - a safety net independent of the cloud. Import restores from that file if you ever need to.</p>
      </div>

      <div class="help-section" style="border-bottom:none;">
        <h3>Language</h3>
        <p>Change the app's language (and voice recognition language) from Settings.</p>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector("#helpClose").addEventListener("click", () => overlay.remove());
  overlay.addEventListener("click", e => { if (e.target === overlay) overlay.remove(); });
}

function openDayAgenda(date) {
  const dStr = iso(date);
  const evs = eventsOnDate(date).sort((a, b) => {
    if (a.allDay && !b.allDay) return -1;
    if (!a.allDay && b.allDay) return 1;
    return a.start - b.start;
  });

  const overlay = document.createElement("div");
  overlay.className = "overlay";
  overlay.id = "agendaOverlay";

  const rowsHtml = () => evs.length
    ? evs.map(ev => {
        const cat = categoryOf(ev.categoryId);
        const timeLabel = ev.allDay
          ? (ev.endDateISO && ev.endDateISO !== ev.dateISO ? `${ev.dateISO} – ${ev.endDateISO}` : t("allDay"))
          : `${minToLabel(ev.start)} – ${minToLabel(ev.start + ev.duration)}`;
        return `<div class="agenda-row" data-id="${ev.id}">
          <span class="agenda-dot" style="background:${cat.color}"></span>
          <div class="agenda-info">
            <div class="agenda-title">${escapeHtml(ev.title)}</div>
            <div class="agenda-time">${timeLabel} · ${cat.name}</div>
          </div>
          <button type="button" class="agenda-delete" data-id="${ev.id}" title="Delete">✕</button>
        </div>`;
      }).join("")
    : `<div style="padding:20px 0; text-align:center; color:var(--ink-soft); font-size:0.85rem;">No events on this day.</div>`;

  overlay.innerHTML = `
    <div class="sheet">
      <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:12px;">
        <h2 style="margin:0;">${date.toLocaleDateString(undefined,{weekday:"long", month:"short", day:"numeric"})}</h2>
        <button id="agendaClose" style="border:none; background:none; font-size:1.3rem; line-height:1; color:var(--ink-soft); padding:4px;">×</button>
      </div>
      <div id="agendaList">${rowsHtml()}</div>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.querySelector("#agendaClose").addEventListener("click", () => overlay.remove());
  overlay.addEventListener("click", e => { if (e.target === overlay) overlay.remove(); });

  function attachRowHandlers() {
    overlay.querySelectorAll(".agenda-delete").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const ev = events.find(x => x.id === btn.dataset.id);
        if (!ev) return;
        if (getRecurrenceDays(ev) > 0) {
          openDeleteChoice(ev, overlay, dStr);
        } else {
          if (!confirm(`Delete "${ev.title}"?`)) return;
          const deletedEvent = ev;
          events = events.filter(x => x.id !== ev.id);
          save();
          overlay.remove();
          render();
          showUndoSnackbar(`Deleted "${deletedEvent.title}"`, () => { events.push(deletedEvent); save(); render(); });
        }
      });
    });

    overlay.querySelectorAll(".agenda-row").forEach(row => {
      row.addEventListener("click", () => {
        const ev = events.find(x => x.id === row.dataset.id);
        if (ev) { overlay.remove(); openSheet(ev, false, dStr); }
      });
    });
  }
  attachRowHandlers();
}

function openEditChoice(originalDraft, updated, parentOverlay, occurrenceDateISO) {
  const overlay = document.createElement("div");
  overlay.className = "overlay";
  overlay.innerHTML = `
    <div class="sheet">
      <h2>Save changes to this repeating event</h2>
      <p style="font-size:0.88rem; color:var(--ink-soft); margin:0 0 16px;">This event repeats. What would you like to do?</p>
      <div style="display:flex; flex-direction:column; gap:10px;">
        <button class="btn ghost" id="editCancel">Cancel</button>
        <button class="btn ghost" id="editOne">Edit just this date (${occurrenceDateISO})</button>
        <button class="btn" id="editAll" style="background:var(--danger); color:white;">Edit this and all future dates</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.addEventListener("click", e => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector("#editCancel").addEventListener("click", () => overlay.remove());

  overlay.querySelector("#editOne").addEventListener("click", () => {
    const orig = events.find(e => e.id === originalDraft.id);
    if (orig) {
      orig.excludedDates = Array.isArray(orig.excludedDates) ? [...orig.excludedDates, occurrenceDateISO] : [occurrenceDateISO];
    }
    const oneOff = { ...updated, id: uid(), seriesId: uid(), dateISO: occurrenceDateISO, endDateISO: null, recurrence: "none", recurrenceDays: 0, excludedDates: [], seriesEndISO: null };
    events.push(oneOff);
    save();
    overlay.remove();
    parentOverlay?.remove();
    selectedDate = startOfDay(new Date(occurrenceDateISO));
    weekStart = startOfWeek(selectedDate);
    view = "day";
    render();
  });

  overlay.querySelector("#editAll").addEventListener("click", () => {
    const orig = events.find(e => e.id === originalDraft.id);
    if (orig) orig.seriesEndISO = occurrenceDateISO;
    const newSeries = { ...updated, id: uid(), seriesId: uid(), dateISO: occurrenceDateISO, endDateISO: null, excludedDates: [], seriesEndISO: null };
    events.push(newSeries);
    save();
    overlay.remove();
    parentOverlay?.remove();
    selectedDate = startOfDay(new Date(occurrenceDateISO));
    weekStart = startOfWeek(selectedDate);
    view = "day";
    render();
  });
}

function openDeleteChoice(draft, parentOverlay, targetDateISO) {
  const overlay = document.createElement("div");
  overlay.className = "overlay";
  overlay.innerHTML = `
    <div class="sheet">
      <h2>${t("deleteRepeating")}</h2>
      <p style="font-size:0.88rem; color:var(--ink-soft); margin:0 0 16px;">${t("deleteRepeatingDesc")}</p>
      <div style="display:flex; flex-direction:column; gap:10px;">
        <button class="btn ghost" id="delCancel">${t("cancelDelete")}</button>
        <button class="btn ghost" id="delOne">${t("deleteJustThis")} (${formatDateReadable(targetDateISO)})</button>
        <button class="btn" id="delAll" style="background:var(--danger); color:white;">${t("deleteAllFuture")}</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.addEventListener("click", e => { if (e.target === overlay) overlay.remove(); });

  overlay.querySelector("#delCancel").addEventListener("click", () => overlay.remove());

  overlay.querySelector("#delOne").addEventListener("click", () => {
    const ev = events.find(e => e.id === draft.id);
    if (ev) {
      const prevExcluded = Array.isArray(ev.excludedDates) ? [...ev.excludedDates] : [];
      ev.excludedDates = [...prevExcluded, targetDateISO];
      save();
      overlay.remove();
      parentOverlay?.remove();
      render();
      showUndoSnackbar(`Removed "${ev.title}" on ${targetDateISO}`, () => { ev.excludedDates = prevExcluded; save(); render(); });
    } else {
      overlay.remove();
      parentOverlay?.remove();
    }
  });

  overlay.querySelector("#delAll").addEventListener("click", () => {
    const deletedEvent = events.find(e => e.id === draft.id);
    events = events.filter(e => e.id !== draft.id);
    save();
    overlay.remove();
    parentOverlay?.remove();
    render();
    if (deletedEvent) showUndoSnackbar(`Deleted "${deletedEvent.title}" (entire series)`, () => { events.push(deletedEvent); save(); render(); });
  });
}

let undoTimer = null;
function showUndoSnackbar(message, restoreFn) {
  clearTimeout(undoTimer);
  const existing = document.getElementById("undoSnackbar");
  if (existing) existing.remove();
  const bar = document.createElement("div");
  bar.id = "undoSnackbar";
  bar.className = "undo-snackbar";
  bar.innerHTML = `<button type="button" id="undoBtn">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M3 7v6h6"/>
      <path d="M21 17a9 9 0 0 0-15-6.7L3 13"/>
    </svg>
    <span>Undo</span>
  </button>`;
  document.body.appendChild(bar);
  bar.querySelector("#undoBtn").addEventListener("click", () => {
    clearTimeout(undoTimer);
    bar.remove();
    restoreFn();
  });
  undoTimer = setTimeout(() => { bar.remove(); }, 5000);
}

/* ---------- Add/edit sheet ---------- */
function openSheet(ev, isNew=false, occurrenceDateISO=null) {
  const isEdit = !isNew && ev && events.includes(ev);
  const draft = isEdit ? ev : (ev || {
    id: uid(), seriesId: uid(), title:"", categoryId: categories[0].id,
    dateISO: iso(selectedDate), start: roundToNext30(), duration:60,
    bufferBefore:0,
    bufferAfter:0,
    reminder:"30m",
    mandatory:true,
    earnsMoney:false,
    recurrence:"none"
  });

  const overlay = document.createElement("div");
  overlay.className = "overlay";
  overlay.innerHTML = `
    <div class="sheet">
      <h2>${isEdit ? t("editEvent") : t("newEvent")}</h2>
      <div class="field"><label>${t("titleLabel")}</label><input type="text" id="f-title" value="${escapeHtml(draft.title)}" /></div>
      <div class="field"><label>${t("dateLabel")}</label><input type="date" id="f-date" value="${draft.dateISO}" /></div>
      <div class="togglerow" style="border-bottom:none"><span>${t("allDay")}</span><input type="checkbox" id="f-allday" ${draft.allDay?"checked":""} /></div>
      <div class="row2" id="f-timerow" style="${draft.allDay?"display:none;":""}">
        <div class="field"><label>${t("startTime")}</label><input type="time" id="f-time" value="${pad2(Math.floor(draft.start/60))}:${pad2(draft.start%60)}" /></div>
        <div class="field"><label>${t("endTime")}</label><input type="time" id="f-endtime" value="${pad2(Math.floor(((draft.start+draft.duration)%1440)/60))}:${pad2((draft.start+draft.duration)%60)}" /></div>
      </div>
      <div class="row2" id="f-allday-daterow" style="${draft.allDay?"":"display:none;"}">
        <div class="field"><label>${t("startDay")}</label><input type="date" id="f-alldaystart" value="${draft.dateISO}" /></div>
        <div class="field"><label>${t("endDay")}</label><input type="date" id="f-alldayend" value="${draft.endDateISO || draft.dateISO}" /></div>
      </div>
      <div class="field">
        <label style="display:flex; align-items:center; justify-content:space-between;">
          <span>${t("category")}</span>
          <button type="button" id="manageCatsBtn" style="border:none; background:none; text-decoration:underline; cursor:pointer; font-size:0.75rem; color:var(--ink-soft); padding:0;">${t("editCategories")}</button>
        </label>
        <div class="chiprow" id="f-cats">
          ${categories.map(c=>`<div class="chip ${c.id===draft.categoryId?"selected":""}" data-cat="${c.id}"><span class="swatch" style="background:${c.color}"></span>${c.name}</div>`).join("")}
        </div>
      </div>
      <div class="row2" id="f-bufferrow" style="${draft.allDay?"display:none;":""}">
        <div class="field">
          <label>${t("bufferBefore")}</label>
          <select id="f-bufbefore">
            ${Array.from({length:25},(_,i)=>i*5).map(m => `
              <option value="${m}" ${Number(draft.bufferBefore) === m ? "selected" : ""}>
                ${m < 60 ? `${m} ${t("minutes")}` : `${Math.floor(m/60)} ${m >= 120 ? t("hours") : t("hour")}${m % 60 ? ` ${m % 60} ${t("minutes")}` : ""}`}
              </option>
            `).join("")}
          </select>
        </div>

        <div class="field">
          <label>${t("bufferAfter")}</label>
          <select id="f-bufafter">
            ${Array.from({length:25},(_,i)=>i*5).map(m => `
              <option value="${m}" ${Number(draft.bufferAfter) === m ? "selected" : ""}>
                ${m < 60 ? `${m} ${t("minutes")}` : `${Math.floor(m/60)} ${m >= 120 ? t("hours") : t("hour")}${m % 60 ? ` ${m % 60} ${t("minutes")}` : ""}`}
              </option>
            `).join("")}
          </select>
        </div>
      </div>
      <div class="field">
        <label>${t("remindMe")}</label>
        <select id="f-reminder">
          <option value="none" ${draft.reminder === "none" ? "selected" : ""}>${t("noReminder")}</option>
          <option value="30m" ${(!draft.reminder || draft.reminder === "30m") ? "selected" : ""}>30 ${t("minutes")}</option>
          <option value="1h" ${draft.reminder === "1h" ? "selected" : ""}>1 ${t("hour")}</option>
          <option value="6h" ${draft.reminder === "6h" ? "selected" : ""}>6 ${t("hours")}</option>
          <option value="12h" ${draft.reminder === "12h" ? "selected" : ""}>12 ${t("hours")}</option>
          <option value="1d" ${draft.reminder === "1d" ? "selected" : ""}>1 ${t("hours") === "hours" ? "day" : t("hours")}</option>
          <option value="1w" ${draft.reminder === "1w" ? "selected" : ""}>1 week</option>
          <option value="1mo" ${draft.reminder === "1mo" ? "selected" : ""}>1 month</option>
        </select>
      </div>
      <div class="field"><label>${t("repeats")}</label>
        <select id="f-recur">
          <option value="none" ${draft.recurrence==="none"?"selected":""}>${t("doesntRepeat")}</option>
          <option value="weekly" ${draft.recurrence==="weekly"?"selected":""}>${t("weekly")}</option>
          <option value="fortnightly" ${draft.recurrence==="fortnightly"?"selected":""}>${t("fortnightly")}</option>
        </select>
      </div>
      <div class="togglerow"><span>${t("mandatory")}</span><input type="checkbox" id="f-mandatory" ${draft.mandatory?"checked":""} /></div>
      <div class="togglerow" style="border-bottom:none"><span>${t("earnsMoney")}</span><input type="checkbox" id="f-money" ${draft.earnsMoney?"checked":""} /></div>
      <div class="sheetactions">
        ${isEdit ? `<button class="btn danger" id="f-delete">${t("delete")}</button>` : ""}
        <button class="btn ghost" id="f-cancel">${t("cancel")}</button>
        <button class="btn primary" id="f-save">${isEdit?t("save"):t("add")}</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  let chosenCat = draft.categoryId;

  function attachCatChipHandlers() {
    overlay.querySelectorAll("[data-cat]").forEach(chip=>{
      chip.addEventListener("click", ()=>{
        chosenCat = chip.dataset.cat;
        overlay.querySelectorAll("[data-cat]").forEach(c=>c.classList.remove("selected"));
        chip.classList.add("selected");
        const cat = categoryOf(chosenCat);
        overlay.querySelector("#f-money").checked = !!cat.earnsDefault;
      });
    });
  }
  attachCatChipHandlers();

  const alldayCheckbox = overlay.querySelector("#f-allday");
  const timeRow = overlay.querySelector("#f-timerow");
  const bufferRow = overlay.querySelector("#f-bufferrow");
  const alldayDateRow = overlay.querySelector("#f-allday-daterow");
  alldayCheckbox.addEventListener("change", () => {
    const isAllDay = alldayCheckbox.checked;
    timeRow.style.display = isAllDay ? "none" : "";
    bufferRow.style.display = isAllDay ? "none" : "";
    alldayDateRow.style.display = isAllDay ? "" : "none";
  });

  overlay.querySelector("#manageCatsBtn").addEventListener("click", () => {
    openCategoryManager(() => {
      if (!categories.find(c => c.id === chosenCat)) chosenCat = categories[0].id;
      const catsContainer = overlay.querySelector("#f-cats");
      catsContainer.innerHTML = categories.map(c=>`<div class="chip ${c.id===chosenCat?"selected":""}" data-cat="${c.id}"><span class="swatch" style="background:${c.color}"></span>${c.name}</div>`).join("");
      attachCatChipHandlers();
    });
  });

  overlay.querySelector("#f-cancel").addEventListener("click", ()=> overlay.remove());
  overlay.addEventListener("click", e=>{ if (e.target===overlay) overlay.remove(); });

  if (isEdit) {
    overlay.querySelector("#f-delete").addEventListener("click", ()=>{
      if (getRecurrenceDays(draft) > 0) {
        openDeleteChoice(draft, overlay, occurrenceDateISO || draft.dateISO);
      } else {
        const deletedEvent = draft;
        events = events.filter(e=>e.id!==draft.id);
        save(); overlay.remove(); render();
        showUndoSnackbar(`Deleted "${deletedEvent.title}"`, () => { events.push(deletedEvent); save(); render(); });
      }
    });
  }

  overlay.querySelector("#f-save").addEventListener("click", ()=>{
    const isAllDay = overlay.querySelector("#f-allday").checked;
    let startMin = 0, duration = 0, bufferBefore = 0, bufferAfter = 0;
    let dateISO = overlay.querySelector("#f-date").value;
    let endDateISO = null;

    if (!isAllDay) {
      const [hh,mm] = overlay.querySelector("#f-time").value.split(":").map(Number);
      const [ehh,emm] = overlay.querySelector("#f-endtime").value.split(":").map(Number);
      startMin = hh*60+mm;
      let endMin = ehh*60+emm;
      if (endMin <= startMin) endMin += 24*60; // crosses midnight
      duration = Math.max(5, endMin - startMin);
      bufferBefore = parseInt(overlay.querySelector("#f-bufbefore").value,10) || 0;
      bufferAfter = parseInt(overlay.querySelector("#f-bufafter").value,10) || 0;
    } else {
      dateISO = overlay.querySelector("#f-alldaystart").value;
      endDateISO = overlay.querySelector("#f-alldayend").value;
      if (endDateISO < dateISO) endDateISO = dateISO; // guard against end before start
    }

    const updated = {
      ...draft,
      title: overlay.querySelector("#f-title").value.trim() || "Untitled",
      dateISO: dateISO,
      endDateISO: isAllDay ? endDateISO : null,
      allDay: isAllDay,
      start: startMin,
      duration: duration,
      categoryId: chosenCat,
      bufferBefore: bufferBefore,
      bufferAfter: bufferAfter,
      recurrence: overlay.querySelector("#f-recur").value,
      reminder: overlay.querySelector("#f-reminder").value,
      mandatory: overlay.querySelector("#f-mandatory").checked,
      earnsMoney: overlay.querySelector("#f-money").checked,
      notes: overlay.querySelector("#f-notes") ? overlay.querySelector("#f-notes").value.trim() : (draft.notes || "")
    };

    if (isEdit && getRecurrenceDays(draft) > 0) {
      openEditChoice(draft, updated, overlay, occurrenceDateISO || draft.dateISO);
      return;
    }

    if (isEdit) {
      events = events.map(e=> e.id===updated.id ? updated : e);
    } else {
      events.push(updated);
    }
    save(); overlay.remove();
    selectedDate = startOfDay(new Date(updated.dateISO));
    weekStart = startOfWeek(selectedDate);
    view = "day";
    render();
    // const qi = document.getElementById("quickinput"); if (qi) qi.value = "";
  });
}

/* ---------- Boot ---------- */

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return null;

  try {
    const registration = await navigator.serviceWorker.register("./sw.js", {
      updateViaCache: "none"
    });

    try {
      await registration.update();
    } catch (error) {
      console.warn("Service worker update check failed:", error);
    }

    return registration;
  } catch (error) {
    console.error("Service worker registration failed:", error);
    return null;
  }
}

window.addEventListener("load", registerServiceWorker);

async function checkAiStatus() {
  try {
    const res = await fetch("/api/ai-status");
    const data = await res.json();
    setAiStatus(data.status === "good" ? "good" : "busy");
  } catch (e) {
    setAiStatus("busy");
  }
}

checkAiStatus();
setInterval(checkAiStatus, 60 * 1000); // recheck every 1 minutes while the app stays open

async function signInCloud() {
  const existing = document.getElementById("authOverlay");
  if (existing) existing.remove();

  const overlay = document.createElement("div");
  overlay.id = "authOverlay";
  overlay.className = "overlay";

  overlay.innerHTML = `
    <div class="sheet">
      <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:12px;">
        <h2 style="margin:0;">Cloud account</h2>
        <button id="authClose" style="border:none; background:none; font-size:1.3rem; line-height:1; color:var(--ink-soft); padding:4px;">×</button>
      </div>

      <div class="field">
        <label>Email</label>
        <input id="authEmail" type="email" autocomplete="email" placeholder="you@example.com" />
      </div>

      <div class="field">
        <label>Password</label>
        <input id="authPassword" type="password" autocomplete="current-password" placeholder="Password" />
      </div>

      <div id="authMessage" style="display:none; margin:10px 0; padding:10px; border-radius:8px; font-size:13px;"></div>

      <button class="btn primary" id="authLogin" style="width:100%;">Sign in</button>

      <div style="display:flex; justify-content:space-between; margin-top:14px; font-size:13px;">
        <button id="authCreate" style="border:none; background:none; text-decoration:underline; cursor:pointer; padding:0; color:var(--ink);">Create an account</button>
        <button id="authForgot" style="border:none; background:none; text-decoration:underline; cursor:pointer; padding:0; color:var(--ink);">Forgot password?</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const emailInput = overlay.querySelector("#authEmail");
  const passwordInput = overlay.querySelector("#authPassword");
  const messageBox = overlay.querySelector("#authMessage");

  const showMessage = (text, isError = true) => {
    messageBox.textContent = text;
    messageBox.style.background = isError ? "#fff0ef" : "#eefaf0";
    messageBox.style.color = isError ? "#b42318" : "#1a7f3c";
    messageBox.style.display = "block";
  };
  const hideMessage = () => { messageBox.style.display = "none"; };

  overlay.querySelector("#authClose").addEventListener("click", () => overlay.remove());
  overlay.addEventListener("click", e => { if (e.target === overlay) overlay.remove(); });

  overlay.querySelector("#authLogin").addEventListener("click", async () => {
    hideMessage();
    const email = emailInput.value.trim().toLowerCase();
    const password = passwordInput.value;

    if (!email) return showMessage("Enter your email address.");
    if (!password) return showMessage("Enter your password.");

    try {
      await signInWithEmailAndPassword(auth, email, password);
      overlay.remove();
    } catch (error) {
      console.error("Email sign-in failed:", error);
      const messages = {
        "auth/invalid-credential": "The email or password is incorrect.",
        "auth/user-not-found": "No account exists with this email — try Create an account instead.",
        "auth/wrong-password": "The password is incorrect.",
        "auth/invalid-email": "Enter a valid email address.",
        "auth/too-many-requests": "Too many attempts. Try again later."
      };
      showMessage(messages[error.code] || error.message || "Sign-in failed.");
    }
  });

  overlay.querySelector("#authCreate").addEventListener("click", async () => {
    hideMessage();
    const email = emailInput.value.trim().toLowerCase();
    const password = passwordInput.value;

    if (!email) return showMessage("Enter your email address.");
    if (password.length < 6) return showMessage("Password must contain at least 6 characters.");

    try {
      await createUserWithEmailAndPassword(auth, email, password);
      overlay.remove();
    } catch (error) {
      console.error("Account creation failed:", error);
      const messages = {
        "auth/email-already-in-use": "An account already exists with this email — try Sign in, or use Forgot password.",
        "auth/invalid-email": "Enter a valid email address.",
        "auth/weak-password": "Password must contain at least 6 characters."
      };
      showMessage(messages[error.code] || error.message || "Could not create account.");
    }
  });

  overlay.querySelector("#authForgot").addEventListener("click", async () => {
    hideMessage();
    const email = emailInput.value.trim().toLowerCase();
    if (!email) return showMessage("Enter your email address first, then tap Forgot password.");

    try {
      await sendPasswordResetEmail(auth, email);
      showMessage("Password reset email sent — check your inbox, then come back and sign in.", false);
    } catch (error) {
      console.error("Password reset failed:", error);
      const messages = {
        "auth/user-not-found": "No account exists with this email — try Create an account instead.",
        "auth/invalid-email": "Enter a valid email address."
      };
      showMessage(messages[error.code] || error.message || "Couldn't send reset email.");
    }
  });
}

function signOutCloud() {
  signOut(auth).catch(error => {
    console.error("Sign out failed:", error);
  });
}

async function toggleNotifications() {
  if (!currentUser) {
    alert("Please sign in first to manage notifications.");
    return;
  }

  if (pushEnabled) {
    try {
      const messaging = getMessaging(fbApp);
      await deleteToken(messaging).catch(error => {
        console.warn("FCM token deletion failed:", error);
      });

      await setDoc(doc(db, "users", currentUser.uid), {
        pushToken: null,
        pushEnabled: false,
        updatedAt: Date.now()
      }, { merge: true });

      pushEnabled = false;
      render();
      refreshSettingsPanel();
    } catch (error) {
      console.error("Failed to disable notifications:", error);
      alert("Couldn't disable notifications: " + error.message);
    }
    return;
  }

  await enableNotifications();
}

async function enableNotifications() {
  try {
    if (!("Notification" in window)) {
      alert("This browser does not support web notifications.");
      return;
    }

    if (!("serviceWorker" in navigator)) {
      alert("This browser does not support service workers.");
      return;
    }

    const supported = await messagingSupported();
    if (!supported) {
      alert("Push notifications are not supported in this browser or app mode.");
      return;
    }

    let permission = Notification.permission;

    if (permission === "denied") {
      alert("Notifications are blocked for this website. Enable notifications for Actually Free in Safari settings, then try again.");
      return;
    }

    if (permission !== "granted") {
      permission = await Notification.requestPermission();
    }

    if (permission !== "granted") {
      pushEnabled = false;
      render();
      refreshSettingsPanel();
      return;
    }

    const registration = await registerServiceWorker();
    if (!registration) {
      alert("The notification service could not start. Please reload the app and try again.");
      return;
    }

    const messaging = getMessaging(fbApp);
    const token = await getToken(messaging, {
      vapidKey: VAPID_PUBLIC_KEY,
      serviceWorkerRegistration: registration
    });

    if (!token) {
      throw new Error("Firebase did not return a notification token.");
    }

    await setDoc(doc(db, "users", currentUser.uid), {
      pushToken: token,
      pushEnabled: true,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      updatedAt: Date.now()
    }, { merge: true });

    pushEnabled = true;
    render();
    refreshSettingsPanel();
  } catch (error) {
    console.error("Push setup failed:", error);
    alert("Push setup failed: " + error.message);
  }
}

async function handleEmailLinkSignIn() {
  if (!isSignInWithEmailLink(auth, window.location.href)) return;

  let email = localStorage.getItem("af_email_for_signin");

  if (!email) {
    email = prompt("Confirm your email address to finish signing in:", "");
  }

  if (!email) return;

  try {
    await signInWithEmailLink(auth, email.trim().toLowerCase(), window.location.href);
    localStorage.setItem("af_email_for_signin", email.trim().toLowerCase());
    window.history.replaceState({}, document.title, window.location.pathname);
  } catch (error) {
    console.error("Email-link sign-in failed:", error);
    alert("Sign-in failed: " + error.message);
  }
}

async function syncCloudData(user) {
  const dataRef = doc(db, "users", user.uid, "data", "events");
  const row = document.getElementById("cloudstatus");

  try {
    if (row) row.textContent = "Checking cloud calendar...";

    if (unsubscribeCloudData) unsubscribeCloudData();

    unsubscribeCloudData = onSnapshot(dataRef, async snap => {
      // Our own writes echo back here optimistically before the server even
      // confirms them — that's not new information, so ignore it entirely
      // rather than treating it like a genuine remote change.
      if (snap.metadata.hasPendingWrites) return;

      try {
        // Always back up whatever's currently in memory before touching it,
        // so a bad or delayed remote read can never destroy real data.
        if (Array.isArray(events) && events.length > 0) {
          localStorage.setItem(`af_local_backup_${user.uid}`, JSON.stringify({
            list: events,
            categories,
            savedAt: Date.now()
          }));
        }

        if (!snap.exists()) {
          await setDoc(dataRef, {
            list: Array.isArray(events) ? events : [],
            categories: Array.isArray(categories) ? categories : DEFAULT_CATEGORIES,
            updatedAt: Date.now()
          });
          if (row) row.textContent = `Calendar backed up as ${user.email || "your account"}`;
          return;
        }

        const remote = snap.data() || {};
        const remoteEvents = Array.isArray(remote.list) ? remote.list : [];
        const remoteCategories = Array.isArray(remote.categories) ? remote.categories : null;
        const remoteUpdatedAt = remote.updatedAt || 0;
        const lastLocalSaveAt = parseInt(localStorage.getItem("af_last_local_save") || "0", 10);

        // If the cloud looks empty but we currently have real local data,
        // treat the cloud as behind — push our data up instead of accepting
        // the empty result as truth.
        //
        // Also guard against the cloud reporting a version OLDER than a local
        // change we already know we made — this can happen if a previous save
        // never actually reached the server before the app closed. In that
        // case, don't accept the stale data; re-push what we have instead.
        const remoteLooksBehind = (remoteEvents.length === 0 && Array.isArray(events) && events.length > 0)
          || (lastLocalSaveAt > 0 && remoteUpdatedAt < lastLocalSaveAt);

        if (remoteLooksBehind) {
          suppressNextCloudPush = true;
          await setDoc(dataRef, { list: events, categories, updatedAt: Date.now() }, { merge: true });
          lastSyncedAt = Date.now();
          syncFailed = false;
          if (row) row.textContent = `Synced as ${user.email || "your account"} · last saved ${formatSyncTime(lastSyncedAt)}`;
          refreshSyncTag();
          return;
        }

        suppressNextCloudPush = true;
        events = remoteEvents;
        if (remoteCategories) categories = ensureLoveCategory(remoteCategories);

        localStorage.setItem("af_events", JSON.stringify(events));
        localStorage.setItem("af_categories", JSON.stringify(categories));
        lastSyncedAt = Date.now();
        syncFailed = false;
        if (row) row.textContent = `Synced as ${user.email || "your account"} · last saved ${formatSyncTime(lastSyncedAt)}`;
        refreshSyncTag();
        render();
      } catch (error) {
        console.error("Cloud calendar sync failed:", error);
        syncFailed = true;
        if (row) row.textContent = "Cloud calendar sync failed";
        refreshSyncTag();
      }
    }, error => {
      console.error("Cloud calendar listener failed:", error);
      syncFailed = true;
      if (row) row.textContent = "Cloud calendar unavailable";
      refreshSyncTag();
    });
  } catch (error) {
    console.error("Cloud sync setup failed:", error);
    if (row) row.textContent = "Cloud sync failed";
  }
}

async function loadPushState(user) {
  try {
    const supported = "Notification" in window && await messagingSupported();
    if (!supported) {
      pushEnabled = false;
      return;
    }

    const userRef = doc(db, "users", user.uid);

    if (unsubscribeUserDoc) unsubscribeUserDoc();

    unsubscribeUserDoc = onSnapshot(userRef, snap => {
      pushEnabled = !!(snap.exists() && snap.data().pushToken);
      render();
      refreshSettingsPanel();
    }, error => {
      console.error("Push state listener failed:", error);
      pushEnabled = Notification.permission === "granted";
      render();
      refreshSettingsPanel();
    });
  } catch (error) {
    console.error("Push state check failed:", error);
    pushEnabled = false;
  }
}

async function handleAuthChange(user) {
  currentUser = user;
  settingsAuthView = "main";
  if (unsubscribeCloudData) {
    unsubscribeCloudData();
    unsubscribeCloudData = null;
  }

  if (unsubscribeUserDoc) {
    unsubscribeUserDoc();
    unsubscribeUserDoc = null;
  }

  if (!user) {
    pushEnabled = false;
    render();
    return;
  }

  try {
    await setDoc(doc(db, "users", user.uid), {
      email: user.email || null,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      updatedAt: Date.now()
    }, { merge: true });

    await syncCloudData(user);
    await loadPushState(user);
  } catch (error) {
    console.error("Account setup failed:", error);
  }

  render();
  refreshSettingsPanel();
}

onAuthStateChanged(auth, handleAuthChange);
setupDelegatedHandlers();
render();