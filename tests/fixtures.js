// SYNTHETISCHE TESTDATEN – ausschließlich für automatisierte Tests und den gekennzeichneten Testmodus.
// Diese Daten sind KEINE echten Marktdaten.
import { nyTimeOnDate, addDays, weekday } from '../market-time.js';

const MIN = 60000;

export function rng(seed = 1) {
  let x = seed >>> 0 || 1;
  return () => { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
}

function volProfile(m) { return 1 + 2.5 * Math.exp(-m / 25) + 1.2 * Math.exp(-(390 - m) / 30); }

/** 1-Min-Kerzen 04:00–16:00 NY. pattern: 'long' | 'short' | 'fake' | 'flat' */
export function genDay({ date, base = 100, pattern = 'flat', volMult = 1, seed = 7, baseVol = 2000 }) {
  const r = rng(seed);
  const openMs = nyTimeOnDate(date, '09:30');
  const start = nyTimeOnDate(date, '04:00');
  const end = nyTimeOnDate(date, '16:00');
  const bars = [];
  let px = base;
  const orH = base * 1.005, orL = base * 0.995;
  for (let t = start; t < end; t += MIN) {
    const m = Math.round((t - openMs) / MIN);
    let o = px, c, v;
    const noise = (r() - 0.5) * base * 0.0008;
    if (m < 0) { c = base * (0.998 + r() * 0.003); v = baseVol * 0.1 * (0.5 + r()); }
    else if (m < 15 && pattern !== 'flat') {
      c = (m % 4 < 2 ? orH * 0.999 : orL * 1.001) + noise * 0.3; if (m === 3) c = orH; if (m === 9) c = orL;
      v = baseVol * volProfile(m) * volMult * (0.8 + r() * 0.4);
    } else if (pattern === 'long' || pattern === 'fake') {
      if (m < 20) c = orH * (0.9985 + r() * 0.001);
      else if (m === 20) { o = orH * 0.9995; c = orH * 1.004; }
      else if (m === 21) c = orH * 1.0025;
      else if (m === 22) c = orH * 1.0012;
      else if (m === 23) c = orH * 1.0006;
      else if (pattern === 'fake' && m === 24) c = orH * 0.993;
      else if (pattern === 'long' && m === 24) { o = orH * 1.0006; c = orH * 1.0045; }
      else if (pattern === 'long') c = px * 1.00035 + noise * 0.4;
      else c = px * 0.9998 + noise * 0.4;
      v = baseVol * volProfile(m) * volMult * (0.8 + r() * 0.4) * (m === 20 ? 2.5 : 1);
    } else if (pattern === 'short') {
      if (m < 20) c = orL * (1.0005 + r() * 0.001);
      else if (m === 20) { o = orL * 1.0005; c = orL * 0.996; }
      else if (m === 21) c = orL * 0.9975;
      else if (m === 22) c = orL * 0.9988;
      else if (m === 23) c = orL * 0.9994;
      else if (m === 24) { o = orL * 0.9994; c = orL * 0.9955; }
      else c = px * 0.99965 + noise * 0.4;
      v = baseVol * volProfile(m) * volMult * (0.8 + r() * 0.4) * (m === 20 ? 2.5 : 1);
    } else { c = px + noise * 3.5; v = baseVol * volProfile(m) * volMult * (0.8 + r() * 0.4); }
    let h = Math.max(o, c) + base * 0.0002 * r();
    let l = Math.min(o, c) - base * 0.0002 * r();
    if ((pattern === 'long' || pattern === 'fake') && m === 23) l = orH * 1.0002;
    if ((pattern === 'long' || pattern === 'fake') && m === 22) l = Math.max(l, orH * 1.0008);
    if (pattern === 'short' && m === 23) h = orL * 0.9998;
    if (pattern === 'short' && m === 22) h = Math.min(h, orL * 0.9992);
    if (m >= 0 && m < 15 && pattern !== 'flat') { h = Math.min(h, orH); l = Math.max(l, orL); if (m === 3) h = orH; if (m === 9) l = orL; }
    bars.push({ t, o, h, l, c, v: Math.round(v), vw: (o + h + l + c) / 4 });
    px = c;
  }
  return bars;
}

export function tradingDaysBack(endDate, n) {
  const out = [];
  let d = endDate;
  while (out.length < n) { d = addDays(d, -1); const wd = weekday(d); if (wd !== 0 && wd !== 6) out.unshift(d); }
  return out;
}

export function genDaily(endDate, n = 260, base = 100) {
  const days = tradingDaysBack(endDate, n);
  const r = rng(99);
  let px = base * 0.85;
  return days.map(d => {
    const o = px, c = px * (1 + (r() - 0.45) * 0.01);
    const b = { t: nyTimeOnDate(d, '00:00'), o, h: Math.max(o, c) * 1.02, l: Math.min(o, c) * 0.98, c, v: 1e6 };
    px = c; return b;
  }).map((b, i, arr) => (i === arr.length - 1 ? { ...b, c: base * 0.999, h: base * 1.0, l: base * 0.97 } : b));
}
