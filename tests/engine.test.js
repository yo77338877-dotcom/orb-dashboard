// Integrationstests: Signal-Engine, Zustandsmaschine, Journal, Backtest – mit SYNTHETISCHEN Testdaten
import test from 'node:test';
import assert from 'node:assert/strict';
import { genDay, genDaily, tradingDaysBack } from './fixtures.js';
import { analyzeSymbol, marketContext, StateTracker } from '../signal-engine.js';
import { DEFAULT_SETTINGS as S, STATES } from '../config.js';
import { MarketCalendar, dateStr } from '../market-time.js';
import { aggregate, rvolBaseline } from '../indicators.js';
import { Journal, metrics, performance, monitorPosition } from '../trade-journal.js';
import { backtestSymbol, summarize, simulateTrade } from '../backtest.js';
import { FxService } from '../fx-service.js';
import { splitSessions, dataQuality } from '../market-data.js';

const MIN = 60000;
const D = '2026-11-17';
const cal = new MarketCalendar();
const sess = cal.session(D);

function makeCtx(pattern, { market = 'long', volMult = 2.2 } = {}) {
  const hist = tradingDaysBack(D, 22).map((d, i) => {
    const s = cal.session(d);
    return { openMs: s.openMs, closeMs: s.closeMs, bars: genDay({ date: d, pattern: 'flat', seed: i + 3 }).filter(x => x.t >= s.openMs && x.t < s.closeMs) };
  });
  const idx = { SPY: genDay({ date: D, pattern: market, seed: 5, base: 600 }), QQQ: genDay({ date: D, pattern: market, seed: 6, base: 500 }) };
  return {
    ctx: { symbol: 'TEST', meta: { group: 'test' }, session: sess, bars1m: genDay({ date: D, pattern, volMult, seed: 42 }),
      hist5m: hist.slice(-3).map(h => ({ bars: aggregate(h.bars, 5, h.openMs) })), daily: genDaily(D), baseline: rvolBaseline(hist, 5), dataStatus: { ok: true, reasons: [] } },
    idx,
  };
}
function run(pattern, minute, opts = {}, ctxOpts) {
  const { ctx, idx } = makeCtx(pattern, ctxOpts);
  const at = sess.openMs + minute * MIN;
  ctx.market = marketContext(idx, sess.openMs, at);
  if (opts.data) ctx.dataStatus = opts.data;
  return analyzeSymbol(ctx, { ...S, ...(opts.s || {}) }, at, { fxRate: 1.1, fxExecutable: opts.fxExec ?? true, broker: opts.broker, risk: opts.risk });
}
const quote = (A, f = 1.0002) => ({ ask: A.plan.eur.entry * f, bid: A.plan.eur.entry * f * 0.9996, ts: sess.openMs + 25 * MIN });

