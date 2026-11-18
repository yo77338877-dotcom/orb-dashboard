// ORB Trading Intelligence Dashboard V2.1 – zentrale Konfiguration
// Enthält KEINE Secrets. API-Schlüssel liegen ausschließlich als Cloudflare Worker Secrets vor.

export const APP_VERSION = '2.1.0';
export const MAX_WATCHLIST = 20;
export const MARKET_SYMBOLS = ['SPY', 'QQQ'];

// ISIN/WKN/Primärbörse geprüft (Stand Nov. 2026). Handelbarkeit bitte per ISIN in der Trade-Republic-App bestätigen.
// Walmart notiert seit Dez. 2025 an der Nasdaq.
// Logos: keine Markenlogos von Drittseiten; neutrale Ticker-Badges. Eigene rechtmäßige Logo-URL je Aktie möglich.
export const DEFAULT_WATCHLIST = [
  { ticker: 'NVDA', name: 'NVIDIA', isin: 'US67066G1040', wkn: '918422', exchange: 'NASDAQ', sector: 'Halbleiter / KI', group: 'semis' },
  { ticker: 'AAPL', name: 'Apple', isin: 'US0378331005', wkn: '865985', exchange: 'NASDAQ', sector: 'Technologie', group: 'megatech' },
  { ticker: 'MSFT', name: 'Microsoft', isin: 'US5949181045', wkn: '870747', exchange: 'NASDAQ', sector: 'Software / Cloud', group: 'megatech' },
  { ticker: 'AMZN', name: 'Amazon', isin: 'US0231351067', wkn: '906866', exchange: 'NASDAQ', sector: 'E-Commerce / Cloud', group: 'megatech' },
  { ticker: 'GOOGL', name: 'Alphabet Class A', isin: 'US02079K3059', wkn: 'A14Y6F', exchange: 'NASDAQ', sector: 'Technologie', group: 'megatech' },
  { ticker: 'META', name: 'Meta Platforms', isin: 'US30303M1027', wkn: 'A1JWVX', exchange: 'NASDAQ', sector: 'Technologie', group: 'megatech' },
  { ticker: 'TSLA', name: 'Tesla', isin: 'US88160R1014', wkn: 'A1CX3T', exchange: 'NASDAQ', sector: 'Automobil', group: 'highbeta' },
  { ticker: 'AMD', name: 'AMD', isin: 'US0079031078', wkn: '863186', exchange: 'NASDAQ', sector: 'Halbleiter', group: 'semis' },
  { ticker: 'AVGO', name: 'Broadcom', isin: 'US11135F1012', wkn: 'A2JG9Z', exchange: 'NASDAQ', sector: 'Halbleiter', group: 'semis' },
  { ticker: 'PLTR', name: 'Palantir', isin: 'US69608A1088', wkn: 'A2QA4J', exchange: 'NASDAQ', sector: 'Software / KI', group: 'highbeta' },
  { ticker: 'NFLX', name: 'Netflix', isin: 'US64110L1061', wkn: '552484', exchange: 'NASDAQ', sector: 'Streaming', group: 'megatech' },
  { ticker: 'UBER', name: 'Uber Technologies', isin: 'US90353T1007', wkn: 'A2PHHG', exchange: 'NYSE', sector: 'Mobilität', group: 'highbeta' },
  { ticker: 'CRM', name: 'Salesforce', isin: 'US79466L3024', wkn: 'A0B87V', exchange: 'NYSE', sector: 'Software', group: 'software' },
  { ticker: 'JPM', name: 'JPMorgan Chase', isin: 'US46625H1005', wkn: '850628', exchange: 'NYSE', sector: 'Banken', group: 'financials' },
  { ticker: 'V', name: 'Visa', isin: 'US92826C8394', wkn: 'A0NC7B', exchange: 'NYSE', sector: 'Finanzdienstleistungen', group: 'payments' },
  { ticker: 'MA', name: 'Mastercard', isin: 'US57636Q1040', wkn: 'A0F602', exchange: 'NYSE', sector: 'Finanzdienstleistungen', group: 'payments' },
  { ticker: 'WMT', name: 'Walmart', isin: 'US9311421039', wkn: '860853', exchange: 'NASDAQ', sector: 'Einzelhandel', group: 'retail' },
  { ticker: 'COST', name: 'Costco', isin: 'US22160K1051', wkn: '888351', exchange: 'NASDAQ', sector: 'Einzelhandel', group: 'retail' },
  { ticker: 'XOM', name: 'Exxon Mobil', isin: 'US30231G1022', wkn: '852549', exchange: 'NYSE', sector: 'Energie', group: 'energy' },
  { ticker: 'ABBV', name: 'AbbVie', isin: 'US00287Y1091', wkn: 'A1J84E', exchange: 'NYSE', sector: 'Pharma', group: 'pharma' },
].map(s => ({ ...s, currency: 'USD', tvSymbol: `${s.exchange}:${s.ticker}` }));

