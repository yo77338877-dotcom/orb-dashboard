// ORB-Engine – Opening Range, Breakout, Retest, Fehlausbrüche
// Nur vollständig abgeschlossene Kerzen in Original-USD. Kein Look-ahead.

const MIN = 60000;

export function computeOpeningRange(bars1m, openMs, minutes, nowMs, opts = {}) {
  const endMs = openMs + minutes * MIN;
  const inWin = bars1m.filter(b => b.t >= openMs && b.t < endMs && b.t + MIN <= nowMs);
  const timeComplete = nowMs >= endMs;
  const coverage = inWin.length / minutes;
  const res = {
    minutes, openMs, endMs, timeComplete, barsCount: inWin.length, coverage,
    complete: false, high: null, low: null, mid: null, width: null, widthPct: null,
    widthAtr: null, widthDailyAtr: null, volume: 0, openPrice: null, closePrice: null, changePct: null, issues: [],
  };
  if (!inWin.length) { res.issues.push(timeComplete ? 'Keine Kerzen in der Opening Range' : 'Opening Range in Bildung'); return res; }
  res.high = Math.max(...inWin.map(b => b.h));
  res.low = Math.min(...inWin.map(b => b.l));
  res.mid = (res.high + res.low) / 2;
  res.width = res.high - res.low;
  res.openPrice = inWin[0].o;
  res.closePrice = inWin[inWin.length - 1].c;
  res.widthPct = res.width / res.mid * 100;
  res.changePct = (res.closePrice / res.openPrice - 1) * 100;
  res.volume = inWin.reduce((a, b) => a + b.v, 0);
  if (opts.atr5) res.widthAtr = res.width / opts.atr5;
  if (opts.dailyAtr) res.widthDailyAtr = res.width / opts.dailyAtr;
  const minCov = opts.minBarCoverage ?? 0.8;
  if (!timeComplete) res.issues.push('Opening Range in Bildung');
  else if (coverage < minCov) res.issues.push(`Opening Range unvollständig (${inWin.length}/${minutes} Kerzen)`);
  res.complete = timeComplete && coverage >= minCov && res.width > 0;
  return res;
}

export function assessOpeningRange(or, p) {
  const out = { ok: true, notes: [] };
  if (!or.complete) { out.ok = false; out.notes.push('Opening Range nicht vollständig'); return out; }
  if (or.widthAtr == null) { out.ok = false; out.notes.push('ATR unbekannt – OR-Breite nicht bewertbar'); return out; }
  if (or.widthAtr < p.minOrWidthAtr) { out.ok = false; out.tooSmall = true; out.notes.push(`Opening Range sehr eng (${or.widthAtr.toFixed(2)} × ATR) – Fehlausbruchrisiko`); }
  if (or.widthAtr > p.maxOrWidthAtr) { out.ok = false; out.tooLarge = true; out.notes.push(`Opening Range sehr groß (${or.widthAtr.toFixed(2)} × ATR) – ungünstiges CRV`); }
  if (or.widthDailyAtr != null && or.widthDailyAtr > p.maxOrWidthDailyAtr) { out.ok = false; out.tooLarge = true; out.notes.push(`Opening Range verbraucht ${(or.widthDailyAtr * 100).toFixed(0)} % der Tages-ATR`); }
  return out;
}

export function breakoutBuffer(price, atrVal, p) {
  return Math.max(price * (p.bufferPct / 100), atrVal ? atrVal * p.bufferAtr : 0);
}

/**
 * Sequenzieller Breakout-/Retest-Scanner über abgeschlossene Bestätigungskerzen ab OR-Ende.
 * Je Richtung max. ein Setup pro Tag (keine doppelten Signale).
 */
