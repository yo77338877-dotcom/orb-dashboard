// Technische Indikatoren – reine Funktionen ohne DOM-Zugriff
// Bar-Format: { t: ms (Kerzenbeginn UTC), o, h, l, c, v, vw? }

export function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = 0;
  for (let i = 0; i < period; i++) prev += values[i];
  prev /= period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) { prev = values[i] * k + prev * (1 - k); out[i] = prev; }
  return out;
}

export function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) { const d = closes[i] - closes[i - 1]; if (d >= 0) gain += d; else loss -= d; }
  let ag = gain / period, al = loss / period;
  out[period] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + Math.max(d, 0)) / period;
    al = (al * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return out;
}

export function macd(closes, fast = 12, slow = 26, signal = 9) {
  const ef = ema(closes, fast), es = ema(closes, slow);
  const line = closes.map((_, i) => (ef[i] != null && es[i] != null ? ef[i] - es[i] : null));
  const first = line.findIndex(v => v != null);
  const sig = new Array(closes.length).fill(null);
  if (first >= 0) ema(line.slice(first), signal).forEach((v, j) => { sig[first + j] = v; });
  const hist = line.map((v, i) => (v != null && sig[i] != null ? v - sig[i] : null));
  return { line, signal: sig, hist };
}

export function trueRange(bars) {
  return bars.map((b, i) => (i === 0 ? b.h - b.l : Math.max(b.h - b.l, Math.abs(b.h - bars[i - 1].c), Math.abs(b.l - bars[i - 1].c))));
}

export function atr(bars, period = 14) {
  const tr = trueRange(bars);
  const out = new Array(bars.length).fill(null);
  if (bars.length < period) return out;
  let a = 0;
  for (let i = 0; i < period; i++) a += tr[i];
  a /= period; out[period - 1] = a;
  for (let i = period; i < bars.length; i++) { a = (a * (period - 1) + tr[i]) / period; out[i] = a; }
  return out;
}

// Session-VWAP (nur Kerzen der regulären Sitzung übergeben). Nutzt Bar-VWAP (vw), falls vorhanden.
export function sessionVwap(bars) {
  let pv = 0, vol = 0;
  return bars.map(b => {
    const px = b.vw != null && b.vw > 0 ? b.vw : (b.h + b.l + b.c) / 3;
    pv += px * b.v; vol += b.v;
    return vol > 0 ? pv / vol : null;
  });
}

// 1-Min → N-Min, verankert an anchorMs (Börsenöffnung)
export function aggregate(bars, minutes, anchorMs = 0) {
  const size = minutes * 60000;
  const out = [];
  let cur = null;
  for (const b of bars) {
    const bucket = anchorMs + Math.floor((b.t - anchorMs) / size) * size;
    if (!cur || cur.t !== bucket) {
      if (cur) out.push(cur);
      cur = { t: bucket, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, vwSum: (b.vw ?? b.c) * b.v, n: 1 };
    } else {
      cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l); cur.c = b.c; cur.v += b.v; cur.vwSum += (b.vw ?? b.c) * b.v; cur.n++;
    }
  }
  if (cur) out.push(cur);
  return out.map(x => ({ t: x.t, o: x.o, h: x.h, l: x.l, c: x.c, v: x.v, vw: x.v > 0 ? x.vwSum / x.v : x.c, n: x.n }));
}

// Swings – erst nach `right` Folgekerzen bekannt (kein Look-ahead)
export function swings(bars, left = 2, right = 2) {
  const res = [];
  for (let i = left; i < bars.length - right; i++) {
    let hi = true, lo = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      if (bars[j].h >= bars[i].h) hi = false;
      if (bars[j].l <= bars[i].l) lo = false;
    }
    if (hi) res.push({ type: 'high', price: bars[i].h, t: bars[i].t, knownAt: bars[i + right].t });
    if (lo) res.push({ type: 'low', price: bars[i].l, t: bars[i].t, knownAt: bars[i + right].t });
  }
  return res;
}

export function last(arr) { for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i]; return null; }

// RVOL-Basis: kumuliertes Volumen je Bucket seit Börsenöffnung, gemittelt über vergangene Sitzungen
export function rvolBaseline(sessions, bucketMin = 5) {
  const maxBuckets = Math.ceil(390 / bucketMin) + 1;
  const sums = new Array(maxBuckets).fill(0), cnt = new Array(maxBuckets).fill(0), barSums = new Array(maxBuckets).fill(0);
  for (const s of sessions) {
    const per = new Array(maxBuckets).fill(0);
    for (const b of s.bars) {
      const k = Math.floor((b.t - s.openMs) / (bucketMin * 60000));
      if (k >= 0 && k < maxBuckets) per[k] += b.v;
    }
    let cum = 0;
    const lastBucket = Math.floor((s.closeMs - s.openMs) / (bucketMin * 60000));
    for (let k = 0; k < maxBuckets && k < lastBucket; k++) { cum += per[k]; sums[k] += cum; barSums[k] += per[k]; cnt[k]++; }
  }
  return {
    bucketMin, days: sessions.length,
    cumAvg: sums.map((s, k) => (cnt[k] ? s / cnt[k] : null)),
    bucketAvg: barSums.map((s, k) => (cnt[k] ? s / cnt[k] : null)),
  };
}

export function sessionRvol(baseline, todayBars, openMs, atMs) {
  if (!baseline || baseline.days < 5) return null;
  const bm = baseline.bucketMin * 60000;
  const k = Math.floor((atMs - openMs) / bm) - 1;
  if (k < 0) return null;
  const endMs = openMs + (k + 1) * bm;
  const vol = todayBars.filter(b => b.t >= openMs && b.t < endMs).reduce((a, b) => a + b.v, 0);
  const base = baseline.cumAvg[k];
  return base ? vol / base : null;
}

export function intervalRvol(baseline, todayBars, openMs, fromMs, toMs) {
  if (!baseline || baseline.days < 5) return null;
  const bm = baseline.bucketMin * 60000;
  const vol = todayBars.filter(b => b.t >= fromMs && b.t < toMs).reduce((a, b) => a + b.v, 0);
  let base = 0;
  const k0 = Math.floor((fromMs - openMs) / bm), k1 = Math.ceil((toMs - openMs) / bm);
  for (let k = k0; k < k1; k++) {
    const bucketStart = openMs + k * bm, bucketEnd = bucketStart + bm;
    const overlap = Math.max(0, Math.min(toMs, bucketEnd) - Math.max(fromMs, bucketStart)) / bm;
    base += (baseline.bucketAvg[k] || 0) * overlap;
  }
  return base > 0 ? vol / base : null;
}