export const CORRELATION_GROUP_LABELS = {
  semis: 'Halbleiter', megatech: 'Mega-Cap Tech', highbeta: 'High-Beta Wachstum', software: 'Software',
  financials: 'Banken', payments: 'Zahlungsdienstleister', retail: 'Einzelhandel', energy: 'Energie', pharma: 'Pharma', other: 'Sonstige',
};

export function tradingViewUrl(meta) {
  return `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(meta.tvSymbol || meta.ticker)}`;
}

// Einstiegsfenster-Beginn = Ende der jeweiligen Opening Range
export const ORB_WINDOW_START = { 5: '09:35', 15: '09:45', 30: '10:00' };

export const DEFAULT_SETTINGS = {
  orbMinutes: 15,
  confirmTimeframe: 1,
  entryWindowStart: '09:45',
  entryWindowEnd: '12:00',
  bufferPct: 0.05,
  bufferAtr: 0.10,
  retestRequired: true,
  retestTolAtr: 0.15,
  maxRetestBars: 20,
  signalValidityBars: 10,
  maxChaseR: 0.25,
  minOrWidthAtr: 0.5,
  maxOrWidthAtr: 4.0,
  maxOrWidthDailyAtr: 0.6,
  maxExtensionAtr: 1.5,
  maxBreakoutCandleAtr: 2.5,
  minBodyRatio: 0.5,
  slMode: 'structure',
  slBufferAtr: 0.10,
  minRiskAtr: 0.15,
  maxRiskAtr: 2.0,
  minBarCoverage: 0.8,
  minRvol: 1.5,
  minScore: 75,
  vwapFilter: true,
  emaFilter: true,
  rsiFilter: true,
  macdFilter: true,
  marketFilter: true,
  minNetCrv: 2.0,
  maxSpreadPct: 0.15,
  capital: 10000,
  riskPerTradePct: 0.5,
  maxDailyRiskPct: 1.5,
  maxPositions: 3,
  maxPerCorrelationGroup: 2,
  feeBuy: 1.0,
  feeSell: 1.0,
  brokerSpreadPct: 0.05,
  slippagePct: 0.03,
  tp1Pct: 30, tp2Pct: 40, tp3Pct: 30,
  breakEvenAfterTp1: true,
  trailingStop: false,
  trailingAtr: 1.0,
  exitOnOrReentry: true,
  exitOnVwapLoss: false,
  closeBeforeEndMin: 15,
  brokerQuoteMaxAgeSec: 120,
  workerUrl: '',
  pollSeconds: 15,
  fxPollSeconds: 60,
  maxDataAgeSec: 150,
  maxFxAgeSec: 180,
  theme: 'dark',
  view: 'table',
  notifications: false,
  sound: false,
  notifyEvents: { open: true, orDone: true, breakout: true, retest: true, longSetup: true, bearSetup: true, inZone: true, missed: true, tp: true, sl: true, invalid: true, close: true, data: true },
  hiddenColumns: [],
  mode: 'live',
  autoPaper: false,
};

