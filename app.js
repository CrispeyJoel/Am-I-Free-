/* ---------- Cloud sync + push (Firebase) ----------
   Fill these in from your Firebase project (see README "Cloud sync setup").
   This file must be loaded as a <script type="module"> for the imports below to work. */
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  getFirestore, doc, setDoc, onSnapshot
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import {
  getMessaging, getToken, isSupported as messagingSupported
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-messaging.js";

// ====== FILL THIS IN — Firebase console → Project settings → General → your web app config ======
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyD9GasWarxCefArgzbq2vPgSuYmlkTvPs0",
  authDomain: "amifree-6e5e1.firebaseapp.com",
  projectId: "amifree-6e5e1",
  storageBucket: "amifree-6e5e1.firebasestorage.app",
  messagingSenderId: "592230919079",
  appId: "1:592230919079:web:b01ed6ee1804bf59656482"
};
// Firebase console → Project settings → Cloud Messaging → Web Push certificates → generate, then paste the key pair's public key here
const VAPID_PUBLIC_KEY = "BFXiYQnuOx5YnxnSs_6hbwYScOzo0V8brVdsOAzGNOVBhWh_9XfPn62P5E2ga0RK7ANeeanCZoSZsuLq1ZQjuG8";
// ===================================================================================================

const fbApp = initializeApp(FIREBASE_CONFIG);
const auth = getAuth(fbApp);
const db = getFirestore(fbApp);
let currentUser = null;
let suppressNextCloudPush = false; // avoids re-saving the instant a remote update arrives

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
function save() {
  localStorage.setItem("af_events", JSON.stringify(events));
  localStorage.setItem("af_categories", JSON.stringify(categories));
  if (currentUser && !suppressNextCloudPush) {
    setDoc(doc(db, "users", currentUser.uid, "data", "events"), { list: events, categories }).catch(()=>{});
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
  return { busy:false, text:`Free for <b>${dur}</b> — next at ${minToLabel(next.start)}` };
}

/* ---------- Quick add parsing ---------- */
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
        if (diff === 0) diff = 7; // next occurrence, not today, when just a bare day name
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
    if (!ap && h <= 7) h += 12; // bare small numbers -> assume afternoon
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
    bufferBefore: 30,
    bufferAfter: 30,
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
  const label = view==="month"
    ? monthCursor.toLocaleDateString(undefined,{month:"long", year:"numeric"})
    : `${weekStart.toLocaleDateString(undefined,{month:"short",day:"numeric"})} – ${addDays(weekStart,6).toLocaleDateString(undefined,{month:"short",day:"numeric"})}`;
  return `
  <div class="topbar">
    <button class="iconbtn" data-act="prev">‹</button>
    <div style="text-align:center">
      <div class="weeklabel">${label}</div>
    </div>
    <button class="iconbtn" data-act="next">›</button>
  </div>
  <div class="topbar" style="padding-top:0">
    <button class="iconbtn" data-act="today" title="Back to today">•</button>
    <div class="viewtoggle">
      <button data-view="day" class="${view==="day"?"active":""}">Week</button>
      <button data-view="month" class="${view==="month"?"active":""}">Month</button>
    </div>
    <button class="iconbtn" data-act="cloud" title="Cloud sync">${currentUser ? "☁︎" : "☁"}</button>
  </div>
  <div id="cloudstatus" style="padding:0 16px 6px;font-size:0.7rem;color:var(--ink-soft)">${currentUser ? `Synced as ${currentUser.displayName||currentUser.email}` : "Tap the cloud icon to back up + enable notifications"}</div>`;
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
  const empty = evs.length===0 ? `<div class="emptyday">Nothing scheduled — tap + below to add something.</div>` : "";
  return `<div class="daycol">
    <div class="timeline" style="height:${(DAY_END_MIN-DAY_START_MIN)/60*HOUR_PX}px">
      ${hours}
      <div class="eventlayer">${blocks}${nowLine}</div>
    </div>
    ${empty}
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
    <input id="quickinput" type="text" placeholder="Quick add — e.g. Piano - Zach, Tue 4pm" />
    <button id="quickadd" title="Add">+</button>
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

/* ---------- Event handlers ---------- */
function attachHandlers() {
  app.querySelectorAll("[data-act]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const act = btn.dataset.act;
      if (act==="today") { weekStart = startOfWeek(new Date()); selectedDate = startOfDay(new Date()); monthCursor = startOfMonth(new Date()); render(); }
      if (act==="prev") { view==="month" ? shiftMonth(-1) : shiftWeek(-1); }
      if (act==="next") { view==="month" ? shiftMonth(1) : shiftWeek(1); }
      if (act==="cloud") {
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
  if (qa) qa.addEventListener("click", ()=> submitQuickAdd());
  if (qi) qi.addEventListener("keydown", e=>{ if (e.key==="Enter") submitQuickAdd(); });
}

function submitQuickAdd() {
  const qi = document.getElementById("quickinput");
  if (!qi.value.trim()) return;
  const draft = parseQuickAdd(qi.value);
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
    bufferBefore:30,
    bufferAfter:30,
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
        <div class="field"><label>Buffer before (min)</label><input type="number" id="f-bufbefore" value="${draft.bufferBefore}" min="0" step="5" /></div>
        <div class="field"><label>Buffer after (min)</label><input type="number" id="f-bufafter" value="${draft.bufferAfter}" min="0" step="5" /></div>
      </div>
      <div class="field">
        <label>Remind me</label>
        <select id="f-reminder">
          <option value="none" ${draft.reminder === "none" ? "selected" : ""}>No reminder</option>
          <option value="30m" ${(!draft.reminder || draft.reminder === "30m") ? "selected" : ""}>30 minutes before leaving</option>
          <option value="1h" ${draft.reminder === "1h" ? "selected" : ""}>1 hour before leaving</option>
          <option value="6h" ${draft.reminder === "6h" ? "selected" : ""}>6 hours before leaving</option>
          <option value="12h" ${draft.reminder === "12h" ? "selected" : ""}>12 hours before leaving</option>
          <option value="1d" ${draft.reminder === "1d" ? "selected" : ""}>1 day before leaving</option>
          <option value="1w" ${draft.reminder === "1w" ? "selected" : ""}>1 week before leaving</option>
          <option value="1mo" ${draft.reminder === "1mo" ? "selected" : ""}>1 month before leaving</option>
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
          // simplest instance-exception: shift recurrence anchor forward by one cycle from this date
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
if ("serviceWorker" in navigator) {
  window.addEventListener("load", ()=> navigator.serviceWorker.register("./sw.js").catch(()=>{}));
}

function signInCloud() {
  signInWithPopup(auth, new GoogleAuthProvider()).catch(err => alert("Sign-in failed: " + err.message));
}
function signOutCloud() { signOut(auth); }

async function enableNotifications() {
  try {
    if (!("Notification" in window)) return;
    const supported = await messagingSupported();
    if (!supported) return;
    const perm = await Notification.requestPermission();
    if (perm !== "granted") return;
    const reg = await navigator.serviceWorker.ready;
    const messaging = getMessaging(fbApp);
    const token = await getToken(messaging, { vapidKey: VAPID_PUBLIC_KEY, serviceWorkerRegistration: reg });
    if (token && currentUser) {
      await setDoc(doc(db, "users", currentUser.uid), { pushToken: token }, { merge: true });
    }
  } catch (e) {
  console.error("Push setup failed:", e);
  alert("Push setup failed: " + e.message);
}
}

onAuthStateChanged(auth, (user) => {
  currentUser = user;
  if (user) {
    setDoc(doc(db, "users", user.uid), {
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      updatedAt: Date.now()
    }, { merge: true });

    onSnapshot(doc(db, "users", user.uid, "data", "events"), (snap) => {
      if (snap.exists()) {
        const remote = snap.data();
        suppressNextCloudPush = true;
        if (remote.list) events = remote.list;
        if (remote.categories) categories = remote.categories;
        localStorage.setItem("af_events", JSON.stringify(events));
        localStorage.setItem("af_categories", JSON.stringify(categories));
        render();
      }
    });

    enableNotifications();
  }
  const row = document.getElementById("cloudstatus");
  if (row) row.textContent = user ? `Synced as ${user.displayName || user.email}` : "Not connected";
});

render();