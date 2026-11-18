// FX-Service: zentraler EUR/USD-Kurs, Euro-Umrechnung und deutsche Zahlenformate
// Formel: Kurs EUR = Kurs USD / (EUR/USD). Intern volle Präzision, Rundung nur bei Anzeige.

const nfEUR = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nfUSD = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nfCache = new Map();
const nf = d => { if (!nfCache.has(d)) nfCache.set(d, new Intl.NumberFormat('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d })); return nfCache.get(d); };
const MINUS = '\u2212';

export function usdToEur(usd, eurUsd) {
  if (usd == null || !Number.isFinite(usd) || !eurUsd || !Number.isFinite(eurUsd) || eurUsd <= 0) return null;
  return usd / eurUsd;
}
export function eurToUsd(eur, eurUsd) { return eur == null || !eurUsd ? null : eur * eurUsd; }
export function fmtEUR(v) { return v == null || !Number.isFinite(v) ? '–' : nfEUR.format(v).replace('-', MINUS); }
export function fmtUSD(v) { return v == null || !Number.isFinite(v) ? '–' : nfUSD.format(v).replace('-', MINUS); }
export function fmtNum(v, d = 2) { return v == null || !Number.isFinite(v) ? '–' : nf(d).format(v).replace('-', MINUS); }
export function fmtPct(v, d = 2, sign = true) {
  if (v == null || !Number.isFinite(v)) return '–';
  const s = fmtNum(Math.abs(v), d) + ' %';
  if (!sign) return (v < 0 ? MINUS : '') + s;
  return (v > 0 ? '+' : v < 0 ? MINUS : '±') + s;
}
export function fmtSignedEUR(v) {
  if (v == null || !Number.isFinite(v)) return '–';
  return (v > 0 ? '+' : v < 0 ? MINUS : '') + nfEUR.format(Math.abs(v));
}

export class FxService {
  constructor() {
    this.rate = null; this.source = null; this.live = false; this.ts = null; this.fetchedAt = null; this.error = null;
    this.history = new Map();
  }
  update(payload, nowMs = Date.now()) {
    if (!payload || !Number.isFinite(payload.rate) || payload.rate < 0.5 || payload.rate > 2.5) {
      this.error = 'Unplausibler oder fehlender Wechselkurs'; return false;
    }
    this.rate = payload.rate; this.source = payload.source; this.live = !!payload.live;
    this.ts = payload.ts || nowMs; this.fetchedAt = nowMs; this.error = null;
    return true;
  }
  ageSec(nowMs = Date.now()) { return this.ts ? Math.max(0, (nowMs - this.ts) / 1000) : Infinity; }
  executable(maxAgeSec, nowMs = Date.now()) { return !!this.rate && this.live && this.ageSec(nowMs) <= maxAgeSec; }
  sourceLabel() {
    if (!this.source) return 'Keine FX-Daten';
    return { twelvedata: 'Twelve Data (live)', frankfurter: 'Frankfurter/EZB (Tagesreferenz)', test: 'TESTDATEN' }[this.source] || this.source;
  }
  toEUR(usd) { return usdToEur(usd, this.rate); }
  setHistory(obj) { for (const [d, v] of Object.entries(obj || {})) if (Number.isFinite(v)) this.history.set(d, v); }
  /** EZB-Referenz des letzten Bankarbeitstags VOR dem Datum (kein Look-ahead) */
  rateBefore(dStr) {
    let best = null;
    for (const [d, v] of this.history) if (d < dStr && (!best || d > best[0])) best = [d, v];
    return best ? best[1] : null;
  }
}
