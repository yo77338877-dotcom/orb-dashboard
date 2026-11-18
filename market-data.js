// Marktdaten-Client: spricht ausschließlich mit dem eigenen Cloudflare Worker (keine Schlüssel im Browser)
// Datenfeed: Alpaca IEX (kostenlos). IEX und SIP werden nie vermischt – alle Abfragen mit feed=iex.

export const FEED = 'iex';

export function normalizeBars(arr) {
  return (arr || []).map(b => ({ t: Date.parse(b.t), o: +b.o, h: +b.h, l: +b.l, c: +b.c, v: +b.v, vw: b.vw != null ? +b.vw : null, n: b.n }))
    .filter(b => Number.isFinite(b.t) && Number.isFinite(b.c));
}

// Request-Budget: Alpaca Basic 200 Calls/Min, Worker-Limit 90/Min je IP → Client bleibt bei max. 75/Min.
export class RequestBudget {
  constructor(limitPerMin = 75) { this.limit = limitPerMin; this.calls = []; }
  note(now = Date.now()) { this.calls.push(now); this.trim(now); }
  trim(now = Date.now()) { const c = now - 60000; while (this.calls.length && this.calls[0] <= c) this.calls.shift(); }
  perMin() { this.trim(); return this.calls.length; }
  upstreamPerMin() { return this.perMin(); }
  canSpend(n = 1) { return this.perMin() + n <= this.limit; }
  waitMs() { this.trim(); return this.calls.length ? Math.max(500, this.calls[0] + 60000 - Date.now() + 50) : 0; }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

export class WorkerClient {
  constructor(getUrl, getToken, budget) { this.getUrl = getUrl; this.getToken = getToken; this.budget = budget || new RequestBudget(); this.lastError = null; this.lastOk = null; }
  async req(path, params = {}, timeoutMs = 25000) {
    const base = (this.getUrl() || '').replace(/\/+$/, '');
    if (!base) throw new Error('Keine Worker-URL konfiguriert');
    while (!this.budget.canSpend(1)) await sleep(this.budget.waitMs()); // Drosselung vor Limit-Überschreitung
    const u = new URL(base + path);
    for (const [k, v] of Object.entries(params)) if (v != null && v !== '') u.searchParams.set(k, v);
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      this.budget.note();
      const res = await fetch(u.toString(), { headers: { 'X-ORB-Token': this.getToken() || '' }, signal: ctl.signal, cache: 'no-store' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      this.lastOk = Date.now(); this.lastError = null;
      return body;
    } catch (e) {
      this.lastError = e.name === 'AbortError' ? 'Zeitüberschreitung' : (e.message === 'Failed to fetch' ? 'Worker nicht erreichbar (URL/CORS/ALLOWED_ORIGINS prüfen)' : e.message);
      throw new Error(this.lastError);
    } finally { clearTimeout(to); }
  }
  health() { return this.req('/api/health'); }
  calendar(start, end) { return this.req('/api/calendar', { start, end }); }
  live(symbols, since) { return this.req('/api/live', { symbols: symbols.join(','), since }); }
  fx() { return this.req('/api/fx'); }
  fxHistory(start, end) { return this.req('/api/fx/history', { start, end }); }
  events(from, to, symbols) { return this.req('/api/events', { from, to, symbols: symbols.join(',') }); }
  // Historische Kerzen, folgt next_page_token (1 Seite je Worker-Aufruf)
  async bars(symbols, timeframe, start, end, onProgress) {
    const out = {};
    let token = null, guard = 0;
    do {
      const body = await this.req('/api/bars', { symbols: symbols.join(','), timeframe, start, end, page_token: token }, 60000);
      for (const [sym, arr] of Object.entries(body.bars || {})) (out[sym] || (out[sym] = [])).push(...normalizeBars(arr));
      token = body.next_page_token || null;
      if (onProgress) onProgress(Object.values(out).reduce((a, b) => a + b.length, 0));
    } while (token && ++guard < 300);
    for (const k of Object.keys(out)) out[k] = dedupe(out[k]);
    return out;
  }
}

export function dedupe(bars) {
  const m = new Map();
  for (const b of bars) m.set(b.t, b);
  return [...m.values()].sort((a, b) => a.t - b.t);
}

// ---------- IndexedDB-Cache (historische Daten) ----------
const DB = 'orb-dashboard', STORE = 'cache';
let dbp = null;
function idb() {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  if (!dbp) dbp = new Promise(res => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => res(null);
  });
  return dbp;
}
const mem = new Map();
export async function cacheGet(key) {
  const db = await idb();
  if (!db) return mem.get(key) ?? null;
  return new Promise(res => { const tx = db.transaction(STORE).objectStore(STORE).get(key); tx.onsuccess = () => res(tx.result ?? null); tx.onerror = () => res(null); });
}
export async function cacheSet(key, val) {
  const db = await idb();
  if (!db) { mem.set(key, val); return; }
  return new Promise(res => { try { const tx = db.transaction(STORE, 'readwrite'); tx.objectStore(STORE).put(val, key); tx.oncomplete = () => res(); tx.onerror = () => res(); } catch { res(); } });
}
export async function cacheClear() {
  const db = await idb();
  if (!db) { mem.clear(); return; }
  return new Promise(res => { const tx = db.transaction(STORE, 'readwrite'); tx.objectStore(STORE).clear(); tx.oncomplete = () => res(); tx.onerror = () => res(); });
}

/** Teilt Kerzen in Sitzungen (reguläre Handelszeit in .bars, alles inkl. Pre-Market in .all) */
export function splitSessions(bars, cal, dateOf) {
  const byDay = new Map();
  for (const b of bars) { const d = dateOf(b.t); if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push(b); }
  const sessions = [];
  for (const [d, arr] of byDay) {
    const s = cal.session(d);
    if (!s.isTradingDay) continue;
    const reg = arr.filter(b => b.t >= s.openMs && b.t < s.closeMs);
    if (reg.length) sessions.push({ date: d, openMs: s.openMs, closeMs: s.closeMs, bars: reg, all: arr });
  }
  return sessions.sort((a, b) => a.openMs - b.openMs);
}

/** Datenqualität eines Symbols während der Sitzung */
export function dataQuality({ lastBarT, lastPollOk, pollError, nowMs, phase, maxAgeSec, sessionBars, openMs }) {
  const reasons = [];
  const ageSec = lastBarT ? (nowMs - (lastBarT + 60000)) / 1000 : Infinity;
  if (pollError) reasons.push('API-Fehler: ' + pollError);
  if (!lastPollOk || nowMs - lastPollOk > maxAgeSec * 1000) reasons.push('Keine aktuelle Verbindung zum Worker');
  let coverage = null;
  if (phase === 'open') {
    if (ageSec > maxAgeSec) reasons.push(`Letzte Kerze ${Number.isFinite(ageSec) ? Math.round(ageSec) + ' s' : '–'} alt`);
    const from = Math.max(openMs, nowMs - 15 * 60000);
    const expected = Math.floor((nowMs - from) / 60000) - 1;
    if (expected >= 3) {
      const have = (sessionBars || []).filter(b => b.t >= from).length;
      coverage = Math.min(1, have / expected);
      if (coverage < 0.6) reasons.push(`Nur ${Math.round(coverage * 100)} % der Kerzen der letzten 15 Min vorhanden`);
    }
  }
  return { ok: reasons.length === 0, reasons, ageSec, coverage, label: phase === 'open' ? `Alter ${Number.isFinite(ageSec) ? Math.round(ageSec) + ' s' : '–'}` : 'Markt nicht geöffnet' };
}
