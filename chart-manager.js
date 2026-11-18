// Chart-Manager: TradingView Lightweight Charts 4.2 (Apache-2.0) – Kursachsen in EUR
import { fmtEUR, fmtNum } from './fx-service.js';
import { tzOffsetMs, BERLIN, dateStr } from './market-time.js';

const LWC = () => (typeof window !== 'undefined' ? window.LightweightCharts : null);
export const chartLibAvailable = () => !!LWC();

// Lightweight Charts rechnet in UTC → Verschiebung auf deutsche Ortszeit für die Achsenbeschriftung
export const toChartTime = ms => Math.floor((ms + tzOffsetMs(ms, BERLIN)) / 1000);

function themeColors() {
  const cs = getComputedStyle(document.documentElement);
  const v = n => cs.getPropertyValue(n).trim() || '#888';
  return { bg: v('--panel'), text: v('--text-dim'), grid: v('--grid'), up: v('--green'), down: v('--red'), border: v('--border') };
}
function baseOptions(el, height, timeVisible = true) {
  const c = themeColors();
  return {
    width: el.clientWidth || 600, height,
    layout: { background: { type: 'solid', color: c.bg }, textColor: c.text, fontSize: 11 },
    grid: { vertLines: { color: c.grid }, horzLines: { color: c.grid } },
    rightPriceScale: { borderColor: c.border },
    timeScale: { borderColor: c.border, timeVisible, secondsVisible: false, rightOffset: 4 },
    crosshair: { mode: 0 },
    localization: { locale: 'de-DE', priceFormatter: p => fmtEUR(p) },
  };
}
function uniqSorted(pts) {
  const m = new Map(); for (const p of pts) m.set(p.time, p);
  return [...m.values()].sort((a, b) => (a.time > b.time ? 1 : a.time < b.time ? -1 : 0));
}

