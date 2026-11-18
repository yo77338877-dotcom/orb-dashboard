// ORB Trading Intelligence Dashboard V2.1 – Hauptanwendung (Browser)
import { DEFAULT_SETTINGS, DEFAULT_WATCHLIST, MARKET_SYMBOLS, MAX_WATCHLIST, STATES, stateColor, tradingViewUrl } from './config.js';
import { MarketCalendar, marketPhase, dateStr, addDays, nyTimeOnDate, fmtTime, fmtDate, fmtCountdown, NY, BERLIN } from './market-time.js';
import { FxService, fmtEUR, fmtUSD, fmtNum, fmtPct } from './fx-service.js';
import { WorkerClient, RequestBudget, splitSessions, dataQuality, dedupe, cacheGet, cacheSet, normalizeBars, FEED } from './market-data.js';
import { analyzeSymbol, marketContext, StateTracker } from './signal-engine.js';
import { aggregate, rvolBaseline, ema } from './indicators.js';
import { Journal, monitorPosition } from './trade-journal.js';
import { usedDailyRisk, positionOpenRisk } from './risk-management.js';
import { DetailChart, sparkline } from './chart-manager.js';
import * as Views from './views.js';

const MIN = 60000;
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const TEST_MODE = new URLSearchParams(location.search).get('testmodus') === '1';
const store = TEST_MODE ? prefixed(localStorage, 'test.') : localStorage; // Testmodus berührt echte Daten nie

function prefixed(st, p) { return { getItem: k => st.getItem(p + k), setItem: (k, v) => st.setItem(p + k, v), removeItem: k => st.removeItem(p + k) }; }

function loadSettings() {
  let st = {};
  try { st = JSON.parse(store.getItem('orb.settings') || '{}'); } catch { st = {}; }
  return { ...DEFAULT_SETTINGS, ...st, notifyEvents: { ...DEFAULT_SETTINGS.notifyEvents, ...(st.notifyEvents || {}) } };
}
function loadWatchlist() {
  try { const w = JSON.parse(store.getItem('orb.watchlist') || 'null'); if (Array.isArray(w) && w.length) return w.slice(0, MAX_WATCHLIST); } catch { /* */ }
  return DEFAULT_WATCHLIST.map(x => ({ ...x }));
}

export const app = {
  testMode: TEST_MODE, store,
  settings: loadSettings(),
  watchlist: loadWatchlist(),
  cal: new MarketCalendar(),
  fx: new FxService(),
  budget: new RequestBudget(75),
  data: { bars: {}, snaps: {}, sessions5: {}, daily: {}, baseline: {}, events: null },
  analyses: {}, broker: {},
  journal: new Journal(store),
  tracker: new StateTracker(store),
  sort: { key: null, asc: false },
  lastPollOk: null, pollError: null, pollFailures: 0, lastUpdate: null, connState: 'init', warnings: [],
  ready: false, detail: null, timers: {},
};
app.client = new WorkerClient(() => app.settings.workerUrl, () => getToken(), app.budget);
export function getToken() { return sessionStorage.getItem('orb.token') || localStorage.getItem('orb.token') || ''; }
export function setToken(tok, remember) {
  sessionStorage.setItem('orb.token', tok);
  if (remember) localStorage.setItem('orb.token', tok); else localStorage.removeItem('orb.token');
}
export function saveSettings() { store.setItem('orb.settings', JSON.stringify(app.settings)); applyTheme(); }
export function saveWatchlist() { store.setItem('orb.watchlist', JSON.stringify(app.watchlist)); }
export function symbols() { return app.watchlist.map(w => w.ticker); }
export function allSymbols() { return [...symbols(), ...MARKET_SYMBOLS]; }
function applyTheme() {
  document.documentElement.dataset.theme = app.settings.theme;
  const mb = $('#mode-badge');
  mb.textContent = { live: 'Live-Analyse', paper: 'Paper Trading', backtest: 'Backtesting' }[app.settings.mode];
  mb.className = 'mode ' + app.settings.mode;
}

// Simulierte Uhr nur im Testmodus
let testClockStart = null, testClockBase = null;
export function now() { return TEST_MODE && testClockBase ? testClockBase + (Date.now() - testClockStart) : Date.now(); }

// ---------------- Toasts / Benachrichtigungen ----------------
export function toast(text, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind; el.textContent = text;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 7000);
}
let audioCtx = null;
function beep(kind) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.frequency.value = kind === 'red' ? 330 : kind === 'green' ? 880 : 600;
    g.gain.value = 0.06; o.connect(g); g.connect(audioCtx.destination); o.start(); o.stop(audioCtx.currentTime + 0.18);
  } catch { /* */ }
}
/** Jedes Ereignis nur einmal. Beim ersten Laden werden bereits vergangene Ereignisse still registriert (kein Benachrichtigungs-Schwall). */
export function notify(eventType, key, title, body, kind = '') {
  const k = 'orb.notified.' + (app.activeDay || dateStr(now()));
  let set;
  try { set = new Set(JSON.parse(store.getItem(k) || '[]')); } catch { set = new Set(); }
  if (set.has(key)) return;
  set.add(key); store.setItem(k, JSON.stringify([...set]));
  if (!app.ready || !app.settings.notifyEvents[eventType]) return;
  toast(`${title}: ${body}`, kind);
  if (app.settings.notifications && 'Notification' in window && Notification.permission === 'granted') {
    try { new Notification(title, { body, tag: key }); } catch { /* */ }
  }
  if (app.settings.sound) beep(kind);
}

// ---------------- Datenladen ----------------
function setConn(state, text) { app.connState = state; app.connText = text; renderHeader(); }

function determineActiveDay() {
  const t = now(), today = dateStr(t);
  const s = app.cal.session(today);
  app.activeDay = s.isTradingDay && t >= nyTimeOnDate(today, '04:00') ? today : app.cal.prevTradingDay(today);
  app.session = app.cal.session(app.activeDay);
}

async function loadFx() {
  try {
    const d = await app.client.fx();
    app.fx.update(d, now());
    if (d.warning) addWarning('fx', d.warning); else removeWarning('fx');
  } catch (e) { app.fx.error = e.message; addWarning('fx', 'Wechselkurs nicht verfügbar: ' + e.message); }
}
async function loadFxHistory() {
  const start = addDays(app.activeDay, -420), key = `fxh:${start}:${app.activeDay}`;
  let h = await cacheGet(key);
  if (!h) { try { h = (await app.client.fxHistory(start, app.activeDay)).rates; await cacheSet(key, h); } catch (e) { addWarning('fxh', 'Historische Wechselkurse nicht verfügbar: ' + e.message); } }
  if (h) app.fx.setHistory(h);
}

async function loadHistory() {
  const syms = allSymbols();
  const key = `hist:v2:${app.activeDay}:${syms.join(',')}`;
  let h = await cacheGet(key);
  if (!h) {
    setConn('loading', 'Lade Tageskerzen …');
    const daily = await app.client.bars(syms, '1Day', addDays(app.activeDay, -420), addDays(app.activeDay, -1));
    setConn('loading', 'Lade 5-Min-Historie (RVOL-Basis, 20 Handelstage) …');
    const end = new Date(nyTimeOnDate(app.activeDay, '04:00')).toISOString();
    const b5 = await app.client.bars(syms, '5Min', addDays(app.activeDay, -35), end, n => setConn('loading', `Lade 5-Min-Historie … ${n.toLocaleString('de-DE')} Kerzen`));
    const sessions5 = {};
    for (const sym of syms) sessions5[sym] = splitSessions(b5[sym] || [], app.cal, t => dateStr(t)).slice(-20).map(x => ({ date: x.date, openMs: x.openMs, closeMs: x.closeMs, bars: x.bars }));
    h = { daily, sessions5 };
    await cacheSet(key, h);
  }
  app.data.daily = h.daily; app.data.sessions5 = h.sessions5;
  const thin = [];
  for (const sym of syms) {
    const n = (h.sessions5[sym] || []).length;
    app.data.baseline[sym] = n >= 5 ? rvolBaseline(h.sessions5[sym], 5) : null;
    if (n < 5) thin.push(sym);
  }
  if (thin.length) addWarning('hist', `Zu wenig Historie für RVOL: ${thin.join(', ')} – dort keine Signale möglich.`); else removeWarning('hist');
}

async function loadToday() {
  setConn('loading', 'Lade Intraday-Kerzen des Handelstags …');
  const start = new Date(nyTimeOnDate(app.activeDay, '04:00')).toISOString();
  const end = app.activeDay === dateStr(now()) ? null : new Date(nyTimeOnDate(app.activeDay, '20:00')).toISOString();
  const b = await app.client.bars(allSymbols(), '1Min', start, end);
  for (const sym of allSymbols()) app.data.bars[sym] = b[sym] || [];
  app.lastPollOk = now();
}

async function loadEvents() {
  try {
    const d = await app.client.events(app.activeDay, addDays(app.activeDay, 1), symbols());
    app.data.events = d.available ? d.earnings : null;
  } catch { app.data.events = null; }
}

