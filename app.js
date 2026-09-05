[source: 1]import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";

import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  onAuthStateChanged,
  signOut,
  setPersistence,
  browserLocalPersistence,
  isSignInWithEmailLink,
  signInWithEmailLink
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";

import {
  getFirestore,
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
const db = getFirestore(fbApp);

let currentUser = null;
let suppressNextCloudPush = false;
let pushEnabled = false;
let unsubscribeCloudData = null;
let unsubscribeUserDoc = null;

setPersistence(auth, browserLocalPersistence).catch(error => {
  console.error("Firebase persistence failed:", error);
});

/* ---------- Config ---------- */
const DAY_START_MIN = 6 * 60;   // 6:00am
const DAY_END_MIN = 23 * 60;    // 11:00pm
const HOUR_PX = 56;
const DEFAULT_CATEGORIES = [
  { id: "work",     name: "Work",     color: "#3F7D58", earnsDefault: true  },
  { id: "tutoring", name: "Tutoring", color: "#2C6E7F", earnsDefault: true  },
  { id: "friends",  name: "Friends",  color: "#3B5BA5", earnsDefault: false },
  { id: "family",   name: "Family",   color: "#8B5E3C", earnsDefault: false },
  { id: "personal", name: "Personal", color: "#7C5CBF", earnsDefault: false }
];
const DAY_NAMES = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
const DAY_ALIASES = { sun:0, mon:1, tue:2, tues:2, wed:3, weds:3, thu:4, thur:4, thurs:4, fri:5, sat:6 };

/* ---------- State ---------- */
let categories = load("af_categories", DEFAULT_CATEGORIES);
let events = load("af_events", []);
let selectedDate = startOfDay(new Date());
let weekStart = startOfWeek(selectedDate);
let view = "day"; // "day" | "month"
let monthCursor = startOfMonth(selectedDate);

/* ---------- Storage / util ---------- */
function load(key, fallback) {
  try { const v = JSON.parse(localStorage.getItem(key)); return v || fallback; }
  catch { return fallback; }
}
async function save() {
  localStorage.setItem("af_events", JSON.stringify(events));
  localStorage.setItem("af_categories", JSON.stringify(categories));

  if (currentUser && !suppressNextCloudPush) {
    try {
      await setDoc(
        doc(db, "users", currentUser.uid, "data", "events"),
        { list: events, categories, updatedAt: Date.now() },
        { merge: true }
      );
    } catch (error) {
      console.error("Cloud save failed:", error);
      const row = document.getElementById("cloudstatus");
      if (row) row.textContent = "Cloud save failed. Check your connection.";
    }
  }

  suppressNextCloudPush = false;
}
function startOfDay(d) { const x = new Date(d); x.setHours(0,0,0,0); return x; }
function startOfWeek(d) { const x = startOfDay(d); const dow = (x.getDay()+6)%7; x.setDate(x.getDate()-dow); return x; } // Monday start
function startOfMonth(d) { const x = new Date(d); x.setDate(1); x.setHours(0,0,0,0); return x; }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate()+n); return x; }
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
function categoryOf(id) { return categories.find(c=>c.id===id) || categories[0]; }
function uid() { return Date.now().toString(36)+Math.random().toString(36).slice(2,7); }

