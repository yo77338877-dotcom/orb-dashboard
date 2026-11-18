// Backtesting – nutzt exakt dieselbe Signal-Engine (analyzeSymbol) wie die Live-Analyse.
// Kein Look-ahead: Bewertung zum Schluss der Bestätigungskerze nur mit bis dahin bekannten Daten.
// Ausführung: Eröffnung der Folgekerze + Spread/Slippage; Gebühren je Order; EUR über EZB-Kurs des Vortags (indikativ).
import { STATES } from './config.js';
import { analyzeSymbol, marketContext } from './signal-engine.js';
import { aggregate, rvolBaseline, sessionVwap } from './indicators.js';
import { costPct } from './risk-management.js';
import { performance } from './trade-journal.js';
import { weekday } from './market-time.js';

const MIN = 60000;
export const WEEKDAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

export const VARIANTS = [
  { id: 'base', label: 'Aktuelle Einstellungen', patch: {} },
  { id: 'orb5', label: '5-Minuten-ORB', patch: { orbMinutes: 5, entryWindowStart: '09:35' } },
  { id: 'orb15', label: '15-Minuten-ORB', patch: { orbMinutes: 15, entryWindowStart: '09:45' } },
  { id: 'orb30', label: '30-Minuten-ORB', patch: { orbMinutes: 30, entryWindowStart: '10:00' } },
  { id: 'noRetest', label: 'Breakout ohne Retest', patch: { retestRequired: false } },
  { id: 'retest', label: 'Breakout mit Retest', patch: { retestRequired: true } },
  { id: 'noVol', label: 'Ohne Volumenfilter (RVOL ≥ 0)', patch: { minRvol: 0 } },
  { id: 'noVwap', label: 'Ohne VWAP-Filter', patch: { vwapFilter: false } },
  { id: 'noEma', label: 'Ohne EMA-Filter', patch: { emaFilter: false } },
  { id: 'noMom', label: 'Ohne Momentumfilter (RSI/MACD)', patch: { rsiFilter: false, macdFilter: false } },
  { id: 'tp2', label: 'Komplettausstieg TP2', patch: { tp1Pct: 0, tp2Pct: 100, tp3Pct: 0 } },
  { id: 'tp3', label: 'Komplettausstieg TP3', patch: { tp1Pct: 0, tp2Pct: 0, tp3Pct: 100 } },
  { id: 'slMid', label: 'Stop an OR-Mitte', patch: { slMode: 'orMid' } },
];

export function backtestSymbol({ symbol, meta, sessions, daily, idxSessions, fx, s, warmup = 20, testDays = null }) {
  const trades = [], stats = { days: 0, signals: 0, bearSignals: 0, missed: 0, falseBreakouts: 0, noFx: 0, sizeZero: 0 };
  const tf = Number(s.confirmTimeframe) || 1;
  const startIdx = Math.max(warmup, testDays ? sessions.length - testDays : warmup);
  for (let d = startIdx; d < sessions.length; d++) {
    const day = sessions[d];
    const baseline = rvolBaseline(sessions.slice(d - warmup, d).map(x => ({ openMs: x.openMs, closeMs: x.closeMs, bars: x.bars })), 5);
    const hist5m = sessions.slice(Math.max(0, d - 3), d).map(x => ({ bars: aggregate(x.bars, 5, x.openMs) }));
    const idxBars = { SPY: idxSessions.SPY?.get(day.date) || [], QQQ: idxSessions.QQQ?.get(day.date) || [] };
    const base = { symbol, meta, session: { openMs: day.openMs, closeMs: day.closeMs }, bars1m: day.all, hist5m, daily, baseline,
      dataStatus: { ok: true, reasons: [] }, eventStatus: { status: 'unknown', text: 'Ereignisse im Backtest nicht berücksichtigt' } };
    stats.days++;
    const eod = analyzeSymbol({ ...base, market: marketContext(idxBars, day.openMs, day.closeMs) }, s, day.closeMs, { backtest: true });
    stats.falseBreakouts += (eod.events || []).filter(e => e.type === 'invalid').length;
    const confirms = (eod.events || []).filter(e => e.type === 'confirm');
    const rate = fx.rateBefore(day.date);
    if (!rate) { if (confirms.length) stats.noFx++; continue; }
    let busyUntil = 0;
    for (const ev of confirms) {
      const T = ev.t + tf * MIN;
      if (T <= busyUntil) continue;
      const A = analyzeSymbol({ ...base, market: marketContext(idxBars, day.openMs, T) }, s, T, { fxRate: rate, fxExecutable: true, backtest: true, risk: { openPositions: [], usedDailyRisk: 0 } });
      if (A.state === STATES.BEAR_OK) { stats.bearSignals++; continue; }
      if (![STATES.CHECK_BROKER, STATES.IN_ZONE].includes(A.state)) { if (A.state === STATES.MISSED) stats.missed++; continue; }
      stats.signals++;
      const res = simulateTrade({ A, bars: day.bars, closeMs: day.closeMs, s, rate });
      if (!res) { stats.missed++; continue; }
      if (res.sizeZero) { stats.sizeZero++; continue; }
      busyUntil = res.exitT;
      trades.push({ ...res, symbol, date: day.date, orb: Number(s.orbMinutes), time: res.entryT, weekday: WEEKDAYS[weekday(day.date)],
        entrySlot: entrySlot(res.entryT, day.openMs), rvolBucket: rvolBucket(A.rvol), score: A.score, rvol: A.rvol });
    }
  }
  return { trades, stats };
}

