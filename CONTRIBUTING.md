# Mitwirken

Besucherlogin wird von einer Person entwickelt (integrisec, Steven Mai). Der Code
liegt offen, damit Betreiber prüfen können, was auf ihrer Infrastruktur läuft –
und damit die öffentliche Demo und der Quellcode deckungsgleich nachvollziehbar
sind.

Das heißt auch: Es gibt kein Team im Hintergrund. Rückmeldungen sind willkommen,
aber Antworten und Übernahmen können dauern, und nicht jeder Vorschlag passt in
die Richtung des Projekts. Damit niemand Arbeit umsonst macht, steht unten, woran
sich Änderungen messen lassen.

## Sicherheitslücken

**Nicht als Issue, nicht als Pull Request.** Vertraulich per E-Mail an
`kontakt@integrisec.de`; das Vorgehen steht in [SECURITY.md](SECURITY.md).

Installationen dieser Software verarbeiten Besucherdaten. Eine öffentliche
Meldung setzt Betreiber einem Risiko aus, bevor sie reagieren können.

## Fehler melden

Als Issue, mit Version oder Commit, Betriebsart (Node, Cloudflare Pages oder
Appliance) und dem Weg zum Nachstellen. Bei Fehlern im Betrieb hilft die Ausgabe
von `journalctl -u besucherlogin` bzw. `podman logs besucherlogin`.

## Änderungen vorschlagen

Kleine, abgeschlossene Pull Requests mit einem Satz zur Begründung. Bitte vorher
ein Issue, wenn die Änderung Verhalten oder Oberfläche betrifft – das erspart
beiden Seiten einen fertigen PR, der nicht passt.

Diese Randbedingungen sind nicht verhandelbar, weil das Projekt davon lebt:

- **Keine Laufzeit-Abhängigkeiten.** `package.json` hat weder `dependencies` noch
  `devDependencies` und kein Lockfile. Es gibt keinen Build-Schritt und kein
  `npm install`. Genutzt werden ausschließlich Node-Kernmodule.
- **Keine externen Requests im Betrieb.** Schriften, Logo und Skripte werden
  lokal ausgeliefert – kein CDN, kein Tracking, keine Telemetrie.
- **Eine Codebasis für beide Betriebsarten.** `functions/[[path]].js` läuft
  unverändert auf Cloudflare Workers und unter Node; plattformeigene Dinge
  gehören in `server.mjs`.
- **Zeilenenden.** `.gitattributes` erzwingt LF für Shell-Skripte, das
  Containerfile, YAML und `.mjs`. CRLF zerschießt Shebangs auf der Kunden-VM und
  den in `sbom.cdx.json` hinterlegten SHA-256 von `qrcode.js`.
- **Oberflächentexte auf Deutsch.** Zielgruppe sind Empfang und Pforte im
  deutschsprachigen Raum.

Wer eine Fremdkomponente mitbringt, ergänzt sie in `NOTICE` und `sbom.cdx.json`.

## Lizenz

Beiträge werden unter der [Apache License 2.0](LICENSE) aufgenommen – derselben
Lizenz wie das Projekt. Marken- und Logo-Material von integrisec ist davon nicht
erfasst; Apache-2.0 Abschnitt 6 gewährt keine Markenrechte.
