# ORB Trading Intelligence Dashboard V2.1

Webbasiertes Analyse-Dashboard für die **Opening Range Breakout Strategy (ORB)** auf 20 liquide US-Aktien.
Die Analyse läuft in Original-USD, Darstellung und Handelspläne sind in **Euro**. Gehandelt wird ausschließlich **manuell** über Trade Republic.

> **NO VALID ORB – NO TRADE.** Kein automatischer Handel, keine Gewinnversprechen, keine erfundenen Kurse. Tage ohne Signal sind gewollt.

**Einrichtung:** siehe **[SETUP-CHECKLISTE.md](SETUP-CHECKLISTE.md)** (Schritt für Schritt mit Prüfkriterien).
**Ohne Einrichtung testen:** Dashboard-Adresse + `?testmodus=1` (synthetische Daten, deutlich gekennzeichnet, getrennter Speicher).

## Architektur (0 € laufende Kosten)

```
Browser (GitHub Pages) ──HTTPS + Zugriffstoken──► Cloudflare Worker (Free) ──► Alpaca Market Data Basic (feed=iex)
  HTML/CSS/JS, LocalStorage, IndexedDB           Secrets, Origin-Prüfung,     ──► Twelve Data Basic (EUR/USD live)
                                                 Rate-Limit, Cache            ──► Frankfurter/EZB (Rückfall, Historie)
                                                                              ──► Finnhub (optional, Quartalszahlen)
```

| Datei | Aufgabe |
|---|---|
| `index.html`, `styles.css` | Oberfläche (Dark/Light, responsiv) |
| `app.js` | Start, Datenzyklus, Dashboard, Detailansicht, Benachrichtigungen |
| `views.js` | Positionen, Journal, Backtesting, Einstellungen, Status |
| `config.js` | Watchlist (ISIN/WKN), Standardwerte, Zustände, Feiertags-Fallback |
| `market-time.js` | Zeitzonen New York/Berlin, Sommer-/Winterzeit, Börsenkalender |
| `market-data.js` | Worker-Client, Request-Drossel, Cache, Datenqualität |
| `fx-service.js` | EUR/USD, Umrechnung, deutsches Zahlenformat |
| `indicators.js` | EMA, RSI, MACD, ATR, VWAP, RVOL, Swings |
| `orb-engine.js` | Opening Range, Breakout, Retest, Fehlausbrüche |
| `signal-engine.js` | Score, Pflichtkriterien, Zustandsmaschine |
| `risk-management.js` | Entry/Stop/TP, Netto-CRV, Positionsgröße, Tagesrisiko, Korrelation |
| `chart-manager.js` | TradingView Lightweight Charts 4.2 (Achsen in EUR) |
| `trade-journal.js` | Journal, Positionsüberwachung, Kennzahlen |
| `backtest.js` | Backtests mit derselben Signal-Engine |
| `worker.js` | Cloudflare Worker (geschützter API-Proxy) |
| `tests/` | 71 automatisierte Tests + synthetische Testdaten |

## Strategie-Regeln (Standardprofil)

| Regel | Standard |
|---|---|
| Strategie | 15-Min-ORB (09:30–09:45 NY); 5/30 Min separat wählbar, Einstiegsfenster passt sich an |
| Breakout | abgeschlossene 1-Min-Kerze schließt über OR-High + Puffer (max. aus 0,05 % und 0,10 × ATR) |
| Retest | Pflicht: Rücklauf zum OR-High (Toleranz 0,15 × ATR) + bullische Bestätigungskerze, max. 20 Kerzen |
| Invalidierung | Schluss unter OR-High − Toleranz (Bull Trap); max. 1 Setup je Richtung und Tag |
| Volumen | Session-RVOL ≥ 1,5 (gleiche Uhrzeit, 20 Tage, IEX vs. IEX) |
| Trend | über VWAP; EMA 9 > EMA 20 (5 Min); EMA 50/200 (Tag) als Kontext |
| Markt | SPY/QQQ nicht klar gegenläufig |
| Stop | unter Retest-Tief/Invalidierungsniveau + 0,10 × ATR; ATR beim OR-Ende fixiert (kein Repainting) |
| Ziele | 1R/2R/3R, begrenzt durch Vortageshoch, Pre-Market-Hoch, Swing-Hochs |
| CRV | netto ≥ 2,0 nach 1 € Gebühr je Order, Spread und Slippage am realistischen Hauptziel |
| Freigabe | Score ≥ 75 **und** alle Pflichtkriterien **und** Brokerkurs geprüft → „EINSTIEG INNERHALB DER ZONE“ |
| Blockade | Tagesrisiko erreicht, Brokerkurs über Max-Einstieg, Spread zu groß, CRV zum Brokerkurs zu klein → „KEIN EINSTIEG“ |
| Verpasst | Kurs über Max-Einstieg oder > 10 Kerzen nach Signal → „EINSTIEG VERPASST“ (bleibt so) |
| Zeitfenster | 09:45–12:00 NY; Schließhinweis 15 Min vor Börsenschluss |
| Risiko | 0,5 % je Trade, 1,5 % pro Tag, max. 3 Positionen, korrelierte Werte begrenzt, kein Hebel |