export const SETTINGS_SCHEMA = [
  ['ORB-Strategie', [
    ['orbMinutes', 'Primäre ORB-Strategie', 'select', [[5, '5-Minuten-ORB'], [15, '15-Minuten-ORB'], [30, '30-Minuten-ORB']]],
    ['confirmTimeframe', 'Breakout-Bestätigung', 'select', [[1, 'Abgeschlossene 1-Min-Kerze'], [5, 'Abgeschlossene 5-Min-Kerze']]],
    ['entryWindowStart', 'Einstiegsfenster Beginn (New York)', 'time'],
    ['entryWindowEnd', 'Einstiegsfenster Ende (New York)', 'time'],
    ['bufferPct', 'Breakout-Puffer (% vom Kurs)', 'number', 0, 1, 0.01],
    ['bufferAtr', 'Breakout-Puffer (× ATR)', 'number', 0, 1, 0.01],
    ['retestRequired', 'Retest verpflichtend', 'bool'],
    ['retestTolAtr', 'Retest-Toleranz (× ATR)', 'number', 0, 1, 0.01],
    ['maxRetestBars', 'Max. Retest-Dauer (Kerzen)', 'number', 1, 120, 1],
    ['signalValidityBars', 'Signalgültigkeit (Kerzen)', 'number', 1, 60, 1],
    ['maxChaseR', 'Max. Einstieg über Entry (× R)', 'number', 0, 1, 0.05],
    ['minOrWidthAtr', 'Min. OR-Breite (× 5-Min-ATR)', 'number', 0, 5, 0.1],
    ['maxOrWidthAtr', 'Max. OR-Breite (× 5-Min-ATR)', 'number', 0.5, 20, 0.1],
    ['maxOrWidthDailyAtr', 'Max. OR-Breite (× Tages-ATR)', 'number', 0.1, 2, 0.05],
    ['slMode', 'Stop-Loss-Methode', 'select', [['structure', 'Retest-/Swing-Struktur + ATR-Puffer'], ['orMid', 'Opening-Range-Mitte']]],
    ['slBufferAtr', 'Stop-Loss-Puffer (× ATR)', 'number', 0, 1, 0.01],
  ]],
  ['Signalverifizierung', [
    ['minRvol', 'Mindest-RVOL', 'number', 0, 10, 0.1],
    ['minScore', 'Mindest-Trading-Score', 'number', 0, 100, 1],
    ['vwapFilter', 'VWAP-Filter (Pflicht)', 'bool'],
    ['emaFilter', 'EMA-Trendfilter (Pflicht)', 'bool'],
    ['rsiFilter', 'RSI als Bestätigung', 'bool'],
    ['macdFilter', 'MACD als Bestätigung', 'bool'],
    ['marketFilter', 'Gesamtmarktfilter (Pflicht)', 'bool'],
    ['minNetCrv', 'Mindest-Netto-CRV', 'number', 0.5, 10, 0.1],
    ['maxSpreadPct', 'Max. Broker-Spread (%)', 'number', 0, 2, 0.01],
    ['maxExtensionAtr', 'Max. Kursüberdehnung (× ATR)', 'number', 0.1, 10, 0.1],
  ]],
  ['Risiko', [
    ['capital', 'Trading-Kapital (€)', 'number', 0, 1e9, 100],
    ['riskPerTradePct', 'Risiko pro Trade (%)', 'number', 0.05, 5, 0.05],
    ['maxDailyRiskPct', 'Max. Tagesrisiko (%)', 'number', 0.1, 10, 0.1],
    ['maxPositions', 'Max. parallele Positionen', 'number', 1, 10, 1],
    ['maxPerCorrelationGroup', 'Max. Positionen je Korrelationsgruppe', 'number', 1, 10, 1],
    ['feeBuy', 'Gebühr Kauf (€)', 'number', 0, 50, 0.5],
    ['feeSell', 'Gebühr Verkauf (€)', 'number', 0, 50, 0.5],
    ['brokerSpreadPct', 'Geschätzter Broker-Spread (%)', 'number', 0, 2, 0.01],
    ['slippagePct', 'Geschätzte Slippage (%)', 'number', 0, 2, 0.01],
    ['tp1Pct', 'Teilverkauf TP1 (%)', 'number', 0, 100, 5],
    ['tp2Pct', 'Teilverkauf TP2 (%)', 'number', 0, 100, 5],
    ['tp3Pct', 'Teilverkauf TP3 (%)', 'number', 0, 100, 5],
    ['breakEvenAfterTp1', 'Break-even-Stop nach TP1', 'bool'],
    ['trailingStop', 'Trailing Stop (ATR) nach TP2', 'bool'],
    ['trailingAtr', 'Trailing-Abstand (× ATR)', 'number', 0.2, 5, 0.1],
    ['exitOnOrReentry', 'Exit bei Rückkehr in die Opening Range', 'bool'],
    ['exitOnVwapLoss', 'Exit bei VWAP-Verlust', 'bool'],
    ['closeBeforeEndMin', 'Schließhinweis vor Börsenschluss (Min.)', 'number', 0, 120, 5],
  ]],
  ['Datenquellen', [
    ['pollSeconds', 'Aktien-Aktualisierung (Sek.)', 'number', 10, 120, 1],
    ['fxPollSeconds', 'Wechselkurs-Aktualisierung (Sek.)', 'number', 60, 600, 10],
    ['maxDataAgeSec', 'Max. Datenalter für Signale (Sek.)', 'number', 60, 900, 10],
    ['maxFxAgeSec', 'Max. FX-Alter für Euro-Freigabe (Sek.)', 'number', 60, 1800, 10],
    ['brokerQuoteMaxAgeSec', 'Max. Alter Brokerkurs-Eingabe (Sek.)', 'number', 30, 900, 10],
  ]],
  ['Betrieb & Darstellung', [
    ['mode', 'Betriebsmodus', 'select', [['live', 'Live-Analyse'], ['paper', 'Paper Trading'], ['backtest', 'Backtesting']]],
    ['autoPaper', 'Paper Trading: bestätigte Signale automatisch erfassen', 'bool'],
    ['theme', 'Design', 'select', [['dark', 'Dark Mode'], ['light', 'Light Mode']]],
    ['view', 'Standardansicht', 'select', [['table', 'Tabelle'], ['cards', 'Karten']]],
    ['notifications', 'Browser-Benachrichtigungen', 'bool'],
    ['sound', 'Akustische Signale', 'bool'],
  ]],
];

