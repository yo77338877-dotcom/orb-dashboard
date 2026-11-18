// Zeitzonen- und Börsenkalender-Logik (America/New_York, Europe/Berlin)
// Keine fest programmierten deutschen Öffnungszeiten: alles aus New-York-Zeit + IANA-Zeitzonen.
import { FALLBACK_HOLIDAYS, FALLBACK_EARLY_CLOSES } from './config.js';

export const NY = 'America/New_York';
export const BERLIN = 'Europe/Berlin';
const MIN = 60000;

const dtfCache = new Map();
function dtf(tz) {
  if (!dtfCache.has(tz)) {
    dtfCache.set(tz, new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
    }));
  }
  return dtfCache.get(tz);
}

export function zonedParts(ms, tz) {
  const p = {};
  for (const { type, value } of dtf(tz).formatToParts(new Date(ms))) p[type] = value;
  const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday];
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second, wd };
}

export function tzOffsetMs(ms, tz) {
  const p = zonedParts(ms, tz);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

// Wanduhrzeit in einer Zeitzone → UTC-Millisekunden (DST-sicher)
export function zonedToUtc(y, m, d, h, mi, tz) {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  let ts = guess - tzOffsetMs(guess, tz);
  ts = guess - tzOffsetMs(ts, tz);
  return ts;
}

export function dateStr(ms, tz = NY) {
  const p = zonedParts(ms, tz);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

export function parseHM(hm) { const [h, m] = String(hm).split(':').map(Number); return { h, m }; }

export function nyTimeOnDate(dStr, hm) {
  const [y, m, d] = dStr.split('-').map(Number);
  const t = parseHM(hm);
  return zonedToUtc(y, m, d, t.h, t.m, NY);
}

export function addDays(dStr, n) {
  const [y, m, d] = dStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function weekday(dStr) { const [y, m, d] = dStr.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); }

export class MarketCalendar {
  constructor() { this.days = new Map(); this.source = 'Fallback-Tabelle (lokal)'; }
  loadAlpaca(list) {
    if (!Array.isArray(list) || !list.length) return;
    this.days.clear();
    for (const d of list) this.days.set(d.date, { open: d.open, close: d.close });
    this.source = 'Alpaca-Börsenkalender';
    this.rangeStart = list[0].date; this.rangeEnd = list[list.length - 1].date;
  }
  session(dStr) {
    if (this.days.size && dStr >= this.rangeStart && dStr <= this.rangeEnd) {
      const d = this.days.get(dStr);
      if (!d) return { date: dStr, isTradingDay: false, reason: weekday(dStr) % 6 === 0 ? 'Wochenende' : 'US-Börsenfeiertag' };
      return this._mk(dStr, d.open, d.close);
    }
    const wd = weekday(dStr);
    if (wd === 0 || wd === 6) return { date: dStr, isTradingDay: false, reason: 'Wochenende' };
    if (FALLBACK_HOLIDAYS.includes(dStr)) return { date: dStr, isTradingDay: false, reason: 'US-Börsenfeiertag' };
    return this._mk(dStr, '09:30', FALLBACK_EARLY_CLOSES[dStr] || '16:00');
  }
  _mk(dStr, open, close) {
    return { date: dStr, isTradingDay: true, openMs: nyTimeOnDate(dStr, open), closeMs: nyTimeOnDate(dStr, close), earlyClose: close !== '16:00', closeHM: close };
  }
  prevTradingDay(dStr) { let d = addDays(dStr, -1); for (let i = 0; i < 15; i++) { if (this.session(d).isTradingDay) return d; d = addDays(d, -1); } return null; }
  nextTradingDay(dStr) { let d = addDays(dStr, 1); for (let i = 0; i < 15; i++) { if (this.session(d).isTradingDay) return d; d = addDays(d, 1); } return null; }
}

export function marketPhase(cal, nowMs) {
  const today = dateStr(nowMs);
  const s = cal.session(today);
  if (!s.isTradingDay) {
    const next = cal.nextTradingDay(today);
    return { phase: 'closed', label: `Geschlossen (${s.reason})`, session: s, nextOpenMs: next ? cal.session(next).openMs : null };
  }
  if (nowMs < s.openMs) return { phase: 'pre', label: 'Vorbörslich', session: s, nextOpenMs: s.openMs };
  if (nowMs < s.closeMs) return { phase: 'open', label: s.earlyClose ? `Geöffnet (verkürzt bis ${s.closeHM} NY)` : 'Geöffnet', session: s };
  const next = cal.nextTradingDay(today);
  return { phase: 'post', label: 'Geschlossen (nach Börsenschluss)', session: s, nextOpenMs: next ? cal.session(next).openMs : null };
}

export function fmtTime(ms, tz, withSec = false) {
  return new Intl.DateTimeFormat('de-DE', { timeZone: tz, hour: '2-digit', minute: '2-digit', ...(withSec ? { second: '2-digit' } : {}) }).format(new Date(ms));
}
export function fmtDate(ms, tz = BERLIN) {
  return new Intl.DateTimeFormat('de-DE', { timeZone: tz, weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(ms));
}
export function fmtDateTime(ms, tz = BERLIN) {
  return new Intl.DateTimeFormat('de-DE', { timeZone: tz, day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(ms));
}
export function fmtCountdown(ms) {
  if (ms <= 0) return '00:00:00';
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  const d = Math.floor(h / 24);
  const core = `${String(h % 24).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}`;
  return d > 0 ? `${d} T ${core}` : core;
}
export const MINUTE = MIN;