export class DetailChart {
  constructor(container, subContainers) { this.el = container; this.sub = subContainers; this.charts = []; this.pairs = []; this.boxes = []; this.timer = null; }
  destroy() {
    clearInterval(this.timer); this.timer = null;
    if (this.ro) { this.ro.disconnect(); this.ro = null; }
    for (const c of this.charts) try { c.remove(); } catch { /* */ }
    this.charts = []; this.pairs = []; this.boxes.forEach(b => b.el.remove()); this.boxes = []; this.main = null; this.candle = null;
  }
  /** data: { candles (EUR), daily, lines{vwap,e9,e20,e50,e200}, levels, boxes, markers, subs{rsi,macd,atr,rvol} } */
  render(data) {
    this.destroy();
    const L = LWC();
    if (!L) { this.el.innerHTML = '<div class="chart-missing">Chartbibliothek nicht geladen (Internetverbindung / Werbeblocker prüfen). Analyse und Handelsplan funktionieren weiterhin.</div>'; return; }
    this.el.innerHTML = '';
    if (!data.candles.length) { this.el.innerHTML = '<div class="chart-missing">Keine Kerzen für diesen Zeitraum vorhanden.</div>'; return; }
    const c = themeColors();
    const tt = data.daily ? (ms => dateStr(ms)) : toChartTime;
    const chart = L.createChart(this.el, baseOptions(this.el, this.el.clientHeight || 420, !data.daily));
    this.main = chart; this.charts.push(chart); this.pairs.push([chart, this.el]);
    const candle = chart.addCandlestickSeries({ upColor: c.up, downColor: c.down, wickUpColor: c.up, wickDownColor: c.down, borderVisible: false });
    candle.setData(uniqSorted(data.candles.map(b => ({ time: tt(b.t), open: b.o, high: b.h, low: b.l, close: b.c }))));
    this.candle = candle;
    const times = data.candles.map(b => b.t);
    const snap = ms => { let lo = 0, hi = times.length - 1, r = null; while (lo <= hi) { const m = (lo + hi) >> 1; if (times[m] <= ms) { r = times[m]; lo = m + 1; } else hi = m - 1; } return r; };
    const vol = chart.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: 'vol', lastValueVisible: false, priceLineVisible: false });
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    vol.setData(uniqSorted(data.candles.map(b => ({ time: tt(b.t), value: b.v, color: b.c >= b.o ? c.up + '66' : c.down + '66' }))));
    const lineColors = { vwap: '#f5a623', e9: '#4fc3f7', e20: '#ba68c8', e50: '#90a4ae', e200: '#cfd8dc' };
    const lineNames = { vwap: 'VWAP', e9: 'EMA 9', e20: 'EMA 20', e50: 'EMA 50', e200: 'EMA 200' };
    for (const [k, pts] of Object.entries(data.lines || {})) {
      const clean = (pts || []).filter(p => p.v != null && Number.isFinite(p.v));
      if (!clean.length) continue;
      const s = chart.addLineSeries({ color: lineColors[k] || '#888', lineWidth: k === 'vwap' ? 2 : 1, priceLineVisible: false, lastValueVisible: false, title: lineNames[k] || k, crosshairMarkerVisible: false });
      s.setData(uniqSorted(clean.map(p => ({ time: tt(p.t), value: p.v }))));
    }
    for (const lv of data.levels || []) {
      if (lv.price == null || !Number.isFinite(lv.price)) continue;
      candle.createPriceLine({ price: lv.price, color: lv.color || '#888', lineWidth: lv.width || 1, lineStyle: lv.style ?? 2, axisLabelVisible: true, title: lv.title });
    }
    const mk = (data.markers || []).map(m => ({ ...m, t: m.t != null ? snap(m.t) : null })).filter(m => m.t != null).sort((a, b) => a.t - b.t);
    if (mk.length) candle.setMarkers(mk.map(m => ({ time: tt(m.t), position: m.position, color: m.color, shape: m.shape, text: m.text })));
    chart.timeScale().fitContent();
    for (const bx of data.boxes || []) {
      const f = snap(bx.from) ?? times[0], t2 = snap(bx.to);
      if (f == null || t2 == null || bx.top == null || bx.bottom == null) continue;
      const el = document.createElement('div');
      el.className = 'chart-box'; el.style.background = bx.color; el.title = bx.label || '';
      if (bx.label) el.innerHTML = `<span>${bx.label}</span>`;
      this.el.appendChild(el);
      this.boxes.push({ el, top: bx.top, bottom: bx.bottom, from: tt(f), to: tt(t2) });
    }
    this.timer = setInterval(() => this.updateBoxes(), 250);
    // Indikator-Subcharts (immer 5-Min-Intraday)
    const subDefs = [
      ['rsi', 'RSI 14 (5 Min)', [{ k: 'rsi', color: '#4fc3f7' }], [30, 50, 70]],
      ['macd', 'MACD 12/26/9 (5 Min)', [{ k: 'line', color: '#4fc3f7' }, { k: 'signal', color: '#f5a623' }, { k: 'hist', hist: true }], [0]],
      ['atr', 'ATR 14 (5 Min, USD)', [{ k: 'atr', color: '#ba68c8' }], []],
      ['rvol', 'Relatives Volumen kumuliert (IEX)', [{ k: 'rvol', color: '#26a69a' }], [1, 1.5, 2]],
    ];
    for (const [key, title, series, guides] of subDefs) {
      const host = this.sub[key]; if (!host) continue;
      host.innerHTML = `<div class="sub-title">${title}</div>`;
      const d = (data.subs || {})[key] || {};
      if (!(d[series[0].k] || []).some(p => p.v != null)) { host.querySelector('.sub-title').textContent += ' – keine Daten'; continue; }
      const box = document.createElement('div'); box.className = 'sub-chart'; host.appendChild(box);
      const o = baseOptions(box, 90, true);
      o.localization = { locale: 'de-DE', priceFormatter: p => fmtNum(p, 2) };
      o.timeScale.visible = key === 'rvol';
      const sc = L.createChart(box, o);
      this.charts.push(sc); this.pairs.push([sc, box]);
      let first = null;
      for (const sd of series) {
        const pts = uniqSorted((d[sd.k] || []).filter(p => p.v != null && Number.isFinite(p.v)).map(p => ({ time: toChartTime(p.t), value: p.v, ...(sd.hist ? { color: p.v >= 0 ? c.up + 'aa' : c.down + 'aa' } : {}) })));
        const s = sd.hist ? sc.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false }) : sc.addLineSeries({ color: sd.color, lineWidth: 1, priceLineVisible: false, lastValueVisible: true });
        s.setData(pts);
        if (!first) first = s;
      }
      for (const g of guides) first.createPriceLine({ price: g, color: c.border, lineWidth: 1, lineStyle: 2, axisLabelVisible: false });
      sc.timeScale().fitContent();
    }
    if (!data.daily) {
      const others = this.charts.slice(1);
      chart.timeScale().subscribeVisibleTimeRangeChange(r => { if (!r) return; for (const o of others) try { o.timeScale().setVisibleRange(r); } catch { /* */ } });
    }
    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(() => { for (const [ch, host] of this.pairs) try { ch.applyOptions({ width: host.clientWidth }); } catch { /* */ } });
      this.ro.observe(this.el);
    }
  }
  updateBoxes() {
    if (!this.main || !this.candle) return;
    const ts = this.main.timeScale();
    let bs = 6; try { bs = ts.options().barSpacing || 6; } catch { /* */ }
    for (const b of this.boxes) {
      const x1 = ts.timeToCoordinate(b.from), x2 = ts.timeToCoordinate(b.to);
      const y1 = this.candle.priceToCoordinate(b.top), y2 = this.candle.priceToCoordinate(b.bottom);
      if ([x1, x2, y1, y2].some(v => v == null)) { b.el.style.display = 'none'; continue; }
      const left = Math.min(x1, x2) - bs / 2, right = Math.max(x1, x2) + bs / 2;
      Object.assign(b.el.style, { display: 'block', left: `${left}px`, width: `${Math.max(2, right - left)}px`, top: `${Math.min(y1, y2)}px`, height: `${Math.max(1, Math.abs(y2 - y1))}px` });
    }
  }
}

/** Mini-Chart (SVG-Sparkline) für Karten */
export function sparkline(values, { w = 120, h = 34, color = 'var(--text-dim)', ref = null } = {}) {
  const v = values.filter(x => x != null && Number.isFinite(x));
  if (v.length < 2) return `<svg class="spark" width="${w}" height="${h}" aria-hidden="true"></svg>`;
  const lo = Math.min(...v, ref ?? Infinity), hi = Math.max(...v, ref ?? -Infinity);
  const sx = (w - 2) / (v.length - 1), sy = hi > lo ? (h - 4) / (hi - lo) : 1;
  const y = x => (h - 2 - (x - lo) * sy).toFixed(1);
  const pts = v.map((x, i) => `${(1 + i * sx).toFixed(1)},${y(x)}`).join(' ');
  const refLine = ref != null ? `<line x1="0" x2="${w}" y1="${y(ref)}" y2="${y(ref)}" stroke="var(--border)" stroke-dasharray="2 2"/>` : '';
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">${refLine}<polyline fill="none" stroke="${color}" stroke-width="1.5" points="${pts}"/></svg>`;
}
