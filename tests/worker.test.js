// Worker-Tests mit simulierten Upstream-Antworten (kein echter API-Zugriff)
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';

const env = { ACCESS_TOKEN: 'geheim-123', ALPACA_KEY_ID: 'k', ALPACA_SECRET_KEY: 's', TWELVEDATA_KEY: 't', ALLOWED_ORIGINS: 'https://user.github.io/' };
const calls = [];
globalThis.fetch = async (url, init) => {
  const u = String(url); calls.push({ u, init });
  if (u.includes('/v2/stocks/snapshots')) return Response.json({ SPY: { latestTrade: { p: 600, t: new Date().toISOString() } } });
  if (u.includes('/v2/stocks/bars')) return Response.json({ bars: { SPY: [{ t: new Date().toISOString(), o: 1, h: 1, l: 1, c: 1, v: 1 }] }, next_page_token: null });
  if (u.includes('/v2/calendar')) return Response.json([{ date: '2026-11-18', open: '09:30', close: '16:00' }]);
  if (u.includes('twelvedata')) return Response.json({ symbol: 'EUR/USD', rate: 1.0912, timestamp: Math.floor(Date.now() / 1000) });
  if (u.includes('frankfurter')) return Response.json({ date: '2026-11-17', rates: { USD: 1.09 } });
  return new Response('not found', { status: 404 });
};
const req = (path, headers = {}, e = env) => worker.fetch(new Request('https://w.example' + path, { headers: { Origin: 'https://user.github.io', 'X-ORB-Token': 'geheim-123', ...headers } }), e);

test('Startseite ohne Token: Lebenszeichen ohne Daten', async () => {
  const r = await worker.fetch(new Request('https://w.example/'), env);
  assert.equal(r.status, 200); assert.match((await r.json()).service, /läuft/);
});
test('Falsches Token → 401, fremde Origin → 403, ohne ACCESS_TOKEN gesperrt', async () => {
  assert.equal((await req('/api/health', { 'X-ORB-Token': 'falsch' })).status, 401);
  assert.equal((await req('/api/health', { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await req('/api/health', {}, { ...env, ACCESS_TOKEN: '' })).status, 500);
});
test('ALLOWED_ORIGINS mit Schrägstrich am Ende wird toleriert', async () => {
  const r = await req('/api/health');
  assert.equal(r.status, 200); assert.equal(r.headers.get('Access-Control-Allow-Origin'), 'https://user.github.io');
});
test('Ohne ALLOWED_ORIGINS: Origin gespiegelt, Token schützt weiter', async () => {
  const e = { ...env, ALLOWED_ORIGINS: '' };
  const r = await req('/api/health', {}, e);
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), 'https://user.github.io');
  assert.equal((await r.json()).originCheck, false);
  assert.equal((await req('/api/health', { 'X-ORB-Token': 'x' }, e)).status, 401);
});
test('Health meldet Secrets, gibt sie aber nie aus', async () => {
  const j = await (await req('/api/health')).json();
  assert.equal(j.secrets.alpaca, true); assert.ok(!JSON.stringify(j).includes('geheim-123')); assert.ok(!JSON.stringify(j).includes('"k"'));
});
test('Ungültige Parameter → 400', async () => {
  assert.equal((await req('/api/live?symbols=SPY;DROP&since=' + new Date().toISOString())).status, 400);
  const many = Array.from({ length: 30 }, (_, i) => 'A' + String.fromCharCode(65 + (i % 26)) + (i > 25 ? 'X' : '')).join(',');
  assert.equal((await req('/api/live?symbols=' + many + '&since=' + new Date().toISOString())).status, 400);
  assert.equal((await req('/api/bars?symbols=SPY&timeframe=2Min&start=2026-11-17')).status, 400);
  assert.equal((await req('/api/bars?symbols=SPY&timeframe=1Min')).status, 400);
});
test('Live: nur feed=iex, Schlüssel nur an Alpaca', async () => {
  calls.length = 0;
  const r = await req('/api/live?symbols=SPY&since=' + new Date(Date.now() - 60000).toISOString());
  assert.equal(r.status, 200);
  const alp = calls.filter(c => c.u.includes('alpaca'));
  assert.equal(alp.length, 2);
  for (const c of alp) { assert.match(c.u, /feed=iex/); assert.equal(c.init.headers['APCA-API-KEY-ID'], 'k'); }
  for (const c of calls.filter(c => !c.u.includes('alpaca'))) assert.ok(!JSON.stringify(c.init || {}).includes('APCA'));
});
test('FX live über Twelve Data, Cache verhindert Mehrfachabruf', async () => {
  calls.length = 0;
  const a = await (await req('/api/fx')).json(); const b = await (await req('/api/fx')).json();
  assert.equal(a.live, true); assert.equal(a.rate, 1.0912); assert.equal(b.cached, true);
  assert.equal(calls.filter(c => c.u.includes('twelvedata')).length, 1);
});
test('Bars: Rohdaten-Durchreichung, Kalender', async () => {
  assert.equal((await (await req('/api/bars?symbols=SPY&timeframe=1Min&start=2026-11-17')).json()).bars.SPY.length, 1);
  assert.equal((await (await req('/api/calendar?start=2026-11-18&end=2026-11-19')).json()).days.length, 1);
});
test('Alpaca 403 → verständliche Fehlermeldung', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => new Response('forbidden', { status: 403 });
  const r = await req('/api/bars?symbols=MSFT&timeframe=1Day&start=2026-01-01');
  globalThis.fetch = orig;
  assert.equal(r.status, 502); assert.match((await r.json()).error, /Schlüssel ab/);
});
test('OPTIONS-Preflight', async () => {
  assert.equal((await worker.fetch(new Request('https://w.example/api/fx', { method: 'OPTIONS', headers: { Origin: 'https://user.github.io' } }), env)).status, 204);
});
