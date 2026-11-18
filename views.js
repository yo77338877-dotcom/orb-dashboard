// Ansichten: Positionen, Trading-Journal, Backtesting, Einstellungen, Status & Hilfe
import { DEFAULT_SETTINGS, DEFAULT_WATCHLIST, SETTINGS_SCHEMA, MAX_WATCHLIST, CORRELATION_GROUP_LABELS, MARKET_SYMBOLS, STATES, ORB_WINDOW_START, APP_VERSION, stateColor } from './config.js';
import { fmtEUR, fmtNum, fmtPct, fmtSignedEUR } from './fx-service.js';
import { dateStr, addDays, fmtDateTime, fmtTime, BERLIN, NY } from './market-time.js';
import { metrics, performance } from './trade-journal.js';
import { positionOpenRisk } from './risk-management.js';
import { VARIANTS, backtestSymbol, summarize } from './backtest.js';
import { splitSessions, cacheGet, cacheSet, cacheClear } from './market-data.js';

let appModule = null; // Lazy-Import vermeidet Zirkelbezug beim Laden
async function appMod() { if (!appModule) appModule = await import('./app.js'); return appModule; }
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = v => { const x = parseFloat(String(v ?? '').replace(',', '.')); return Number.isFinite(x) ? x : null; };
const toLocalInput = ms => new Date(ms - new Date(ms).getTimezoneOffset() * 60000).toISOString().slice(0, 16);
const fx4 = v => (v != null && Number.isFinite(+v) ? +(+v).toFixed(4) : '');

let current = 'dashboard';
export function render(app, name) {
  current = name;
  ({ positions: renderPositions, journal: renderJournal, backtest: renderBacktest, settings: renderSettings, status: renderStatus }[name] || (() => {}))(app);
}
export function refreshActive(app) { if (current === 'positions' && !$('#posform')?.open) renderPositions(app); }

// ======================= Positionen =======================
function renderPositions(app) {
  const el = $('#tab-positions');
  const r = app.risk || { used: 0, limit: app.settings.capital * app.settings.maxDailyRiskPct / 100 };
  let html = `<div class="actions" style="margin-top:0"><button class="primary" id="p-new">+ Position erfassen</button><span class="tiny">Das Dashboard führt keine Orders aus. Hinweise basieren auf umgerechneten US-Referenzkursen.</span></div>
    <div class="kpis" style="margin-top:10px">
      <div class="kpi"><div class="v">${fmtEUR(r.used)}</div><div class="l">Genutztes Tagesrisiko (${app.settings.mode === 'paper' ? 'Paper' : 'echt'})</div></div>
      <div class="kpi ${r.used >= r.limit ? 'red' : 'green'}"><div class="v">${fmtEUR(Math.max(0, r.limit - r.used))}</div><div class="l">Verbleibend von ${fmtEUR(r.limit)}</div></div>
      <div class="kpi"><div class="v">${app.journal.open('real').length} / ${app.settings.maxPositions}</div><div class="l">Offene echte Positionen</div></div>
      <div class="kpi"><div class="v">${app.journal.open('paper').length}</div><div class="l">Offene Paper-Positionen</div></div>
    </div>`;
  for (const [kind, title] of [['real', 'Echte Positionen (manuell bei Trade Republic ausgeführt)'], ['paper', 'Paper-Trading-Positionen']]) {
    const list = app.journal.open(kind);
    html += `<h2 class="sec-title">${title}</h2>`;
    if (!list.length) { html += '<div class="empty">Keine offenen Positionen.</div>'; continue; }
    const groups = {};
    list.forEach(p => { if (p.group) groups[p.group] = (groups[p.group] || 0) + 1; });
    const corr = Object.entries(groups).filter(([, n]) => n > 1).map(([g, n]) => `${CORRELATION_GROUP_LABELS[g] || g}: ${n} Positionen`);
    if (corr.length) html += `<div class="note warn">Korrelierte Positionen – Risiken nicht unabhängig: ${esc(corr.join(', '))}</div>`;
    html += `<div class="table-wrap"><table class="grid"><thead><tr><th>Aktie</th><th class="num">Einstieg €</th><th class="num">Stück (Rest)</th><th class="num">Stop €</th><th class="num">TP1/2/3 €</th><th class="num">Referenz €</th><th class="num">Unreal. G/V</th><th class="num">Offenes Risiko</th><th>Status</th><th>Hinweise</th><th>Aktionen</th></tr></thead><tbody>`;
    for (const p of list) {
      const A = app.analyses[p.symbol];
      const mon = A?.position?.id === p.id ? A.monitor : null;
      const ref = A && app.fx.rate && A.price ? A.price / app.fx.rate : null;
      const st = mon?.state || STATES.POS_OPEN;
      html += `<tr data-id="${p.id}"><td><b>${p.symbol}</b><div class="tiny">${fmtDateTime(p.buyTime)}</div></td><td class="num">${fmtEUR(p.entry)}</td><td class="num">${p.shares} (${p.remainingShares})</td>
        <td class="num">${fmtEUR(p.stop)}${mon && mon.suggestedStop != null && mon.suggestedStop !== p.stop ? `<div class="tiny">Vorschlag ${fmtEUR(mon.suggestedStop)}</div>` : ''}</td>
        <td class="num">${(p.tps || []).map(v => (v == null ? '–' : fmtNum(v))).join(' / ') || '–'}</td><td class="num">${fmtEUR(ref)}</td>
        <td class="num ${mon?.pnlEUR >= 0 ? 'pos' : 'neg'}">${fmtSignedEUR(mon?.pnlEUR)}</td><td class="num">${fmtEUR(positionOpenRisk(p))}</td>
        <td><span class="badge ${stateColor(st)}">${esc(st)}</span></td>
        <td style="white-space:normal;min-width:220px">${(mon?.alerts || []).map(a => `<div class="tiny">• ${esc(a.text)}</div>`).join('') || '<span class="tiny">–</span>'}</td>
        <td><button data-act="exit">Verkauf erfassen</button> <button data-act="edit">Bearbeiten</button> <button data-act="del" class="danger">Löschen</button></td></tr>`;
    }
    html += '</tbody></table></div>';
  }
  el.innerHTML = html;
  $('#p-new').onclick = () => openPositionForm(app, { kind: app.settings.mode === 'paper' ? 'paper' : 'real', date: app.activeDay, buyTime: Date.now(), feeBuy: app.settings.feeBuy, fxAtOpen: app.fx.rate });
  el.querySelectorAll('tr[data-id] button').forEach(b => b.onclick = () => {
    const id = b.closest('tr').dataset.id;
    if (b.dataset.act === 'exit') openExitForm(app, id);
    if (b.dataset.act === 'edit') openPositionForm(app, app.journal.get(id));
    if (b.dataset.act === 'del' && confirm('Position wirklich löschen?')) { app.journal.remove(id); refreshAfterChange(app); }
  });
}

async function refreshAfterChange(app) { const m = await appMod(); m.analyzeAll(); m.renderAll(); render(app, current); }

