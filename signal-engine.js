// Signal-Engine: Verifizierung, Trading-Score, Ausschlusskriterien, Zustandsmaschine
// analyzeSymbol() wird identisch für Live-Analyse, Paper Trading und Backtesting verwendet.
import { STATES } from './config.js';
import { ema, rsi, macd, atr, sessionVwap, aggregate, swings, sessionRvol, intervalRvol, last } from './indicators.js';
import { computeOpeningRange, assessOpeningRange, scanOrb, breakoutQuality } from './orb-engine.js';
import { buildPlanUSD, netCrv, costPct, sizePosition, grossCrv } from './risk-management.js';
import { nyTimeOnDate, dateStr } from './market-time.js';
import { fmtNum } from './fx-service.js';

const MIN = 60000;

/** Marktkontext aus SPY/QQQ */
export function marketContext(idxBars, openMs, atMs) {
  const out = { items: {}, regime: null, label: 'unbekannt', avgPct: null };
  const pcts = [];
  let up = 0, down = 0, n = 0;
  for (const [sym, bars] of Object.entries(idxBars || {})) {
    const sb = (bars || []).filter(b => b.t >= openMs && b.t + MIN <= atMs);
    if (sb.length < 3) { out.items[sym] = null; continue; }
    const vw = last(sessionVwap(sb));
    const px = sb[sb.length - 1].c, op = sb[0].o;
    const pct = (px / op - 1) * 100;
    const above = px > vw;
    out.items[sym] = { pct, aboveVwap: above, price: px, vwap: vw };
    pcts.push(pct); n++;
    if (pct > 0.1 && above) up++; else if (pct < -0.1 && !above) down++;
  }
  if (n === 0) return out;
  out.avgPct = pcts.reduce((a, b) => a + b, 0) / pcts.length;
  if (up === n) { out.regime = 1; out.label = 'positiv'; }
  else if (down === n) { out.regime = -1; out.label = 'negativ'; }
  else { out.regime = 0; out.label = 'neutral'; }
  out.complete = n === Object.keys(idxBars).length;
  return out;
}

function chk(list, key, label, status, points, max, detail, mandatory = false, group = '') {
  list.push({ key, label, status, points, max, detail, mandatory, group });
}

/**
 * Vollständige Analyse eines Symbols zum Zeitpunkt atMs.
 * ctx: { symbol, meta, session, bars1m, hist5m, daily, baseline, market, lastPrice, dataStatus, eventStatus }
 * opts: { fxRate, fxExecutable, broker:{bid,ask,ts}, risk:{openPositions, usedDailyRisk}, backtest }
 */