Score: ORB-Qualität 35 · RVOL 20 · VWAP 10 · EMA 10 · RSI+MACD 5 · Markt 10 · CRV 10. Der Score ist eine Qualitätsbewertung, **keine** Gewinnwahrscheinlichkeit.
Bärische Setups sind nur ein Warnsignal für Long-Positionen und keine Empfehlung für Leerverkäufe oder Hebelprodukte.

## Datenquellen und Grenzen

| Quelle | Kosten | Grenze |
|---|---|---|
| Alpaca Basic (feed=iex) | 0 € | Echtzeit nur IEX (~2–3 % des US-Volumens), 200 Calls/Min |
| Twelve Data Basic | 0 € | 8 Credits/Min, 800/Tag |
| Frankfurter (EZB) | 0 € | Tagesreferenz, **nicht live** → keine Euro-Ausführungsfreigabe |
| Finnhub (optional) | 0 € | nur Quartalszahlen; sonst „unbekannt“ |
| Cloudflare Workers Free | 0 € | 100.000 Aufrufe/Tag, 10 ms CPU je Aufruf |
| GitHub Pages | 0 € | öffentliches Repository |

- **Kein WebSocket**, weil sonst die Schlüssel im Browser liegen müssten. Stattdessen fragt das Dashboard alle 15 s gebündelt über den Worker ab (≈ 2 Alpaca-Calls je Abfrage).
- **Trade Republic** bietet keine offizielle Kursschnittstelle. Alle Euro-Kurse sind umgerechnete US-Referenzkurse.
- **Fail-Closed:** Bei Daten älter als 150 s, Verbindungsfehlern, Lücken oder unplausiblen Kursen werden keine Signale erzeugt.

## Implementierungsstatus

| Bereich | Status |
|---|---|
| ORB-Engine, Indikatoren, Score, Zustandsmaschine, Entry/SL/TP, CRV, Positionsgröße, Tagesrisiko, Korrelation, EUR-Umrechnung, Zeitzonen/Feiertage, Backtest-Engine, Journal, Worker-Schutz | **Implementiert und automatisiert getestet** (71 Tests, Worker mit simulierten Antworten) |
| Oberfläche inkl. aller Chart-Zeitrahmen | **Ohne Laufzeitfehler in simulierter Browserumgebung geprüft**, im echten Browser noch nicht |
| Live-Daten Alpaca, Twelve Data, Kalender, Finnhub, Backtest mit Echtdaten | **Implementiert, Live-Verbindung ungetestet; benötigt deine API-Konfiguration** |
| IEX-Volumen, kein WebSocket, keine TR-Kurse, keine kostenlose Quelle für Makro-Termine | **Durch kostenlose Datenquellen eingeschränkt** |

## Tests

```bash
npm test     # node --test tests/*.test.js  (Node.js ≥ 20)
```

## Sicherheit
- Keine API-Schlüssel in HTML/JS/Repository/URL/LocalStorage, nur Cloudflare Secrets.
- Worker-Schutz: Zugriffstoken (zeitkonstanter Vergleich), Origin-Prüfung, Rate-Limit je IP, Validierung aller Parameter, Caching, Fail-Closed ohne `ACCESS_TOKEN`.
- Das Zugriffstoken ist kein API-Schlüssel. „Auf diesem Gerät merken“ legt es lokal ab; ohne Haken gilt es nur für die Browsersitzung.
- Keine Trade-Republic-Zugangsdaten, keine inoffiziellen Schnittstellen.

## Haftungsausschluss
Regelbasierte technische Analyse zur Unterstützung manueller Entscheidungen, keine Anlageberatung. Daytrading kann zum Totalverlust führen. Stop-Orders garantieren keinen Ausführungspreis.