export function openPositionForm(app, pre = {}) {
  const dlg = $('#posform');
  const isEdit = !!pre.id;
  const opts = app.watchlist.map(w => `<option value="${w.ticker}" ${w.ticker === pre.symbol ? 'selected' : ''}>${w.ticker} – ${esc(w.name)}</option>`).join('');
  const tps = pre.tps || [];
  dlg.innerHTML = `<div class="modal-head"><h2>${isEdit ? 'Position bearbeiten' : 'Position manuell erfassen'}</h2><span class="spacer"></span><button id="pf-x" aria-label="Schließen">✕</button></div>
  <form class="modal-body" id="pf"><div class="form-grid">
    <label>Art<select name="kind"><option value="real" ${pre.kind !== 'paper' ? 'selected' : ''}>Echter Trade (Trade Republic)</option><option value="paper" ${pre.kind === 'paper' ? 'selected' : ''}>Paper-Trade</option></select></label>
    <label>Aktie<select name="symbol">${opts}</select></label>
    <label>Tatsächlicher Einstiegskurs €<input name="entry" type="number" step="0.0001" min="0" required value="${fx4(pre.entry)}"></label>
    <label>Aktienanzahl<input name="shares" type="number" step="1" min="1" required value="${pre.shares || ''}"></label>
    <label>Kaufzeitpunkt<input name="buyTime" type="datetime-local" value="${toLocalInput(pre.buyTime || Date.now())}"></label>
    <label>Gebühr Kauf €<input name="feeBuy" type="number" step="0.01" min="0" value="${pre.feeBuy ?? app.settings.feeBuy}"></label>
    <label>Tatsächlich platzierter Stop Loss €<input name="stop" type="number" step="0.0001" min="0" value="${fx4(pre.stop)}"></label>
    <label>Take Profit 1 €<input name="tp1" type="number" step="0.0001" value="${fx4(tps[0])}"></label>
    <label>Take Profit 2 €<input name="tp2" type="number" step="0.0001" value="${fx4(tps[1])}"></label>
    <label>Take Profit 3 €<input name="tp3" type="number" step="0.0001" value="${fx4(tps[2])}"></label>
    <label>ORB-Strategie<select name="orb">${[5, 15, 30].map(m => `<option value="${m}" ${(+pre.orb || 15) === m ? 'selected' : ''}>${m} Min</option>`).join('')}</select></label>
    <label>Geplanter Einstieg €<input name="plannedEntry" type="number" step="0.0001" value="${fx4(pre.plannedEntry)}"></label>
  </div>
  <label class="tiny" style="display:block;margin-top:8px">Notizen<textarea name="notes" rows="3" style="width:100%">${esc(pre.notes || '')}</textarea></label>
  <div class="note" style="margin-top:8px">Nur erfassen, was tatsächlich bei Trade Republic ausgeführt wurde. Score ${pre.score ?? '–'} · RVOL ${fmtNum(pre.rvol)} · Signal ${pre.signalTime ? fmtTime(pre.signalTime, BERLIN) : '–'}</div>
  <div class="actions"><button type="submit" class="primary">Speichern</button><button type="button" id="pf-c">Abbrechen</button></div></form>`;
  dlg.showModal();
  $('#pf-x').onclick = () => dlg.close(); $('#pf-c').onclick = () => dlg.close();
  $('#pf').onsubmit = async ev => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    const entry = num(f.get('entry')), shares = parseInt(f.get('shares'), 10), stop = num(f.get('stop'));
    if (!(entry > 0) || !(shares > 0)) { alert('Einstiegskurs und Stückzahl müssen größer 0 sein.'); return; }
    if (stop != null && stop >= entry) { alert('Der Stop Loss muss unter dem Einstiegskurs liegen (Long).'); return; }
    const tpsN = [num(f.get('tp1')), num(f.get('tp2')), num(f.get('tp3'))];
    if (tpsN.some(t => t != null && t <= entry)) { alert('Take-Profit-Ziele müssen über dem Einstiegskurs liegen.'); return; }
    const sym = f.get('symbol');
    const meta = app.watchlist.find(w => w.ticker === sym) || {};
    const buyTime = new Date(f.get('buyTime')).getTime() || Date.now();
    const rec = { ...pre, kind: f.get('kind'), symbol: sym, group: meta.group, entry, shares, stop, initialStop: isEdit ? (pre.initialStop ?? stop) : stop,
      tps: tpsN, buyTime, feeBuy: num(f.get('feeBuy')) || 0, orb: +f.get('orb'), plannedEntry: num(f.get('plannedEntry')), notes: f.get('notes'), date: dateStr(buyTime) };
    if (!isEdit && rec.kind === 'real' && app.journal.open('real').length >= app.settings.maxPositions && !confirm(`Maximale Anzahl paralleler Positionen (${app.settings.maxPositions}) erreicht. Trotzdem erfassen?`)) return;
    if (isEdit) app.journal.update(pre.id, rec); else app.journal.add(rec);
    dlg.close(); (await appMod()).toast(isEdit ? 'Position aktualisiert' : 'Position erfasst – Überwachung aktiv', 'green');
    refreshAfterChange(app);
  };
}

function openExitForm(app, id) {
  const p = app.journal.get(id); if (!p) return;
  const A = app.analyses[p.symbol];
  const ref = A && app.fx.rate && A.price ? A.price / app.fx.rate : null;
  const dlg = $('#posform');
  dlg.innerHTML = `<div class="modal-head"><h2>Verkauf erfassen – ${p.symbol}</h2><span class="spacer"></span><button id="ef-x" aria-label="Schließen">✕</button></div>
  <form class="modal-body" id="ef"><div class="form-grid">
    <label>Tatsächlicher Verkaufskurs €<input name="price" type="number" step="0.0001" min="0" required value="${ref ? ref.toFixed(2) : ''}"></label>
    <label>Stück (Rest ${p.remainingShares})<input name="shares" type="number" step="1" min="1" max="${p.remainingShares}" required value="${p.remainingShares}"></label>
    <label>Gebühr Verkauf €<input name="fee" type="number" step="0.01" min="0" value="${app.settings.feeSell}"></label>
    <label>Zeitpunkt<input name="time" type="datetime-local" value="${toLocalInput(Date.now())}"></label>
    <label>Ausstiegsgrund<select name="reason">${['TP1', 'TP2', 'TP3', 'Stop Loss', 'Trailing Stop', 'Break-even-Stop', 'Invalidierung', 'Rückkehr in die Opening Range', 'VWAP-Verlust', 'Zeit-Exit', 'Manuell'].map(r => `<option>${r}</option>`).join('')}</select></label>
  </div><div class="note" style="margin-top:8px">Vorbelegt mit dem umgerechneten Referenzkurs – bitte den tatsächlichen Ausführungskurs aus Trade Republic eintragen.</div>
  <div class="actions"><button type="submit" class="primary">Speichern</button></div></form>`;
  dlg.showModal();
  $('#ef-x').onclick = () => dlg.close();
  $('#ef').onsubmit = ev => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    const price = num(f.get('price')), shares = parseInt(f.get('shares'), 10);
    if (!(price > 0) || !(shares > 0) || shares > p.remainingShares) { alert('Bitte gültigen Kurs und Stückzahl eingeben.'); return; }
    app.journal.addExit(id, { price, shares, fee: num(f.get('fee')) || 0, time: new Date(f.get('time')).getTime() || Date.now(), reason: f.get('reason') });
    dlg.close(); refreshAfterChange(app);
  };
}