test('Vor Abschluss der Opening Range kein Signal', () => { const A = run('long', 10); assert.equal(A.state, STATES.FORMING); assert.equal(A.plan, null); });
test('Vor Börsenstart: WARTE AUF BÖRSENSTART', () => assert.equal(run('long', -30).state, STATES.PRE));
test('Bestätigtes Long-Setup ohne Brokerkurs → BROKERKURS PRÜFEN', () => {
  const A = run('long', 25);
  assert.equal(A.state, STATES.CHECK_BROKER, A.explanation);
  assert.ok(A.score >= 75 && A.mandatoryOk);
  assert.match(A.explanation, /Brokerkurs noch prüfen/);
  assert.ok(Math.abs(A.plan.eur.entry - A.plan.entry / 1.1) < 1e-9);
});
test('Aktueller, passender Brokerkurs → EINSTIEG INNERHALB DER ZONE', () => {
  const A = run('long', 25, { broker: quote(run('long', 25)) });
  assert.equal(A.state, STATES.IN_ZONE, A.exec.reasons.join('; '));
});
test('Brokerkurs über maximalem Einstiegspreis → KEIN EINSTIEG', () => {
  const pre = run('long', 25);
  const A = run('long', 25, { broker: { ask: pre.plan.eur.maxEntry * 1.01, bid: pre.plan.eur.maxEntry, ts: sess.openMs + 25 * MIN } });
  assert.equal(A.state, STATES.NO_ENTRY); assert.ok(A.exec.reasons.some(r => /maximalem Einstiegspreis/.test(r)));
});
test('Zu großer Broker-Spread → KEIN EINSTIEG', () => {
  const pre = run('long', 25);
  const A = run('long', 25, { broker: { ask: pre.plan.eur.entry, bid: pre.plan.eur.entry * 0.99, ts: sess.openMs + 25 * MIN } });
  assert.equal(A.state, STATES.NO_ENTRY);
});
test('Veralteter Brokerkurs → nur Prüfhinweis', () => {
  const pre = run('long', 25);
  const A = run('long', 25, { broker: { ...quote(pre), ts: sess.openMs } });
  assert.equal(A.state, STATES.CHECK_BROKER); assert.ok(A.exec.reasons.some(r => /veraltet/.test(r)));
});
test('Ohne Live-FX keine Euro-Freigabe, technische Analyse bleibt', () => {
  const A = run('long', 25, { fxExec: false, broker: quote(run('long', 25)) });
  assert.equal(A.state, STATES.CHECK_BROKER); assert.ok(A.exec.reasons.some(r => /Wechselkurs/.test(r))); assert.ok(A.mandatoryOk);
});
test('Veraltete Marktdaten → DATEN NICHT VERFÜGBAR', () => assert.equal(run('long', 25, { data: { ok: false, reasons: ['alt'] } }).state, STATES.NO_DATA));
test('Fehlausbruch → SIGNAL INVALIDIERT', () => assert.equal(run('fake', 30).state, STATES.INVALID));
test('Warten auf Retest', () => assert.equal(run('long', 22).state, STATES.WAIT_RETEST));
test('Kurs weggelaufen → kein Einstieg in der Zone', () => assert.ok([STATES.MISSED, STATES.WATCH, STATES.NO_ENTRY].includes(run('long', 60).state)));
test('Schwaches Volumen blockiert', () => {
  const A = run('long', 25, {}, { volMult: 0.8 });
  assert.ok(A.failedMandatory.some(c => c.key === 'rvol')); assert.notEqual(A.state, STATES.CHECK_BROKER);
});
test('Bärisches Setup: bei positivem Markt blockiert, bei negativem bestätigt', () => {
  assert.notEqual(run('short', 25).state, STATES.BEAR_OK);
  const A = run('short', 25, { s: { emaFilter: false } }, { market: 'short' }); // synthetische Vortage enden über dem Niveau
  assert.equal(A.state, STATES.BEAR_OK, A.explanation); assert.match(A.explanation, /Keine Leerverkaufsempfehlung/);
});
test('Außerhalb des Einstiegszeitfensters blockiert', () => {
  const A = run('long', 25, { s: { entryWindowEnd: '09:50' } });
  assert.equal(A.checks.find(c => c.key === 'window').status, 'fail'); assert.notEqual(A.state, STATES.CHECK_BROKER);
});
test('Tagesrisikolimit erreicht → KEIN EINSTIEG (keine ausführungsbereite Anzeige)', () => {
  const A = run('long', 25, { risk: { openPositions: [], usedDailyRisk: 10000 } });
  assert.equal(A.state, STATES.NO_ENTRY); assert.ok(A.exec.reasons.some(r => /Tagesrisiko/.test(r))); assert.ok(A.mandatoryOk, 'technische Analyse bleibt');
});
test('Score: Summe der Kategorien = Gesamtscore, Maximum 100', () => {
  const A = run('long', 25);
  assert.equal(Object.values(A.scoreBreakdown).reduce((a, [p]) => a + p, 0), A.score);
  assert.equal(Object.values(A.scoreBreakdown).reduce((a, [, m]) => a + m, 0), 100);
});
test('Kein Look-ahead: spätere Kerzen ändern das Ergebnis nicht', () => {
  const { ctx, idx } = makeCtx('long');
  const at = sess.openMs + 25 * MIN;
  ctx.market = marketContext(idx, sess.openMs, at);
  const a = analyzeSymbol(ctx, S, at, { fxRate: 1.1 });
  const b = analyzeSymbol({ ...ctx, bars1m: ctx.bars1m.filter(x => x.t + MIN <= at) }, S, at, { fxRate: 1.1 });
  assert.deepEqual([a.score, a.state, a.plan.stop], [b.score, b.state, b.plan.stop]);
});
test('Kein Repainting: Stop bleibt nach Bestätigung gleich', () => {
  const a = run('long', 25), b = run('long', 30);
  assert.equal(a.plan.stop, b.plan.stop); assert.equal(a.signalTime, b.signalTime);
});
test('StateTracker: Zeitstempel, keine Duplikate', () => {
  const mem = new Map(); const st = { getItem: k => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  const t = new StateTracker(st); t.ensureDay(D);
  assert.equal(t.record('NVDA', STATES.FORMING, 1), true); assert.equal(t.record('NVDA', STATES.FORMING, 2), false);
  assert.equal(t.record('NVDA', STATES.WAIT_BREAKOUT, 3), true); assert.equal(t.history('NVDA').length, 2);
  const t2 = new StateTracker(st); t2.ensureDay(D); assert.equal(t2.history('NVDA').length, 2, 'Persistenz');
});
test('Datenqualität: alte Kerze → nicht ok; frisch → ok', () => {
  const now = sess.openMs + 60 * MIN;
  const bars = Array.from({ length: 59 }, (_, i) => ({ t: sess.openMs + i * MIN }));
  assert.equal(dataQuality({ lastBarT: now - 10 * MIN, lastPollOk: now, nowMs: now, phase: 'open', maxAgeSec: 150, sessionBars: bars, openMs: sess.openMs }).ok, false);
  assert.equal(dataQuality({ lastBarT: now - 2 * MIN, lastPollOk: now, nowMs: now, phase: 'open', maxAgeSec: 150, sessionBars: bars, openMs: sess.openMs }).ok, true);
});

test('Journal: Teilverkäufe, G/V, R, CSV/JSON, Import', () => {
  const mem = new Map(); const st = { getItem: k => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  const j = new Journal(st);
  const e = j.add({ kind: 'real', symbol: 'nvda', entry: 100, stop: 98, shares: 10, feeBuy: 1, tps: [102, 104, 106] });
  j.addExit(e.id, { price: 102, shares: 3, fee: 1 }); assert.equal(j.get(e.id).status, 'open');
  j.addExit(e.id, { price: 104, shares: 7, fee: 1 });
  const m = metrics(j.get(e.id));
  assert.equal(j.get(e.id).status, 'closed'); assert.equal(m.pnl, 31); assert.equal(m.r, 31 / 20);
  assert.match(j.toCSV(), /NVDA/);
  assert.equal(new Journal({ getItem: () => null, setItem: () => {} }).importJSON(j.toJSON()), 1);
  assert.equal(new Journal(st).entries.length, 1, 'Persistenz');
  j.remove(e.id); assert.equal(j.entries.length, 0);
});
test('Performance-Kennzahlen', () => {
  const p = performance([{ pnl: 100, r: 2, time: 1 }, { pnl: -50, r: -1, time: 2 }, { pnl: -50, r: -1, time: 3 }, { pnl: 200, r: 3, time: 4 }]);
  assert.deepEqual([p.n, p.hitRate, p.net, p.profitFactor, p.maxDD, p.expectancy], [4, 50, 200, 3, 100, 50]);
});
test('Positionsüberwachung: TP, Stop hat Vorrang, Zeit-Exit, FX-Warnung, OR-Rückkehr', () => {
  const pos = { entry: 100, stop: 98, tps: [102, 104, 106], remainingShares: 10, feeBuy: 1, fxAtOpen: 1.10 };
  assert.equal(monitorPosition(pos, { priceEUR: 102.5, nowMs: 0 }, S).state, STATES.TP1);
  assert.equal(monitorPosition(pos, { priceEUR: 97.9, nowMs: 1000 * MIN, closeMs: 1010 * MIN }, S).state, STATES.SL);
  assert.equal(monitorPosition(pos, { priceEUR: 101, nowMs: 1000 * MIN, closeMs: 1010 * MIN }, S).state, STATES.CLOSE_POS);
  assert.ok(monitorPosition(pos, { priceEUR: 101, nowMs: 0, fxRate: 1.11 }, S).alerts.some(a => a.key === 'fx'));
  assert.equal(monitorPosition(pos, { priceEUR: 99.5, nowMs: 0, closedBelowOr: true }, S).state, STATES.CLOSE_POS);
});

test('Backtest: gleiche Engine, EUR über Vortageskurs, Fehlausbrüche gezählt', () => {
  const days = tradingDaysBack('2026-11-18', 26);
  const bars = days.flatMap((d, i) => genDay({ date: d, pattern: i >= 20 ? (i % 2 ? 'long' : 'fake') : 'flat', volMult: i >= 20 ? 2.2 : 1, seed: i + 11 }));
  const sessions = splitSessions(bars, cal, t => dateStr(t));
  assert.equal(sessions.length, 26);
  const idxSessions = { SPY: new Map(), QQQ: new Map() };
  for (const d of days) { idxSessions.SPY.set(d, genDay({ date: d, pattern: 'long', seed: 5, base: 600 })); idxSessions.QQQ.set(d, genDay({ date: d, pattern: 'long', seed: 6, base: 500 })); }
  const fx = new FxService(); const hist = {}; for (const d of tradingDaysBack('2026-11-19', 40)) hist[d] = 1.1; fx.setHistory(hist);
  const { trades, stats } = backtestSymbol({ symbol: 'TEST', meta: {}, sessions, daily: genDaily('2026-11-18'), idxSessions, fx, s: S, warmup: 20 });
  assert.equal(stats.days, 6); assert.ok(stats.falseBreakouts >= 3); assert.ok(trades.length >= 1);
  for (const t of trades) { assert.ok(Number.isFinite(t.pnl)); assert.equal(t.fxRate, 1.1); }
  const sum = summarize(trades, days[23]);
  assert.equal(sum.inSample.n + sum.outSample.n, trades.length);
});
test('Backtest: Stop und Ziel in derselben Kerze → Stop (konservativ)', () => {
  const A = { signalTime: 0, plan: { entry: 100, stop: 99, maxEntry: 100.5, tpReal: [101, 102, 103], breakoutLevel: 99.5 }, scan: { tol: 0.1 } };
  const r = simulateTrade({ A, bars: [{ t: 0, o: 100, h: 100.2, l: 99.8, c: 100 }, { t: MIN, o: 100, h: 103.5, l: 98.5, c: 100 }], closeMs: 100 * MIN, s: { ...S, closeBeforeEndMin: 0, brokerSpreadPct: 0, slippagePct: 0 }, rate: 1 });
  assert.equal(r.exitReason, 'Stop Loss'); assert.ok(r.pnl < 0);
});
test('Verpasstes Signal springt nicht auf BEOBACHTEN zurück', () => {
  let seenMissed = false;
  for (let m = 25; m <= 140; m++) {
    const st = run('long', m).state;
    if (st === STATES.MISSED) seenMissed = true;
    if (seenMissed) assert.ok([STATES.MISSED, STATES.NO_ENTRY].includes(st), `Minute ${m}: ${st}`);
  }
  assert.ok(seenMissed);
});