/* ---------- Recurrence ---------- */
function dateFromISO(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function occursOn(ev, date) {
  const anchor = dateFromISO(ev.dateISO);
  const diff = dayDiff(date, anchor);

  if (diff < 0) return false;
  if (ev.recurrence === "weekly") return diff % 7 === 0;
  if (ev.recurrence === "fortnightly") return diff % 14 === 0;
  return diff === 0;
}
function eventsOnDate(date) { return events.filter(ev => occursOn(ev, date)); }

/* ---------- Free-time calc ---------- */
function busyIntervals(date) {
  return eventsOnDate(date).map(ev => ({
    start: ev.start - ev.bufferBefore,
    end: ev.start + ev.duration + ev.bufferAfter,
    ev
  })).sort((a,b)=>a.start-b.start);
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
  const now = new Date();
  if (!sameDay(now, selectedDate) && !sameDay(now, new Date())) { /* n/a */ }
  const today = new Date();
  const nowMin = today.getHours()*60 + today.getMinutes();
  const merged = mergedIntervals(today);
  const cur = merged.find(iv => nowMin >= iv.start && nowMin < iv.end);
  if (cur) return { busy:true, text:`Busy until <b>${minToLabel(cur.end)}</b>` };
  const next = merged.find(iv => iv.start > nowMin);
  if (!next) return { busy:false, text:`Free for the rest of the day` };
  const mins = next.start - nowMin;
  const hrs = Math.floor(mins/60), rem = mins%60;
  const dur = hrs>0 ? `${hrs}h ${rem}m` : `${rem}m`;
  return { busy:false, text:`Free for <b>${dur}</b> - next at ${minToLabel(next.start)}` };
}

/* ---------- Quick add parsing (local fallback) ---------- */
function parseQuickAdd(text) {
  let s = text.trim();
  let dayOffset = null;
  let time = null;

  const lower = s.toLowerCase();
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
  const date = addDays(startOfDay(new Date()), dayOffset===null?0:dayOffset);

  let categoryId = categories[categories.length-1].id;
  for (const c of categories) {
    if (title.toLowerCase().includes(c.name.toLowerCase())) { categoryId = c.id; break; }
  }
  const cat = categoryOf(categoryId);

  return {
    id: uid(), seriesId: uid(),
    title, categoryId,
    dateISO: iso(date),
    start: time===null ? roundToNext30() : time,
    duration: 60,
    bufferBefore: 0,
    bufferAfter: 0,
    reminder: "30m",
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
      categories: categories.map(c => ({ name: c.name, earnsDefault: !!c.earnsDefault }))
    })
  });
  const data = await res.json().catch(()=>null);
  if (!res.ok || !data || data.error) throw new Error((data && data.error) || "AI parse failed");

  const cat = categories.find(c => c.name.toLowerCase() === (data.category || "").toLowerCase())
    || categories[categories.length - 1];
  const [hh, mm] = (data.time || "12:00").split(":").map(Number);

  return {
    id: uid(), seriesId: uid(),
    title: cleanAITitle(data.title, text),
    categoryId: cat.id,
    dateISO: data.date || iso(new Date()),
    start: (isNaN(hh) ? 12 : hh) * 60 + (isNaN(mm) ? 0 : mm),
    duration: Number.isFinite(data.duration) ? data.duration : 60,
    bufferBefore: Number.isFinite(data.bufferBefore) ? data.bufferBefore : 30,
    bufferAfter: Number.isFinite(data.bufferAfter) ? data.bufferAfter : 30,
    reminder: data.reminder || "30m",
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
    ${renderQuickBar()}
  `;
  attachHandlers();
  if (view==="day") {
    scrollToDay(selectedDate, false);
    tickNowLine();
  }
}

function renderTopbar() {
  const label = view === "month" 
    ? monthCursor.toLocaleDateString(undefined, { month: "long", year: "numeric" }) 
    : `${weekStart.toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${addDays(weekStart, 6).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;

  return `
    <div class="topbar">
      <button class="iconbtn" data-act="prev">‹</button>
      <div style="text-align:center">
        <div class="weeklabel">${label}</div>
      </div>
      <button class="iconbtn" data-act="next">›</button>
    </div>

    <div class="topbar-actions">
      <button class="todaybtn" data-act="today" title="Back to today">Today</button>
      
      <button class="pushbtn-slim ${pushEnabled ? "active" : ""}" data-act="toggle-push" title="Toggle push notifications">
        <span class="dot"></span>
        <span>${pushEnabled ? "Push On" : "Push Off"}</span>
      </button>

      <button class="signinbtn" data-act="cloud" title="Cloud sync">
        ${currentUser ? "Signed in" : "Sign in"}
      </button>
    </div>

    <div class="topbar-view">
      <div class="viewtoggle">
        <button data-view="day" class="${view === "day" ? "active" : ""}">Week</button>
        <button data-view="month" class="${view === "month" ? "active" : ""}">Month</button>
      </div>
    </div>

    <div id="cloudstatus" class="cloudstatus">
      ${currentUser ? `Synced as ${currentUser.displayName || currentUser.email}` : "Sign in to back up your calendar + enable notifications"}
    </div>
  `;
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
  let html = `<div class="dayscroller" id="scroller">`;
  for (let i=0;i<7;i++) html += renderDayCol(addDays(weekStart,i));
  return html + `</div>`;
}

function renderDayCol(date) {
  const evs = eventsOnDate(date);
  let hours = "";
  for (let m=DAY_START_MIN; m<=DAY_END_MIN; m+=60) {
    hours += `<div class="hourrow"><span class="label">${minToLabel(m)}</span></div>`;
  }
  let blocks = "";
  for (const ev of evs) {
    const cat = categoryOf(ev.categoryId);
    const top = (ev.start - DAY_START_MIN)/60*HOUR_PX;
    const height = Math.max(ev.duration/60*HOUR_PX, 24);
    const bTop = (ev.start - ev.bufferBefore - DAY_START_MIN)/60*HOUR_PX;
    const bHeightBefore = ev.bufferBefore/60*HOUR_PX;
    const bTopAfter = (ev.start + ev.duration - DAY_START_MIN)/60*HOUR_PX;
    const bHeightAfter = ev.bufferAfter/60*HOUR_PX;
    if (ev.bufferBefore>0) blocks += `<div class="buffer" style="top:${bTop}px;height:${bHeightBefore}px;color:${cat.color}"></div>`;
    if (ev.bufferAfter>0) blocks += `<div class="buffer" style="top:${bTopAfter}px;height:${bHeightAfter}px;color:${cat.color}"></div>`;
    blocks += `<div class="event ${ev.mandatory?"":"optional"}" style="top:${top}px;height:${height}px;background:${cat.color};border-color:${cat.color}" data-edit="${ev.id}">
      <div class="title">${escapeHtml(ev.title)}${ev.earnsMoney?`<span class="dollar">$</span>`:""}</div>
      <div class="meta">${minToLabel(ev.start)} · ${cat.name}</div>
    </div>`;
  }
  const nowMin = new Date().getHours()*60+new Date().getMinutes();
  const showNow = sameDay(date,new Date()) && nowMin>=DAY_START_MIN && nowMin<=DAY_END_MIN;
  const nowLine = showNow ? `<div class="nowline" id="nowline" style="top:${(nowMin-DAY_START_MIN)/60*HOUR_PX}px"></div>` : "";
  return `<div class="daycol">
    <div class="timeline" style="height:${(DAY_END_MIN-DAY_START_MIN)/60*HOUR_PX}px">
      ${hours}
      <div class="eventlayer">${blocks}${nowLine}</div>
    </div>
  </div>`;
}

function renderMonth() {
  const first = monthCursor;
  const gridStart = startOfWeek(first);
  const today = startOfDay(new Date());
  let head = `<div class="monthhead">${DAY_NAMES.slice(1).concat(DAY_NAMES[0]).map(d=>`<span>${d}</span>`).join("")}</div>`;
  let body = `<div class="monthbody">`;
  for (let i=0;i<42;i++) {
    const d = addDays(gridStart,i);
    const inMonth = d.getMonth()===first.getMonth();
    const evs = eventsOnDate(d);
    const cats = [...new Set(evs.map(e=>e.categoryId))].slice(0,4);
    body += `<button class="monthday ${sameDay(d,today)?"today":""} ${inMonth?"":"other"}" data-goto="${iso(d)}">
      <span>${d.getDate()}</span>
      <span class="dots">${cats.map(c=>`<span style="background:${categoryOf(c).color}"></span>`).join("")}</span>
    </button>`;
  }
  return `<div class="monthgrid">${head}${body}</div>`;
}

function renderQuickBar() {
  return `<div class="quickbar">
    <button
      id="voicebtn"
      type="button"
      title="Add event by voice"
      aria-label="Add event by voice"
    >
      Voice
    </button>

    <input
      id="quickinput"
      type="text"
      placeholder="Quick add"
      autocomplete="off"
    />

    <button
      id="quickadd"
      type="button"
      title="Add"
      aria-label="Add event"
    >
      +
    </button>
  </div>`;
}

function escapeHtml(s) { return s.replace(/[&<>"]/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])); }

/* ---------- Scroll / nav handlers ---------- */
function scrollToDay(date, smooth=true) {
  const scroller = document.getElementById("scroller");
  if (!scroller) return;
  const idx = dayDiff(date, weekStart);
  scroller.scrollTo({ left: idx*scroller.clientWidth, behavior: smooth?"smooth":"auto" });
}

let scrollTimer;
function onScrollerScroll(e) {
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(()=>{
    const idx = Math.round(e.target.scrollLeft / e.target.clientWidth);
    const d = addDays(weekStart, idx);
    if (!sameDay(d, selectedDate)) {
      selectedDate = d;
      document.querySelectorAll(".pip").forEach((p,i)=> p.classList.toggle("selected", i===idx));
      const banner = document.querySelector(".freebanner");
      if (banner) banner.outerHTML = renderFreeBanner();
    }
  }, 80);
}

function tickNowLine() {
  clearInterval(window._nowTick);
  window._nowTick = setInterval(()=>{
    const line = document.getElementById("nowline");
    if (line) {
      const nowMin = new Date().getHours()*60+new Date().getMinutes();
      line.style.top = `${(nowMin-DAY_START_MIN)/60*HOUR_PX}px`;
    }
    const banner = document.querySelector(".freebanner");
    if (banner) banner.outerHTML = renderFreeBanner();
  }, 60000);
}

let voiceRecognition = null;
let isRecording = false;

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

  voiceRecognition.lang = "en-AU";
  voiceRecognition.continuous = false;
  voiceRecognition.interimResults = false;
  voiceRecognition.maxAlternatives = 1;

  isRecording = true;

  const button = document.getElementById("voicebtn");

  if (button) {
    button.classList.add("recording");
    button.textContent = "Voice";
  }

  voiceRecognition.onresult = (event) => {
    const transcript =
      event.results[0][0].transcript.trim();

    const input = document.getElementById("quickinput");

    if (input) {
      input.value = transcript;
    }

    submitQuickAdd();
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
      button.textContent = "Voice";
    }

    voiceRecognition = null;
  };

  voiceRecognition.start();
}

/* ---------- Event handlers ---------- */
function attachHandlers() {
  app.querySelectorAll("[data-act]").forEach(btn => {
    btn.addEventListener("click", () => {
      const act = btn.dataset.act;
      if (act === "today") { weekStart = startOfWeek(new Date()); selectedDate = startOfDay(new Date()); monthCursor = startOfMonth(new Date()); render(); }
      if (act === "prev") { view === "month" ? shiftMonth(-1) : shiftWeek(-1); }
      if (act === "next") { view === "month" ? shiftMonth(1) : shiftWeek(1); }
      if (act === "toggle-push") { toggleNotifications(); }
      if (act === "cloud") {
        if (!currentUser) signInCloud();
        else if (confirm(`Synced as ${currentUser.displayName||currentUser.email}. Sign out of cloud backup?`)) signOutCloud();
      }
    });
  });
  app.querySelectorAll("[data-view]").forEach(btn=>{
    btn.addEventListener("click", ()=>{ view = btn.dataset.view; render(); });
  });
  app.querySelectorAll("[data-jump]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const idx = parseInt(btn.dataset.jump,10);
      selectedDate = addDays(weekStart, idx);
      scrollToDay(selectedDate, true);
      render();
    });
  });
  app.querySelectorAll("[data-goto]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const d = dateFromISO(btn.dataset.goto);
      selectedDate = startOfDay(d); weekStart = startOfWeek(selectedDate); view="day"; render();
    });
  });
  app.querySelectorAll("[data-edit]").forEach(el=>{
    el.addEventListener("click", ()=> openSheet(events.find(e=>e.id===el.dataset.edit)));
  });
  const scroller = document.getElementById("scroller");
  if (scroller) scroller.addEventListener("scroll", onScrollerScroll);

  const qa = document.getElementById("quickadd");
  const qi = document.getElementById("quickinput");
  const voice = document.getElementById("voicebtn");

  if (qa) {
    qa.addEventListener("click", () => submitQuickAdd());
  }

  if (voice) {
    voice.addEventListener("click", startVoiceInput);
  }
  if (qi) qi.addEventListener("keydown", e=>{ if (e.key==="Enter") submitQuickAdd(); });
}