function entrySlot(t, openMs) { const m = Math.floor((t - openMs) / MIN / 30) * 30; const tot = 9 * 60 + 30 + m; return `${String(Math.floor(tot / 60)).padStart(2, '0')}:${String(tot % 60).padStart(2, '0')} NY`; }
function rvolBucket(r) { if (r == null) return 'unbekannt'; if (r < 1.5) return '< 1,5'; if (r < 2) return '1,5–2'; if (r < 3) return '2–3'; return '≥ 3'; }

/** Trade-Simulation, konservativ: berührt eine Kerze Stop und Ziel, gilt der Stop. */
export function simulateTrade({ A, bars, closeMs, s, rate }) {
  const p = A.plan; if (!p) return null;
  const after = bars.filter(b => b.t >= A.signalTime);
  if (!after.length) return null;
  const offset = bars.length - after.length;
  const c = costPct(s);
  const first = after[0];
  if (first.o > p.maxEntry) return null; // Kurslücke über max. Einstieg → verpasst
  const entryUSD = first.o * (1 + c);
  const eur = v => v / rate;
  const entryEUR = eur(entryUSD);
  const riskPerShareEUR = entryEUR - eur(p.stop * (1 - c));
  if (!(riskPerShareEUR > 0)) return null;
  let shares = Math.floor((s.capital * s.riskPerTradePct / 100 - s.feeBuy - s.feeSell) / riskPerShareEUR);
  shares = Math.max(0, Math.min(shares, Math.floor((s.capital - s.feeBuy) / entryEUR)));
  if (shares <= 0) return { sizeZero: true };
  const parts = [s.tp1Pct, s.tp2Pct, s.tp3Pct].map(x => x / 100);
  const qty = parts.map(x => Math.floor(shares * x));
  const lastActive = parts.map((x, i) => (x > 0 ? i : -1)).filter(i => i >= 0).pop() ?? 2;
  qty[lastActive] += shares - qty.reduce((a, b) => a + b, 0);
  let remaining = shares, stop = p.stop, fees = s.feeBuy, proceedsUSD = 0, exitT = null, reason = null;
  const hit = [false, false, false];
  const timeExit = closeMs - s.closeBeforeEndMin * MIN;
  const vw = sessionVwap(bars);
  const tol = A.scan.tol || 0;
  const sell = (q, pxUSD, t, why) => { if (q <= 0) return; proceedsUSD += q * pxUSD * (1 - c); remaining -= q; fees += s.feeSell; exitT = t; reason = why; };
  for (let j = 0; j < after.length; j++) {
    const b = after[j];
    if (b.t + MIN > timeExit) { sell(remaining, b.o, b.t, 'Zeit-Exit vor Börsenschluss'); break; }
    if (b.l <= stop) { sell(remaining, Math.min(stop, b.o), b.t + MIN, stop >= p.entry ? 'Break-even-Stop' : 'Stop Loss'); break; }
    for (let k = 0; k < 3; k++) {
      if (!hit[k] && b.h >= p.tpReal[k]) {
        hit[k] = true;
        if (qty[k] > 0) sell(qty[k], p.tpReal[k], b.t + MIN, `TP${k + 1}`);
        if (k === 0 && s.breakEvenAfterTp1 && qty[0] > 0) stop = Math.max(stop, p.entry);
      }
    }
    if (remaining <= 0) break;
    if (s.exitOnOrReentry && b.c < p.breakoutLevel - tol) { sell(remaining, b.c, b.t + MIN, 'Rückkehr in die Opening Range'); break; }
    if (s.exitOnVwapLoss && vw[offset + j] != null && b.c < vw[offset + j]) { sell(remaining, b.c, b.t + MIN, 'VWAP-Verlust'); break; }
  }
  if (remaining > 0) { const lb = after[after.length - 1]; sell(remaining, lb.c, lb.t + MIN, 'Sitzungsende'); }
  const pnlEUR = eur(proceedsUSD) - entryEUR * shares - fees;
  const riskEUR = riskPerShareEUR * shares + s.feeBuy + s.feeSell;
  return {
    entryT: first.t, exitT, entryUSD, entryEUR, stopEUR: eur(p.stop), shares, pnl: pnlEUR, r: pnlEUR / riskEUR,
    holdMin: Math.round((exitT - first.t) / MIN), exitReason: reason, fxRate: rate, indicative: true,
  };
}

export function summarize(trades, splitDate) {
  const inS = trades.filter(t => t.date < splitDate), outS = trades.filter(t => t.date >= splitDate);
  const groupBy = key => {
    const m = {};
    for (const t of trades) (m[t[key]] || (m[t[key]] = [])).push(t);
    return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, performance(v)]));
  };
  return {
    all: performance(trades), inSample: performance(inS), outSample: performance(outS), splitDate,
    bySymbol: groupBy('symbol'), byWeekday: groupBy('weekday'), bySlot: groupBy('entrySlot'), byRvol: groupBy('rvolBucket'), byExit: groupBy('exitReason'),
  };
}
