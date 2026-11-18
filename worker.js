// ORB Trading Intelligence Dashboard – Cloudflare Worker (kostenloser Tarif)
// Geschützter Proxy zu Alpaca (IEX), Twelve Data (EUR/USD), Frankfurter (EZB) und optional Finnhub.
//
// Secrets (Worker → Settings → Variables and Secrets → Typ "Secret"):
//   ALPACA_KEY_ID, ALPACA_SECRET_KEY, TWELVEDATA_KEY, ACCESS_TOKEN, (optional) FINNHUB_KEY
// Variable (Typ "Text"):
//   ALLOWED_ORIGINS   z. B. https://deinname.github.io   (ohne Pfad, ohne "/" am Ende)
//
// Schutz: Zugriffstoken (X-ORB-Token) + Origin-Prüfung + Rate-Limit je IP + Parameter-Validierung + Caching.

const ALPACA_DATA = 'https://data.alpaca.markets';
const ALPACA_TRADING = 'https://paper-api.alpaca.markets'; // nur Börsenkalender (Paper-Konto genügt)
const VERSION = '2.1.0';
const SYMBOL_RE = /^[A-Z]{1,6}(\.[A-Z])?$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z)?$/;
const MAX_SYMBOLS = 24;
const RATE_LIMIT_PER_MIN = 90;

const memCache = new Map(); // isolate-lokal (best effort)
const ipHits = new Map();

class BadRequest extends Error {}

function allowedOrigins(env) { return String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean); }
function cors(origin, env) {
  const allowed = allowedOrigins(env);
  // Ohne ALLOWED_ORIGINS wird die anfragende Origin gespiegelt; Schutz erfolgt dann allein über das Token.
  const acao = allowed.length ? (allowed.includes(origin) ? origin : allowed[0]) : (origin || '*');
  return {
    'Access-Control-Allow-Origin': acao,
    'Access-Control-Allow-Headers': 'X-ORB-Token, Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Max-Age': '7200',
    'Vary': 'Origin',
  };
}
function json(data, status, headers) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers } });
}
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || !a.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
function rateLimited(ip) {
  const now = Date.now();
  const arr = (ipHits.get(ip) || []).filter(t => now - t < 60000);
  arr.push(now); ipHits.set(ip, arr);
  if (ipHits.size > 5000) ipHits.clear();
  return arr.length > RATE_LIMIT_PER_MIN;
}
function parseSymbols(str) {
  const list = String(str || '').toUpperCase().split(',').map(s => s.trim()).filter(Boolean);
  if (!list.length || list.length > MAX_SYMBOLS) throw new BadRequest(`1–${MAX_SYMBOLS} Symbole erforderlich`);
  for (const s of list) if (!SYMBOL_RE.test(s)) throw new BadRequest('Ungültiges Symbol: ' + s);
  return [...new Set(list)];
}
function isoParam(v, name) { if (v && !ISO_RE.test(v)) throw new BadRequest('Ungültiger Parameter ' + name); return v; }

async function cached(key, ttlMs, fn) {
  const hit = memCache.get(key);
  const now = Date.now();
  if (hit && now - hit.t < ttlMs) return { ...hit.v, cached: true, upstreamCalls: 0 };
  const v = await fn();
  memCache.set(key, { t: now, v });
  while (memCache.size > 40) memCache.delete(memCache.keys().next().value);
  return v;
}

function alpacaHeaders(env) {
  if (!env.ALPACA_KEY_ID || !env.ALPACA_SECRET_KEY) throw new Error('Alpaca-Secrets fehlen im Worker (ALPACA_KEY_ID / ALPACA_SECRET_KEY)');
  return { 'APCA-API-KEY-ID': env.ALPACA_KEY_ID, 'APCA-API-SECRET-KEY': env.ALPACA_SECRET_KEY, Accept: 'application/json' };
}
async function alpacaRaw(env, path, params, base = ALPACA_DATA) {
  const u = new URL(base + path);
  for (const [k, v] of Object.entries(params || {})) if (v != null && v !== '') u.searchParams.set(k, v);
  const r = await fetch(u, { headers: alpacaHeaders(env) });
  const txt = await r.text();
  if (r.status === 429) throw new Error('Alpaca Rate-Limit erreicht (429) – bitte kurz warten');
  if (r.status === 401 || r.status === 403) throw new Error(`Alpaca lehnt die Schlüssel ab (HTTP ${r.status}) – Key ID/Secret prüfen`);
  if (!r.ok) throw new Error(`Alpaca HTTP ${r.status}: ${txt.slice(0, 200)}`);
  return txt;
}
async function alpaca(env, path, params, base) { return JSON.parse(await alpacaRaw(env, path, params, base)); }