export function analyzeSymbol(ctx, s, atMs, opts = {}) {
  const { session } = ctx;
  const openMs = session.openMs, closeMs = session.closeMs;
  const tf = Number(s.confirmTimeframe) || 1;
  const orbMin = Number(s.orbMinutes) || 15;
  const A = { symbol: ctx.symbol, atMs, orbMinutes: orbMin, checks: [], warnings: [], score: 0, session };

  const all = (ctx.bars1m || []).filter(b => b.t + MIN <= atMs);
  const sessionBars = all.filter(b => b.t >= openMs && b.t < closeMs);
  const pre = all.filter(b => b.t < openMs && b.t >= openMs - 330 * MIN);
  A.sessionBars = sessionBars;
  A.lastBar = sessionBars[sessionBars.length - 1] || null;
  A.price = ctx.lastPrice ?? (A.lastBar ? A.lastBar.c : (pre.length ? pre[pre.length - 1].c : null));
  const todayStr = dateStr(openMs);

  // Vortag / Tageskerzen
  const daily = (ctx.daily || []).filter(b => dateStr(b.t) < todayStr);
  const pd = daily[daily.length - 1] || null;
  A.prevClose = pd ? pd.c : null; A.pdh = pd ? pd.h : null; A.pdl = pd ? pd.l : null;
  A.dailyAtr = daily.length >= 15 ? last(atr(daily, 14)) : null;
  const dCloses = daily.map(b => b.c);
  A.ema50d = last(ema(dCloses, 50)); A.ema200d = last(ema(dCloses, 200));
  A.pmh = pre.length ? Math.max(...pre.map(b => b.h)) : null;
  A.pml = pre.length ? Math.min(...pre.map(b => b.l)) : null;
  A.openPrice = sessionBars.length ? sessionBars[0].o : null;
  A.dayChangePct = A.prevClose && A.price ? (A.price / A.prevClose - 1) * 100 : null;
  A.gapPct = A.prevClose && A.openPrice ? (A.openPrice / A.prevClose - 1) * 100 : null;
  if (A.gapPct != null) {
    const dayLow = Math.min(...sessionBars.map(b => b.l)), dayHigh = Math.max(...sessionBars.map(b => b.h));
    A.gap = { pct: A.gapPct, dir: A.gapPct > 0.05 ? 'up' : A.gapPct < -0.05 ? 'down' : 'none',
      size: Math.abs(A.gapPct) >= 2 ? 'groß' : Math.abs(A.gapPct) >= 0.75 ? 'mittel' : 'klein',
      filled: A.gapPct > 0 ? dayLow <= A.prevClose : A.gapPct < 0 ? dayHigh >= A.prevClose : true };
  }

  // Intraday-Indikatoren auf 5 Min (inkl. 3 Vortage zum Einschwingen)
  const today5 = aggregate(sessionBars, 5, openMs).filter(b => b.t + 5 * MIN <= atMs);
  const hist5 = (ctx.hist5m || []).slice(-3).flatMap(x => x.bars);
  const bars5 = hist5.concat(today5);
  const c5 = bars5.map(b => b.c);
  const e9 = ema(c5, 9), e20 = ema(c5, 20), e50 = ema(c5, 50), e200 = ema(c5, 200);
  const r = rsi(c5, 14), m = macd(c5), a5 = atr(bars5, 14);
  A.series5 = { bars: bars5, e9, e20, e50, e200, rsi: r, macd: m, atr: a5, todayStartIdx: hist5.length };
  A.ema9 = last(e9); A.ema20 = last(e20);
  const e20prev = e20.length > 3 ? e20[e20.length - 4] : null;
  A.ema20Slope = A.ema20 != null && e20prev != null ? A.ema20 - e20prev : null;
  A.rsi = last(r); A.macdHist = last(m.hist);
  const hPrev = m.hist.length > 1 ? m.hist[m.hist.length - 2] : null;
  A.macdRising = A.macdHist != null && hPrev != null ? A.macdHist > hPrev : null;
  A.atr5 = last(a5);
  const vw = sessionVwap(sessionBars);
  A.vwapSeries = vw; A.vwap = last(vw);
  const vwPrev = vw.length > 10 ? vw[vw.length - 11] : null;
  A.vwapSlope = A.vwap != null && vwPrev != null ? A.vwap - vwPrev : null;

  // ATR zum OR-Ende fixieren (Puffer, Toleranz, Stop) – kein Repainting
  const orEndMs = openMs + orbMin * MIN;
  let atrOrIdx = -1;
  for (let i = bars5.length - 1; i >= 0; i--) if (bars5[i].t + 5 * MIN <= Math.min(orEndMs, atMs)) { atrOrIdx = i; break; }
  A.atrOr = atrOrIdx >= 0 ? a5[atrOrIdx] : null;
  const atrSig = A.atrOr || A.atr5;

  A.rvol = sessionRvol(ctx.baseline, sessionBars, openMs, atMs);

  // Opening Ranges (5/15/30)
  A.ranges = {};
  for (const mins of [5, 15, 30]) A.ranges[mins] = computeOpeningRange(sessionBars, openMs, mins, atMs, { atr5: mins === orbMin ? atrSig : A.atr5, dailyAtr: A.dailyAtr, minBarCoverage: s.minBarCoverage });
  const or = A.ranges[orbMin];
  A.or = or;
  A.orAssess = assessOpeningRange(or, s);
  if (or.complete) A.orRvol = intervalRvol(ctx.baseline, sessionBars, openMs, openMs, or.endMs);

  A.phase = atMs < openMs ? 'pre' : atMs >= closeMs ? 'post' : 'open';

  // Breakout-/Retest-Scan
  let confirmBars = [];
  if (or.complete) {
    confirmBars = tf === 5
      ? aggregate(sessionBars.filter(b => b.t >= or.endMs), 5, openMs).filter(b => b.t + 5 * MIN <= atMs)
      : sessionBars.filter(b => b.t >= or.endMs);
  }
  A.scan = or.complete ? scanOrb(confirmBars, or, atrSig, s) : { setup: null, events: [], finished: [], tol: 0 };
  const setup = A.scan.setup;
  A.setup = setup; A.events = A.scan.events; A.dir = setup ? setup.dir : null;
  A.quality = breakoutQuality(setup, s);
  if (setup) A.breakoutRvol = intervalRvol(ctx.baseline, sessionBars, openMs, setup.breakout.t, setup.breakout.t + tf * MIN);

  // Unterstützungen / Widerstände (nur bekannte Levels)
  const sw = swings(today5, 2, 2).filter(x => x.knownAt + 5 * MIN <= atMs);
  A.swingHighs = sw.filter(x => x.type === 'high').map(x => x.price);
  A.swingLows = sw.filter(x => x.type === 'low').map(x => x.price);
  A.resistances = [A.pdh, A.pmh, ...A.swingHighs].filter(x => x != null);
  A.supports = [A.pdl, A.pml, ...A.swingLows].filter(x => x != null);

  const L = A.dir === 'long', S = A.dir === 'short';
  A.plan = setup && setup.confirm ? buildPlanUSD({ dir: A.dir, setup, or, atr: atrSig, resistances: A.resistances, supports: A.supports }, s) : null;

  // Euro-Plan, Netto-CRV, Positionsgröße
  const fx = opts.fxRate || null;
  const toE = v => (v == null || !fx ? null : v / fx);
  if (A.plan) {
    const p = A.plan;
    const rate = fx || 1; // ohne FX nur technische Näherung
    const eurEntry = p.entry / rate, eurStop = p.stop / rate;
    const sizing = sizePosition({ dir: A.dir, entry: eurEntry, stop: eurStop, tps: p.tpReal.map(x => x / rate), group: ctx.meta?.group,
      openPositions: opts.risk?.openPositions || [], usedDailyRisk: opts.risk?.usedDailyRisk || 0 }, s);
    const refSizing = sizePosition({ dir: A.dir, entry: eurEntry, stop: eurStop, tps: [] }, s); // CRV-Referenz ohne Tageslimits
    const n = Math.max(1, refSizing.shares || 1);
    const crvAt = tgt => netCrv({ entry: eurEntry, stop: eurStop, target: tgt / rate, n, feeBuy: s.feeBuy, feeSell: s.feeSell, cPct: costPct(s), dir: A.dir }).crv;
    p.netCrvs = p.tpReal.map(crvAt);
    p.grossCrvs = p.tps.map(t => grossCrv(p.entry, p.stop, t));
    p.realCrvs = p.tpReal.map(t => grossCrv(p.entry, p.stop, t));
    // Hauptziel TP2; TP3 nur, wenn nicht begrenzt und innerhalb der Tages-ATR erreichbar
    let mainIdx = 1;
    const dayExt = sessionBars.length ? (L ? Math.min(...sessionBars.map(b => b.l)) : Math.max(...sessionBars.map(b => b.h))) : null;
    const tp3Reach = A.dailyAtr && dayExt != null ? Math.abs(p.tps[2] - dayExt) <= A.dailyAtr : false;
    if ((p.netCrvs[1] ?? 0) < s.minNetCrv && !p.capped[2] && tp3Reach && (p.netCrvs[2] ?? 0) >= s.minNetCrv) mainIdx = 2;
    p.mainIdx = mainIdx; p.netCrv = p.netCrvs[mainIdx]; p.feeApprox = !fx;
    p.sizing = sizing;
    if (fx) p.eur = { entry: toE(p.entry), stop: toE(p.stop), tps: p.tps.map(toE), tpReal: p.tpReal.map(toE), zoneLow: toE(p.zoneLow), zoneHigh: toE(p.zoneHigh), maxEntry: toE(p.maxEntry), R: toE(p.R), breakoutLevel: toE(p.breakoutLevel), retestLevel: toE(p.retestLevel) };
  }

  // ===== Checks & Score (max. 100) =====
  const C = A.checks;
  const ds = ctx.dataStatus || { ok: true, reasons: [] };
  chk(C, 'orComplete', 'Opening Range vollständig', or.complete ? 'ok' : (or.timeComplete ? 'fail' : 'unknown'), 0, 0, or.issues.join('; ') || `${or.barsCount}/${orbMin} Kerzen`, true, 'ORB');
  chk(C, 'orWidth', 'Opening Range Breite angemessen', !or.complete ? 'unknown' : A.orAssess.ok ? 'ok' : 'fail', or.complete && A.orAssess.ok ? 5 : 0, 5,
    or.complete ? `${fmtNum(or.widthPct)} % · ${or.widthAtr != null ? fmtNum(or.widthAtr) + ' × ATR' : 'ATR unbekannt'}${A.orAssess.notes.length ? ' · ' + A.orAssess.notes.join('; ') : ''}` : '–', true, 'ORB');
  chk(C, 'breakout', 'Breakout bestätigt (Kerzenschluss + Puffer)', setup ? 'ok' : (or.complete ? 'fail' : 'unknown'), setup ? 10 : 0, 10,
    setup ? `${L ? 'Long' : 'bärisch'} · Schluss ${fmtNum(setup.breakout.price)} USD, Level ${fmtNum(setup.level)} ± Puffer ${fmtNum(setup.buffer, 3)}` : 'Kein Ausbruch', true, 'ORB');
  const retestOk = !!(setup && setup.retest && setup.confirm);
  chk(C, 'retest', s.retestRequired ? 'Retest erfolgreich (Pflicht)' : 'Retest erfolgreich (optional)',
    retestOk ? 'ok' : setup ? (['TIMEOUT', 'INVALID'].includes(setup.state) || s.retestRequired ? 'fail' : 'unknown') : 'unknown',
    retestOk ? 10 : (!s.retestRequired && setup && setup.confirm ? 4 : 0), 10,
    setup ? ({ WAIT_RETEST: 'Warte auf Retest', RETEST_TOUCHED: 'Retest berührt – warte auf Bestätigungskerze', CONFIRMED: retestOk ? 'Retest + Bestätigungskerze' : 'Ohne Retest', TIMEOUT: setup.timeout?.reason, INVALID: setup.invalidation?.reason }[setup.state]) : '–', !!s.retestRequired, 'ORB');
  const q = A.quality;
  chk(C, 'candle', 'Breakout-Kerze kräftig', q ? (q.weakCandle ? 'fail' : 'ok') : 'unknown', q && !q.weakCandle ? 5 : 0, 5, q ? `Körperanteil ${fmtNum(q.bodyRatio * 100, 0)} %` : '–', false, 'ORB');
  const ext = A.price != null && setup && A.atr5 ? (L ? A.price - setup.level : setup.level - A.price) / A.atr5 : null;
  A.extensionAtr = ext;
  const extOk = ext != null && ext <= s.maxExtensionAtr && !(q && q.longCandle);
  chk(C, 'extension', 'Nicht überdehnt', ext == null ? 'unknown' : extOk ? 'ok' : 'fail', extOk ? 5 : 0, 5,
    ext != null ? `${fmtNum(ext)} × ATR vom Level${q && q.longCandle ? ' · übermäßig lange Breakout-Kerze' : ''}` : '–', true, 'ORB');

  const rv = A.rvol, brv = A.breakoutRvol;
  const rvPts = rv == null ? 0 : rv >= 3 ? 14 : rv >= 2 ? 12 : rv >= 1.5 ? 10 : rv >= 1.2 ? 5 : rv >= 1 ? 2 : 0;
  const brvPts = brv == null ? 0 : brv >= 2 ? 6 : brv >= 1.5 ? 4 : brv >= 1.2 ? 2 : 0;
  chk(C, 'rvol', `Volumen ausreichend (RVOL ≥ ${fmtNum(s.minRvol, 1)})`, rv == null ? 'unknown' : rv >= s.minRvol ? 'ok' : 'fail', rvPts + brvPts, 20,
    `Session-RVOL ${rv != null ? fmtNum(rv) : 'unbekannt'} · OR-RVOL ${A.orRvol != null ? fmtNum(A.orRvol) : '–'} · Breakout-Kerze ${brv != null ? fmtNum(brv) : '–'}${ctx.baseline ? ` · Basis ${ctx.baseline.days} Tage (IEX)` : ' · keine Historie'}`, true, 'Volumen');

  const vwSide = A.vwap != null && A.price != null ? (S ? A.price < A.vwap : A.price > A.vwap) : null;
  const vwSlopeOk = A.vwapSlope != null ? (S ? A.vwapSlope < 0 : A.vwapSlope > 0) : null;
  chk(C, 'vwap', S ? 'Kurs unterhalb VWAP' : 'Kurs oberhalb VWAP', vwSide == null ? 'unknown' : vwSide ? 'ok' : 'fail',
    (vwSide ? 7 : 0) + (vwSide && vwSlopeOk ? 3 : 0), 10, A.vwap != null ? `VWAP ${fmtNum(A.vwap)} USD · Steigung ${vwSlopeOk == null ? '–' : vwSlopeOk ? 'bestätigend' : 'gegenläufig'}` : 'unbekannt', !!s.vwapFilter, 'Trend');

  // EMA 9/20 auf 5 Min, EMA 50/200 auf Tagesbasis
  let emaPts = 0, emaTrend = null;
  if (A.ema9 != null && A.ema20 != null && A.price != null) {
    const cross = S ? A.ema9 < A.ema20 : A.ema9 > A.ema20;
    const pos = S ? A.price < A.ema9 && A.price < A.ema20 : A.price > A.ema9 && A.price > A.ema20;
    const slope = A.ema20Slope != null && (S ? A.ema20Slope < 0 : A.ema20Slope > 0);
    const dTrend = A.ema50d != null && (S ? A.price < A.ema50d : A.price > A.ema50d);
    emaPts = (cross ? 4 : 0) + (pos ? 3 : 0) + (slope ? 2 : 0) + (dTrend ? 1 : 0);
    emaTrend = cross;
    A.emaTrendLabel = A.ema9 > A.ema20 ? 'steigend' : 'fallend';
  }
  chk(C, 'ema', S ? 'EMA-Trend negativ (EMA 9 < EMA 20, 5 Min)' : 'EMA-Trend positiv (EMA 9 > EMA 20, 5 Min)', emaTrend == null ? 'unknown' : emaTrend ? 'ok' : 'fail', emaPts, 10,
    `EMA9 ${fmtNum(A.ema9)} · EMA20 ${fmtNum(A.ema20)} · Tages-EMA50 ${fmtNum(A.ema50d)} · Tages-EMA200 ${fmtNum(A.ema200d)}`, !!s.emaFilter, 'Trend');

  const rsiOk = A.rsi == null ? null : S ? A.rsi >= 25 && A.rsi <= 50 : A.rsi >= 50 && A.rsi <= 75;
  if (A.rsi != null && (A.rsi > 80 || A.rsi < 20)) A.warnings.push(`Extremer RSI (${fmtNum(A.rsi, 1)}) – Überdehnungsgefahr`);
  const macdOk = A.macdHist == null ? null : S ? A.macdHist < 0 && A.macdRising === false : A.macdHist > 0 && A.macdRising === true;
  if (s.rsiFilter) chk(C, 'rsi', S ? 'RSI bestätigt Momentum (25–50)' : 'RSI bestätigt Momentum (50–75)', rsiOk == null ? 'unknown' : rsiOk ? 'ok' : 'fail', rsiOk ? 3 : 0, 3, `RSI 14 (5 Min): ${fmtNum(A.rsi, 1)}`, false, 'Momentum');
  if (s.macdFilter) chk(C, 'macd', 'MACD bestätigt Momentum', macdOk == null ? 'unknown' : macdOk ? 'ok' : 'fail', macdOk ? 2 : 0, 2, `Histogramm ${fmtNum(A.macdHist, 3)} ${A.macdRising ? '↑' : '↓'}`, false, 'Momentum');

  const mk = ctx.market || { regime: null };
  let mkPts = 0, mkStatus = 'unknown';
  if (mk.regime != null) {
    const aligned = S ? mk.regime === -1 : mk.regime === 1;
    const contrary = S ? mk.regime === 1 : mk.regime === -1;
    mkPts = aligned ? 6 : mk.regime === 0 ? 3 : 0;
    mkStatus = contrary ? 'fail' : 'ok';
  }
  const stockPct = A.openPrice && A.price ? (A.price / A.openPrice - 1) * 100 : null;
  A.relStrength = stockPct != null && mk.avgPct != null ? stockPct - mk.avgPct : null;
  if (A.relStrength != null && (S ? A.relStrength < 0 : A.relStrength > 0)) mkPts += 4;
  chk(C, 'market', S ? 'Markttrend negativ/neutral' : 'Markttrend positiv/neutral', mkStatus, mkPts, 10,
    `SPY/QQQ: ${mk.label || 'unbekannt'} · Relative Stärke ${A.relStrength != null ? fmtNum(A.relStrength) + ' %-Pkt.' : '–'}`, !!s.marketFilter, 'Markt');
  A.marketLabel = mk.label || 'unbekannt';

  const nc = A.plan?.netCrv;
  const crvPts = nc == null ? 0 : nc >= 3 ? 10 : nc >= 2.5 ? 8 : nc >= s.minNetCrv ? 6 : 0;
  chk(C, 'crv', `Netto-CRV ausreichend (≥ ${fmtNum(s.minNetCrv, 1)})`, nc == null ? 'unknown' : nc >= s.minNetCrv ? 'ok' : 'fail', crvPts, 10,
    A.plan ? `Netto-CRV ${fmtNum(nc)} am ${A.plan.capped[A.plan.mainIdx] ? 'begrenzten ' : ''}TP${A.plan.mainIdx + 1}${A.plan.nearestObstacle != null ? ` · Hindernis ${fmtNum(A.plan.nearestObstacle)} USD` : ''}${A.plan.feeApprox ? ' · Gebühren ohne FX geschätzt' : ''}` : 'Kein Handelsplan', true, 'CRV');
  if (A.plan) {
    const ra = A.plan.riskAtr;
    chk(C, 'stopDist', 'Stop-Loss-Distanz sinnvoll', ra >= s.minRiskAtr && ra <= s.maxRiskAtr ? 'ok' : 'fail', 0, 0, `${fmtNum(ra)} × ATR (erlaubt ${fmtNum(s.minRiskAtr)}–${fmtNum(s.maxRiskAtr)})`, true, 'CRV');
  }

  // Einstiegszeitfenster (frühestens OR-Ende)
  const winStart = Math.max(nyTimeOnDate(todayStr, s.entryWindowStart), or.endMs);
  const winEnd = Math.min(nyTimeOnDate(todayStr, s.entryWindowEnd), closeMs);
  const sigT = setup?.confirm ? setup.confirm.t + tf * MIN : null;
  A.signalTime = sigT;
  const inWin = sigT != null ? sigT >= winStart && sigT <= winEnd && atMs <= winEnd : (atMs <= winEnd ? null : false);
  A.window = { start: winStart, end: winEnd };
  chk(C, 'window', 'Innerhalb Einstiegszeitfenster', inWin == null ? 'unknown' : inWin ? 'ok' : 'fail', 0, 0, `${s.entryWindowStart}–${s.entryWindowEnd} New York`, true, 'Zeit');

  chk(C, 'data', 'Marktdaten aktuell und vollständig', ds.ok ? 'ok' : 'fail', 0, 0, ds.ok ? (ds.label || 'OK') : ds.reasons.join('; '), true, 'Daten');
  const plaus = plausible(sessionBars);
  chk(C, 'plausible', 'Kurse plausibel', plaus.ok ? 'ok' : 'fail', 0, 0, plaus.ok ? 'Keine Auffälligkeiten' : plaus.reason, true, 'Daten');
  if (setup && setup.state === 'INVALID') chk(C, 'notInvalid', 'Setup nicht invalidiert', 'fail', 0, 0, setup.invalidation.reason, true, 'ORB');

  A.eventStatus = ctx.eventStatus || { status: 'unknown', text: 'Ereignisstatus unbekannt' };
  if (A.eventStatus.status === 'earnings') A.warnings.push(A.eventStatus.text);

  A.score = Math.round(C.reduce((a, c) => a + (c.points || 0), 0));
  const pts = k => C.filter(c => c.key === k).reduce((a, c) => a + c.points, 0);
  A.scoreBreakdown = {
    'ORB-Qualität': [C.filter(c => c.group === 'ORB').reduce((a, c) => a + c.points, 0), 35],
    'Relatives Volumen': [pts('rvol'), 20], 'VWAP': [pts('vwap'), 10], 'EMA-Trend': [pts('ema'), 10],
    'RSI & MACD': [C.filter(c => c.group === 'Momentum').reduce((a, c) => a + c.points, 0), 5],
    'Markt & rel. Stärke': [pts('market'), 10], 'CRV & Hindernisse': [crvPts, 10],
  };
  A.failedMandatory = C.filter(c => c.mandatory && c.status !== 'ok');
  A.mandatoryOk = A.failedMandatory.length === 0;

  A.state = deriveState(A, s, atMs, opts, ds);
  A.explanation = explain(A);
  return A;
}