async function poll() {
  const t = now(), syms = allSymbols();
  let latest = 0;
  for (const s of syms) { const b = app.data.bars[s]; if (b && b.length) latest = Math.max(latest, b[b.length - 1].t); }
  const since = new Date(Math.max(nyTimeOnDate(app.activeDay, '04:00'), (latest || t) - 3 * MIN, t - 25 * 3600000)).toISOString();
  try {
    const d = await app.client.live(syms, since);
    for (const [sym, arr] of Object.entries(d.bars || {})) app.data.bars[sym] = dedupe([...(app.data.bars[sym] || []), ...normalizeBars(arr)]);
    if (d.next_page_token) {
      const more = await app.client.bars(syms, '1Min', since, null);
      for (const [sym, arr] of Object.entries(more)) app.data.bars[sym] = dedupe([...(app.data.bars[sym] || []), ...arr]);
    }
    app.data.snaps = d.snapshots || {};
    app.lastPollOk = now(); app.pollError = null; app.pollFailures = 0;
    setConn('ok', 'Verbunden');
  } catch (e) {
    app.pollError = e.message; app.pollFailures++;
    setConn('error', 'Fehler: ' + e.message);
    if (app.pollFailures === 3) notify('data', 'conn-' + Math.floor(t / 600000), 'Datenproblem', 'Verbindung zum Worker gestört – neue Signale blockiert', 'orange');
  }
  app.lastUpdate = now();
}

function scheduleLoops() {
  clearTimeout(app.timers.poll); clearTimeout(app.timers.fx);
  const loopPoll = async () => {
    try {
      if (!TEST_MODE) {
        const today = dateStr(now());
        if (today !== app.activeDay && app.cal.session(today).isTradingDay && now() >= nyTimeOnDate(today, '04:00')) { await startLive(); return; }
        if (app.activeDay === today) await poll(); else { app.lastPollOk = now(); app.lastUpdate = now(); }
      }
      analyzeAll(); renderAll();
    } catch (e) { console.error(e); addWarning('loop', 'Interner Fehler: ' + e.message); }
    const ph = marketPhase(app.cal, now()).phase;
    const base = ph === 'open' ? app.settings.pollSeconds : ph === 'pre' ? 60 : 300;
    const wait = app.pollFailures ? Math.min(120, base * 2 ** Math.min(3, app.pollFailures)) : base;
    app.timers.poll = setTimeout(loopPoll, wait * 1000);
  };
  const loopFx = async () => {
    if (!TEST_MODE) await loadFx();
    const ph = marketPhase(app.cal, now()).phase;
    app.timers.fx = setTimeout(loopFx, (ph === 'open' || ph === 'pre' ? app.settings.fxPollSeconds : 600) * 1000);
  };
  app.timers.poll = setTimeout(loopPoll, 1000);
  app.timers.fx = setTimeout(loopFx, app.settings.fxPollSeconds * 1000);
}

export async function startLive() {
  clearTimeout(app.timers.poll); clearTimeout(app.timers.fx);
  app.ready = false;
  if (!app.settings.workerUrl || !getToken()) {
    setConn('config', 'Nicht konfiguriert');
    addWarning('cfg', 'Noch keine Datenverbindung eingerichtet. Bitte unter „Einstellungen“ Worker-URL und Zugriffstoken eintragen. Ohne Daten werden keine Signale erzeugt.');
    renderAll(); return;
  }
  removeWarning('cfg'); removeWarning('init');
  try {
    setConn('loading', 'Verbinde mit Worker …');
    app.health = await app.client.health();
    if (!app.health.secrets?.alpaca) throw new Error('Alpaca-Schlüssel fehlen im Worker');
    if (!app.health.originCheck) addWarning('origin', 'Hinweis: ALLOWED_ORIGINS ist im Worker nicht gesetzt – Schutz erfolgt nur über das Token.'); else removeWarning('origin');
    const today = dateStr(now());
    try { const c = await app.client.calendar(addDays(today, -420), addDays(today, 20)); app.cal.loadAlpaca(c.days); removeWarning('cal'); }
    catch (e) { addWarning('cal', 'Börsenkalender von Alpaca nicht verfügbar – lokale Feiertagstabelle wird genutzt: ' + e.message); }
    determineActiveDay();
    app.tracker.ensureDay(app.activeDay);
    await loadFx();
    await loadHistory();
    await loadToday();
    if (app.activeDay === dateStr(now())) await poll();
    app.lastUpdate = now();
    setConn('ok', 'Verbunden');
    loadEvents().then(() => { analyzeAll(); renderAll(); });
    loadFxHistory();
  } catch (e) {
    setConn('error', 'Fehler: ' + e.message);
    addWarning('init', 'Initialisierung fehlgeschlagen: ' + e.message + ' – Analyse blockiert. Bitte „Verbindungstest“ unter Einstellungen ausführen.');
  }
  analyzeAll(); app.ready = true; renderAll();
  scheduleLoops();
}

async function startTestMode() {
  const fx = await import('./tests/fixtures.js');
  const today = dateStr(Date.now());
  const day = app.cal.session(today).isTradingDay ? today : app.cal.prevTradingDay(today);
  const s = app.cal.session(day);
  testClockBase = s.openMs + 25 * MIN; testClockStart = Date.now();
  app.activeDay = day; app.session = s; app.tracker.ensureDay(day);
  const patterns = { NVDA: 'long', AMD: 'long', TSLA: 'fake', XOM: 'short', META: 'long' };
  const histDays = fx.tradingDaysBack(day, 22);
  allSymbols().forEach((sym, i) => {
    const base = sym === 'SPY' ? 600 : sym === 'QQQ' ? 500 : 100 + i * 13;
    const pat = MARKET_SYMBOLS.includes(sym) ? 'long' : (patterns[sym] || 'flat');
    app.data.bars[sym] = fx.genDay({ date: day, base, pattern: pat, volMult: pat === 'flat' ? 1 : 2.2, seed: 40 + i });
    app.data.sessions5[sym] = histDays.map((d, k) => { const ss = app.cal.session(d); return ss.isTradingDay ? { date: d, openMs: ss.openMs, closeMs: ss.closeMs, bars: aggregate(fx.genDay({ date: d, base, pattern: 'flat', seed: k + 3 + i }).filter(b => b.t >= ss.openMs && b.t < ss.closeMs), 5, ss.openMs) } : null; }).filter(Boolean).slice(-20);
    app.data.baseline[sym] = rvolBaseline(app.data.sessions5[sym], 5);
    app.data.daily[sym] = fx.genDaily(day, 260, base);
  });
  app.fx.update({ rate: 1.10, source: 'test', live: true, ts: now() }, now());
  app.lastPollOk = now(); app.lastUpdate = now();
  setConn('test', 'TESTMODUS');
  analyzeAll(); app.ready = true; renderAll(); scheduleLoops();
  setInterval(() => { app.lastPollOk = now(); app.fx.ts = now(); }, 5000);
}

// ---------------- Analyse ----------------
function eventStatusFor(sym) {
  if (app.data.events == null) return { status: 'unknown', text: 'Ereignisstatus unbekannt (keine kostenlose Datenquelle konfiguriert)' };
  const e = app.data.events.find(x => x.symbol === sym && x.date === app.activeDay);
  if (e) return { status: 'earnings', text: `Quartalszahlen heute (${e.hour === 'bmo' ? 'vor Börseneröffnung' : e.hour === 'amc' ? 'nach Börsenschluss' : 'Zeitpunkt unbekannt'}) – erhöhtes Risiko` };
  return { status: 'none', text: 'Keine Quartalszahlen heute laut Finnhub (sonstige Ereignisse unbekannt)' };
}
export function positionKind() { return app.settings.mode === 'paper' ? 'paper' : 'real'; }