export function scanOrb(bars, or, atrVal, p) {
  const events = [];
  const used = { long: false, short: false };
  let st = null, lastDone = null;
  const finished = [];
  const tol = (atrVal || or.width * 0.25) * p.retestTolAtr;

  const newSetup = (dir, i, b, buf) => ({
    dir, state: p.retestRequired ? 'WAIT_RETEST' : 'CONFIRMED', level: dir === 'long' ? or.high : or.low, buffer: buf,
    breakout: { i, t: b.t, price: b.c, bar: b, bodyRatio: (b.h - b.l) > 0 ? Math.abs(b.c - b.o) / (b.h - b.l) : 0, rangeAtr: atrVal ? (b.h - b.l) / atrVal : null },
    retest: null, confirm: p.retestRequired ? null : { i, t: b.t, price: b.c, bar: b }, invalidation: null, timeout: null,
    extreme: dir === 'long' ? b.l : b.h,
  });

  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (!st || ['INVALID', 'TIMEOUT'].includes(st.state)) {
      if (st) { finished.push(st); lastDone = st; st = null; }
      const bufUp = breakoutBuffer(or.high, atrVal, p), bufDn = breakoutBuffer(or.low, atrVal, p);
      if (!used.long && b.c > or.high + bufUp) {
        st = newSetup('long', i, b, bufUp); used.long = true;
        events.push({ type: 'breakout', dir: 'long', t: b.t, price: b.c, text: 'Breakout über OR-High (Kerzenschluss)' });
        if (st.state === 'CONFIRMED') events.push({ type: 'confirm', dir: 'long', t: b.t, price: b.c, text: 'Breakout-Einstieg (ohne Retest)' });
      } else if (!used.short && b.c < or.low - bufDn) {
        st = newSetup('short', i, b, bufDn); used.short = true;
        events.push({ type: 'breakout', dir: 'short', t: b.t, price: b.c, text: 'Breakout unter OR-Low (Kerzenschluss)' });
        if (st.state === 'CONFIRMED') events.push({ type: 'confirm', dir: 'short', t: b.t, price: b.c, text: 'Breakout-Signal (ohne Retest)' });
      }
      continue;
    }
    const L = st.dir === 'long';
    const lvl = st.level;
    if (st.state !== 'CONFIRMED') st.extreme = L ? Math.min(st.extreme, b.l) : Math.max(st.extreme, b.h);
    if (L ? b.c < lvl - tol : b.c > lvl + tol) {
      st.state = 'INVALID';
      st.invalidation = { t: b.t, price: b.c, reason: L ? 'Rückkehr in die Opening Range – Fehlausbruch (Bull Trap)' : 'Rückkehr in die Opening Range – Fehlausbruch (Bear Trap)' };
      events.push({ type: 'invalid', dir: st.dir, t: b.t, price: b.c, text: st.invalidation.reason });
      continue;
    }
    if (st.state === 'WAIT_RETEST') {
      const touched = L ? (b.l <= lvl + tol && b.c >= lvl - tol) : (b.h >= lvl - tol && b.c <= lvl + tol);
      if (touched) {
        st.state = 'RETEST_TOUCHED';
        st.retest = { i, t: b.t, extreme: L ? b.l : b.h };
        events.push({ type: 'retest', dir: st.dir, t: b.t, price: L ? b.l : b.h, text: 'Retest des Breakout-Levels' });
      } else if (i - st.breakout.i >= p.maxRetestBars) {
        st.state = 'TIMEOUT'; st.timeout = { t: b.t, reason: 'Kein Retest innerhalb der maximalen Kerzenanzahl' };
        events.push({ type: 'timeout', dir: st.dir, t: b.t, price: b.c, text: st.timeout.reason });
      }
      continue;
    }
    if (st.state === 'RETEST_TOUCHED') {
      st.retest.extreme = L ? Math.min(st.retest.extreme, b.l) : Math.max(st.retest.extreme, b.h);
      const prev = bars[i - 1];
      const confirmBar = L ? (b.c > b.o && b.c > prev.h && b.c > lvl) : (b.c < b.o && b.c < prev.l && b.c < lvl);
      if (confirmBar) {
        st.state = 'CONFIRMED';
        st.confirm = { i, t: b.t, price: b.c, bar: b };
        events.push({ type: 'confirm', dir: st.dir, t: b.t, price: b.c, text: L ? 'Bullische Bestätigung nach Retest' : 'Bärische Bestätigung nach Retest' });
      } else if (i - st.retest.i >= p.maxRetestBars) {
        st.state = 'TIMEOUT'; st.timeout = { t: b.t, reason: 'Keine Bestätigungskerze nach Retest' };
        events.push({ type: 'timeout', dir: st.dir, t: b.t, price: b.c, text: st.timeout.reason });
      }
    }
  }
  const setup = st || lastDone;
  if (setup && setup.confirm) setup.barsSinceConfirm = bars.length - 1 - setup.confirm.i;
  return { setup, finished, events, lastBar: bars.length ? bars[bars.length - 1] : null, tol };
}

export function breakoutQuality(setup, p) {
  if (!setup) return null;
  const b = setup.breakout;
  return { weakCandle: b.bodyRatio < p.minBodyRatio, longCandle: b.rangeAtr != null && b.rangeAtr > p.maxBreakoutCandleAtr, bodyRatio: b.bodyRatio, rangeAtr: b.rangeAtr };
}