function plausible(bars) {
  for (let i = Math.max(1, bars.length - 60); i < bars.length; i++) {
    const b = bars[i], p = bars[i - 1];
    if (!(b.h >= b.l) || !(b.c > 0) || !(b.o > 0)) return { ok: false, reason: 'Ungültige Kerze (OHLC)' };
    if (Math.abs(b.c / p.c - 1) > 0.15) return { ok: false, reason: 'Kurssprung > 15 % zwischen zwei Minuten' };
  }
  return { ok: true };
}

function deriveState(A, s, atMs, opts, ds) {
  const St = STATES;
  const setup = A.setup;
  A.exec = { status: null, reasons: [] };
  if (A.phase === 'pre') return St.PRE;
  if (!ds.ok && A.phase === 'open') return St.NO_DATA;
  if (!A.or.timeComplete) return St.FORMING;
  if (!A.or.complete) return A.phase === 'post' ? St.CLOSED : St.NO_DATA;
  const ended = atMs > A.window.end;
  if (!setup) return A.phase === 'post' ? St.CLOSED : ended ? St.NO_ENTRY : St.WAIT_BREAKOUT;
  if (setup.state === 'INVALID') return St.INVALID;
  if (setup.state === 'TIMEOUT') return St.NO_ENTRY;
  if (setup.state === 'WAIT_RETEST') return ended ? St.NO_ENTRY : St.WAIT_RETEST;
  if (setup.state === 'RETEST_TOUCHED') return ended ? St.NO_ENTRY : St.WAIT_CONFIRM;
  // Bestätigt. Long: abgelaufene Signale bleiben verpasst (kein Rücksprung auf BEOBACHTEN, kein Hinterherlaufen)
  const p = A.plan;
  if (A.dir === 'long' && p && ((setup.barsSinceConfirm ?? 0) > s.signalValidityBars || (A.price != null && A.price > p.maxEntry))) {
    const extFail = A.failedMandatory.some(c => c.key === 'extension');
    const otherFails = A.failedMandatory.filter(c => c.key !== 'extension').length;
    return otherFails === 0 && A.score + (extFail ? 5 : 0) >= s.minScore ? St.MISSED : St.NO_ENTRY;
  }
  if (!(A.mandatoryOk && A.score >= s.minScore)) return A.score >= 60 && !ended ? St.WATCH : St.NO_ENTRY;
  if (A.dir === 'short') return St.BEAR_OK;
  if (!p) return St.NO_ENTRY;
  if (A.phase === 'post') return St.CLOSED;
  // Ausführungsprüfung: harte Blockaden → KEIN EINSTIEG; fehlende Prüfung → BROKERKURS PRÜFEN
  const hard = [], soft = [];
  if (p.sizing?.blocks.length) hard.push(...p.sizing.blocks);
  if (!opts.fxExecutable) soft.push('Kein aktueller Live-Wechselkurs – Euro-Freigabe blockiert');
  const b = opts.broker;
  if (!b || !b.ask) soft.push('Technisches ORB-Setup bestätigt – Brokerkurs noch prüfen.');
  else if (!opts.backtest && atMs - b.ts > s.brokerQuoteMaxAgeSec * 1000) soft.push('Brokerkurs-Eingabe veraltet – bitte neu eingeben');
  else if (p.eur) {
    const spread = b.bid ? (b.ask - b.bid) / ((b.ask + b.bid) / 2) * 100 : null;
    A.exec.brokerSpread = spread;
    if (b.ask > p.eur.maxEntry) hard.push('Brokerkurs über maximalem Einstiegspreis');
    if (spread != null && spread > s.maxSpreadPct) hard.push(`Broker-Spread ${fmtNum(spread)} % zu groß`);
    if (spread == null) soft.push('Broker-Geldkurs fehlt – Spread unbekannt');
    const n = Math.max(1, p.sizing?.shares || 1);
    const brokerCrv = netCrv({ entry: b.ask, stop: p.eur.stop, target: p.eur.tpReal[p.mainIdx], n, feeBuy: s.feeBuy, feeSell: s.feeSell, cPct: (s.slippagePct || 0) / 100 }).crv;
    A.exec.brokerCrv = brokerCrv;
    if (brokerCrv == null || brokerCrv < s.minNetCrv) hard.push(`Netto-CRV zum Brokerkurs ${fmtNum(brokerCrv)} unter Minimum`);
  }
  A.exec.reasons = [...hard, ...soft];
  if (hard.length) { A.exec.status = 'blocked'; return St.NO_ENTRY; }
  if (soft.length) { A.exec.status = 'check'; return St.CHECK_BROKER; }
  A.exec.status = 'ready';
  return St.IN_ZONE;
}