async function submitQuickAdd() {
  const qi = document.getElementById("quickinput");
  if (!qi || !qi.value.trim()) return;
  const text = qi.value.trim();

  const qa = document.getElementById("quickadd");
  const originalLabel = qa ? qa.textContent : null;
  if (qa) { qa.disabled = true; qa.textContent = "…"; }

  let draft;
  try {
    draft = await parseQuickAddAI(text);
  } catch (e) {
    console.warn("AI parse unavailable, falling back to local parsing:", e.message);
    draft = parseQuickAdd(text);
  }

  if (qa) { qa.disabled = false; qa.textContent = originalLabel; }
  openSheet(draft, true);
}

function shiftWeek(n) { weekStart = addDays(weekStart, 7*n); selectedDate = addDays(selectedDate,7*n); render(); }
function shiftMonth(n) { monthCursor = new Date(monthCursor.getFullYear(), monthCursor.getMonth()+n, 1); render(); }

/* ---------- Add/edit sheet ---------- */
function openSheet(ev, isNew=false) {
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
      <h2>${isEdit ? "Edit event" : "New event"}</h2>
      <div class="field"><label>Title</label><input type="text" id="f-title" value="${escapeHtml(draft.title)}" /></div>
      <div class="row2">
        <div class="field"><label>Date</label><input type="date" id="f-date" value="${draft.dateISO}" /></div>
        <div class="field"><label>Start time</label><input type="time" id="f-time" value="${pad2(Math.floor(draft.start/60))}:${pad2(draft.start%60)}" /></div>
      </div>
      <div class="field"><label>Duration (minutes)</label><input type="number" id="f-duration" value="${draft.duration}" min="5" step="5" /></div>
      <div class="field"><label>Category</label>
        <div class="chiprow" id="f-cats">
          ${categories.map(c=>`<div class="chip ${c.id===draft.categoryId?"selected":""}" data-cat="${c.id}"><span class="swatch" style="background:${c.color}"></span>${c.name}</div>`).join("")}
        </div>
      </div>
      <div class="row2">
        <div class="field">
          <label>Buffer before</label>
          <select id="f-bufbefore">
            ${[0,10,20,30].map(m => `
              <option value="${m}" ${Number(draft.bufferBefore) === m ? "selected" : ""}>
                ${m < 60 ? `${m} minutes` : `${Math.floor(m/60)} hour${m >= 120 ? "s" : ""}${m % 60 ? ` ${m % 60} minutes` : ""}`}
              </option>
            `).join("")}
          </select>
        </div>

        <div class="field">
          <label>Buffer after</label>
          <select id="f-bufafter">
            ${[0,10,20,30].map(m => `
              <option value="${m}" ${Number(draft.bufferAfter) === m ? "selected" : ""}>
                ${m < 60 ? `${m} minutes` : `${Math.floor(m/60)} hour${m >= 120 ? "s" : ""}${m % 60 ? ` ${m % 60} minutes` : ""}`}
              </option>
            `).join("")}
          </select>
        </div>
      </div>
      <div class="field">
        <label>Remind me (before leaving)</label>
        <select id="f-reminder">
          <option value="none" ${draft.reminder === "none" ? "selected" : ""}>No reminder</option>
          <option value="30m" ${(!draft.reminder || draft.reminder === "30m") ? "selected" : ""}>30 minutes</option>
          <option value="1h" ${draft.reminder === "1h" ? "selected" : ""}>1 hour</option>
          <option value="6h" ${draft.reminder === "6h" ? "selected" : ""}>6 hours</option>
          <option value="12h" ${draft.reminder === "12h" ? "selected" : ""}>12 hours</option>
          <option value="1d" ${draft.reminder === "1d" ? "selected" : ""}>1 day</option>
          <option value="1w" ${draft.reminder === "1w" ? "selected" : ""}>1 week</option>
          <option value="1mo" ${draft.reminder === "1mo" ? "selected" : ""}>1 month</option>
        </select>
      </div>
      <div class="field"><label>Repeats</label>
        <select id="f-recur">
          <option value="none" ${draft.recurrence==="none"?"selected":""}>Doesn't repeat</option>
          <option value="weekly" ${draft.recurrence==="weekly"?"selected":""}>Weekly</option>
          <option value="fortnightly" ${draft.recurrence==="fortnightly"?"selected":""}>Fortnightly</option>
        </select>
      </div>
      <div class="togglerow"><span>Mandatory</span><input type="checkbox" id="f-mandatory" ${draft.mandatory?"checked":""} /></div>
      <div class="togglerow" style="border-bottom:none"><span>Earns money</span><input type="checkbox" id="f-money" ${draft.earnsMoney?"checked":""} /></div>
      <div class="sheetactions">
        ${isEdit ? `<button class="btn danger" id="f-delete">Delete</button>` : ""}
        <button class="btn ghost" id="f-cancel">Cancel</button>
        <button class="btn primary" id="f-save">${isEdit?"Save":"Add"}</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  let chosenCat = draft.categoryId;
  overlay.querySelectorAll("[data-cat]").forEach(chip=>{
    chip.addEventListener("click", ()=>{
      chosenCat = chip.dataset.cat;
      overlay.querySelectorAll("[data-cat]").forEach(c=>c.classList.remove("selected"));
      chip.classList.add("selected");
      const cat = categoryOf(chosenCat);
      overlay.querySelector("#f-money").checked = !!cat.earnsDefault;
    });
  });

  overlay.querySelector("#f-cancel").addEventListener("click", ()=> overlay.remove());
  overlay.addEventListener("click", e=>{ if (e.target===overlay) overlay.remove(); });

  if (isEdit) {
    overlay.querySelector("#f-delete").addEventListener("click", ()=>{
      if (draft.recurrence !== "none") {
        const seriesWide = confirm("Delete the whole repeating series? Cancel to delete just this date's instance.");
        if (seriesWide) {
          events = events.filter(e=>e.id!==draft.id);
        } else {
          draft.dateISO = iso(addDays(new Date(draft.dateISO), draft.recurrence==="weekly"?7:14));
        }
      } else {
        events = events.filter(e=>e.id!==draft.id);
      }
      save(); overlay.remove(); render();
    });
  }

  overlay.querySelector("#f-save").addEventListener("click", ()=>{
    const [hh,mm] = overlay.querySelector("#f-time").value.split(":").map(Number);
    const updated = {
      ...draft,
      title: overlay.querySelector("#f-title").value.trim() || "Untitled",
      dateISO: overlay.querySelector("#f-date").value,
      start: hh*60+mm,
      duration: parseInt(overlay.querySelector("#f-duration").value,10) || 30,
      categoryId: chosenCat,
      bufferBefore: parseInt(overlay.querySelector("#f-bufbefore").value,10) || 0,
      bufferAfter: parseInt(overlay.querySelector("#f-bufafter").value,10) || 0,
      recurrence: overlay.querySelector("#f-recur").value,
      reminder: overlay.querySelector("#f-reminder").value,
      mandatory: overlay.querySelector("#f-mandatory").checked,
      earnsMoney: overlay.querySelector("#f-money").checked
    };
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
    const qi = document.getElementById("quickinput"); if (qi) qi.value = "";
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

async function signInCloud() {
  const existing = document.getElementById("authOverlay");
  if (existing) existing.remove();

  const overlay = document.createElement("div");
  overlay.id = "authOverlay";
  overlay.className = "overlay";

  overlay.innerHTML = `
    <div class="sheet">
      <h2>Cloud account</h2>

      <div class="field">
        <label>Email</label>
        <input
          id="authEmail"
          type="email"
          autocomplete="email"
          placeholder="you@example.com"
        />
      </div>

      <div class="field">
        <label>Password</label>
        <input
          id="authPassword"
          type="password"
          autocomplete="current-password"
          placeholder="Password"
        />
      </div>

      <div
        id="authError"
        style="
          display:none;
          margin:10px 0;
          padding:10px;
          border-radius:8px;
          background:#fff0ef;
          color:#b42318;
          font-size:13px;
        "
      ></div>

      <div class="sheetactions">
        <button class="btn ghost" id="authCancel">
          Cancel
        </button>

        <button class="btn ghost" id="authGoogle">
          Google
        </button>

        <button class="btn primary" id="authLogin">
          Sign in
        </button>
      </div>

      <button
        id="authCreate"
        style="
          width:100%;
          margin-top:12px;
          border:0;
          background:none;
          font-size:13px;
          text-decoration:underline;
          cursor:pointer;
        "
      >
        Create an account
      </button>
    </div>
  `;

  document.body.appendChild(overlay);

  const emailInput = overlay.querySelector("#authEmail");
  const passwordInput = overlay.querySelector("#authPassword");
  const errorBox = overlay.querySelector("#authError");

  const showError = message => {
    errorBox.textContent = message;
    errorBox.style.display = "block";
  };

  const hideError = () => {
    errorBox.textContent = "";
    errorBox.style.display = "none";
  };

  overlay.querySelector("#authCancel").addEventListener("click", () => {
    overlay.remove();
  });

  overlay.addEventListener("click", event => {
    if (event.target === overlay) {
      overlay.remove();
    }
  });

  overlay.querySelector("#authLogin").addEventListener("click", async () => {
    hideError();

    const email = emailInput.value.trim().toLowerCase();
    const password = passwordInput.value;

    if (!email) {
      showError("Enter your email address.");
      return;
    }

    if (!password) {
      showError("Enter your password.");
      return;
    }

    try {
      await setPersistence(auth, browserLocalPersistence);

      await signInWithEmailAndPassword(
        auth,
        email,
        password
      );

      overlay.remove();
    } catch (error) {
      console.error("Email sign-in failed:", error);

      const messages = {
        "auth/invalid-credential":
          "The email or password is incorrect.",
        "auth/user-not-found":
          "No account exists with this email.",
        "auth/wrong-password":
          "The password is incorrect.",
        "auth/invalid-email":
          "Enter a valid email address.",
        "auth/too-many-requests":
          "Too many attempts. Try again later."
      };

      showError(
        messages[error.code] ||
        error.message ||
        "Sign-in failed."
      );
    }
  });

  overlay.querySelector("#authCreate").addEventListener("click", async () => {
    hideError();

    const email = emailInput.value.trim().toLowerCase();
    const password = passwordInput.value;

    if (!email) {
      showError("Enter your email address.");
      return;
    }

    if (password.length < 6) {
      showError("Password must contain at least 6 characters.");
      return;
    }

    try {
      await setPersistence(auth, browserLocalPersistence);

      await createUserWithEmailAndPassword(
        auth,
        email,
        password
      );

      overlay.remove();
    } catch (error) {
      console.error("Account creation failed:", error);

      const messages = {
        "auth/email-already-in-use":
          "An account already exists with this email. Try signing in instead.",
        "auth/invalid-email":
          "Enter a valid email address.",
        "auth/weak-password":
          "Password must contain at least 6 characters."
      };

      showError(
        messages[error.code] ||
        error.message ||
        "Could not create account."
      );
    }
  });

  overlay.querySelector("#authGoogle").addEventListener("click", async () => {
    hideError();

    try {
      await setPersistence(auth, browserLocalPersistence);

      const provider = new GoogleAuthProvider();

      await signInWithPopup(auth, provider);

      overlay.remove();
    } catch (error) {
      console.error("Google sign-in failed:", error);

      if (error.code === "auth/popup-blocked") {
        showError("The sign-in window was blocked. Try again.");
      } else if (error.code === "auth/popup-closed-by-user") {
        showError("Google sign-in was cancelled.");
      } else {
        showError(error.message || "Google sign-in failed.");
      }
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
    const localEvents = Array.isArray(events) ? events : [];
    const localCategories = Array.isArray(categories) ? categories : DEFAULT_CATEGORIES;

    if (row) row.textContent = "Checking cloud calendar...";

    const localBackupKey = `af_local_backup_${user.uid}`;
    if (localEvents.length > 0) {
      localStorage.setItem(localBackupKey, JSON.stringify({
        list: localEvents,
        categories: localCategories,
        savedAt: Date.now()
      }));
    }

    if (unsubscribeCloudData) unsubscribeCloudData();

    unsubscribeCloudData = onSnapshot(dataRef, async snap => {
      try {
        if (!snap.exists()) {
          await setDoc(dataRef, {
            list: localEvents,
            categories: localCategories,
            updatedAt: Date.now()
          });

          if (row) row.textContent = `Calendar backed up as ${user.email || "your account"}`;
          return;
        }

        const remote = snap.data() || {};
        const remoteEvents = Array.isArray(remote.list) ? remote.list : [];
        const remoteCategories = Array.isArray(remote.categories) ? remote.categories : null;

        if (remoteEvents.length === 0 && localEvents.length > 0) {
          suppressNextCloudPush = true;
          events = localEvents;
          categories = localCategories;

          await setDoc(dataRef, {
            list: events,
            categories,
            updatedAt: Date.now()
          }, { merge: true });
        } else {
          suppressNextCloudPush = true;
          events = remoteEvents;
          if (remoteCategories) categories = remoteCategories;

          localStorage.setItem("af_events", JSON.stringify(events));
          localStorage.setItem("af_categories", JSON.stringify(categories));
        }

        if (row) row.textContent = `Synced as ${user.email || "your account"}`;
        render();
      } catch (error) {
        console.error("Cloud calendar sync failed:", error);
        if (row) row.textContent = "Cloud calendar sync failed";
      }
    }, error => {
      console.error("Cloud calendar listener failed:", error);
      if (row) row.textContent = "Cloud calendar unavailable";
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
    }, error => {
      console.error("Push state listener failed:", error);
      pushEnabled = Notification.permission === "granted";
      render();
    });
  } catch (error) {
    console.error("Push state check failed:", error);
    pushEnabled = false;
  }
}

async function handleAuthChange(user) {
  currentUser = user;

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
}

onAuthStateChanged(auth, handleAuthChange);
render();