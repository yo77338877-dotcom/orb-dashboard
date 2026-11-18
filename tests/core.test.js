// Automatisierte Tests – Ausführung: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { ema, rsi, macd, atr, sessionVwap, aggregate, swings, rvolBaseline, sessionRvol, sma } from '../indicators.js';
import { MarketCalendar, nyTimeOnDate, marketPhase, zonedParts, BERLIN, NY, dateStr } from '../market-time.js';
import { computeOpeningRange, scanOrb, breakoutBuffer, assessOpeningRange } from '../orb-engine.js';
import { buildPlanUSD, netCrv, sizePosition, usedDailyRisk } from '../risk-management.js';
import { usdToEur, fmtEUR, fmtPct, FxService } from '../fx-service.js';
import { DEFAULT_SETTINGS as S, STATES, stateColor } from '../config.js';
import { RequestBudget } from '../market-data.js';

const MIN = 60000;
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);
const bar = (t, o, h, l, c, v = 1000) => ({ t, o, h, l, c, v });

test('SMA/EMA', () => {
  assert.equal(ema(Array(30).fill(10), 9)[29], 10);
  const x = [1, 2, 3, 4, 5, 6], e = ema(x, 3);
  near(e[2], 2); near(e[3], 3); near(e[5], 6 * 0.5 + e[4] * 0.5);
  assert.equal(sma(x, 3)[2], 2);
});
test('RSI: nur steigend → 100, nur fallend → 0', () => {
  assert.equal(rsi(Array.from({ length: 30 }, (_, i) => 100 + i), 14)[29], 100);
  near(rsi(Array.from({ length: 30 }, (_, i) => 100 - i), 14)[29], 0);
});
test('MACD: Linie = EMA12 − EMA26, Histogramm = Linie − Signal', () => {
  const c = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 5) * 3);
  const m = macd(c), e12 = ema(c, 12), e26 = ema(c, 26);
  near(m.line[59], e12[59] - e26[59]); near(m.hist[59], m.line[59] - m.signal[59]);
  assert.equal(m.signal[32], null); assert.notEqual(m.signal[33], null);
});
test('ATR: konstante Spanne 2 → 2', () => near(atr(Array.from({ length: 20 }, (_, i) => bar(i * MIN, 100, 101, 99, 100)), 14)[19], 2));
test('VWAP volumengewichtet mit Bar-VWAP', () => {
  near(sessionVwap([{ ...bar(0, 10, 10, 10, 10, 100), vw: 10 }, { ...bar(MIN, 20, 20, 20, 20, 300), vw: 20 }])[1], 17.5);
});
test('Aggregation 1 → 5 Min an Börsenöffnung verankert', () => {
  const open = 1_000_000 * MIN;
  const a = aggregate(Array.from({ length: 10 }, (_, i) => bar(open + i * MIN, 100 + i, 101 + i, 99 + i, 100.5 + i, 10)), 5, open);
  assert.equal(a.length, 2); assert.deepEqual([a[0].o, a[0].h, a[0].l, a[0].c, a[0].v], [100, 105, 99, 104.5, 50]);
});
test('Swings erst nach Bestätigungskerzen bekannt', () => {
  const sw = swings([1, 2, 5, 2, 1].map((p, i) => bar(i * MIN, p, p, p, p)), 2, 2);
  assert.equal(sw.length, 1); assert.equal(sw[0].knownAt, 4 * MIN);
});
test('RVOL: doppeltes Volumen → 2; zu wenig Historie → unbekannt', () => {
  const day = k => ({ openMs: 0, closeMs: 390 * MIN, bars: Array.from({ length: 30 }, (_, i) => bar(i * MIN, 1, 1, 1, 1, 100 * k)) });
  near(sessionRvol(rvolBaseline([day(1), day(1), day(1), day(1), day(1)], 5), day(2).bars, 0, 20 * MIN), 2);
  assert.equal(sessionRvol(rvolBaseline([day(1)], 5), day(2).bars, 0, 20 * MIN), null);
});