function explain(A) {
  const or = A.or;
  if (A.phase === 'pre') return 'Vorbörslich – Opening Range noch nicht begonnen.';
  if (!or.timeComplete) return `${A.orbMinutes}-Minuten-Opening-Range in Bildung.`;
  if (!or.complete) return or.issues.join('. ') + '.';
  const st = A.setup;
  if (!st) return `${A.orbMinutes}-Minuten-ORB fixiert (${fmtNum(or.low)}–${fmtNum(or.high)} USD). Kein bestätigter Ausbruch.`;
  const parts = [`${A.orbMinutes}-Minuten-ORB nach ${st.dir === 'long' ? 'oben' : 'unten'} ausgebrochen`];
  if (st.state === 'INVALID') parts.push(st.invalidation.reason);
  else if (st.state === 'TIMEOUT') parts.push(st.timeout.reason);
  else if (st.retest && st.confirm) parts.push('Retest erfolgreich');
  else if (st.state === 'WAIT_RETEST') parts.push('Retest steht aus');
  else if (st.state === 'RETEST_TOUCHED') parts.push('Retest läuft, Bestätigung fehlt');
  if (A.rvol != null) parts.push(`RVOL ${fmtNum(A.rvol)}`);
  if (A.vwap != null && A.price != null) parts.push(`Kurs ${A.price > A.vwap ? 'oberhalb' : 'unterhalb'} VWAP`);
  if (A.dir === 'short') parts.push('Keine Leerverkaufsempfehlung – Warnsignal für Long-Positionen');
  parts.push(`Markttrend ${A.marketLabel}`);
  if (A.plan?.netCrv != null) parts.push(`Netto-CRV ${fmtNum(A.plan.netCrv, 1)}`);
  const fails = A.failedMandatory.filter(c => c.status === 'fail').map(c => c.label);
  if (fails.length && st.state === 'CONFIRMED') parts.push('Nicht erfüllt: ' + fails.join(', '));
  if (A.exec?.reasons?.length) parts.push(A.exec.reasons[0].replace(/\.$/, ''));
  return parts.join('. ') + '.';
}

/** Statusprotokoll – Zeitpunkt jeder Statusänderung, keine Duplikate */
export class StateTracker {
  constructor(storage) { this.storage = storage; this.data = {}; this.day = null; }
  key(day) { return `orb.states.${day}`; }
  load(day) { this.day = day; try { this.data = day && this.storage ? JSON.parse(this.storage.getItem(this.key(day)) || '{}') : {}; } catch { this.data = {}; } }
  ensureDay(day) { if (this.day !== day) this.load(day); }
  record(symbol, state, t) {
    const h = this.data[symbol] || (this.data[symbol] = []);
    if (!h.length || h[h.length - 1].state !== state) {
      h.push({ state, t });
      try { this.storage && this.day && this.storage.setItem(this.key(this.day), JSON.stringify(this.data)); } catch { /* Speicher voll */ }
      return true;
    }
    return false;
  }
  history(symbol) { return this.data[symbol] || []; }
}