export function analyzeAll(overrideSym, overrideSettings) {
  if (!app.session) return null;
  const t = now();
  const ph = marketPhase(app.cal, t);
  app.phase = app.activeDay === dateStr(t) ? ph.phase : 'post';
  const atMs = app.phase === 'post' ? app.session.closeMs : t;
  const openMs = app.session.openMs;
  const market = marketContext({ SPY: app.data.bars.SPY || [], QQQ: app.data.bars.QQQ || [] }, openMs, atMs);
  app.market = market;
  const kind = positionKind();
  const openPos = app.journal.open(kind);
  const realizedToday = app.journal.entries.filter(e => e.kind === kind)
    .flatMap(e => e.exits.filter(x => dateStr(x.time) === app.activeDay).map(x => (x.price - e.entry) * x.shares - x.fee))
    .reduce((a, b) => a + b, 0);
  const used = usedDailyRisk(openPos, realizedToday);
  app.risk = { used, limit: app.settings.capital * app.settings.maxDailyRiskPct / 100, openPositions: openPos.map(p => ({ group: p.group, riskEUR: positionOpenRisk(p), capitalEUR: p.entry * p.remainingShares })) };
  const fxExec = app.fx.executable(app.settings.maxFxAgeSec, t);
  let result = null;
  for (const sym of overrideSym ? [overrideSym] : symbols()) {
    const meta = app.watchlist.find(w => w.ticker === sym) || { ticker: sym, name: sym };
    const bars = app.data.bars[sym] || [];
    const sessionBars = bars.filter(b => b.t >= openMs && b.t < app.session.closeMs);
    const snap = app.data.snaps[sym];
    const tradeT = snap?.latestTrade?.t ? Date.parse(snap.latestTrade.t) : null;
    const lastBarT = Math.max(bars.length ? bars[bars.length - 1].t : 0, tradeT ? tradeT - MIN : 0) || null;
    let ds;
    if (!bars.length) ds = { ok: false, reasons: ['Keine Kursdaten'] };
    else if (app.phase === 'open') ds = dataQuality({ lastBarT, lastPollOk: app.lastPollOk, pollError: app.pollError, nowMs: t, phase: 'open', maxAgeSec: app.settings.maxDataAgeSec, sessionBars, openMs });
    else ds = { ok: true, reasons: [], label: 'Markt nicht geöffnet' };
    if (TEST_MODE) ds.label = 'TESTDATEN';
    const lastPrice = app.phase === 'open' && snap?.latestTrade?.p && tradeT && tradeT >= openMs ? snap.latestTrade.p : null;
    const ctx = { symbol: sym, meta, session: app.session, bars1m: bars, hist5m: (app.data.sessions5[sym] || []).slice(-3), daily: app.data.daily[sym] || [],
      baseline: app.data.baseline[sym], market, lastPrice, dataStatus: ds, eventStatus: eventStatusFor(sym) };
    const A = analyzeSymbol(ctx, overrideSettings || app.settings, atMs, { fxRate: app.fx.rate, fxExecutable: fxExec, broker: app.broker[sym], risk: { openPositions: app.risk.openPositions, usedDailyRisk: used } });
    A.meta = meta; A.dataStatus = ds; A.lastBarT = lastBarT;
    A.signalAge = A.signalTime ? atMs - A.signalTime : null;
    const pos = openPos.find(p => p.symbol === sym);
    if (pos) {
      const rate = app.fx.rate;
      const closedBelowOr = !!(A.lastBar && A.or.complete && A.lastBar.c < A.or.high - (A.scan?.tol || 0) && A.lastBar.t >= pos.buyTime);
      A.monitor = monitorPosition(pos, { priceEUR: rate && A.price ? A.price / rate : null, vwapEUR: rate && A.vwap ? A.vwap / rate : null,
        atrEUR: rate && A.atr5 ? A.atr5 / rate : null, nowMs: t, closeMs: app.phase === 'open' ? app.session.closeMs : null, fxRate: rate, closedBelowOr,
        analysisInvalid: A.setup?.state === 'INVALID' && A.setup.dir === 'long' && A.setup.invalidation.t >= pos.buyTime }, app.settings);
      A.position = pos; A.displayState = A.monitor.state;
    } else A.displayState = A.state;
    if (overrideSym) { result = A; break; }
    app.analyses[sym] = A;
    handleTransitions(sym, A);
  }
  if (!overrideSym) handleGlobalEvents(ph);
  return result;
}

function handleTransitions(sym, A) {
  const t = now(), day = app.activeDay;
  const changed = app.tracker.record(sym, A.displayState, t);
  for (const ev of A.events || []) {
    const map = { breakout: ['breakout', 'Breakout', ''], retest: ['retest', 'Retest', ''], invalid: ['invalid', 'Invalidierung', 'red'] }[ev.type];
    if (map) notify(map[0], `${day}|${sym}|${A.orbMinutes}|${ev.type}|${ev.dir}|${ev.t}`, `${sym} – ${map[1]}`, ev.text, map[2]);
  }
  if (!changed) return;
  const S = STATES, st = A.displayState;
  const sid = `${day}|${sym}|${A.orbMinutes}|${A.dir}|${A.setup?.confirm?.t || ''}`;
  if (st === S.CHECK_BROKER || st === S.IN_ZONE) notify('longSetup', 'long|' + sid, `${sym} – Long-Setup bestätigt`, A.explanation, 'green');
  if (st === S.IN_ZONE) notify('inZone', 'zone|' + sid, `${sym} – Einstieg innerhalb der Zone`, 'Brokerkurs geprüft – manuelle Ausführung möglich', 'green');
  if (st === S.BEAR_OK) notify('bearSetup', 'bear|' + sid, `${sym} – Bärisches ORB-Setup`, 'Warnsignal für Long-Positionen (keine Leerverkaufsempfehlung)', 'red');
  if (st === S.MISSED) notify('missed', 'missed|' + sid, `${sym} – Einstieg verpasst`, 'Kurs außerhalb der Einstiegszone – nicht hinterherlaufen');
  if (st === S.NO_DATA) notify('data', `data|${day}|${sym}|${Math.floor(t / 900000)}`, `${sym} – Datenproblem`, (A.dataStatus.reasons || []).join('; '), 'orange');
  if ([S.TP1, S.TP2, S.TP3].includes(st)) notify('tp', `tp|${A.position?.id}|${st}`, `${sym} – ${st}`, 'Teilgewinnmitnahme gemäß Plan prüfen', 'green');
  if (st === S.SL) notify('sl', `sl|${A.position?.id}`, `${sym} – Stop Loss erreicht`, 'Ausführung beim Broker prüfen', 'red');
  if (st === S.CLOSE_POS) notify('invalid', `close|${A.position?.id}|${(A.monitor?.alerts || []).map(a => a.key).join(',')}`, `${sym} – Position schließen`, (A.monitor?.alerts || []).map(a => a.text).join('; '), 'red');
  // Paper Trading: automatische Erfassung (nur bei aktivem Betrieb, nicht beim Nachladen)
  if (app.ready && app.settings.mode === 'paper' && app.settings.autoPaper && (st === S.CHECK_BROKER || st === S.IN_ZONE) && A.plan?.eur && !A.position && A.plan.sizing.shares > 0) {
    const k = 'orb.autopaper.' + sid;
    if (!store.getItem(k)) {
      store.setItem(k, '1');
      const p = A.plan;
      app.journal.add({ kind: 'paper', symbol: sym, group: A.meta.group, date: day, orb: A.orbMinutes, signalTime: A.signalTime, score: A.score, rvol: A.rvol,
        plannedEntry: p.eur.entry, entry: A.price / app.fx.rate, stop: p.eur.stop, tps: p.eur.tpReal, shares: p.sizing.shares, buyTime: t, feeBuy: app.settings.feeBuy,
        notes: 'Auto-Paper-Trade zum umgerechneten Referenzkurs (kein Brokerkurs)', fxAtOpen: app.fx.rate });
      toast(`Paper-Trade für ${sym} automatisch erfasst`, 'green');
    }
  }
}

function handleGlobalEvents(ph) {
  const day = app.activeDay, t = now();
  if (ph.phase === 'open') notify('open', 'open|' + day, 'US-Börse geöffnet', `Opening Range (${app.settings.orbMinutes} Min) läuft`);
  const orEnd = app.session.openMs + app.settings.orbMinutes * MIN;
  if (ph.phase === 'open' && t >= orEnd) notify('orDone', `ordone|${day}|${app.settings.orbMinutes}`, 'Opening Range abgeschlossen', `${app.settings.orbMinutes}-Minuten-Range fixiert – Breakout-Überwachung aktiv`);
  if (ph.phase === 'open' && app.session.closeMs - t <= app.settings.closeBeforeEndMin * MIN) notify('close', 'preclose|' + day, 'Börsenschluss naht', `Noch ${app.settings.closeBeforeEndMin} Min – Daytrading-Positionen prüfen`, 'orange');
  if (ph.phase === 'post') notify('close', 'close|' + day, 'US-Börse geschlossen', 'Reguläre Sitzung beendet');
}

// ---------------- Banner ----------------
function addWarning(key, text) { app.warnings = app.warnings.filter(w => w.key !== key); app.warnings.push({ key, text }); renderBanners(); }
function removeWarning(key) { const n = app.warnings.length; app.warnings = app.warnings.filter(w => w.key !== key); if (n !== app.warnings.length) renderBanners(); }
function renderBanners() {
  const parts = [];
  if (TEST_MODE) parts.push('<div class="banner test">TESTMODUS – SYNTHETISCHE TESTDATEN · KEINE ECHTEN KURSE · KEINE HANDELSSIGNALE · simulierte Uhrzeit</div>');
  if (app.settings.mode === 'paper') parts.push('<div class="banner paper">Paper Trading aktiv – erfasste Trades werden als Paper-Trades geführt und strikt von echten Trades getrennt.</div>');
  for (const w of app.warnings) parts.push(`<div class="banner warn">⚠ ${esc(w.text)}</div>`);
  $('#banners').innerHTML = parts.join('');
}

