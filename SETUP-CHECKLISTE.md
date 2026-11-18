# Setup-Checkliste – ORB Trading Intelligence Dashboard V2.1

**Gesamtdauer:** ca. 40–60 Minuten, einmalig. Danach musst du nur noch die Webseite öffnen.
**Kosten:** 0 €. Du brauchst weder eine Kreditkarte noch ein Abo.
**Reihenfolge einhalten.** Jeder Schritt hat ein ✅-Prüfkriterium. Erst weitermachen, wenn es erfüllt ist.

---

## Phase 0 – Vorbereitung (5 Min)

- [ ] ZIP `orb-dashboard.zip` entpacken (Rechtsklick → „Alle extrahieren“).
- [ ] Notizzettel bzw. Passwortmanager für diese **6 Werte** bereitlegen:

| Nr. | Wert | Beispiel | Wo verwendet |
|---|---|---|---|
| W1 | GitHub-Benutzername | `alexs` | Adresse des Dashboards |
| W2 | Dashboard-Adresse | `https://alexs.github.io/orb-dashboard/` | Browser-Lesezeichen |
| W3 | Origin (W2 **ohne** `/orb-dashboard/`) | `https://alexs.github.io` | Cloudflare `ALLOWED_ORIGINS` |
| W4 | Worker-URL | `https://orb-proxy.alexs.workers.dev` | Dashboard → Einstellungen |
| W5 | Zugriffstoken (48 Zeichen) | wird im Dashboard erzeugt | Cloudflare + Dashboard (identisch!) |
| W6 | Alpaca Key ID + Secret, Twelve-Data-Key | – | **nur** Cloudflare Secrets |

> API-Schlüssel (W6) niemals in GitHub, in E-Mails oder im Dashboard eintragen. Sie gehören ausschließlich in Cloudflare.

---

## Phase 1 – GitHub: Dashboard online stellen (10 Min)

- [ ] **1.1** Auf <https://github.com/signup> Konto anlegen → Benutzername als **W1** notieren.
- [ ] **1.2** Oben rechts **+** → **New repository**
  - Repository name: `orb-dashboard`
  - **Public** auswählen (GitHub Pages ist nur für öffentliche Repositories kostenlos; es liegen keine Schlüssel darin)
  - **Create repository**
- [ ] **1.3** Auf der leeren Repository-Seite: Link **„uploading an existing file“** (oder **Add file → Upload files**).
- [ ] **1.4** Den entpackten Ordner `orb-dashboard` öffnen, **den Inhalt markieren** (Strg + A) und ins Browserfenster ziehen.
  - Der Ordner `tests` muss mit hochgeladen werden.
  - ⚠ Nicht den Ordner `orb-dashboard` selbst hochziehen, sondern seinen Inhalt.
- [ ] **1.5** Unten **Commit changes**.
  - ✅ In der Dateiliste des Repositorys steht `index.html` **direkt auf oberster Ebene** (nicht `orb-dashboard/index.html`).
- [ ] **1.6** **Settings** → links **Pages** → unter *Build and deployment*:
  - Source: **Deploy from a branch**
  - Branch: **main**, Ordner **/ (root)** → **Save**
- [ ] **1.7** 1–3 Minuten warten, Seite neu laden. Oben erscheint *„Your site is live at …“* → Adresse als **W2** notieren, **W3** ableiten.
- [ ] **1.8** Funktionstest ohne Einrichtung: `W2` + `?testmodus=1` öffnen (z. B. `https://alexs.github.io/orb-dashboard/?testmodus=1`).
  - ✅ Oranger Streifen „TESTMODUS – SYNTHETISCHE TESTDATEN“, Tabelle mit 20 Aktien, Klick auf NVDA öffnet einen Chart.
  - ❌ Weiße Seite / 404 → Schritt 1.5 prüfen (index.html auf oberster Ebene?) und 2 Minuten warten.

---

## Phase 2 – Alpaca: Kursdaten-Schlüssel (10 Min)

- [ ] **2.1** <https://alpaca.markets> → **Sign up** → E-Mail bestätigen. Für Paper Trading ist keine Einzahlung und kein Echtgeldkonto nötig.
- [ ] **2.2** Nach dem Login oben links das Konto **Paper Trading** auswählen.
- [ ] **2.3** Rechte Seitenleiste **API Keys** → **Generate New Keys**.
- [ ] **2.4** **Key ID** und **Secret Key** sofort sicher speichern (**W6**). Das Secret wird nur einmal angezeigt.
  - ✅ Zwei Werte gespeichert. Der kostenlose Datentarif *Basic* ist automatisch aktiv.