test('Sommer-/Winterzeit: 09:30 NY in deutscher Zeit', () => {
  const p = d => zonedParts(nyTimeOnDate(d, '09:30'), BERLIN).h;
  assert.equal(p('2026-01-15'), 15); assert.equal(p('2026-03-16'), 14); assert.equal(p('2026-04-15'), 15); assert.equal(p('2026-10-28'), 14);
  assert.equal(zonedParts(nyTimeOnDate('2026-07-01', '09:30'), NY).h, 9);
});
test('Feiertage, Wochenenden, verkürzte Tage', () => {
  const cal = new MarketCalendar();
  assert.equal(cal.session('2026-11-26').isTradingDay, false);
  assert.equal(cal.session('2026-11-28').isTradingDay, false);
  const f = cal.session('2026-11-27');
  assert.equal(f.earlyClose, true); assert.equal(zonedParts(f.closeMs, NY).h, 13);
  assert.equal(cal.prevTradingDay('2026-11-27'), '2026-11-25');
});
test('Alpaca-Kalender ersetzt Fallback', () => {
  const cal = new MarketCalendar();
  cal.loadAlpaca([{ date: '2026-12-01', open: '09:30', close: '16:00' }, { date: '2026-12-03', open: '09:30', close: '13:00' }]);
  assert.equal(cal.session('2026-12-02').isTradingDay, false); assert.equal(cal.session('2026-12-03').earlyClose, true);
});
test('Marktphase', () => {
  const cal = new MarketCalendar(), s = cal.session('2026-11-17');
  assert.equal(marketPhase(cal, s.openMs - MIN).phase, 'pre'); assert.equal(marketPhase(cal, s.openMs + MIN).phase, 'open'); assert.equal(marketPhase(cal, s.closeMs + MIN).phase, 'post');
  assert.equal(marketPhase(cal, nyTimeOnDate('2026-11-28', '10:00')).phase, 'closed');
});