// Fallback-Börsenkalender (wird durch den Alpaca-Kalender ersetzt, sobald verfügbar)
export const FALLBACK_HOLIDAYS = [
  '2025-01-01', '2025-01-09', '2025-01-20', '2025-02-17', '2025-04-18', '2025-05-26', '2025-06-19', '2025-07-04', '2025-09-01', '2025-11-27', '2025-12-25',
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24',
];
export const FALLBACK_EARLY_CLOSES = {
  '2025-07-03': '13:00', '2025-11-28': '13:00', '2025-12-24': '13:00',
  '2026-11-27': '13:00', '2026-12-24': '13:00',
  '2027-11-26': '13:00',
};

export const STATES = {
  CLOSED: 'MARKT GESCHLOSSEN',
  PRE: 'WARTE AUF BÖRSENSTART',
  FORMING: 'OPENING RANGE IN BILDUNG',
  WAIT_BREAKOUT: 'WARTE AUF BREAKOUT',
  BREAKOUT: 'BREAKOUT ERKANNT',
  WAIT_CONFIRM: 'WARTE AUF BESTÄTIGUNG',
  WAIT_RETEST: 'WARTE AUF RETEST',
  LONG_OK: 'LONG-SETUP BESTÄTIGT',
  BEAR_OK: 'BÄRISCHES SETUP BESTÄTIGT',
  CHECK_BROKER: 'BROKERKURS PRÜFEN',
  IN_ZONE: 'EINSTIEG INNERHALB DER ZONE',
  WATCH: 'BEOBACHTEN',
  MISSED: 'EINSTIEG VERPASST',
  NO_ENTRY: 'KEIN EINSTIEG',
  INVALID: 'SIGNAL INVALIDIERT',
  POS_OPEN: 'POSITION MANUELL ERÖFFNET',
  TP1: 'TAKE PROFIT 1 ERREICHT',
  TP2: 'TAKE PROFIT 2 ERREICHT',
  TP3: 'TAKE PROFIT 3 ERREICHT',
  SL: 'STOP LOSS ERREICHT',
  CLOSE_POS: 'POSITION SCHLIESSEN',
  NO_DATA: 'DATEN NICHT VERFÜGBAR',
};

export function stateColor(state) {
  const S = STATES;
  if ([S.LONG_OK, S.IN_ZONE, S.CHECK_BROKER, S.TP1, S.TP2, S.TP3].includes(state)) return 'green';
  if ([S.BEAR_OK, S.INVALID, S.SL, S.CLOSE_POS].includes(state)) return 'red';
  if ([S.WATCH, S.WAIT_RETEST, S.WAIT_CONFIRM, S.BREAKOUT, S.POS_OPEN].includes(state)) return 'yellow';
  if ([S.FORMING].includes(state)) return 'blue';
  if ([S.NO_DATA].includes(state)) return 'orange';
  return 'grey';
}