---

## Phase 3 – Twelve Data: Live-Wechselkurs EUR/USD (5 Min)

- [ ] **3.1** <https://twelvedata.com> → **Get started** → Plan **Basic ($0)** → Konto bestätigen.
- [ ] **3.2** Im Dashboard **API Keys** → Schlüssel kopieren (**W6**).
  - ✅ Schlüssel gespeichert.

*(Optional) Finnhub für Quartalszahlen: <https://finnhub.io/register> → API-Key kopieren. Ohne Finnhub zeigt das Dashboard „Ereignisstatus unbekannt“; alles andere funktioniert.*

---

## Phase 4 – Cloudflare Worker: geschützter Datenzugang (15 Min)

> ⚠ **Nicht** „Import a repository“, **nicht** „Pages“ und **nicht** „Build / Build variables“ verwenden. Das war der Stolperstein beim letzten Versuch. Wir arbeiten nur mit **Worker + Code einfügen + Variables and Secrets**.

- [ ] **4.1** <https://dash.cloudflare.com/sign-up> → Konto anlegen → E-Mail bestätigen.
- [ ] **4.2** Links **Workers & Pages** (bzw. **Compute → Workers & Pages**) → **Create application** → **Create Worker** (Vorlage „Hello World“).
- [ ] **4.3** Name: `orb-proxy` → **Deploy**.
- [ ] **4.4** **Edit code** → im Editor **alles löschen** → kompletten Inhalt der Datei `worker.js` aus dem ZIP einfügen (mit einem Texteditor öffnen, Strg + A, Strg + C) → oben rechts **Deploy**.
- [ ] **4.5** Worker-Adresse oben im Editor bzw. auf der Übersichtsseite kopieren → **W4** (Format `https://orb-proxy.<name>.workers.dev`).
  - ✅ W4 im Browser öffnen → Anzeige `{"ok":true,"service":"ORB-Worker läuft",…}`
  - ❌ „Hello World!“ → Code wurde nicht gespeichert, Schritt 4.4 wiederholen und **Deploy** klicken.

**Zugriffstoken erzeugen (W5):**
- [ ] **4.6** Dashboard (W2, **ohne** Testmodus) öffnen → Reiter **Einstellungen** → **Token generieren** → Token als **W5** speichern (wird auch in die Zwischenablage kopiert).

**Secrets eintragen:**
- [ ] **4.7** Cloudflare → Worker `orb-proxy` → Reiter **Settings** → Abschnitt **Variables and Secrets** → **+ Add**. Je Zeile einen Eintrag anlegen:

| Type | Variable name (exakt so schreiben) | Value |
|---|---|---|
| **Secret** | `ALPACA_KEY_ID` | Alpaca Key ID |
| **Secret** | `ALPACA_SECRET_KEY` | Alpaca Secret Key |
| **Secret** | `TWELVEDATA_KEY` | Twelve-Data-Schlüssel |
| **Secret** | `ACCESS_TOKEN` | W5 |
| **Text** | `ALLOWED_ORIGINS` | W3, z. B. `https://alexs.github.io` (ohne Pfad, ohne `/` am Ende) |
| Secret (optional) | `FINNHUB_KEY` | Finnhub-Key |

- [ ] **4.8** Mit **Deploy** bzw. **Save and deploy** bestätigen.
  - ✅ Alle 5 (bzw. 6) Namen stehen in der Liste; Secrets zeigen keinen Wert an (das ist korrekt).
  - Typische Fehler: Leerzeichen am Anfang oder Ende des Werts, Tippfehler im Namen, bei `ALLOWED_ORIGINS` der Pfad `/orb-dashboard` angehängt.

---

## Phase 5 – Dashboard verbinden (5 Min)

- [ ] **5.1** Dashboard (W2) → **Einstellungen** → Abschnitt **1. Datenverbindung**:
  - Worker-URL = W4
  - Zugriffstoken = W5
  - ☑ „Token auf diesem Gerät merken“ (sonst musst du es bei jedem Browserstart neu eingeben)
- [ ] **5.2** **Verbindungstest** klicken. Sollergebnis:

| Zeile | Erwartet |
|---|---|
| Worker erreichbar & Token gültig | ✓ |
| Origin-Schutz (ALLOWED_ORIGINS) | ✓ aktiv |
| Alpaca-Secrets | ✓ |
| Twelve-Data-Secret | ✓ |
| Alpaca Marktdaten (IEX) | ✓ mit aktuellem SPY-Kurs |
| Alpaca Börsenkalender | ✓ |
| EUR/USD-Wechselkurs | ✓ „Twelve Data live“ (am Wochenende ggf. ältere Zeitangabe) |

