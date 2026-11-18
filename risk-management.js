// Risikomanagement: Handelsplan (Entry/SL/TP), Netto-CRV, Positionsgröße, Tagesrisiko, Korrelation
// Technische Levels in USD; Geldbeträge/CRV nach Kosten in EUR.

export function costPct(s) { return ((s.brokerSpreadPct || 0) / 2 + (s.slippagePct || 0)) / 100; }

/** Technischer Handelsplan in USD. ctx: { dir, setup, or, atr, resistances, supports } */
export function buildPlanUSD(ctx, s) {
  const { dir, setup, or, atr } = ctx;
  if (!setup || !setup.confirm || !atr) return null;
  const L = dir === 'long';
  const entry = setup.confirm.price;
  const tol = atr * s.retestTolAtr;
  const buf = atr * s.slBufferAtr;
  let stop, reason;
  if (s.slMode === 'orMid') {
    stop = L ? or.mid - buf : or.mid + buf;
    reason = 'Opening-Range-Mitte mit ATR-Puffer';
  } else {
    const structure = setup.retest ? setup.retest.extreme : setup.extreme;
    const invalidLvl = L ? setup.level - tol : setup.level + tol;
    stop = L ? Math.min(structure, invalidLvl) - buf : Math.max(structure, invalidLvl) + buf;
    reason = `${L ? 'Unter' : 'Über'} ${setup.retest ? 'Retest-Extrem' : 'Breakout-Struktur'} / Invalidierungsniveau (OR-${L ? 'High' : 'Low'} ∓ Toleranz) mit ${s.slBufferAtr} × ATR Puffer`;
  }
  const R = L ? entry - stop : stop - entry;
  if (!(R > 0)) return null;
  const sign = L ? 1 : -1;
  const tps = [1, 2, 3].map(k => entry + sign * k * R);
  const obstacles = (L ? (ctx.resistances || []).filter(x => x > entry) : (ctx.supports || []).filter(x => x < entry)).sort((a, b) => (L ? a - b : b - a));
  const nearest = obstacles.length ? obstacles[0] : null;
  const cap = nearest != null ? nearest - sign * atr * 0.05 : null;
  const tpReal = tps.map(tp => (cap != null && (L ? cap < tp : cap > tp) ? cap : tp));
  const capped = tps.map((tp, i) => tpReal[i] !== tp);
  const zoneLow = L ? Math.max(setup.level, entry - 0.25 * R) : entry - s.maxChaseR * R;
  const zoneHigh = L ? entry + s.maxChaseR * R : Math.min(setup.level, entry + 0.25 * R);
  return {
    dir, entry, stop, R, tps, tpReal, capped, nearestObstacle: nearest, zoneLow, zoneHigh, maxEntry: L ? zoneHigh : zoneLow,
    stopReason: reason, riskAtr: R / atr, breakoutLevel: setup.level, retestLevel: setup.retest ? setup.retest.extreme : null,
  };
}

/** Netto-CRV (Spread/Slippage prozentual auf Ein-/Ausstieg + fixe Gebühren), n = Stückzahl */
export function netCrv({ entry, stop, target, n = 1, feeBuy = 1, feeSell = 1, cPct = 0, dir = 'long' }) {
  const L = dir === 'long';
  const eff = L ? entry * (1 + cPct) : entry * (1 - cPct);
  const tgt = L ? target * (1 - cPct) : target * (1 + cPct);
  const st = L ? stop * (1 - cPct) : stop * (1 + cPct);
  const reward = (L ? tgt - eff : eff - tgt) * n - feeBuy - feeSell;
  const risk = (L ? eff - st : st - eff) * n + feeBuy + feeSell;
  if (risk <= 0) return { crv: null, reward, risk };
  return { crv: reward / risk, reward, risk };
}
export function grossCrv(entry, stop, target) { const r = Math.abs(entry - stop); return r > 0 ? Math.abs(target - entry) / r : null; }

