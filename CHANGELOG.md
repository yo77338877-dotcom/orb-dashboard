# Änderungen V2.0 → V2.1 (Prüfung und Korrekturen)

## Logikfehler behoben
1. **„EINSTIEG VERPASST“ sprang auf „BEOBACHTEN“ zurück**, sobald der Kurs weiterlief (Überdehnungsprüfung). Jetzt bleibt ein abgelaufenes Signal verpasst bzw. „KEIN EINSTIEG“.
2. **Harte Blockaden wurden grün angezeigt:** Tagesrisikolimit, Brokerkurs über Max-Einstieg, zu großer Spread oder zu kleines CRV zum Brokerkurs ergaben „BROKERKURS PRÜFEN“ (grün). Jetzt: „KEIN EINSTIEG“ (grau) mit Begründung.
3. **Opening Range ohne ATR** galt als „angemessen“. Jetzt nicht bewertbar und damit kein Signal (Fail-Closed).
4. **Positionsüberwachung:** Stop Loss hat jetzt Vorrang vor allen anderen Exit-Hinweisen. Exit wegen Rückkehr in die Opening Range und Invalidierung nur bei Ereignissen nach dem Kaufzeitpunkt; funktioniert jetzt auch bei manuell (ohne Signal) erfassten Positionen.
5. **Ungültiger Handelsplan** (Stop auf oder über Entry) wird nicht mehr erzeugt.
6. **Backtest:** Break-even-Stop nur, wenn bei TP1 tatsächlich verkauft wird (Varianten „nur TP2/TP3“ waren verfälscht).

## Betriebsfehler behoben
7. **Benachrichtigungs-Schwall** beim Öffnen am Nachmittag (alle vergangenen Ereignisse des Tages). Vergangene Ereignisse werden jetzt still registriert.
8. **Brokerkurs-Eingabe wurde alle 15 s überschrieben**, während du tippst. Eingaben bleiben jetzt erhalten.
9. **Chart bei 5/15/30/60 Min verzerrt:** Die VWAP-Linie lag auf 1-Min-Zeitstempeln und erzeugte Lücken. Sie wird jetzt auf den Chart-Zeitrahmen abgetastet.
10. **Rate-Limit-Konflikt im Backtest:** Der Client durfte 120 Abfragen/Min, der Worker nur 90. Jetzt drosselt der Client automatisch bei 75/Min.
11. **Speicherrisiko im Worker:** Der Cache konnte über 60 MB groß werden. Jetzt gilt ein Limit von 40 Einträgen und max. 1,5 MB je Eintrag.
12. **Einstiegsfenster bei 5/30-Min-ORB** blieb auf 09:45. Es passt sich jetzt automatisch an (09:35 / 10:00).
13. **Testmodus** speichert getrennt und berührt deine echten Einstellungen und dein Journal nicht.

## Einrichtung vereinfacht
14. Worker-Startseite zeigt „ORB-Worker läuft“ (Sofort-Check ohne Token).
15. `ALLOWED_ORIGINS` verträgt einen abschließenden `/`. Fehlt der Wert, funktioniert die Verbindung trotzdem (Schutz über das Token) und das Dashboard weist darauf hin.
16. Verständliche Fehlermeldungen (z. B. „Alpaca lehnt die Schlüssel ab“, „Origin … nicht erlaubt“).
17. Chartbibliothek mit zweitem CDN als Rückfall.
18. Verbindungstest zeigt den Origin-Schutz und den empfohlenen Wert an.
19. Neue **SETUP-CHECKLISTE.md** mit Prüfkriterien je Schritt.