- [ ] **5.3** **Speichern & verbinden** → oben „Aktiendaten: **Verbunden**“.
  - Der erste Start lädt ca. 20 Handelstage Historie (Status „Lädt“, 30–90 Sekunden). Danach ist der Abruf im Browser zwischengespeichert.
  - ✅ Tabelle mit 20 Aktien, Euro-Kursen und Status (außerhalb der Handelszeit: „MARKT GESCHLOSSEN“ oder „KEIN EINSTIEG“ für den letzten Handelstag).

---

## Phase 6 – Persönliche Einstellungen (5 Min)

- [ ] **6.1** Einstellungen → **Risiko**: Trading-Kapital in €, Risiko pro Trade (Standard 0,5 %), Tagesrisiko (1,5 %), max. Positionen (3), Gebühren (1 € je Order).
- [ ] **6.2** **Browser-Benachrichtigungen erlauben** klicken und ggf. „Akustische Signale“ aktivieren.
- [ ] **6.3** Betriebsmodus für die ersten 2–4 Wochen: **Paper Trading** (empfohlen), optional „bestätigte Signale automatisch erfassen“.
- [ ] **6.4** Lesezeichen auf W2 setzen.
- [ ] **6.5** ISIN-Stichprobe in der Trade-Republic-App (z. B. PLTR `US69608A1088`, UBER `US90353T1007`): Aktie handelbar?

---

## Phase 7 – Erster Handelstag: Abnahme (live, 45 Min)

- [ ] **7.1** Dashboard **vor 15:30 Uhr** öffnen. In den Wochen mit unterschiedlicher Zeitumstellung (März/Oktober–November) ist es 14:30 Uhr; der Countdown im Kopfbereich zeigt die richtige Zeit.
- [ ] **7.2** Ab Öffnung: Status „OPENING RANGE IN BILDUNG“ (blau), Datenalter im Kopfbereich unter ca. 30 s.
- [ ] **7.3** Nach 15 Minuten: Status wechselt auf „WARTE AUF BREAKOUT“ bzw. „WARTE AUF RETEST“, OR-High/Low in der Tabelle gefüllt.
- [ ] **7.4** Plausibilitätscheck: Eine Aktie in Detailansicht öffnen und den Euro-Kurs mit Trade Republic vergleichen. Eine Abweichung von wenigen Zehntelprozent ist normal (anderer Handelsplatz, Spread).
- [ ] **7.5** Backtest einmalig starten: Reiter **Backtesting** → 60 Tage → 5 Aktien → **Backtest starten** (lädt einige Minuten).
- [ ] **7.6** Rückmeldung an mich mit Screenshot von Verbindungstest und Tabelle. Dann stimmen wir Parameter anhand echter Daten ab.

---

## Schnelle Fehlerhilfe

| Meldung | Ursache | Lösung |
|---|---|---|
| „Worker nicht erreichbar …“ / „Keine Antwort“ | W4 falsch oder `ALLOWED_ORIGINS` ≠ W3 | W4 im Browser öffnen (muss „ORB-Worker läuft“ zeigen); `ALLOWED_ORIGINS` exakt W3 |
| „Origin … nicht erlaubt“ | Pfad oder `/` in `ALLOWED_ORIGINS` | nur `https://name.github.io` |
| „Zugriffstoken ungültig“ | W5 unterschiedlich | Token in Cloudflare neu setzen, im Dashboard identisch einfügen |
| „ACCESS_TOKEN fehlt im Worker“ | Secret fehlt oder nicht deployt | Schritt 4.7/4.8 |
| „Alpaca lehnt die Schlüssel ab (HTTP 401/403)“ | Schlüssel falsch, alt oder vom falschen Konto | In Alpaca (Paper) neu generieren und beide Secrets ersetzen |
| EUR/USD „nicht live“ | `TWELVEDATA_KEY` fehlt/falsch oder Tageslimit 800 erreicht | Schlüssel prüfen; das Tageslimit setzt sich täglich zurück – bis dahin keine Euro-Freigabe |
| Chart leer: „Chartbibliothek nicht geladen“ | Werbe-/Skriptblocker blockiert unpkg/jsdelivr | Blocker für die Seite deaktivieren |
| „DATEN NICHT VERFÜGBAR“ während der Handelszeit | Tab im Hintergrund gedrosselt oder Verbindungsabbruch | Tab im Vordergrund halten; erholt sich automatisch |
| Änderungen am Code nicht sichtbar | Browser-Cache | Strg + F5 |