function nyClock() {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hourCycle: 'h23', weekday: 'short' }).formatToParts(new Date());
  const g = t => p.find(x => x.type === t)?.value;
  return { h: +g('hour') + +g('minute') / 60, wd: g('weekday') };
}

async function fxLive(env) {
  // 60 s während 09:00–16:15 NY an Werktagen, sonst 15 Min → ca. 550 von 800 Twelve-Data-Credits pro Tag
  const { h, wd } = nyClock();
  const active = !['Sat', 'Sun'].includes(wd) && h >= 9 && h <= 16.25;
  return cached('fx', active ? 55000 : 15 * 60000, async () => {
    let tdError = env.TWELVEDATA_KEY ? null : 'kein TWELVEDATA_KEY';
    if (env.TWELVEDATA_KEY) {
      try {
        const r = await fetch(`https://api.twelvedata.com/exchange_rate?symbol=EUR/USD&apikey=${encodeURIComponent(env.TWELVEDATA_KEY)}`);
        const d = await r.json();
        if (r.ok && d && d.rate && !d.code) {
          return { rate: +d.rate, ts: d.timestamp ? d.timestamp * 1000 : Date.now(), source: 'twelvedata', live: true, upstreamCalls: 1 };
        }
        tdError = d && d.message ? d.message : `HTTP ${r.status}`;
      } catch (e) { tdError = e.message; }
    }
    // Rückfall: EZB-Referenzkurs (nicht live → keine Euro-Ausführungsfreigabe)
    const r2 = await fetch('https://api.frankfurter.dev/v1/latest?base=EUR&symbols=USD');
    const d2 = await r2.json();
    if (!d2 || !d2.rates || !d2.rates.USD) throw new Error('Kein Wechselkurs verfügbar');
    return { rate: +d2.rates.USD, ts: Date.parse(d2.date + 'T14:15:00Z'), refDate: d2.date, source: 'frankfurter', live: false,
      warning: `Twelve Data nicht verfügbar (${tdError}) – EZB-Tagesreferenzkurs, keine Euro-Ausführungsfreigabe`, upstreamCalls: 2 };
  });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const h = cors(origin, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
    if (request.method !== 'GET') return json({ error: 'Nur GET erlaubt' }, 405, h);
    const url = new URL(request.url);

    // Startseite ohne Token: reine Lebenszeichen-Prüfung, keine Daten
    if (url.pathname === '/' || url.pathname === '') {
      return json({ ok: true, service: 'ORB-Worker läuft', version: VERSION, hinweis: 'Daten nur über /api/... mit Zugriffstoken' }, 200, h);
    }

    const allowed = allowedOrigins(env);
    if (allowed.length && origin && !allowed.includes(origin)) return json({ error: `Origin ${origin} nicht erlaubt – ALLOWED_ORIGINS prüfen` }, 403, h);
    if (!env.ACCESS_TOKEN) return json({ error: 'ACCESS_TOKEN fehlt im Worker – Zugriff gesperrt' }, 500, h);
    if (!timingSafeEqual(request.headers.get('X-ORB-Token') || '', env.ACCESS_TOKEN)) return json({ error: 'Zugriffstoken ungültig' }, 401, h);
    if (rateLimited(request.headers.get('CF-Connecting-IP') || 'x')) return json({ error: 'Zu viele Anfragen – bitte kurz warten' }, 429, h);

    const q = url.searchParams;
    try {
      switch (url.pathname) {
        case '/api/health':
          return json({ ok: true, service: 'orb-worker', version: VERSION, time: new Date().toISOString(), feed: 'iex', originCheck: allowed.length > 0,
            secrets: { alpaca: !!(env.ALPACA_KEY_ID && env.ALPACA_SECRET_KEY), twelvedata: !!env.TWELVEDATA_KEY, finnhub: !!env.FINNHUB_KEY }, upstreamCalls: 0 }, 200, h);
        case '/api/calendar': {
          const start = isoParam(q.get('start'), 'start'), end = isoParam(q.get('end'), 'end');
          const d = await cached(`cal:${start}:${end}`, 6 * 3600000, async () => ({ days: await alpaca(env, '/v2/calendar', { start, end }, ALPACA_TRADING), upstreamCalls: 1 }));
          return json(d, 200, h);
        }
        case '/api/live': {
          const symbols = parseSymbols(q.get('symbols'));
          const since = isoParam(q.get('since'), 'since');
          if (!since) throw new BadRequest('Parameter since fehlt');
          if (!(Date.now() - Date.parse(since) < 26 * 3600000)) throw new BadRequest('since darf max. 26 h zurückliegen');
          const d = await cached(`live:${symbols.join(',')}:${since}`, 8000, async () => {
            const [snap, bars] = await Promise.all([
              alpaca(env, '/v2/stocks/snapshots', { symbols: symbols.join(','), feed: 'iex' }),
              alpaca(env, '/v2/stocks/bars', { symbols: symbols.join(','), timeframe: '1Min', start: since, feed: 'iex', adjustment: 'split', limit: 10000, sort: 'asc' }),
            ]);
            return { snapshots: snap, bars: bars.bars || {}, next_page_token: bars.next_page_token || null, feed: 'iex', serverTime: Date.now(), upstreamCalls: 2 };
          });
          return json(d, 200, h);
        }
        case '/api/bars': {
          // Rohdaten-Durchreichung ohne JSON-Parsing (spart CPU im 10-ms-Free-Tarif); genau 1 Seite je Aufruf.
          const symbols = parseSymbols(q.get('symbols'));
          const tf = q.get('timeframe');
          if (!['1Min', '5Min', '15Min', '30Min', '1Hour', '1Day'].includes(tf)) throw new BadRequest('Ungültiger timeframe');
          const start = isoParam(q.get('start'), 'start'), end = isoParam(q.get('end'), 'end');
          if (!start) throw new BadRequest('Parameter start fehlt');
          const pt = q.get('page_token');
          if (pt && !/^[A-Za-z0-9+/=_-]{1,400}$/.test(pt)) throw new BadRequest('Ungültiges page_token');
          const key = `bars:${symbols.join(',')}:${tf}:${start}:${end}:${pt || ''}`;
          const hit = memCache.get(key);
          const hdr = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...h };
          if (hit && Date.now() - hit.t < (end ? 3600000 : 20000)) return new Response(hit.v, { status: 200, headers: hdr });
          const txt = await alpacaRaw(env, '/v2/stocks/bars', { symbols: symbols.join(','), timeframe: tf, start, end, feed: 'iex', adjustment: 'split', limit: 10000, sort: 'asc', page_token: pt });
          if (txt.length < 1_500_000) { // Speicher schonen (128 MB je Isolate)
            memCache.set(key, { t: Date.now(), v: txt });
            while (memCache.size > 40) memCache.delete(memCache.keys().next().value);
          }
          return new Response(txt, { status: 200, headers: hdr });
        }
        case '/api/fx':
          return json(await fxLive(env), 200, h);
        case '/api/fx/history': {
          const start = isoParam(q.get('start'), 'start'), end = isoParam(q.get('end'), 'end') || '';
          if (!start) throw new BadRequest('Parameter start fehlt');
          const d = await cached(`fxh:${start}:${end}`, 6 * 3600000, async () => {
            const r = await fetch(`https://api.frankfurter.dev/v1/${start}..${end}?base=EUR&symbols=USD`);
            if (!r.ok) throw new Error('Frankfurter HTTP ' + r.status);
            const j = await r.json();
            const rates = {};
            for (const [day, v] of Object.entries(j.rates || {})) rates[day] = v.USD;
            return { rates, source: 'frankfurter', upstreamCalls: 1 };
          });
          return json(d, 200, h);
        }
        case '/api/events': {
          if (!env.FINNHUB_KEY) return json({ available: false, reason: 'Kein FINNHUB_KEY – Ereignisstatus unbekannt', upstreamCalls: 0 }, 200, h);
          const symbols = parseSymbols(q.get('symbols'));
          const from = isoParam(q.get('from'), 'from'), to = isoParam(q.get('to'), 'to');
          const d = await cached(`ev:${from}:${to}`, 3 * 3600000, async () => {
            const r = await fetch(`https://finnhub.io/api/v1/calendar/earnings?from=${from}&to=${to}&token=${encodeURIComponent(env.FINNHUB_KEY)}`);
            if (!r.ok) throw new Error('Finnhub HTTP ' + r.status);
            const j = await r.json();
            return { all: (j.earningsCalendar || []).map(e => ({ symbol: e.symbol, date: e.date, hour: e.hour })), upstreamCalls: 1 };
          });
          const set = new Set(symbols);
          return json({ available: true, earnings: d.all.filter(e => set.has(e.symbol)), upstreamCalls: d.upstreamCalls }, 200, h);
        }
        default:
          return json({ error: 'Unbekannter Endpunkt' }, 404, h);
      }
    } catch (e) {
      return json({ error: e.message || String(e) }, e instanceof BadRequest ? 400 : 502, h);
    }
  },
};