// ======================= Journal =======================
let journalKind = 'real';
function perfCards(p) {
  const c = [['Trades', p.n], ['Gewinner', p.wins], ['Verlierer', p.losses], ['Trefferquote', p.hitRate == null ? '–' : fmtNum(p.hitRate, 1) + ' %'],
    ['Ø Gewinn', fmtEUR(p.avgWin)], ['Ø Verlust', fmtEUR(p.avgLoss)], ['Netto-Ergebnis', fmtSignedEUR(p.net)], ['Profit Factor', p.profitFactor === Infinity ? '∞' : fmtNum(p.profitFactor)],
    ['Expectancy / Trade', fmtSignedEUR(p.expectancy)], ['Max. Drawdown', fmtEUR(p.maxDD)], ['Ø Ergebnis in R', fmtNum(p.avgR)], ['Ø Haltedauer', p.avgHold == null ? '–' : fmtNum(p.avgHold, 0) + ' Min']];
  return `<div class="kpis">${c.map(([l, v]) => `<div class="kpi"><div class="v" style="font-size:18px">${v}</div><div class="l">${l}</div></div>`).join('')}</div>`;
}
function groupTable(title, obj) {
  const rows = Object.entries(obj || {}).sort((a, b) => b[1].pnl - a[1].pnl);
  if (!rows.length) return '';
  return `<div class="panel"><h3>${title}</h3><table class="plain"><tr><th></th><th class="num">Trades</th><th class="num">Treffer</th><th class="num">Netto €</th><th class="num">Ø R</th></tr>${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td class="num">${v.n}</td><td class="num">${fmtNum(v.wins / v.n * 100, 0)} %</td><td class="num ${v.pnl >= 0 ? 'pos' : 'neg'}">${fmtSignedEUR(v.pnl)}</td><td class="num">${v.rN ? fmtNum(v.rSum / v.rN) : '–'}</td></tr>`).join('')}</table></div>`;
}
function download(name, text, type) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); }
function renderJournal(app) {
  const el = $('#tab-journal');
  const trades = app.journal.closed(journalKind).map(e => { const m = metrics(e); return { pnl: m.pnl, r: m.r, symbol: e.symbol, orb: e.orb + '-Min-ORB', time: e.buyTime, holdMin: m.holdMin }; });
  const p = performance(trades);
  const all = app.journal.entries.filter(e => e.kind === journalKind).sort((a, b) => b.buyTime - a.buyTime);
  el.innerHTML = `<div class="toolbar" style="margin-top:0"><div class="seg"><button class="seg-btn ${journalKind === 'real' ? 'active' : ''}" data-k="real">Echte Trades</button><button class="seg-btn ${journalKind === 'paper' ? 'active' : ''}" data-k="paper">Paper Trading</button></div>
    <span class="spacer"></span><button id="j-csv">CSV-Export</button><button id="j-json">JSON-Backup</button><label class="tiny" style="display:inline-flex;gap:6px;align-items:center">JSON-Import <input type="file" id="j-imp" accept="application/json,.json"></label></div>
    <div class="note">Daten liegen nur lokal in diesem Browser. Echte Trades, Paper-Trades und Backtests werden strikt getrennt. Bitte regelmäßig ein JSON-Backup erstellen.</div>
    <h2 class="sec-title">Performance (${journalKind === 'real' ? 'echte Trades' : 'Paper Trading'}, abgeschlossen)</h2>${perfCards(p)}
    <div class="grid2" style="margin-top:12px">${groupTable('Ergebnis je Aktie', p.bySymbol)}${groupTable('Ergebnis je ORB-Strategie', p.byOrb)}</div>
    <h2 class="sec-title">Einträge</h2>
    <div class="table-wrap"><table class="grid"><thead><tr><th>Datum</th><th>Aktie</th><th>ORB</th><th>Signal</th><th class="num">Score</th><th class="num">RVOL</th><th class="num">Geplant €</th><th class="num">Einstieg €</th><th class="num">Stop €</th><th class="num">TP €</th><th class="num">Stück</th><th class="num">Größe €</th><th class="num">Ø Ausstieg €</th><th class="num">Haltedauer</th><th class="num">G/V €</th><th class="num">G/V %</th><th class="num">R</th><th class="num">Gebühren</th><th>Status</th><th>Notizen</th><th></th></tr></thead><tbody>
    ${all.map(e => { const m = metrics(e); return `<tr data-id="${e.id}"><td>${fmtDateTime(e.buyTime)}</td><td><b>${e.symbol}</b></td><td>${e.orb}</td><td>${e.signalTime ? fmtTime(e.signalTime, BERLIN) : '–'}</td><td class="num">${e.score ?? '–'}</td><td class="num">${fmtNum(e.rvol)}</td><td class="num">${fmtEUR(e.plannedEntry)}</td><td class="num">${fmtEUR(e.entry)}</td><td class="num">${fmtEUR(e.stop)}</td><td class="num">${(e.tps || []).filter(v => v != null).map(v => fmtNum(v)).join(' / ') || '–'}</td><td class="num">${e.shares}</td><td class="num">${fmtEUR(m.positionSize)}</td><td class="num">${fmtEUR(m.avgExit)}</td><td class="num">${m.holdMin != null ? m.holdMin + ' Min' : '–'}</td><td class="num ${m.pnl >= 0 ? 'pos' : 'neg'}">${e.exits.length ? fmtSignedEUR(m.pnl) : '–'}</td><td class="num">${e.exits.length ? fmtPct(m.pnlPct) : '–'}</td><td class="num">${fmtNum(m.r)}</td><td class="num">${fmtEUR(m.fees)}</td><td>${e.status === 'open' ? 'offen' : 'geschlossen'}</td><td style="white-space:normal;max-width:220px" class="tiny">${esc(e.notes)}</td><td><button data-act="edit">Bearbeiten</button> <button data-act="del" class="danger">Löschen</button></td></tr>`; }).join('') || '<tr><td colspan="21" class="dim">Noch keine Einträge.</td></tr>'}
    </tbody></table></div>`;
  el.querySelectorAll('[data-k]').forEach(b => b.onclick = () => { journalKind = b.dataset.k; renderJournal(app); });
  $('#j-csv').onclick = () => download(`orb-journal-${journalKind}-${dateStr(Date.now())}.csv`, '\ufeff' + app.journal.toCSV(journalKind), 'text/csv;charset=utf-8');
  $('#j-json').onclick = () => download(`orb-journal-backup-${dateStr(Date.now())}.json`, app.journal.toJSON(), 'application/json');
  $('#j-imp').onchange = async ev => {
    const file = ev.target.files[0]; if (!file) return;
    try { const n = app.journal.importJSON(await file.text(), confirm('Bestehende Einträge ersetzen? (Abbrechen = zusammenführen)')); alert(`${n} Einträge importiert.`); renderJournal(app); }
    catch (e) { alert('Import fehlgeschlagen: ' + e.message); }
  };
  el.querySelectorAll('tr[data-id] button').forEach(b => b.onclick = () => {
    const id = b.closest('tr').dataset.id;
    if (b.dataset.act === 'edit') openPositionForm(app, app.journal.get(id));
    if (b.dataset.act === 'del' && confirm('Eintrag wirklich löschen?')) { app.journal.remove(id); renderJournal(app); }
  });
}

// ======================= Backtesting =======================
const bt = { running: false, results: null, selected: 'base' };
function renderBacktest(app) {
  const el = $('#tab-backtest');
  if (bt.running) return;
  el.innerHTML = `<div class="panel"><h3>Backtest konfigurieren</h3>
    <div class="form-grid">
      <label>Testzeitraum<select id="bt-days"><option value="60">60 Handelstage</option><option value="90" selected>90 Handelstage</option><option value="126">ca. 6 Monate</option><option value="252">ca. 12 Monate</option></select></label>
      <label>Optimierungs- / Testzeitraum<select id="bt-split"><option value="0.5" selected>50 % / 50 %</option><option value="0.6">60 % / 40 %</option><option value="0.7">70 % / 30 %</option></select></label>
    </div>
    <h3 style="margin-top:12px">Aktien</h3><div class="form-grid">${app.watchlist.map(w => `<label class="chk"><input type="checkbox" class="bt-sym" value="${w.ticker}" checked> ${w.ticker}</label>`).join('')}</div>
    <h3 style="margin-top:12px">Varianten (getrennt ausgewertet)</h3><div class="form-grid">${VARIANTS.map(v => `<label class="chk"><input type="checkbox" class="bt-var" value="${v.id}" ${['base', 'orb5', 'orb15', 'orb30', 'noRetest'].includes(v.id) ? 'checked' : ''}> ${esc(v.label)}</label>`).join('')}</div>
    <div class="actions"><button class="primary" id="bt-run">Backtest starten</button><span class="tiny" id="bt-msg"></span></div>
    <div class="progress"><div id="bt-prog"></div></div>
    <div class="note" style="margin-top:10px">Gleiche Signal-Engine wie live · nur Daten bis zum Signalzeitpunkt · Einstieg zur Eröffnung der Folgekerze + Spread/Slippage · Gebühren je Order · berühren Stop und Ziel dieselbe Kerze, gilt der Stop · Euro mit EZB-Kurs des Vortags (<b>indikativ</b>) · Datenbasis Alpaca IEX · 20 Tage Aufwärmphase für RVOL. Erster Lauf mit echten Daten lädt ca. 10 Abfragen je Aktie (mehrere Minuten), danach Cache. Die Live-Strategie wird nie automatisch angepasst.</div>
  </div><div id="bt-results"></div>`;
  $('#bt-run').onclick = () => runBacktest(app);
  if (bt.results) renderBtResults(app);
}

async function runBacktest(app) {
  const m = await appMod();
  const syms = [...document.querySelectorAll('.bt-sym:checked')].map(x => x.value);
  const vars = VARIANTS.filter(v => document.querySelector(`.bt-var[value="${v.id}"]`)?.checked);
  const days = +$('#bt-days').value, split = +$('#bt-split').value;
  if (!syms.length || !vars.length) { alert('Bitte mindestens eine Aktie und eine Variante wählen.'); return; }
  if (!app.testMode && !app.settings.workerUrl) { alert('Für Backtests wird die Datenverbindung (Worker) benötigt.'); return; }
  bt.running = true;
  const msg = t => { const x = $('#bt-msg'); if (x) x.textContent = t; };
  const prog = p => { const x = $('#bt-prog'); if (x) x.style.width = Math.round(p * 100) + '%'; };
  $('#bt-run').disabled = true;
  try {
    const last = app.cal.prevTradingDay(dateStr(Date.now()));
    const list = [last];
    while (list.length < days + 20) list.unshift(app.cal.prevTradingDay(list[0]));
    const start = list[0], end = addDays(last, 1);
    const splitDate = list[20 + Math.floor(days * split)];
    const fxf = app.testMode ? await import('./tests/fixtures.js') : null;
    const loadSym = async sym => {
      if (app.testMode) {
        const r = fxf.rng(sym.length * 31 + sym.charCodeAt(0));
        const base = 100 + (sym.charCodeAt(0) % 20) * 9;
        const pats = ['flat', 'long', 'fake', 'short', 'flat'];
        return list.flatMap((d, i) => fxf.genDay({ date: d, base, pattern: i < 20 ? 'flat' : pats[Math.floor(r() * pats.length)], volMult: i < 20 ? 1 : 1 + r() * 1.6, seed: i * 7 + sym.length }));
      }
      const key = `bt:${sym}:${start}:${end}`;
      let b = await cacheGet(key);
      if (!b) { b = (await app.client.bars([sym], '1Min', start, end, n => msg(`${sym}: ${n.toLocaleString('de-DE')} Kerzen geladen …`)))[sym] || []; await cacheSet(key, b); }
      return b;
    };
    msg('Lade Marktindikatoren (SPY, QQQ) …');
    const idxSessions = {};
    for (const s of MARKET_SYMBOLS) idxSessions[s] = new Map(splitSessions(await loadSym(s), app.cal, t => dateStr(t)).map(x => [x.date, x.all]));
    if (app.testMode) { const h = {}; for (const d of list) h[d] = 1.1; h[addDays(start, -3)] = 1.1; app.fx.setHistory(h); }
    else if (!app.fx.rateBefore(list[20])) app.fx.setHistory((await app.client.fxHistory(addDays(start, -10), end)).rates);
    const res = Object.fromEntries(vars.map(v => [v.id, { variant: v, trades: [], stats: { days: 0, signals: 0, bearSignals: 0, missed: 0, falseBreakouts: 0, noFx: 0, sizeZero: 0 } }]));
    for (let i = 0; i < syms.length; i++) {
      const sym = syms[i];
      msg(`Analysiere ${sym} (${i + 1}/${syms.length}) …`); prog(i / syms.length);
      const sessions = splitSessions(await loadSym(sym), app.cal, t => dateStr(t));
      if (sessions.length < 25) { msg(`${sym}: zu wenig Daten (${sessions.length} Tage) – übersprungen`); continue; }
      const meta = app.watchlist.find(w => w.ticker === sym);
      const daily = app.testMode ? fxf.genDaily(last, 400, 100) : (app.data.daily[sym] || []);
      for (const v of vars) {
        const r = backtestSymbol({ symbol: sym, meta, sessions, daily, idxSessions, fx: app.fx, s: { ...app.settings, ...v.patch }, warmup: 20 });
        res[v.id].trades.push(...r.trades);
        for (const k of Object.keys(r.stats)) res[v.id].stats[k] += r.stats[k];
        await new Promise(r2 => setTimeout(r2, 0));
      }
    }
    for (const r of Object.values(res)) r.summary = summarize(r.trades, splitDate);
    bt.results = { res, splitDate, start: list[20], end: last, syms, testMode: app.testMode };
    bt.selected = vars[0].id;
    prog(1); msg('Fertig.');
  } catch (e) { msg('Fehler: ' + e.message); m.toast('Backtest fehlgeschlagen: ' + e.message, 'red'); }
  bt.running = false;
  const b = $('#bt-run'); if (b) b.disabled = false;
  renderBtResults(app);
}

function perfToGroup(obj) { return Object.fromEntries(Object.entries(obj || {}).map(([k, p]) => [k, { n: p.n, wins: p.wins, pnl: p.net, rSum: (p.avgR || 0) * p.n, rN: p.avgR != null ? p.n : 0 }])); }
function renderBtResults(app) {
  const R = bt.results; const host = $('#bt-results'); if (!R || !host) return;
  const row = r => { const a = r.summary.all, i = r.summary.inSample, o = r.summary.outSample; return `<tr data-v="${r.variant.id}" class="${bt.selected === r.variant.id ? 'row-blue' : ''}"><td>${esc(r.variant.label)}</td><td class="num">${a.n}</td><td class="num">${a.hitRate == null ? '–' : fmtNum(a.hitRate, 1) + ' %'}</td><td class="num ${a.net >= 0 ? 'pos' : 'neg'}">${fmtSignedEUR(a.net)}</td><td class="num">${a.profitFactor === Infinity ? '∞' : fmtNum(a.profitFactor)}</td><td class="num">${fmtSignedEUR(a.expectancy)}</td><td class="num">${fmtEUR(a.maxDD)}</td><td class="num">${fmtNum(a.avgR)}</td><td class="num">${fmtSignedEUR(i.net)} / ${fmtNum(i.profitFactor)}</td><td class="num">${fmtSignedEUR(o.net)} / ${fmtNum(o.profitFactor)}</td><td class="num">${r.stats.falseBreakouts}</td><td class="num">${r.stats.missed}</td><td class="num">${r.stats.bearSignals}</td></tr>`; };
  const sel = R.res[bt.selected], S = sel.summary;
  host.innerHTML = `${R.testMode ? '<div class="banner test" style="margin-top:12px">BACKTEST MIT SYNTHETISCHEN TESTDATEN – ERGEBNISSE OHNE AUSSAGEKRAFT</div>' : ''}
  <h2 class="sec-title">Variantenvergleich (${R.start} bis ${R.end}, ${R.syms.length} Aktien; Testzeitraum ab ${R.splitDate})</h2>
  <div class="table-wrap"><table class="grid"><thead><tr><th>Variante</th><th class="num">Trades</th><th class="num">Treffer</th><th class="num">Netto €</th><th class="num">PF</th><th class="num">Expectancy</th><th class="num">Max. DD</th><th class="num">Ø R</th><th class="num">Optimierung Netto/PF</th><th class="num">Test Netto/PF</th><th class="num">Fehlausbr.</th><th class="num">Verpasst</th><th class="num">Bär. Signale</th></tr></thead><tbody>${Object.values(R.res).map(row).join('')}</tbody></table></div>
  <h2 class="sec-title">Details: ${esc(sel.variant.label)} <button id="bt-csv" style="margin-left:8px">Trades als CSV</button></h2>
  ${S.all.n ? '' : '<div class="empty">Keine Trades – keine gültigen Setups im Zeitraum oder unzureichende Datenbasis. Bei strengen Regeln ein legitimes Ergebnis.</div>'}
  <div class="grid2"><div class="panel"><h3>Optimierungszeitraum</h3>${perfCards(S.inSample)}</div><div class="panel"><h3>Unabhängiger Testzeitraum</h3>${perfCards(S.outSample)}</div></div>
  <div class="grid3" style="margin-top:12px">${groupTable('Je Aktie', perfToGroup(S.bySymbol))}${groupTable('Je Wochentag', perfToGroup(S.byWeekday))}${groupTable('Je Einstiegszeitpunkt', perfToGroup(S.bySlot))}${groupTable('Je RVOL-Bereich', perfToGroup(S.byRvol))}${groupTable('Je Ausstiegsgrund', perfToGroup(S.byExit))}</div>
  <h2 class="sec-title">Trades (max. 300)</h2><div class="table-wrap" style="max-height:420px"><table class="grid"><thead><tr><th>Datum</th><th>Aktie</th><th>Einstieg NY</th><th class="num">Einstieg €</th><th class="num">Stop €</th><th class="num">Stück</th><th>Ausstieg</th><th class="num">Dauer</th><th class="num">G/V €</th><th class="num">R</th><th class="num">Score</th><th class="num">RVOL</th></tr></thead><tbody>
  ${sel.trades.slice(-300).reverse().map(t => `<tr><td>${t.date}</td><td>${t.symbol}</td><td>${fmtTime(t.entryT, NY)}</td><td class="num">${fmtEUR(t.entryEUR)}</td><td class="num">${fmtEUR(t.stopEUR)}</td><td class="num">${t.shares}</td><td>${esc(t.exitReason)}</td><td class="num">${t.holdMin} Min</td><td class="num ${t.pnl >= 0 ? 'pos' : 'neg'}">${fmtSignedEUR(t.pnl)}</td><td class="num">${fmtNum(t.r)}</td><td class="num">${t.score}</td><td class="num">${fmtNum(t.rvol)}</td></tr>`).join('')}</tbody></table></div>`;
  host.querySelectorAll('tr[data-v]').forEach(tr => tr.onclick = () => { bt.selected = tr.dataset.v; renderBtResults(app); });
  $('#bt-csv').onclick = () => {
    const cols = ['Datum', 'Aktie', 'ORB', 'Einstieg (UTC)', 'Einstieg €', 'Stop €', 'Stück', 'Ausstiegsgrund', 'Haltedauer Min', 'G/V €', 'R', 'Score', 'RVOL', 'EUR/USD'];
    const rows = sel.trades.map(t => [t.date, t.symbol, t.orb, new Date(t.entryT).toISOString(), t.entryEUR, t.stopEUR, t.shares, t.exitReason, t.holdMin, t.pnl, t.r, t.score, t.rvol, t.fxRate].map(v => (typeof v === 'number' ? String(Math.round(v * 10000) / 10000).replace('.', ',') : v)).join(';'));
    download(`orb-backtest-${bt.selected}.csv`, '\ufeff' + [cols.join(';'), ...rows].join('\r\n'), 'text/csv;charset=utf-8');
  };
}

// ======================= Einstellungen =======================
function currentToken() { return sessionStorage.getItem('orb.token') || localStorage.getItem('orb.token') || ''; }
function renderSettings(app) {
  const el = $('#tab-settings');
  const s = app.settings;
  const field = ([key, label, type, a, b, c]) => {
    const v = s[key];
    if (type === 'bool') return `<label class="chk"><input type="checkbox" data-key="${key}" ${v ? 'checked' : ''}> ${label}</label>`;
    if (type === 'select') return `<label>${label}<select data-key="${key}">${a.map(([val, l]) => `<option value="${val}" ${String(val) === String(v) ? 'selected' : ''}>${l}</option>`).join('')}</select></label>`;
    if (type === 'time') return `<label>${label}<input type="time" data-key="${key}" value="${v}"></label>`;
    return `<label>${label}<input type="number" data-key="${key}" value="${v}" min="${a}" max="${b}" step="${c}"></label>`;
  };
  el.innerHTML = `${app.testMode ? '<div class="note warn">Testmodus: Einstellungen werden getrennt von deinen echten Einstellungen gespeichert.</div>' : ''}
  <div class="grid2">
  <div class="panel"><h3>1. Datenverbindung (Cloudflare Worker)</h3>
    <div class="form-grid">
      <label>Worker-URL<input id="s-url" type="url" placeholder="https://orb-proxy.DEINNAME.workers.dev" value="${esc(s.workerUrl)}" autocomplete="off"></label>
      <label>Zugriffstoken (= Secret ACCESS_TOKEN)<input id="s-tok" type="password" autocomplete="off" value="${esc(currentToken())}"></label>
      <label class="chk"><input id="s-rem" type="checkbox" ${localStorage.getItem('orb.token') ? 'checked' : ''}> Token auf diesem Gerät merken</label>
    </div>
    <div class="actions"><button id="s-gen" title="Erzeugt ein zufälliges Token">Token generieren</button><button id="s-test">Verbindungstest</button><button class="primary" id="s-save">Speichern &amp; verbinden</button></div>
    <div id="s-testres"></div>
    <div class="note" style="margin-top:8px">Das Token ist <b>kein</b> API-Schlüssel – es schützt nur deinen Worker. Alpaca- und Twelve-Data-Schlüssel liegen ausschließlich als Secrets im Worker. Ohne „merken“ gilt das Token nur für diese Browsersitzung.</div>
    <h3 style="margin-top:14px">API-Limit-Status</h3>
    <div class="kv2"><span>Worker-Abfragen (letzte Minute)</span><span>${app.budget.perMin()} von max. ${app.budget.limit} (Client-Drossel)</span>
    <span>Aktien-Aktualisierung</span><span>alle ${s.pollSeconds} s · 1 Abfrage ≈ 2 Alpaca-Calls (Limit 200/Min)</span>
    <span>Wechselkurs</span><span>${esc(app.fx.sourceLabel())} · Worker-Cache 60 s während US-Handelszeit (≈ 550 von 800 Twelve-Data-Credits/Tag)</span>
    <span>Cloudflare Free</span><span>≈ ${Math.round(6.5 * 3600 / s.pollSeconds + 600)} Aufrufe/Handelstag von 100.000</span></div>
  </div>
  <div class="panel"><h3>Benachrichtigungen</h3>
    <div class="actions" style="margin-top:0"><button id="s-perm">Browser-Benachrichtigungen erlauben</button><span class="tiny">Status: ${'Notification' in window ? Notification.permission : 'nicht unterstützt'}</span></div>
    <div class="form-grid" style="margin-top:8px">${Object.entries({ open: 'US-Börsenöffnung', orDone: 'Abschluss Opening Range', breakout: 'Bestätigter Breakout', retest: 'Erfolgreicher Retest', longSetup: 'Bestätigtes Long-Setup', bearSetup: 'Bärisches Setup', inZone: 'Einstiegszone erreicht', missed: 'Einstieg verpasst', tp: 'Take Profit 1/2/3', sl: 'Stop Loss', invalid: 'Invalidierung / Exit', close: 'Börsenschluss', data: 'Datenprobleme' }).map(([k, l]) => `<label class="chk"><input type="checkbox" data-ev="${k}" ${s.notifyEvents[k] ? 'checked' : ''}> ${l}</label>`).join('')}</div>
    <div class="note" style="margin-top:8px">Benachrichtigungen kommen nur, solange das Dashboard im Browser geöffnet ist. Keine Hintergrundüberwachung.</div>
  </div></div>
  ${SETTINGS_SCHEMA.map(([title, fields]) => `<div class="panel" style="margin-top:14px"><h3>${title}</h3><div class="form-grid">${fields.map(field).join('')}</div></div>`).join('')}
  <div class="panel" style="margin-top:14px"><h3>Watchlist (max. ${MAX_WATCHLIST} Aktien) · SPY/QQQ sind feste Marktindikatoren</h3>
    <div class="table-wrap" style="max-height:none"><table class="grid" id="wl"><thead><tr><th>Ticker</th><th>Unternehmen</th><th>ISIN</th><th>WKN</th><th>Primärbörse</th><th>Branche</th><th>Korrelationsgruppe</th><th>Logo-URL (optional)</th><th></th></tr></thead><tbody>
    ${app.watchlist.map((w, i) => `<tr data-i="${i}"><td><input data-f="ticker" value="${esc(w.ticker)}" size="6"></td><td><input data-f="name" value="${esc(w.name)}"></td><td><input data-f="isin" value="${esc(w.isin || '')}" size="13"></td><td><input data-f="wkn" value="${esc(w.wkn || '')}" size="7"></td><td><select data-f="exchange">${['NASDAQ', 'NYSE', 'AMEX', 'NYSEARCA'].map(x => `<option ${x === w.exchange ? 'selected' : ''}>${x}</option>`).join('')}</select></td><td><input data-f="sector" value="${esc(w.sector || '')}"></td><td><select data-f="group">${Object.entries(CORRELATION_GROUP_LABELS).map(([k, l]) => `<option value="${k}" ${k === w.group ? 'selected' : ''}>${l}</option>`).join('')}</select></td><td><input data-f="logo" value="${esc(w.logo || '')}" placeholder="https://…"></td><td><button data-del="${i}" class="danger" aria-label="Entfernen">✕</button></td></tr>`).join('')}
    </tbody></table></div>
    <div class="actions"><button id="wl-add" ${app.watchlist.length >= MAX_WATCHLIST ? 'disabled' : ''}>+ Aktie hinzufügen</button><button class="primary" id="wl-save">Watchlist speichern &amp; Daten neu laden</button><button id="wl-reset">Standard-Watchlist</button></div>
    <div class="note">Handelbarkeit bitte in der Trade-Republic-App per ISIN prüfen – dafür gibt es keine offizielle Schnittstelle.</div>
  </div>
  <div class="panel" style="margin-top:14px"><h3>Wartung</h3><div class="actions" style="margin-top:0"><button id="m-cache">Daten-Cache leeren</button><button id="m-reset" class="danger">Einstellungen auf Standard</button><a href="?testmodus=1" target="_blank" rel="noopener">Testmodus öffnen (synthetische Daten)</a></div></div>`;

  el.querySelectorAll('[data-key]').forEach(inp => inp.addEventListener('change', async () => {
    const m = await appMod();
    const k = inp.dataset.key, def = DEFAULT_SETTINGS[k];
    let v = inp.type === 'checkbox' ? inp.checked : inp.value;
    if (typeof def === 'number') {
      v = num(v); if (v == null) { inp.value = s[k]; return; }
      if (inp.min !== '' && v < +inp.min) v = +inp.min; if (inp.max !== '' && v > +inp.max) v = +inp.max; inp.value = v;
    }
    s[k] = v;
    if (k === 'orbMinutes') { s.entryWindowStart = ORB_WINDOW_START[v]; const w = el.querySelector('[data-key="entryWindowStart"]'); if (w) w.value = s.entryWindowStart; m.toast(`Einstiegsfenster beginnt jetzt um ${s.entryWindowStart} New York (Ende der ${v}-Min-Range)`); }
    if (['tp1Pct', 'tp2Pct', 'tp3Pct'].includes(k) && s.tp1Pct + s.tp2Pct + s.tp3Pct !== 100) m.toast(`Teilverkäufe ergeben ${s.tp1Pct + s.tp2Pct + s.tp3Pct} % – bitte auf 100 % anpassen`, 'orange');
    if (k === 'entryWindowEnd' && s.entryWindowEnd <= s.entryWindowStart) m.toast('Ende des Einstiegsfensters liegt vor dem Beginn – bitte korrigieren', 'orange');
    m.saveSettings();
    if (k === 'mode' && v === 'backtest') m.switchTab('backtest');
    if (k === 'notifications' && v && 'Notification' in window && Notification.permission !== 'granted') await Notification.requestPermission();
    m.analyzeAll(); m.renderAll();
  }));
  el.querySelectorAll('[data-ev]').forEach(inp => inp.addEventListener('change', async () => { s.notifyEvents[inp.dataset.ev] = inp.checked; (await appMod()).saveSettings(); }));
  $('#s-perm').onclick = async () => { if (!('Notification' in window)) return; await Notification.requestPermission(); s.notifications = Notification.permission === 'granted'; (await appMod()).saveSettings(); renderSettings(app); };
  $('#s-gen').onclick = () => {
    const a = new Uint8Array(24); crypto.getRandomValues(a);
    const tok = [...a].map(x => x.toString(16).padStart(2, '0')).join('');
    $('#s-tok').value = tok; $('#s-tok').type = 'text';
    navigator.clipboard?.writeText(tok).catch(() => {});
    alert('Neues Token erzeugt und – falls erlaubt – in die Zwischenablage kopiert.\n\n1. Exakt diesen Wert im Cloudflare-Worker als Secret ACCESS_TOKEN eintragen und deployen.\n2. Danach hier „Speichern & verbinden“.');
  };
  $('#s-save').onclick = async () => {
    const m = await appMod();
    const url = $('#s-url').value.trim().replace(/\/+$/, '');
    if (url && !/^https:\/\/[^/]+$/.test(url)) { alert('Die Worker-URL muss so aussehen: https://orb-proxy.DEINNAME.workers.dev (ohne Pfad).'); return; }
    s.workerUrl = url; m.saveSettings(); m.setToken($('#s-tok').value.trim(), $('#s-rem').checked);
    m.toast('Gespeichert – verbinde …'); await m.startLive(); renderSettings(app);
  };
  $('#s-test').onclick = () => connectionTest();
  const readWl = () => [...el.querySelectorAll('#wl tbody tr')].map(tr => { const o = {}; tr.querySelectorAll('[data-f]').forEach(x => { o[x.dataset.f] = x.value.trim(); }); o.ticker = o.ticker.toUpperCase(); o.currency = 'USD'; o.tvSymbol = `${o.exchange}:${o.ticker}`; return o; });
  el.querySelectorAll('[data-del]').forEach(b => b.onclick = () => { app.watchlist = readWl(); app.watchlist.splice(+b.dataset.del, 1); renderSettings(app); });
  $('#wl-add').onclick = () => { app.watchlist = readWl(); if (app.watchlist.length < MAX_WATCHLIST) app.watchlist.push({ ticker: '', name: '', exchange: 'NASDAQ', group: 'other', currency: 'USD' }); renderSettings(app); };
  $('#wl-reset').onclick = () => { if (confirm('Standard-Watchlist wiederherstellen?')) { app.watchlist = DEFAULT_WATCHLIST.map(x => ({ ...x })); renderSettings(app); } };
  $('#wl-save').onclick = async () => {
    const wl = readWl().filter(w => w.ticker);
    const bad = wl.filter(w => !/^[A-Z]{1,6}(\.[A-Z])?$/.test(w.ticker));
    if (bad.length) { alert('Ungültige Ticker: ' + bad.map(b => b.ticker).join(', ')); return; }
    const dup = wl.map(w => w.ticker).filter((t, i, a) => a.indexOf(t) !== i);
    if (dup.length) { alert('Doppelte Ticker: ' + dup.join(', ')); return; }
    if (wl.some(w => MARKET_SYMBOLS.includes(w.ticker))) { alert('SPY und QQQ sind Marktindikatoren und keine Watchlist-Aktien.'); return; }
    if (!wl.length) { alert('Mindestens eine Aktie erforderlich.'); return; }
    app.watchlist = wl.slice(0, MAX_WATCHLIST);
    const m = await appMod(); m.saveWatchlist(); app.analyses = {};
    if (app.testMode) { location.reload(); return; }
    m.toast('Watchlist gespeichert – lade Daten neu …'); await m.startLive();
  };
  $('#m-cache').onclick = async () => { await cacheClear(); (await appMod()).toast('Cache geleert'); };
  $('#m-reset').onclick = async () => { if (confirm('Alle Einstellungen zurücksetzen? (Journal, Watchlist und Worker-URL bleiben erhalten)')) { const url = s.workerUrl; Object.assign(s, JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), { workerUrl: url }); (await appMod()).saveSettings(); renderSettings(app); } };
}

async function connectionTest() {
  const out = $('#s-testres');
  const url = $('#s-url').value.trim().replace(/\/+$/, ''), tok = $('#s-tok').value.trim();
  const rows = [];
  const show = () => { out.innerHTML = `<table class="plain" style="margin-top:8px">${rows.map(([n, ok, d]) => `<tr><td>${ok === true ? '<span class="pos">✓</span>' : ok === false ? '<span class="neg">✗</span>' : '<span class="dim">–</span>'}</td><td>${esc(n)}</td><td class="tiny">${esc(d)}</td></tr>`).join('')}</table>`; };
  const call = async (path, q = {}) => {
    const u = new URL(url + path); for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
    let r;
    try { r = await fetch(u, { headers: { 'X-ORB-Token': tok }, cache: 'no-store' }); }
    catch { throw new Error('Keine Antwort – Worker-URL falsch, Worker nicht deployt oder ALLOWED_ORIGINS passt nicht zu ' + location.origin); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
    return j;
  };
  if (!/^https:\/\/[^/]+$/.test(url)) { rows.push(['Worker-URL', false, 'Format: https://orb-proxy.DEINNAME.workers.dev (ohne Pfad)']); show(); return; }
  if (!tok) { rows.push(['Zugriffstoken', false, 'Bitte Token eintragen (identisch mit Secret ACCESS_TOKEN)']); show(); return; }
  rows.push(['Läuft …', null, '']); show(); rows.length = 0;
  try {
    const h = await call('/api/health');
    rows.push(['Worker erreichbar & Token gültig', true, `Version ${h.version}`]);
    rows.push(['Origin-Schutz (ALLOWED_ORIGINS)', h.originCheck ? true : null, h.originCheck ? `aktiv (diese Seite: ${location.origin})` : `nicht gesetzt – empfohlen: ${location.origin}`]);
    rows.push(['Alpaca-Secrets', h.secrets.alpaca, h.secrets.alpaca ? 'vorhanden' : 'ALPACA_KEY_ID / ALPACA_SECRET_KEY fehlen']);
    rows.push(['Twelve-Data-Secret', h.secrets.twelvedata, h.secrets.twelvedata ? 'vorhanden' : 'fehlt – nur EZB-Referenzkurs, keine Euro-Freigabe']);
    rows.push(['Finnhub (optional)', h.secrets.finnhub ? true : null, h.secrets.finnhub ? 'vorhanden' : 'nicht gesetzt – Ereignisstatus „unbekannt“']);
  } catch (e) { rows.push(['Worker erreichbar & Token gültig', false, e.message]); show(); return; }
  show();
  try { const d = await call('/api/live', { symbols: 'SPY', since: new Date(Date.now() - 25 * 3600000).toISOString() }); const s = d.snapshots?.SPY; rows.push(['Alpaca Marktdaten (IEX)', !!s, s ? `SPY letzter Trade ${fmtNum(s.latestTrade?.p)} USD · ${new Date(s.latestTrade?.t).toLocaleString('de-DE')}` : 'keine Daten']); }
  catch (e) { rows.push(['Alpaca Marktdaten (IEX)', false, e.message]); }
  show();
  try { const c = await call('/api/calendar', { start: dateStr(Date.now()), end: addDays(dateStr(Date.now()), 7) }); rows.push(['Alpaca Börsenkalender', Array.isArray(c.days), `${(c.days || []).length} Handelstage in den nächsten 7 Tagen`]); }
  catch (e) { rows.push(['Alpaca Börsenkalender', false, e.message + ' – lokale Feiertagstabelle wird genutzt']); }
  show();
  try { const f = await call('/api/fx'); rows.push(['EUR/USD-Wechselkurs', f.live, `${fmtNum(f.rate, 4)} · ${f.source === 'twelvedata' ? 'Twelve Data live' : 'EZB-Referenz (nicht live)'}${f.warning ? ' · ' + f.warning : ''}`]); }
  catch (e) { rows.push(['EUR/USD-Wechselkurs', false, e.message]); }
  show();
}

// ======================= Status & Hilfe =======================
function renderStatus(app) {
  const el = $('#tab-status');
  const ST = { ok: ['st-ok', 'Implementiert & automatisiert getestet'], nt: ['st-nt', 'Implementiert, Live-Verbindung nicht getestet'], cfg: ['st-cfg', 'Benötigt API-Konfiguration durch dich'], lim: ['st-lim', 'Durch kostenlose Daten eingeschränkt'] };
  const items = [
    ['ORB-Engine (5/15/30 Min), Breakout, Retest, Fehlausbrüche', ['ok']], ['Indikatoren VWAP, EMA, RSI, MACD, ATR, RVOL', ['ok']], ['Trading-Score, Pflichtkriterien, Zustandsmaschine', ['ok']],
    ['Entry/Stop/TP, Netto-CRV, Hindernisse', ['ok']], ['Positionsgröße, Tagesrisiko, Korrelation', ['ok']], ['EUR-Umrechnung & Formatierung', ['ok']], ['Sommer-/Winterzeit, Feiertage, verkürzte Tage', ['ok']],
    ['Backtest-Engine (gleiche Signal-Engine, konservativ)', ['ok']], ['Journal-Berechnungen, CSV/JSON', ['ok']], ['Worker-Schutz & Validierung (simulierte Antworten)', ['ok']],
    ['Alpaca-Live-Daten über Worker (IEX)', ['nt', 'cfg', 'lim']], ['EUR/USD live (Twelve Data), EZB-Rückfall', ['nt', 'cfg']], ['Börsenkalender von Alpaca', ['nt', 'cfg']],
    ['Quartalszahlen (Finnhub, optional)', ['nt', 'cfg', 'lim']], ['Oberfläche, Charts, Benachrichtigungen im echten Browser', ['nt']], ['Backtest mit echten Daten', ['nt', 'cfg', 'lim']],
    ['Trade-Republic-Kurse', ['lim']], ['WebSocket-Streaming', ['lim']],
  ];
  el.innerHTML = `<div class="grid2"><div class="panel"><h3>Implementierungsstatus (Version ${APP_VERSION})</h3><table class="plain">${items.map(([n, st]) => `<tr><td><b>${esc(n)}</b></td><td>${st.map(k => `<div class="${ST[k][0]} tiny">● ${ST[k][1]}</div>`).join('')}</td></tr>`).join('')}</table></div>
  <div class="panel"><h3>Wichtige Einschränkungen</h3><ul>
    <li><b>IEX statt Gesamtmarkt:</b> Alpaca Basic liefert Echtzeit nur vom Handelsplatz IEX (ca. 2–3 % des US-Volumens). RVOL vergleicht IEX mit IEX – konsistent, aber nicht das Gesamtvolumen. IEX und SIP werden nie vermischt.</li>
    <li><b>Kein WebSocket im Browser:</b> Der Alpaca-Stream bräuchte die Schlüssel im Browser. Stattdessen alle ${app.settings.pollSeconds} s gebündelte Abfrage über den Worker.</li>
    <li><b>Trade-Republic-Kurse:</b> keine offizielle Schnittstelle. Euro-Kurse sind umgerechnete US-Referenzkurse. „Einstieg innerhalb der Zone“ erst nach Eingabe von Brief-/Geldkurs.</li>
    <li><b>Wechselkurs:</b> Twelve Data Basic 8 Credits/Min, 800/Tag. Rückfall EZB-Referenz → keine Euro-Ausführungsfreigabe.</li>
    <li><b>Ereignisse:</b> nur Quartalszahlen über Finnhub (optional). Wirtschaftsdaten und Notenbanktermine: „unbekannt“.</li>
    <li><b>Benachrichtigungen</b> nur bei geöffnetem Browser-Tab.</li>
    <li><b>Backtests</b> mit IEX-1-Minuten-Daten; Euro-Werte indikativ. Survivorship Bias: die Watchlist besteht aus heute bekannten Großwerten.</li>
  </ul></div></div>
  <div class="panel" style="margin-top:14px"><h3>Täglicher Ablauf</h3><ol>
    <li>Dashboard vor 15:30 Uhr öffnen (in den Wochen unterschiedlicher Zeitumstellung 14:30 Uhr – wird automatisch angezeigt). Späteres Öffnen ist möglich, die Opening Range wird rekonstruiert.</li>
    <li>Grünes Signal → Detailansicht → Brief- und Geldkurs aus Trade Republic eintragen.</li>
    <li>Nur bei <b>EINSTIEG INNERHALB DER ZONE</b> manuell kaufen; Stop sofort setzen.</li>
    <li>Kauf unter „Position manuell erfassen“ eintragen – das Dashboard überwacht Ziele, Stop und Exit-Signale.</li>
    <li>Verkäufe unter „Positionen → Verkauf erfassen“ eintragen.</li>
  </ol><p class="tiny">Testmodus mit synthetischen Daten: <a href="?testmodus=1" target="_blank" rel="noopener">?testmodus=1</a></p></div>`;
}