function orFixture() {
  const open = nyTimeOnDate('2026-11-17', '09:30');
  return { open, b: Array.from({ length: 15 }, (_, i) => bar(open + i * MIN, 100, i === 3 ? 101 : 100.6, i === 9 ? 99 : 99.5, 100)) };
}
test('Opening Range erst nach Abschluss fixiert; Kennzahlen korrekt', () => {
  const { open, b } = orFixture();
  assert.equal(computeOpeningRange(b, open, 15, open + 10 * MIN, { atr5: 1 }).complete, false);
  const or = computeOpeningRange(b, open, 15, open + 15 * MIN, { atr5: 1 });
  assert.deepEqual([or.complete, or.high, or.low, or.mid, or.width], [true, 101, 99, 100, 2]); near(or.widthAtr, 2);
  const or5 = computeOpeningRange(b, open, 5, open + 15 * MIN, {});
  assert.equal(or5.high, 101); assert.equal(or5.low, 99.5);
});
test('Fehlende Kerzen → Opening Range unvollständig (keine Interpolation)', () => {
  const { open, b } = orFixture();
  const or = computeOpeningRange(b.filter((_, i) => i % 2 === 0), open, 15, open + 20 * MIN, { minBarCoverage: 0.8 });
  assert.equal(or.complete, false); assert.match(or.issues[0], /unvollständig/);
});
test('OR ohne ATR ist nicht bewertbar (fail closed)', () => {
  const { open, b } = orFixture();
  assert.equal(assessOpeningRange(computeOpeningRange(b, open, 15, open + 15 * MIN, {}), S).ok, false);
});
test('Breakout-Puffer = max(% vom Kurs, ATR-Anteil)', () => {
  near(breakoutBuffer(100, 1, { bufferPct: 0.05, bufferAtr: 0.1 }), 0.1); near(breakoutBuffer(1000, 1, { bufferPct: 0.05, bufferAtr: 0.1 }), 0.5);
});
const P = { ...S, maxRetestBars: 10 };
const or0 = { high: 101, low: 99, mid: 100, width: 2 };
test('Docht über OR-High ohne Kerzenschluss ist kein Breakout', () => assert.equal(scanOrb([bar(0, 100.8, 101.6, 100.7, 100.95)], or0, 1, P).setup, null));
test('Breakout → Retest → Bestätigung', () => {
  const r = scanOrb([bar(0, 100.9, 101.4, 100.9, 101.3), bar(MIN, 101.3, 101.35, 101.05, 101.1), bar(2 * MIN, 101.1, 101.15, 101.02, 101.08), bar(3 * MIN, 101.1, 101.5, 101.08, 101.45)], or0, 1, P);
  assert.equal(r.setup.state, 'CONFIRMED'); assert.deepEqual(r.events.map(e => e.type), ['breakout', 'retest', 'confirm']); assert.equal(r.setup.confirm.price, 101.45);
});
test('Fehlausbruch invalidiert; kein zweites Long-Signal am selben Tag', () => {
  const r = scanOrb([bar(0, 100.9, 101.4, 100.9, 101.3), bar(MIN, 101.3, 101.3, 100.5, 100.6), bar(2 * MIN, 100.6, 101.6, 100.6, 101.5)], or0, 1, P);
  assert.equal(r.setup.state, 'INVALID'); assert.match(r.setup.invalidation.reason, /Bull Trap/);
  assert.equal(r.events.filter(e => e.type === 'breakout').length, 1);
});
test('Verspäteter Retest → Timeout', () => {
  const bars = [bar(0, 100.9, 101.4, 100.9, 101.3)];
  for (let i = 1; i <= 12; i++) bars.push(bar(i * MIN, 101.5 + i * 0.1, 101.7 + i * 0.1, 101.45 + i * 0.1, 101.6 + i * 0.1));
  assert.equal(scanOrb(bars, or0, 1, P).setup.state, 'TIMEOUT');
});
test('Ohne Retest-Pflicht sofort bestätigt', () => assert.equal(scanOrb([bar(0, 100.9, 101.4, 100.9, 101.3)], or0, 1, { ...P, retestRequired: false }).setup.state, 'CONFIRMED'));
test('Bärischer Breakout gespiegelt', () => {
  const r = scanOrb([bar(0, 99.1, 99.1, 98.6, 98.7), bar(MIN, 98.7, 98.95, 98.7, 98.9), bar(2 * MIN, 98.9, 98.92, 98.5, 98.55)], or0, 1, P);
  assert.equal(r.setup.dir, 'short'); assert.equal(r.setup.state, 'CONFIRMED');
});