/** Positionsgröße in ganzen Stück, Werte in EUR. */
export function sizePosition(ctx, s) {
  const c = costPct(s);
  const warnings = [], blocks = [];
  const L = ctx.dir !== 'short';
  const entryEff = L ? ctx.entry * (1 + c) : ctx.entry * (1 - c);
  const stopEff = L ? ctx.stop * (1 - c) : ctx.stop * (1 + c);
  const perShareRisk = L ? entryEff - stopEff : stopEff - entryEff;
  const open = ctx.openPositions || [];
  const riskBudget = s.capital * s.riskPerTradePct / 100;
  const dailyLimit = s.capital * s.maxDailyRiskPct / 100;
  const remainingDaily = Math.max(0, dailyLimit - (ctx.usedDailyRisk || 0));
  let budget = Math.min(riskBudget, remainingDaily);
  if (remainingDaily <= 0) blocks.push('Tagesrisikolimit erreicht');
  if (open.length >= s.maxPositions) blocks.push(`Maximale Anzahl paralleler Positionen (${s.maxPositions}) erreicht`);
  const sameGroup = open.filter(p => p.group && p.group === ctx.group).length;
  if (ctx.group && sameGroup >= s.maxPerCorrelationGroup) blocks.push(`Korrelationsgruppe bereits mit ${sameGroup} Position(en) belegt`);
  else if (ctx.group && sameGroup > 0) { budget *= 0.5; warnings.push('Korrelierte Position offen – Risikobudget halbiert'); }
  const openCapital = open.reduce((a, p) => a + (p.capitalEUR || 0), 0);
  const freeCapital = Math.max(0, s.capital - openCapital);
  const nRisk = perShareRisk > 0 ? Math.floor((budget - s.feeBuy - s.feeSell) / perShareRisk) : 0;
  const nCap = Math.floor((freeCapital - s.feeBuy) / Math.abs(entryEff));
  let n = Math.max(0, Math.min(nRisk, nCap));
  if (perShareRisk <= 0) blocks.push('Ungültiger Stop-Loss-Abstand');
  if (blocks.length) n = 0;
  if (n === 0 && !blocks.length) blocks.push('Risikobudget reicht nicht für 1 Aktie inkl. Gebühren');
  const lossAtStop = n > 0 ? perShareRisk * n + s.feeBuy + s.feeSell : 0;
  const gains = (ctx.tps || []).map(tp => (n > 0 ? (L ? tp * (1 - c) - entryEff : entryEff - tp * (1 + c)) * n - s.feeBuy - s.feeSell : 0));
  const parts = [s.tp1Pct, s.tp2Pct, s.tp3Pct];
  (ctx.tps || []).forEach((tp, i) => {
    const qty = Math.floor(n * parts[i] / 100);
    if (L && n > 0 && parts[i] > 0 && qty > 0 && (tp * (1 - c) - entryEff) * qty - s.feeSell <= 0) warnings.push(`Teilverkauf TP${i + 1} nach Gebühren unwirtschaftlich`);
    if (n > 0 && parts[i] > 0 && qty === 0) warnings.push(`Teilverkauf TP${i + 1} ergibt 0 Stück – Position zu klein`);
  });
  return {
    shares: n, capitalNeeded: n * entryEff + s.feeBuy, lossAtStop, gains, riskBudget, dailyLimit,
    remainingDaily: Math.max(0, remainingDaily - lossAtStop), remainingDailyBefore: remainingDaily,
    maxCapital: freeCapital, maxSharesRisk: Math.max(0, nRisk), maxSharesCapital: Math.max(0, nCap),
    estCosts: n * ctx.entry * c * 2 + (n > 0 ? s.feeBuy + s.feeSell : 0), limitedBy: n > 0 ? (nCap < nRisk ? 'Kapital' : 'Risiko') : null, warnings, blocks, perShareRisk,
  };
}

export function positionOpenRisk(pos) {
  const remaining = pos.remainingShares ?? pos.shares;
  if (!pos.stop || !remaining) return 0;
  return Math.max(0, (pos.entry - pos.stop) * remaining);
}

export function usedDailyRisk(openPositions, realizedTodayEUR) {
  return openPositions.reduce((a, p) => a + positionOpenRisk(p), 0) + Math.max(0, -(realizedTodayEUR || 0));
}