// ---------------- Kopfbereich ----------------
function renderHeader() {
  const t = now();
  $('#h-date').textContent = fmtDate(t, BERLIN);
  $('#h-de').textContent = fmtTime(t, BERLIN, true);
  $('#h-ny').textContent = fmtTime(t, NY, true);
  const ph = marketPhase(app.cal, t);
  $('#h-market').innerHTML = `<span class="badge ${{ open: 'green', pre: 'blue' }[ph.phase] || 'grey'}">${esc(ph.label)}</span>`;
  if (ph.phase === 'open') { $('#h-cd1-lbl').textContent = 'Börsenschluss in'; $('#h-cd1').textContent = fmtCountdown(ph.session.closeMs - t); }
  else { $('#h-cd1-lbl').textContent = 'Börsenöffnung in'; $('#h-cd1').textContent = ph.nextOpenMs ? `${fmtCountdown(ph.nextOpenMs - t)} (${fmtTime(ph.nextOpenMs, BERLIN)} Uhr)` : '–'; }
  const s = app.cal.session(dateStr(t));
  const orEnd = s.isTradingDay ? s.openMs + app.settings.orbMinutes * MIN : null;
  $('#h-cd2').textContent = orEnd && t < orEnd ? `${fmtCountdown(orEnd - t)} (${fmtTime(orEnd, BERLIN)} Uhr)` : orEnd && t < s.closeMs ? 'abgeschlossen' : '–';
  for (const [id, sym] of [['#h-spy', 'SPY'], ['#h-qqq', 'QQQ']]) {
    const x = app.market?.items?.[sym];
    $(id).innerHTML = x ? `<span class="${x.pct >= 0 ? 'pos' : 'neg'}">${x.pct >= 0 ? '▲' : '▼'} ${fmtPct(x.pct)}</span> <span class="tiny">${x.aboveVwap ? 'über' : 'unter'} VWAP</span>` : '<span class="dim">–</span>';
  }
  const fx = app.fx;
  $('#h-fx').textContent = fx.rate ? fmtNum(fx.rate, 4) : '–';
  $('#h-fx-src').innerHTML = fx.rate ? `${esc(fx.sourceLabel())} · ${fmtTime(fx.ts, BERLIN, true)}${fx.live ? '' : ' · <b class="neg">nicht live</b>'}` : esc(fx.error || 'keine Daten');
  const cs = { ok: ['green', 'Verbunden'], error: ['red', 'Fehler'], loading: ['blue', 'Lädt'], config: ['orange', 'Nicht konfiguriert'], test: ['orange', 'TESTMODUS'], init: ['grey', 'Start'] }[app.connState] || ['grey', '–'];
  $('#h-conn').innerHTML = `<span class="badge ${cs[0]}" title="${esc(app.connText || '')}">${cs[1]}</span>`;
  $('#h-feed').textContent = TEST_MODE ? 'Synthetische Daten' : app.connState === 'loading' ? (app.connText || '') : `Alpaca ${FEED.toUpperCase()} · Echtzeit (nur IEX-Volumen)`;
  $('#h-upd').textContent = app.lastUpdate ? fmtTime(app.lastUpdate, BERLIN, true) : '–';
  $('#h-age').textContent = app.lastPollOk ? `Datenalter ${Math.round((t - app.lastPollOk) / 1000)} s · ${app.budget.perMin()} Abfragen/Min` : '–';
}