test('Stop hinter Invalidierungsniveau, TP = 1R/2R/3R, Widerstand begrenzt Ziel', () => {
  const setup = { dir: 'long', level: 101, retest: { extreme: 101.02 }, extreme: 100.9, confirm: { price: 101.45 } };
  const plan = buildPlanUSD({ dir: 'long', setup, or: or0, atr: 1, resistances: [102.2] }, S);
  near(plan.stop, 101 - 0.15 - 0.1); near(plan.R, 101.45 - plan.stop); near(plan.tps[1], 101.45 + 2 * plan.R);
  assert.ok(plan.capped[1] && plan.tpReal[1] < 102.2);
});
test('Netto-CRV < Brutto-CRV durch Kosten', () => {
  const r = netCrv({ entry: 100, stop: 98, target: 104, n: 10, feeBuy: 1, feeSell: 1, cPct: 0.0005 });
  assert.ok(r.crv < 2 && r.crv > 1.5);
  near(netCrv({ entry: 100, stop: 98, target: 104, n: 10, feeBuy: 0, feeSell: 0, cPct: 0 }).crv, 2);
});
test('Positionsgröße durch Risiko bzw. Kapital begrenzt', () => {
  const s = { ...S, capital: 10000, riskPerTradePct: 0.5, feeBuy: 1, feeSell: 1, brokerSpreadPct: 0, slippagePct: 0 };
  const z = sizePosition({ entry: 100, stop: 98, tps: [102, 104, 106] }, s);
  assert.equal(z.shares, 24); assert.equal(z.limitedBy, 'Risiko');
  const z2 = sizePosition({ entry: 100, stop: 99.9, tps: [] }, s);
  assert.equal(z2.shares, 99); assert.equal(z2.limitedBy, 'Kapital');
});
test('Tagesrisiko erreicht → 0 Stück', () => {
  const z = sizePosition({ entry: 100, stop: 98, tps: [], usedDailyRisk: 150 }, { ...S, capital: 10000 });
  assert.equal(z.shares, 0); assert.ok(z.blocks.some(b => /Tagesrisiko/.test(b)));
  assert.equal(usedDailyRisk([{ entry: 100, stop: 98, shares: 10, remainingShares: 10 }], -20), 40);
});
test('Korrelation: zweite Halbleiterposition halbiert Budget, dritte blockiert', () => {
  const s = { ...S, capital: 10000, brokerSpreadPct: 0, slippagePct: 0 };
  assert.equal(sizePosition({ entry: 100, stop: 98, tps: [], group: 'semis', openPositions: [{ group: 'semis' }] }, s).shares, 11);
  assert.equal(sizePosition({ entry: 100, stop: 98, tps: [], group: 'semis', openPositions: [{ group: 'semis' }, { group: 'semis' }] }, s).shares, 0);
});
test('Stop über Entry → blockiert', () => assert.equal(sizePosition({ entry: 100, stop: 101, tps: [] }, S).shares, 0));

test('EUR-Umrechnung 150 USD / 1,10 = 136,36 € und deutsches Format', () => {
  near(usdToEur(150, 1.10), 136.36363636363635);
  assert.equal(fmtEUR(usdToEur(150, 1.10)).replace(/\u00a0/g, ' '), '136,36 €');
  assert.equal(fmtEUR(1250).replace(/\u00a0/g, ' '), '1.250,00 €');
  assert.equal(fmtPct(2.45), '+2,45 %'); assert.equal(fmtPct(-0.85), '\u22120,85 %');
  assert.equal(usdToEur(150, 0), null);
});
test('FX: live vs. Referenz, Plausibilität, historisch ohne Look-ahead', () => {
  const fx = new FxService();
  assert.equal(fx.update({ rate: 7, source: 'x' }), false);
  fx.update({ rate: 1.08, source: 'frankfurter', live: false, ts: Date.now() }); assert.equal(fx.executable(180), false);
  fx.update({ rate: 1.09, source: 'twelvedata', live: true, ts: Date.now() }); assert.equal(fx.executable(180), true);
  assert.equal(fx.executable(180, Date.now() + 600000), false);
  fx.setHistory({ '2026-11-13': 1.05, '2026-11-16': 1.06, '2026-11-17': 1.07 }); assert.equal(fx.rateBefore('2026-11-17'), 1.06);
});
test('Ampelfarben', () => {
  assert.equal(stateColor(STATES.IN_ZONE), 'green'); assert.equal(stateColor(STATES.WATCH), 'yellow'); assert.equal(stateColor(STATES.INVALID), 'red');
  assert.equal(stateColor(STATES.NO_ENTRY), 'grey'); assert.equal(stateColor(STATES.FORMING), 'blue'); assert.equal(stateColor(STATES.NO_DATA), 'orange');
});
test('dateStr in NY-Zeit', () => assert.equal(dateStr(Date.parse('2026-11-18T03:00:00Z')), '2026-11-17'));
test('Request-Budget drosselt vor dem Limit', () => {
  const b = new RequestBudget(3); b.note(); b.note(); assert.equal(b.canSpend(1), true); b.note(); assert.equal(b.canSpend(1), false); assert.ok(b.waitMs() > 0);
});
