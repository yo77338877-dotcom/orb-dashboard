// Trading-Journal, manuelle Positionen und Positionsüberwachung
// Echte Trades ("real") und Paper-Trades ("paper") werden strikt getrennt. Backtests werden nie ins Journal geschrieben.
import { STATES } from './config.js';

const KEY = 'orb.journal.v2';

export class Journal {
  constructor(storage) { this.storage = storage; this.entries = []; this.load(); }
  load() { try { this.entries = JSON.parse(this.storage?.getItem(KEY) || '[]').map(normalizeEntry); } catch { this.entries = []; } }
  save() { try { this.storage?.setItem(KEY, JSON.stringify(this.entries)); } catch (e) { console.warn('Journal nicht gespeichert', e); } }
  add(e) {
    const entry = normalizeEntry({ ...e, id: e.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}` });
    this.entries.push(entry); this.save(); return entry;
  }
  update(id, patch) { const i = this.entries.findIndex(x => x.id === id); if (i < 0) return null; this.entries[i] = normalizeEntry({ ...this.entries[i], ...patch }); this.save(); return this.entries[i]; }
  remove(id) { this.entries = this.entries.filter(x => x.id !== id); this.save(); }
  get(id) { return this.entries.find(x => x.id === id); }
  open(kind) { return this.entries.filter(e => e.status === 'open' && (!kind || e.kind === kind)); }
  closed(kind) { return this.entries.filter(e => e.status === 'closed' && (!kind || e.kind === kind)); }
  addExit(id, ex) {
    const e = this.get(id); if (!e) return null;
    const qty = Math.min(ex.shares, e.remainingShares);
    if (!(qty > 0)) return e;
    return this.update(id, { exits: [...e.exits, { price: ex.price, shares: qty, time: ex.time || Date.now(), reason: ex.reason || 'Manuell', fee: ex.fee ?? 0 }] });
  }
  toCSV(kind) {
    const cols = ['Datum', 'Art', 'Aktie', 'ORB', 'Signalzeit', 'Score', 'RVOL', 'Geplanter Einstieg', 'Tatsächlicher Einstieg', 'Stop Loss', 'TP1', 'TP2', 'TP3', 'Stück', 'Positionsgröße €', 'Ø Ausstieg', 'Haltedauer Min', 'G/V €', 'G/V %', 'R', 'Gebühren €', 'Status', 'Notizen'];
    const rows = this.entries.filter(e => !kind || e.kind === kind).map(e => {
      const m = metrics(e);
      const tps = [0, 1, 2].map(i => e.tps?.[i] ?? '');
      return [e.date, e.kind, e.symbol, e.orb, e.signalTime ? new Date(e.signalTime).toISOString() : '', e.score ?? '', e.rvol ?? '', e.plannedEntry ?? '', e.entry, e.stop ?? '', ...tps, e.shares,
        m.positionSize, m.avgExit ?? '', m.holdMin ?? '', m.pnl, m.pnlPct, m.r ?? '', m.fees, e.status, (e.notes || '').replace(/[\r\n;]+/g, ' ')];
    });
    const fmt = v => (typeof v === 'number' ? String(Math.round(v * 10000) / 10000).replace('.', ',') : String(v ?? ''));
    return [cols.join(';'), ...rows.map(r => r.map(fmt).join(';'))].join('\r\n');
  }
  toJSON() { return JSON.stringify({ app: 'orb-dashboard', version: 2, exported: new Date().toISOString(), entries: this.entries }, null, 2); }
  importJSON(text, replace = false) {
    const d = JSON.parse(text);
    const list = Array.isArray(d) ? d : d.entries;
    if (!Array.isArray(list)) throw new Error('Ungültiges Backup-Format');
    const clean = list.map(normalizeEntry).filter(e => e.id && e.symbol && Number.isFinite(e.entry) && e.shares > 0);
    if (replace) this.entries = clean;
    else { const ids = new Set(this.entries.map(e => e.id)); for (const e of clean) if (!ids.has(e.id)) this.entries.push(e); }
    this.save(); return clean.length;
  }
}

export function normalizeEntry(e) {
  const exits = (e.exits || []).map(x => ({ price: +x.price, shares: +x.shares, time: +x.time || Date.now(), reason: x.reason || 'Manuell', fee: +x.fee || 0 }));
  const sold = exits.reduce((a, x) => a + x.shares, 0);
  const shares = +e.shares || 0;
  const remaining = Math.max(0, shares - sold);
  const stop = e.stop != null && e.stop !== '' && Number.isFinite(+e.stop) ? +e.stop : null;
  return {
    id: e.id, kind: e.kind === 'paper' ? 'paper' : 'real', symbol: String(e.symbol || '').toUpperCase(), group: e.group || null,
    date: e.date || new Date().toISOString().slice(0, 10), orb: +e.orb || 15, signalTime: e.signalTime || null, score: e.score ?? null, rvol: e.rvol ?? null,
    plannedEntry: e.plannedEntry ?? null, entry: +e.entry, stop, initialStop: e.initialStop ?? stop,
    tps: (e.tps || []).map(v => (v === '' || v == null || !Number.isFinite(+v) ? null : +v)), shares, remainingShares: remaining, buyTime: +e.buyTime || Date.now(), feeBuy: +e.feeBuy || 0,
    exits, status: shares > 0 && remaining === 0 ? 'closed' : 'open', notes: e.notes || '', fxAtOpen: e.fxAtOpen ?? null,
  };
}

export function metrics(e) {
  const sold = e.exits.reduce((a, x) => a + x.shares, 0);
  const proceeds = e.exits.reduce((a, x) => a + x.price * x.shares, 0);
  const fees = e.feeBuy + e.exits.reduce((a, x) => a + x.fee, 0);
  const cost = e.entry * sold;
  const pnl = proceeds - cost - fees;
  const risk = e.initialStop ? (e.entry - e.initialStop) * e.shares : null;
  const lastExit = e.exits.length ? Math.max(...e.exits.map(x => x.time)) : null;
  return {
    positionSize: e.entry * e.shares, avgExit: sold ? proceeds / sold : null, pnl, pnlPct: cost ? pnl / cost * 100 : 0, fees,
    r: risk && risk > 0 ? pnl / risk : null, holdMin: lastExit ? Math.round((lastExit - e.buyTime) / 60000) : null,
  };
}

/** Performance-Kennzahlen (Journal und Backtest identisch). trades: [{ pnl, r, symbol, orb, time, holdMin }] */
export function performance(trades) {
  const n = trades.length;
  const wins = trades.filter(t => t.pnl > 0), losses = trades.filter(t => t.pnl <= 0);
  const gw = wins.reduce((a, t) => a + t.pnl, 0), gl = -losses.reduce((a, t) => a + t.pnl, 0);
  let eq = 0, peak = 0, dd = 0;
  for (const t of [...trades].sort((a, b) => a.time - b.time)) { eq += t.pnl; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
  const by = key => {
    const m = {};
    for (const t of trades) { const k = t[key]; if (!m[k]) m[k] = { n: 0, pnl: 0, wins: 0, rSum: 0, rN: 0 }; m[k].n++; m[k].pnl += t.pnl; if (t.pnl > 0) m[k].wins++; if (t.r != null) { m[k].rSum += t.r; m[k].rN++; } }
    return m;
  };
  const rs = trades.filter(t => t.r != null);
  return {
    n, wins: wins.length, losses: losses.length, hitRate: n ? wins.length / n * 100 : null,
    avgWin: wins.length ? gw / wins.length : null, avgLoss: losses.length ? -gl / losses.length : null,
    net: gw - gl, profitFactor: gl > 0 ? gw / gl : (gw > 0 ? Infinity : null), expectancy: n ? (gw - gl) / n : null,
    maxDD: dd, avgR: rs.length ? rs.reduce((a, t) => a + t.r, 0) / rs.length : null,
    avgHold: n ? trades.reduce((a, t) => a + (t.holdMin || 0), 0) / n : null,
    bySymbol: by('symbol'), byOrb: by('orb'),
  };
}

/** Überwachung einer manuell erfassten Position (Referenzkurs in EUR). Führt niemals Orders aus. */
export function monitorPosition(pos, ref, s) {
  const out = { state: STATES.POS_OPEN, alerts: [], suggestedStop: pos.stop, pnlEUR: null };
  if (ref.priceEUR == null) { out.alerts.push({ key: 'nodata', text: 'Kein aktueller Referenzkurs – Überwachung eingeschränkt' }); return out; }
  out.pnlEUR = (ref.priceEUR - pos.entry) * pos.remainingShares - pos.feeBuy;
  const tps = pos.tps || [];
  let reached = 0;
  tps.forEach((tp, i) => { if (tp != null && ref.priceEUR >= tp) reached = i + 1; });
  if (reached) { out.state = [STATES.TP1, STATES.TP2, STATES.TP3][reached - 1]; out.alerts.push({ key: 'tp' + reached, text: `Referenzkurs hat TP${reached} (${tps[reached - 1].toFixed(2).replace('.', ',')} €) erreicht – Teilverkauf gemäß Plan prüfen` }); }
  if (reached >= 1 && s.breakEvenAfterTp1 && pos.stop != null && pos.stop < pos.entry) {
    out.suggestedStop = pos.entry; out.alerts.push({ key: 'be', text: 'Break-even-Stop: Stop auf Einstiegskurs nachziehen' });
  }
  if (reached >= 2 && s.trailingStop && ref.atrEUR) {
    const trail = ref.priceEUR - ref.atrEUR * s.trailingAtr;
    if (trail > (out.suggestedStop ?? -Infinity)) { out.suggestedStop = trail; out.alerts.push({ key: 'trail', text: `Trailing Stop: ${trail.toFixed(2).replace('.', ',')} €` }); }
  }
  if (s.exitOnOrReentry && ref.closedBelowOr) { out.state = STATES.CLOSE_POS; out.alerts.push({ key: 'orre', text: 'Rückkehr in die Opening Range – Exit-Signal' }); }
  if (s.exitOnVwapLoss && ref.vwapEUR != null && ref.priceEUR < ref.vwapEUR) { out.state = STATES.CLOSE_POS; out.alerts.push({ key: 'vwap', text: 'VWAP verloren – Exit-Signal' }); }
  if (ref.analysisInvalid) { out.state = STATES.CLOSE_POS; out.alerts.push({ key: 'inv', text: 'Setup invalidiert – Exit prüfen' }); }
  if (ref.closeMs && ref.nowMs >= ref.closeMs - s.closeBeforeEndMin * 60000 && ref.nowMs < ref.closeMs) {
    out.state = STATES.CLOSE_POS; out.alerts.push({ key: 'time', text: `Zeitbasierter Exit: ${s.closeBeforeEndMin} Min vor US-Börsenschluss` });
  }
  if (pos.stop != null && ref.priceEUR <= pos.stop) { out.state = STATES.SL; out.alerts.push({ key: 'sl', text: 'Referenzkurs auf/unter Stop-Loss – Ausführung beim Broker prüfen (kein garantierter Ausführungspreis)' }); }
  if (pos.fxAtOpen && ref.fxRate && Math.abs(ref.fxRate / pos.fxAtOpen - 1) > 0.003) {
    out.alerts.push({ key: 'fx', text: `EUR/USD seit Eröffnung um ${((ref.fxRate / pos.fxAtOpen - 1) * 100).toFixed(2).replace('.', ',')} % verändert – Stop-/TP-Orders in EUR prüfen` });
  }
  return out;
}