// ---------------- Dashboard ----------------
const LONG_STATES = [STATES.IN_ZONE, STATES.CHECK_BROKER, STATES.LONG_OK];
const stateIcon = st => ({ green: '▲', red: '▼', yellow: '◆', blue: '◷', orange: '⚠', grey: '■' }[stateColor(st)] || '■');
export function badge(st) { return `<span class="badge ${stateColor(st)}" title="${esc(st)}"><span aria-hidden="true">${stateIcon(st)}</span>${esc(st)}</span>`; }
export function logo(meta) {
  const colors = { semis: '#7c3aed', megatech: '#2563eb', highbeta: '#db2777', software: '#0891b2', financials: '#059669', payments: '#d97706', retail: '#65a30d', energy: '#b45309', pharma: '#0d9488' };
  if (meta.logo && /^https:\/\//.test(meta.logo)) return `<span class="tlogo"><img src="${esc(meta.logo)}" alt="" loading="lazy" referrerpolicy="no-referrer"></span>`;
  return `<span class="tlogo" style="background:${colors[meta.group] || '#475569'}" aria-hidden="true">${esc((meta.ticker || '').slice(0, 4))}</span>`;
}
const scoreCls = s => (s >= 85 ? 's85' : s >= 75 ? 's75' : s >= 60 ? 's60' : 's0');
export const eur = usd => (usd == null || !app.fx.rate ? null : usd / app.fx.rate);
const ageTxt = ms => (ms == null ? '–' : ms < 60000 ? `${Math.round(ms / 1000)} s` : ms < 3600000 ? `${Math.round(ms / 60000)} Min` : `${(ms / 3600000).toFixed(1).replace('.', ',')} h`);

function kpis() {
  const as = Object.values(app.analyses);
  const c = st => as.filter(a => st.includes(a.displayState)).length;
  const items = [
    ['Überwachte Aktien', as.length, 'blue'],
    ['Bestätigte Long-Setups', c(LONG_STATES), 'green'],
    ['Bärische Setups', c([STATES.BEAR_OK]), 'red'],
    ['In Beobachtung', c([STATES.WATCH, STATES.WAIT_RETEST, STATES.WAIT_CONFIRM, STATES.BREAKOUT]), 'yellow'],
    ['Ohne Einstieg', c([STATES.NO_ENTRY, STATES.WAIT_BREAKOUT, STATES.INVALID, STATES.CLOSED, STATES.PRE, STATES.FORMING]), 'grey'],
    ['Verpasste Einstiege', c([STATES.MISSED]), 'grey'],
    ['Aktive Positionen', app.journal.open(positionKind()).length, 'blue'],
    ['Datenprobleme', c([STATES.NO_DATA]), 'orange'],
    ['Verbleibendes Tagesrisiko', fmtEUR(Math.max(0, (app.risk?.limit || 0) - (app.risk?.used || 0))), app.risk && app.risk.used >= app.risk.limit ? 'red' : 'green'],
  ];
  $('#kpis').innerHTML = items.map(([l, v, cl]) => `<div class="kpi ${cl}"><div class="v">${v}</div><div class="l">${l}</div></div>`).join('');
}
const todaysCloses = A => (A.series5?.bars || []).slice(A.series5?.todayStartIdx || 0).map(b => eur(b.c));

function topSetups() {
  const list = Object.values(app.analyses).filter(a => LONG_STATES.includes(a.state) && a.mandatoryOk && a.plan?.eur).sort(defaultCmp).slice(0, 3);
  if (!list.length) { $('#top').innerHTML = '<div class="empty">Aktuell keine bestätigten ORB-Trading-Setups.</div>'; return; }
  $('#top').innerHTML = list.map(A => {
    const p = A.plan, e = p.eur;
    const warn = [...A.warnings, ...(p.sizing?.warnings || []), ...(A.exec?.reasons || [])];
    return `<div class="setup-card" data-sym="${A.symbol}">
      <div class="sc-head">${logo(A.meta)}<div><div class="nm">${esc(A.meta.name)}</div><div class="tk">${A.symbol} · ${A.orbMinutes}-Min-ORB</div></div>
        <span class="spacer"></span><div style="text-align:right"><b class="mono">${fmtEUR(eur(A.price))}</b><div class="${A.dayChangePct >= 0 ? 'pos' : 'neg'} tiny">${fmtPct(A.dayChangePct)}</div></div>
        <span class="score ${scoreCls(A.score)}">${A.score}</span></div>
      <div style="margin-top:8px">${badge(A.displayState)} <span class="tiny">Broker: ${A.exec?.status === 'ready' ? 'geprüft ✓' : 'noch prüfen'}</span></div>
      <div class="sc-grid">
        <div><span>Einstiegszone</span><b>${fmtEUR(e.zoneLow)} – ${fmtEUR(e.zoneHigh)}</b></div>
        <div><span>Stop Loss</span><b class="neg">${fmtEUR(e.stop)}</b></div>
        <div><span>Netto-CRV</span><b>${fmtNum(p.netCrv, 1)}</b></div>
        <div><span>TP1</span><b>${fmtEUR(e.tpReal[0])}</b></div><div><span>TP2</span><b>${fmtEUR(e.tpReal[1])}</b></div><div><span>TP3</span><b>${fmtEUR(e.tpReal[2])}</b></div>
        <div><span>RVOL</span><b>${fmtNum(A.rvol)}</b></div><div><span>Signalalter</span><b>${ageTxt(A.signalAge)}</b></div><div><span>Max. Einstieg</span><b>${fmtEUR(e.maxEntry)}</b></div>
      </div>
      ${sparkline(todaysCloses(A), { w: 300, h: 40, color: 'var(--green)', ref: eur(A.or.high) })}
      <div class="reason">${esc(A.explanation)}</div>
      ${warn.length ? `<ul class="warnlist">${warn.slice(0, 4).map(w => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
    </div>`;
  }).join('');
}

function stateRank(st) {
  if (LONG_STATES.includes(st)) return 0;
  if ([STATES.TP1, STATES.TP2, STATES.TP3, STATES.POS_OPEN, STATES.CLOSE_POS, STATES.SL].includes(st)) return 1;
  if (st === STATES.BEAR_OK) return 2;
  if ([STATES.WATCH, STATES.WAIT_RETEST, STATES.WAIT_CONFIRM].includes(st)) return 3;
  if (st === STATES.NO_DATA) return 6;
  return 4;
}
function defaultCmp(a, b) {
  return stateRank(a.displayState) - stateRank(b.displayState) || b.score - a.score || (b.plan?.netCrv ?? -9) - (a.plan?.netCrv ?? -9) || (b.rvol ?? -1) - (a.rvol ?? -1);
}

export const COLUMNS = [
  ['rank', 'Rang', A => A._rank, A => A._rank, true],
  ['logo', 'Logo', A => logo(A.meta), A => A.symbol],
  ['name', 'Unternehmen', A => esc(A.meta.name), A => A.meta.name],
  ['ticker', 'Ticker', A => `<b>${A.symbol}</b>`, A => A.symbol],
  ['price', 'Kurs €', A => fmtEUR(eur(A.price)), A => A.price ?? -1, true],
  ['chg', 'Tag', A => `<span class="${A.dayChangePct >= 0 ? 'pos' : 'neg'}">${fmtPct(A.dayChangePct)}</span>`, A => A.dayChangePct ?? -999, true],
  ['orh', 'OR High €', A => fmtEUR(eur(A.or.high)), A => A.or.high ?? -1, true],
  ['orl', 'OR Low €', A => fmtEUR(eur(A.or.low)), A => A.or.low ?? -1, true],
  ['orb', 'ORB-Status', A => esc(orbStatus(A)), A => orbStatus(A)],
  ['rvol', 'RVOL', A => `<span class="${A.rvol >= app.settings.minRvol ? 'pos' : ''}">${fmtNum(A.rvol)}</span>`, A => A.rvol ?? -1, true],
  ['vwap', 'VWAP', A => (A.vwap == null || A.price == null ? '–' : A.price > A.vwap ? '<span class="pos">▲ darüber</span>' : '<span class="neg">▼ darunter</span>'), A => (A.price ?? 0) - (A.vwap ?? 0)],
  ['ema', 'EMA-Trend', A => (A.emaTrendLabel ? `<span class="${A.emaTrendLabel === 'steigend' ? 'pos' : 'neg'}">${A.emaTrendLabel}</span>` : '–'), A => A.emaTrendLabel || ''],
  ['rsi', 'RSI', A => fmtNum(A.rsi, 1), A => A.rsi ?? -1, true],
  ['rs', 'Marktstärke', A => (A.relStrength == null ? '–' : `<span class="${A.relStrength >= 0 ? 'pos' : 'neg'}">${fmtNum(A.relStrength)}</span>`), A => A.relStrength ?? -99, true],
  ['score', 'Score', A => `<span class="score ${scoreCls(A.score)}">${A.score}</span>`, A => A.score, true],
  ['signal', 'Signal', A => badge(A.displayState), A => -stateRank(A.displayState)],
  ['entry', 'Entry €', A => fmtEUR(A.plan?.eur?.entry), A => A.plan?.entry ?? -1, true],
  ['sl', 'Stop €', A => fmtEUR(A.plan?.eur?.stop), A => A.plan?.stop ?? -1, true],
  ['tp1', 'TP1 €', A => fmtEUR(A.plan?.eur?.tpReal?.[0]), A => A.plan?.tpReal?.[0] ?? -1, true],
  ['tp2', 'TP2 €', A => fmtEUR(A.plan?.eur?.tpReal?.[1]), A => A.plan?.tpReal?.[1] ?? -1, true],
  ['tp3', 'TP3 €', A => fmtEUR(A.plan?.eur?.tpReal?.[2]), A => A.plan?.tpReal?.[2] ?? -1, true],
  ['crv', 'Netto-CRV', A => fmtNum(A.plan?.netCrv, 1), A => A.plan?.netCrv ?? -9, true],
  ['age', 'Signalalter', A => ageTxt(A.signalAge), A => -(A.signalAge ?? 1e12), true],
  ['dq', 'Datenqualität', A => (A.dataStatus.ok ? `<span class="pos">✓ ${esc(A.dataStatus.label || 'OK')}</span>` : `<span class="neg" title="${esc(A.dataStatus.reasons.join('; '))}">⚠ ${esc(A.dataStatus.reasons[0] || 'Problem')}</span>`), A => (A.dataStatus.ok ? 1 : 0)],
];

export function orbStatus(A) {
  if (!A.or.timeComplete) return 'in Bildung';
  if (!A.or.complete) return 'unvollständig';
  if (!A.setup) return 'kein Ausbruch';
  const d = A.setup.dir === 'long' ? '↑' : '↓';
  return { WAIT_RETEST: `${d} Breakout, Retest offen`, RETEST_TOUCHED: `${d} Retest, Bestätigung offen`, CONFIRMED: `${d} bestätigt`, INVALID: `${d} Fehlausbruch`, TIMEOUT: `${d} ohne Retest` }[A.setup.state] || A.setup.state;
}

function filtered() {
  const q = ($('#search').value || '').trim().toLowerCase();
  const f = $('#filter').value;
  const ranked = Object.values(app.analyses).sort(defaultCmp);
  ranked.forEach((A, i) => { A._rank = i + 1; });
  let list = ranked;
  if (q) list = list.filter(A => A.symbol.toLowerCase().includes(q) || (A.meta.name || '').toLowerCase().includes(q));
  const fm = {
    long: A => LONG_STATES.includes(A.displayState), bear: A => A.displayState === STATES.BEAR_OK,
    watch: A => [STATES.WATCH, STATES.WAIT_RETEST, STATES.WAIT_CONFIRM, STATES.BREAKOUT].includes(A.displayState),
    none: A => [STATES.NO_ENTRY, STATES.MISSED, STATES.INVALID, STATES.WAIT_BREAKOUT].includes(A.displayState),
    data: A => A.displayState === STATES.NO_DATA || !A.dataStatus.ok, pos: A => !!A.position,
  };
  if (fm[f]) list = list.filter(fm[f]);
  if (app.sort.key) {
    const col = COLUMNS.find(c => c[0] === app.sort.key);
    list = [...list].sort((a, b) => { const x = col[3](a), y = col[3](b); const r = x > y ? 1 : x < y ? -1 : 0; return app.sort.asc ? r : -r; });
  }
  return list;
}

function renderTable() {
  const hidden = new Set(app.settings.hiddenColumns || []);
  const cols = COLUMNS.filter(c => !hidden.has(c[0]));
  const list = filtered();
  const head = cols.map(c => `<th data-k="${c[0]}" class="${c[4] ? 'num' : ''} ${app.sort.key === c[0] ? 'sorted' + (app.sort.asc ? ' asc' : '') : ''}">${c[1]}</th>`).join('');
  const rows = list.map(A => `<tr data-sym="${A.symbol}" class="row-${stateColor(A.displayState)}">${cols.map(c => `<td class="${c[4] ? 'num' : ''}">${c[2](A)}</td>`).join('')}</tr>`).join('');
  $('#table-wrap').innerHTML = `<table class="grid"><thead><tr>${head}</tr></thead><tbody>${rows || `<tr><td colspan="${cols.length}" class="dim">Keine Aktien für diesen Filter.</td></tr>`}</tbody></table>`;
  $('#sort-info').textContent = app.sort.key ? `Sortierung: ${COLUMNS.find(c => c[0] === app.sort.key)[1]} ${app.sort.asc ? '↑' : '↓'} (Klick auf „Rang“ = Standard)` : 'Sortierung: Standard (Long-Setups, Score, Netto-CRV, RVOL)';
}

function renderCards() {
  $('#cards-wrap').innerHTML = filtered().map(A => {
    const e = A.plan?.eur || {};
    return `<div class="mini ${stateColor(A.displayState)}" data-sym="${A.symbol}">
      <div class="row">${logo(A.meta)}<div style="flex:1;min-width:0"><b>${esc(A.meta.name)}</b><div class="tiny">${A.symbol}</div></div><span class="score ${scoreCls(A.score)}">${A.score}</span></div>
      <div class="row" style="margin-top:6px"><b class="mono">${fmtEUR(eur(A.price))}</b><span class="${A.dayChangePct >= 0 ? 'pos' : 'neg'}">${fmtPct(A.dayChangePct)}</span></div>
      ${sparkline(todaysCloses(A), { w: 228, h: 32, color: A.dayChangePct >= 0 ? 'var(--green)' : 'var(--red)' })}
      <div>${badge(A.displayState)}</div>
      <div class="kv"><span>ORB</span><b>${esc(orbStatus(A))}</b><span>Entry</span><b>${fmtEUR(e.entry)}</b><span>Stop</span><b>${fmtEUR(e.stop)}</b><span>TP1/2/3</span><b>${e.tpReal ? e.tpReal.map(v => fmtNum(v)).join(' / ') : '–'}</b><span>Netto-CRV</span><b>${fmtNum(A.plan?.netCrv, 1)}</b></div>
    </div>`;
  }).join('') || '<div class="empty">Keine Aktien für diesen Filter.</div>';
}

function renderColChooser() {
  const hidden = new Set(app.settings.hiddenColumns || []);
  $('#colchooser').innerHTML = COLUMNS.map(c => `<label><input type="checkbox" data-col="${c[0]}" ${hidden.has(c[0]) ? '' : 'checked'}> ${c[1]}</label>`).join('');
}

export function renderAll() {
  renderHeader(); renderBanners();
  if ($('#tab-dashboard').classList.contains('active')) {
    kpis(); topSetups();
    const cards = app.settings.view === 'cards';
    $('#table-wrap').classList.toggle('hidden', cards); $('#cards-wrap').classList.toggle('hidden', !cards);
    $('#v-table').classList.toggle('active', !cards); $('#v-cards').classList.toggle('active', cards);
    if (!Object.keys(app.analyses).length) $('#table-wrap').innerHTML = `<div class="empty">${app.connState === 'config' ? 'Keine Datenverbindung konfiguriert – bitte „Einstellungen“ öffnen.' : app.connState === 'error' ? 'Keine Daten – siehe Fehlermeldung oben.' : 'Daten werden geladen …'}</div>`;
    else if (cards) renderCards(); else renderTable();
  }
  if (app.detail) renderDetailSide();
  Views.refreshActive(app);
}

// ---------------- Detailansicht ----------------
export function openDetail(sym) {
  app.detail = { sym, tf: '1Min', orb: Number(app.settings.orbMinutes) };
  const dlg = $('#detail');
  const meta = app.watchlist.find(w => w.ticker === sym) || { ticker: sym, name: sym };
  dlg.innerHTML = `<div class="modal-head">${logo(meta)}<div><h2>${esc(meta.name)} <span class="dim">${sym}</span></h2>
      <div class="tiny">ISIN ${esc(meta.isin || '–')} · WKN ${esc(meta.wkn || '–')} · ${esc(meta.exchange || '–')} · ${esc(meta.sector || '')} · Originalwährung ${esc(meta.currency || 'USD')} · <a href="${tradingViewUrl(meta)}" target="_blank" rel="noopener">TradingView ↗</a></div></div>
      <span class="spacer"></span>
      <div class="tfbar" id="d-tf">${[['1Min', '1 Min'], ['5Min', '5 Min'], ['15Min', '15 Min'], ['30Min', '30 Min'], ['1Hour', '1 Std'], ['1Day', '1 Tag']].map(([t, l]) => `<button data-tf="${t}" class="${t === '1Min' ? 'active' : ''}">${l}</button>`).join('')}</div>
      <div class="tfbar" id="d-orb">${[5, 15, 30].map(m => `<button data-orb="${m}" class="${m === app.detail.orb ? 'active' : ''}">${m}-Min-ORB</button>`).join('')}</div>
      <button id="d-close" aria-label="Schließen">✕</button></div>
    <div class="modal-body"><div class="detail-layout">
      <div><div id="d-chart" class="chart-main"></div><div class="tiny" id="d-chart-note" style="margin-top:4px"></div>
        <div class="subcharts"><div id="d-rsi"></div><div id="d-macd"></div><div id="d-atr"></div><div id="d-rvol"></div></div></div>
      <div id="d-side"></div>
    </div></div>`;
  dlg.showModal();
  $('#d-close').onclick = () => dlg.close();
  dlg.onclose = () => { if (app.detailChart) app.detailChart.destroy(); app.detail = null; };
  $('#d-tf').onclick = e => { const b = e.target.closest('button'); if (!b) return; $$('#d-tf button').forEach(x => x.classList.toggle('active', x === b)); setDetailView(b.dataset.tf, null); };
  $('#d-orb').onclick = e => { const b = e.target.closest('button'); if (!b) return; $$('#d-orb button').forEach(x => x.classList.toggle('active', x === b)); setDetailView(null, +b.dataset.orb); };
  app.detailChart = new DetailChart($('#d-chart'), { rsi: $('#d-rsi'), macd: $('#d-macd'), atr: $('#d-atr'), rvol: $('#d-rvol') });
  renderDetailSide(true); renderDetailChart(true);
}

/** Zeitrahmen und/oder ORB-Variante der Detailansicht wechseln */
export function setDetailView(tf, orb) {
  if (!app.detail) return;
  if (tf) app.detail.tf = tf;
  if (orb) { app.detail.orb = orb; renderDetailSide(true); }
  renderDetailChart(true);
}

function detailAnalysis() {
  const d = app.detail;
  if (!d) return null;
  if (d.orb === Number(app.settings.orbMinutes)) return app.analyses[d.sym] || analyzeAll(d.sym);
  const end = new Date(app.session.openMs + d.orb * MIN);
  const s = { ...app.settings, orbMinutes: d.orb, entryWindowStart: new Intl.DateTimeFormat('en-GB', { timeZone: NY, hour: '2-digit', minute: '2-digit' }).format(end) };
  return analyzeAll(d.sym, s);
}

function renderDetailSide(force = false) {
  const side = $('#d-side');
  if (!side) return;
  // Eingaben nicht überschreiben, solange der Nutzer tippt
  const active = document.activeElement;
  if (!force && active && side.contains(active) && /INPUT|TEXTAREA|SELECT/.test(active.tagName)) return;
  const keep = { ask: $('#d-ask')?.value, bid: $('#d-bid')?.value };
  const A = detailAnalysis(); if (!A) return;
  const p = A.plan, e = p?.eur;
  const col = stateColor(A.displayState);
  const ampelTxt = { green: 'GRÜN – Technisches ORB-Setup bestätigt. Einstieg innerhalb der akzeptablen Zone; Ausführung gemäß Brokerstatus prüfen.', yellow: 'GELB – Beobachten. Mindestens eine Bestätigung fehlt oder der Retest steht aus.', red: 'ROT – Kein Long-Einstieg oder bestehendes Setup invalidiert.', grey: 'GRAU – Markt geschlossen bzw. kein relevantes Setup.', orange: 'ORANGE – Technisches Datenproblem. Keine ausführungsbereite Empfehlung.', blue: 'BLAU – Opening Range in Bildung.' }[col];
  const bq = app.broker[A.symbol];
  const checks = A.checks.map(c => `<li><span class="ic ${c.status}">${c.status === 'ok' ? '✓' : c.status === 'fail' ? '✗' : '?'}</span><span>${esc(c.label)} ${c.mandatory ? '<span class="m">Pflicht</span>' : ''}</span><span class="tiny">${c.max ? `${c.points}/${c.max}` : ''}</span><span class="d">${esc(c.detail || '')}</span></li>`).join('')
    + `<li><span class="ic ${bq ? 'ok' : 'unknown'}">${bq ? '✓' : '?'}</span><span>Brokerkurs geprüft</span><span></span><span class="d">${bq ? `Brief ${fmtEUR(bq.ask)} · Geld ${fmtEUR(bq.bid)} · ${fmtTime(bq.ts, BERLIN, true)}` : 'Noch kein Trade-Republic-Kurs erfasst'}</span></li>`;
  const sb = Object.entries(A.scoreBreakdown || {}).map(([k, [v, m]]) => `<span>${k}</span><span>${v} / ${m}</span>`).join('');
  const hist = app.tracker.history(A.symbol).slice(-8).reverse().map(h => `<span>${fmtTime(h.t, BERLIN, true)}</span><span>${esc(h.state)}</span>`).join('');
  const ev = (A.events || []).map(x => `<span>${fmtTime(x.t, BERLIN)} (${fmtTime(x.t, NY)} NY)</span><span>${esc(x.text)}</span>`).join('');
  const z = p?.sizing;
  const warn = [...A.warnings, ...(z?.warnings || []), ...(A.monitor?.alerts || []).map(a => a.text)];
  side.innerHTML = `
    <div class="ampel ${col}"><div class="light"></div><div class="txt"><b>${esc(A.displayState)}</b><span class="tiny">${esc(ampelTxt)}</span></div></div>
    <p class="reason">${esc(A.explanation)}</p>
    ${A.exec?.reasons?.length ? `<div class="note warn"><b>${A.exec.status === 'blocked' ? 'Ausführung blockiert' : 'Vor Ausführung prüfen'}:</b><ul style="margin:4px 0 0;padding-left:16px">${A.exec.reasons.map(r => `<li>${esc(r)}</li>`).join('')}</ul></div>` : ''}
    ${warn.length ? `<ul class="warnlist">${warn.map(w => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
    <h3 class="sec-title">Handelsplan (EUR, indikativ)</h3>
    ${p && e ? `<div class="kv2">
      <span>Aktueller Referenzkurs</span><span>${fmtEUR(eur(A.price))}</span>
      <span>Idealer Einstieg</span><span><b>${fmtEUR(e.entry)}</b></span>
      <span>Einstiegszone</span><span>${fmtEUR(e.zoneLow)} – ${fmtEUR(e.zoneHigh)}</span>
      <span>Max. Einstiegspreis</span><span>${fmtEUR(e.maxEntry)}</span>
      <span>Abstand zum Einstieg</span><span>${fmtPct(A.price && p.entry ? (A.price / p.entry - 1) * 100 : null)}</span>
      <span>Breakout-Level</span><span>${fmtEUR(e.breakoutLevel)}</span>
      <span>Retest-Level</span><span>${fmtEUR(e.retestLevel)}</span>
      <span>Stop Loss</span><span class="neg"><b>${fmtEUR(e.stop)}</b> (${fmtEUR(Math.abs(e.entry - e.stop))} · ${fmtPct((e.stop / e.entry - 1) * 100)})</span>
      <span>TP1 (1R)</span><span>${fmtEUR(e.tpReal[0])}${p.capped[0] ? ' ⚑' : ''}</span>
      <span>TP2 (2R)</span><span>${fmtEUR(e.tpReal[1])}${p.capped[1] ? ' ⚑' : ''}</span>
      <span>TP3 (3R)</span><span>${fmtEUR(e.tpReal[2])}${p.capped[2] ? ' ⚑' : ''}</span>
      <span>Brutto-CRV (TP${p.mainIdx + 1})</span><span>${fmtNum(p.grossCrvs[p.mainIdx])}</span>
      <span>Realistisches CRV</span><span>${fmtNum(p.realCrvs[p.mainIdx])}</span>
      <span>Netto-CRV nach Kosten</span><span><b>${fmtNum(p.netCrv)}</b></span>
      <span>CRV zum Brokerkurs</span><span>${fmtNum(A.exec?.brokerCrv)}</span>
      <span>Signalzeitpunkt</span><span>${A.signalTime ? `${fmtTime(A.signalTime, BERLIN)} (${fmtTime(A.signalTime, NY)} NY)` : '–'}</span>
      <span>Signalgültigkeit</span><span>${app.settings.signalValidityBars} Kerzen nach Bestätigung</span>
    </div>
    <div class="tiny" style="margin-top:4px">${esc(p.stopReason)}${p.capped.some(Boolean) ? ' · ⚑ = durch Widerstand begrenzt' : ''}</div>
    <details class="box"><summary>Technische Detailansicht (USD)</summary><div class="kv2">
      <span>Entry</span><span>${fmtUSD(p.entry)}</span><span>Stop</span><span>${fmtUSD(p.stop)}</span><span>R</span><span>${fmtUSD(p.R)} (${fmtNum(p.riskAtr)} × ATR)</span>
      <span>TP1/2/3</span><span>${p.tpReal.map(fmtUSD).join(' / ')}</span><span>OR High/Low</span><span>${fmtUSD(A.or.high)} / ${fmtUSD(A.or.low)}</span><span>EUR/USD</span><span>${fmtNum(app.fx.rate, 4)}</span></div></details>`
    : p ? '<div class="note warn">Kein Wechselkurs – Euro-Handelsplan nicht verfügbar.</div>' : '<div class="note">Kein Handelsplan – es liegt kein bestätigtes ORB-Setup vor. <b>NO VALID ORB – NO TRADE.</b></div>'}
    ${A.dir === 'long' && p ? `<h3 class="sec-title">Trade-Republic-Kursabgleich</h3>
    <div class="form-grid">
      <label>Briefkurs (Kauf) €<input id="d-ask" type="number" step="0.01" min="0" inputmode="decimal" value="${keep.ask ?? bq?.ask ?? ''}"></label>
      <label>Geldkurs (Verkauf) €<input id="d-bid" type="number" step="0.01" min="0" inputmode="decimal" value="${keep.bid ?? bq?.bid ?? ''}"></label>
    </div>
    <div class="actions"><button id="d-bq" class="primary">Brokerkurs übernehmen</button><button id="d-bq-clear">Löschen</button></div>
    <div class="tiny">${bq ? `Erfasst ${fmtTime(bq.ts, BERLIN, true)} · gültig ${app.settings.brokerQuoteMaxAgeSec} s · Spread ${fmtNum(A.exec?.brokerSpread)} % · Abweichung zum Referenzkurs ${fmtPct(eur(A.price) ? (bq.ask / eur(A.price) - 1) * 100 : null)}` : 'Kurse aus der Trade-Republic-App abtippen; der Zeitpunkt wird automatisch gespeichert.'}</div>` : ''}
    ${z && A.dir === 'long' ? `<h3 class="sec-title">Positionsgröße</h3><div class="kv2">
      <span>Stückzahl</span><span><b>${z.shares}</b> ${z.limitedBy ? `(begrenzt durch ${z.limitedBy})` : ''}</span>
      <span>Kapitalbedarf</span><span>${fmtEUR(z.capitalNeeded)}</span>
      <span>Verlust am Stop</span><span class="neg">${fmtEUR(z.lossAtStop)}</span>
      <span>Gewinn TP1 / TP2 / TP3</span><span class="pos">${z.gains.map(fmtEUR).join(' / ')}</span>
      <span>Geschätzte Kosten</span><span>${fmtEUR(z.estCosts)}</span>
      <span>Verbleibendes Tagesrisiko</span><span>${fmtEUR(z.remainingDaily)}</span></div>
      ${z.blocks.length ? `<div class="note warn">${z.blocks.map(esc).join('<br>')}</div>` : ''}` : ''}
    <div class="actions">
      <button id="d-pos" ${p && A.dir === 'long' && e ? '' : 'disabled'}>${app.settings.mode === 'paper' ? 'Paper-Trade erfassen' : 'Position manuell erfassen'}</button>
      ${A.position ? '<button id="d-posview">Position anzeigen</button>' : ''}
    </div>
    <h3 class="sec-title">Signalverifizierung</h3><ul class="checklist">${checks}</ul>
    <h3 class="sec-title">Trading-Score ${A.score} / 100</h3><div class="kv2">${sb}</div>
    <div class="tiny">Qualitätsbewertung – keine Gewinnwahrscheinlichkeit.</div>
    <h3 class="sec-title">Kontext</h3><div class="kv2">
      <span>Gap</span><span>${A.gap ? `${fmtPct(A.gap.pct)} (${A.gap.size}, ${A.gap.filled ? 'geschlossen' : 'offen'})` : '–'}</span>
      <span>Vortag H / L / C</span><span>${[A.pdh, A.pdl, A.prevClose].map(v => fmtEUR(eur(v))).join(' / ')}</span>
      <span>Pre-Market H / L</span><span>${fmtEUR(eur(A.pmh))} / ${fmtEUR(eur(A.pml))}</span>
      <span>VWAP</span><span>${fmtEUR(eur(A.vwap))}</span>
      <span>ATR 5 Min / Tag</span><span>${fmtEUR(eur(A.atr5))} / ${fmtEUR(eur(A.dailyAtr))}</span>
      <span>OR-Breite</span><span>${fmtPct(A.or.widthPct, 2, false)} · ${fmtNum(A.or.widthAtr)} × ATR</span>
      <span>Ereignisse</span><span>${esc(A.eventStatus?.text || 'unbekannt')}</span>
      <span>Daten</span><span>${A.dataStatus.ok ? 'OK' : esc(A.dataStatus.reasons.join('; '))} · letzte Kerze ${A.lastBarT ? fmtTime(A.lastBarT, BERLIN, true) : '–'}</span>
    </div>
    ${ev ? `<h3 class="sec-title">Ereignisse heute</h3><div class="kv2">${ev}</div>` : ''}
    ${hist ? `<h3 class="sec-title">Statusverlauf</h3><div class="kv2">${hist}</div>` : ''}`;
  const bqBtn = $('#d-bq');
  if (bqBtn) bqBtn.onclick = () => {
    const ask = parseFloat(String($('#d-ask').value).replace(',', '.')), bid = parseFloat(String($('#d-bid').value).replace(',', '.'));
    if (!(ask > 0)) { toast('Bitte gültigen Briefkurs eingeben', 'red'); return; }
    if (bid > 0 && bid > ask) { toast('Geldkurs darf nicht über dem Briefkurs liegen', 'red'); return; }
    const ref = eur(A.price);
    if (ref && Math.abs(ask / ref - 1) > 0.05) { toast('Brokerkurs weicht > 5 % vom Referenzkurs ab – Eingabe prüfen', 'red'); return; }
    app.broker[A.symbol] = { ask, bid: bid > 0 ? bid : null, ts: now() };
    analyzeAll(); renderAll(); renderDetailSide(true);
  };
  const clr = $('#d-bq-clear');
  if (clr) clr.onclick = () => { delete app.broker[A.symbol]; $('#d-ask').value = ''; $('#d-bid').value = ''; analyzeAll(); renderAll(); renderDetailSide(true); };
  const pb = $('#d-pos'); if (pb) pb.onclick = () => Views.openPositionForm(app, prefillFromAnalysis(A));
  const pv = $('#d-posview'); if (pv) pv.onclick = () => { $('#detail').close(); switchTab('positions'); };
}

export function prefillFromAnalysis(A) {
  const e = A.plan?.eur || {};
  const bq = app.broker[A.symbol];
  return { kind: positionKind(), symbol: A.symbol, group: A.meta.group, orb: A.orbMinutes, signalTime: A.signalTime, score: A.score, rvol: A.rvol,
    plannedEntry: e.entry, entry: bq?.ask ?? e.entry, stop: e.stop, tps: e.tpReal || [], shares: A.plan?.sizing?.shares || 0, buyTime: now(), feeBuy: app.settings.feeBuy,
    fxAtOpen: app.fx.rate, date: app.activeDay };
}

function renderDetailChart(force) {
  if (!app.detail || !app.detailChart) return;
  const A = detailAnalysis(); if (!A) return;
  const tf = app.detail.tf, rate = app.fx.rate, note = $('#d-chart-note');
  if (!rate) { note.textContent = 'Kein Wechselkurs verfügbar – Euro-Chart nicht möglich.'; return; }
  const bars = app.data.bars[A.symbol] || [];
  const s = app.session;
  const conv = (b, r = rate) => ({ t: b.t, o: b.o / r, h: b.h / r, l: b.l / r, c: b.c / r, v: b.v });
  const tfMin = { '1Min': 1, '5Min': 5, '15Min': 15, '30Min': 30, '1Hour': 60 }[tf];
  let candles = [];
  const daily = tf === '1Day';
  if (tf === '1Min') candles = bars.filter(b => b.t + MIN <= A.atMs).map(b => conv(b));
  else if (daily) {
    candles = (app.data.daily[A.symbol] || []).filter(b => dateStr(b.t) < app.activeDay).slice(-250).map(b => conv(b, app.fx.rateBefore(dateStr(b.t)) || rate));
    const sb = A.sessionBars;
    if (sb.length) candles.push(conv({ t: s.openMs, o: sb[0].o, h: Math.max(...sb.map(b => b.h)), l: Math.min(...sb.map(b => b.l)), c: sb[sb.length - 1].c, v: sb.reduce((a, b) => a + b.v, 0) }));
  } else {
    for (const h of (app.data.sessions5[A.symbol] || []).slice(tfMin >= 30 ? -10 : -3)) candles.push(...aggregate(h.bars, tfMin, h.openMs).map(b => conv(b)));
    candles.push(...aggregate(A.sessionBars, tfMin, s.openMs).filter(b => b.t + tfMin * MIN <= A.atMs).map(b => conv(b)));
  }
  const closes = candles.map(c => c.c);
  const mk = arr => arr.map((v, i) => ({ t: candles[i].t, v }));
  const lines = { e9: mk(ema(closes, 9)), e20: mk(ema(closes, 20)), e50: mk(ema(closes, 50)), e200: mk(ema(closes, 200)) };
  if (!daily) {
    // VWAP auf den Chart-Zeitrahmen abtasten (sonst entstehen Lücken im Candle-Chart)
    const vwPts = [];
    A.sessionBars.forEach((b, i) => {
      const v = A.vwapSeries[i]; if (v == null) return;
      const key = tfMin === 1 ? b.t : s.openMs + Math.floor((b.t - s.openMs) / (tfMin * MIN)) * tfMin * MIN;
      vwPts.push({ t: key, v: v / rate });
    });
    lines.vwap = vwPts;
  }
  const p = A.plan, e = p?.eur;
  const levels = [];
  if (A.or.high != null) levels.push({ price: eur(A.or.high), title: 'OR High', color: '#3b82f6', style: 0 }, { price: eur(A.or.low), title: 'OR Low', color: '#3b82f6', style: 0 }, { price: eur(A.or.mid), title: 'OR Mitte', color: '#3b82f699', style: 1 });
  if (e) levels.push({ price: e.entry, title: 'Entry', color: '#22c55e', style: 0, width: 2 }, { price: e.zoneLow, title: 'Zone', color: '#22c55e88', style: 3 }, { price: e.zoneHigh, title: 'Max. Entry', color: '#22c55e88', style: 3 },
    { price: e.stop, title: 'Stop Loss', color: '#ef4444', style: 0, width: 2 }, { price: e.tpReal[0], title: 'TP1', color: '#16a34a', style: 2 }, { price: e.tpReal[1], title: 'TP2', color: '#16a34a', style: 2 }, { price: e.tpReal[2], title: 'TP3', color: '#16a34a', style: 2 });
  levels.push({ price: eur(A.pdh), title: 'Vortageshoch', color: '#9aa3ad', style: 2 }, { price: eur(A.pdl), title: 'Vortagestief', color: '#9aa3ad', style: 2 },
    { price: eur(A.pmh), title: 'PM High', color: '#9aa3ad88', style: 3 }, { price: eur(A.pml), title: 'PM Low', color: '#9aa3ad88', style: 3 });
  for (const r of A.swingHighs.slice(-3)) levels.push({ price: eur(r), title: 'Widerstand', color: '#f9731688', style: 3 });
  for (const r of A.swingLows.slice(-3)) levels.push({ price: eur(r), title: 'Unterstützung', color: '#14b8a688', style: 3 });
  const boxes = [], markers = [];
  if (!daily) {
    if (A.or.high != null) boxes.push({ from: s.openMs, to: s.openMs + A.orbMinutes * MIN - MIN, top: eur(A.or.high), bottom: eur(A.or.low), color: 'rgba(59,130,246,.16)', label: `${A.orbMinutes}-Min-OR` });
    if (e && A.signalTime) boxes.push({ from: A.signalTime, to: Math.min(A.window.end, A.atMs), top: e.zoneHigh, bottom: e.zoneLow, color: 'rgba(34,197,94,.13)', label: 'Einstiegszone' });
    for (const ev of A.events || []) {
      const L = ev.dir === 'long';
      const mm = { breakout: ['Breakout', L ? 'belowBar' : 'aboveBar', L ? 'arrowUp' : 'arrowDown', '#3b82f6'], retest: ['Retest', L ? 'belowBar' : 'aboveBar', 'circle', '#eab308'], confirm: ['Signal', L ? 'belowBar' : 'aboveBar', L ? 'arrowUp' : 'arrowDown', L ? '#22c55e' : '#ef4444'], invalid: ['Invalidiert', 'aboveBar', 'square', '#ef4444'], timeout: ['Timeout', 'aboveBar', 'square', '#9aa3ad'] }[ev.type];
      if (mm) markers.push({ t: ev.t, text: mm[0], position: mm[1], shape: mm[2], color: mm[3] });
    }
    for (const h of app.tracker.history(A.symbol)) if ([STATES.CHECK_BROKER, STATES.IN_ZONE, STATES.BEAR_OK].includes(h.state) && h.t >= s.openMs && h.t <= A.atMs) markers.push({ t: h.t - MIN, text: h.state === STATES.BEAR_OK ? 'Bär. Setup' : 'Long-Setup', position: 'aboveBar', shape: 'circle', color: h.state === STATES.BEAR_OK ? '#ef4444' : '#22c55e' });
  }
  const s5 = A.series5;
  const pts = arr => s5.bars.map((b, i) => ({ t: b.t, v: arr[i] }));
  const rv = [];
  const base = app.data.baseline[A.symbol];
  if (base) { let cum = 0; s5.bars.slice(s5.todayStartIdx).forEach((b, k) => { cum += b.v; const bv = base.cumAvg[k]; rv.push({ t: b.t, v: bv ? cum / bv : null }); }); }
  const subs = { rsi: { rsi: pts(s5.rsi) }, macd: { line: pts(s5.macd.line), signal: pts(s5.macd.signal), hist: pts(s5.macd.hist) }, atr: { atr: pts(s5.atr) }, rvol: { rvol: rv } };
  let prevRange = null;
  if (!force && app.detailChart.main) try { prevRange = app.detailChart.main.timeScale().getVisibleLogicalRange(); } catch { /* */ }
  app.detailChart.render({ candles, daily, lines, levels, boxes, markers, subs });
  if (prevRange && app.detailChart.main) try { app.detailChart.main.timeScale().setVisibleLogicalRange(prevRange); } catch { /* */ }
  note.innerHTML = `Kursachse in EUR (umgerechnet mit ${daily ? 'EZB-Referenzkurs des Vortags je Kerze' : `EUR/USD ${fmtNum(rate, 4)}, ${esc(app.fx.sourceLabel())}`}) – indikativ, kein Brokerkurs. Zeitachse: deutsche Ortszeit. Chart-EMAs auf dem gewählten Zeitrahmen; Signal-EMAs: EMA 9/20 (5 Min), EMA 50/200 (Tag). Datenfeed: ${TEST_MODE ? 'SYNTHETISCH' : 'Alpaca IEX'}.`;
}

// ---------------- Navigation / Ereignisse ----------------
export function switchTab(name) {
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  $$('.tabpane').forEach(p => p.classList.toggle('active', p.id === 'tab-' + name));
  Views.render(app, name);
  if (name === 'dashboard') renderAll();
}

function bind() {
  $$('.tab').forEach(t => t.addEventListener('click', () => switchTab(t.dataset.tab)));
  $('#search').addEventListener('input', renderAll);
  $('#filter').addEventListener('change', renderAll);
  $('#v-table').onclick = () => { app.settings.view = 'table'; saveSettings(); renderAll(); };
  $('#v-cards').onclick = () => { app.settings.view = 'cards'; saveSettings(); renderAll(); };
  $('#table-wrap').addEventListener('click', e => {
    const th = e.target.closest('th');
    if (th) { const k = th.dataset.k; if (k === 'rank') app.sort = { key: null, asc: false }; else if (app.sort.key === k) app.sort.asc = !app.sort.asc; else app.sort = { key: k, asc: false }; renderAll(); return; }
    const tr = e.target.closest('tr[data-sym]'); if (tr) openDetail(tr.dataset.sym);
  });
  $('#cards-wrap').addEventListener('click', e => { const c = e.target.closest('[data-sym]'); if (c) openDetail(c.dataset.sym); });
  $('#top').addEventListener('click', e => { const c = e.target.closest('[data-sym]'); if (c) openDetail(c.dataset.sym); });
  $('#colchooser').addEventListener('change', e => {
    const k = e.target.dataset.col; if (!k) return;
    const h = new Set(app.settings.hiddenColumns || []);
    if (e.target.checked) h.delete(k); else h.add(k);
    app.settings.hiddenColumns = [...h]; saveSettings(); renderAll();
  });
  setInterval(renderHeader, 1000);
  setInterval(() => { if (app.detail) renderDetailChart(false); }, 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !TEST_MODE && app.ready && app.settings.workerUrl) scheduleLoops(); });
}

async function boot() {
  applyTheme(); bind(); renderColChooser(); renderBanners(); renderHeader();
  if (TEST_MODE) { await startTestMode(); return; }
  determineActiveDay();
  if (app.settings.mode === 'backtest') switchTab('backtest');
  await startLive();
  if (app.connState === 'config') switchTab('settings');
}
boot().catch(e => { console.error(e); addWarning('boot', 'Startfehler: ' + e.message); });
