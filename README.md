# Besucherlogin

**Digitales Besucherbuch für Empfang und Pforte.** Besucher werden in Sekunden
erfasst, ein- und ausgecheckt. Die Daten bleiben auf der eigenen Infrastruktur
und werden nach einer einstellbaren Frist automatisch gelöscht.

Anders als ein Besucherbuch aus Papier sieht niemand die Einträge der
vorherigen Besucher, jeder Zugriff ist protokolliert, und Aufbewahrungsfristen
werden technisch durchgesetzt statt per Notizzettel.

**Für wen:** Empfang, Pforte und Werkschutz in Organisationen, die Besuche
dokumentieren müssen, ihre Daten aber nicht in eine fremde Cloud geben wollen –
Behörden, Industrie, Versorger, Bildung, Gesundheitswesen.

> **Screenshot folgt** – hier wird eine Bildschirmaufnahme der Besucherübersicht
> eingefügt. <!-- TODO: assets/screenshot.png einfügen und hier einbinden -->

## Funktionen

- **Besuchererfassung** – Name, Firma, Ansprechpartner, Besuchsgrund und Ausweisnummer in einem Schritt; Check-in und Check-out per Klick
- **Automatische Löschung** – Aufbewahrungsfrist im Adminbereich einstellbar, Löschlauf läuft von selbst (Art. 5 DSGVO, Speicherbegrenzung)
- **Suche und Filter** – Volltext über Name und Firma, Filter für offene Besuche
- **Statistik und CSV-Export** – Besucher pro Tag, häufigste Firmen, Besuchsdauer
- **Lückenloses Audit-Log** – jede Anmeldung, Erfassung und Änderung, filter- und exportierbar
- **Zwei-Faktor-Anmeldung (TOTP)** und getrennte Rollen für Admin und Empfang
- **Verschlüsselte Backups** – Voll-Backup per Passphrase (AES-GCM), Wiederherstellung mit Rollback, CSV-Import
- **White-Label** – eigenes Logo (per URL) und Farbpalette im Adminbereich
- **Keine externen Requests** – Schriften und Logo werden lokal ausgeliefert, kein CDN, kein Tracking

## Schnellstart

Voraussetzung: **Node.js 24+** (für `node:sqlite`). Keine weiteren Abhängigkeiten,
kein Build, kein Paketmanager-Install.

```bash
# einmalig: Startpasswort setzen
ADMIN_PASSWORD="EinStarkesPasswort" node --experimental-sqlite server.mjs

# danach genügt
npm start
```

Erreichbar unter `http://localhost:8787`. Beim ersten Start wird der Benutzer
`admin` angelegt (Passwort aus `ADMIN_PASSWORD`, Vorgabe `admin` – bitte sofort
ändern). Die Datenbank entsteht als einzelne SQLite-Datei.

### Konfiguration

| Variable | Vorgabe | Bedeutung |
|---|---|---|
| `PORT` | `8787` | HTTP-Port |
| `HTTPS_PORT` | `8443` | HTTPS-Port, sobald ein Zertifikat vorliegt |
| `DB_PATH` | `./besucher.db` | Pfad zur SQLite-Datei |
| `TLS_DIR` | neben `DB_PATH` | Verzeichnis für Zertifikat und Schlüssel |
| `ADMIN_PASSWORD` | `admin` | Startpasswort, nur beim allerersten Start |
| `DEMO` | – | `true` schaltet Admin-Schreibaktionen ab |

## Betriebsarten

Dieselbe Codebasis läuft auf zwei Wegen – der Request-Handler
(`functions/[[path]].js`) spricht nur ein KV-artiges Interface an:

| | Node (inhouse / VM) | Cloudflare Pages |
|---|---|---|
| Speicher | `node:sqlite` (eine Datei) | Workers KV |
| Einstieg | `server.mjs` | Pages Functions |
| Start | `npm start` | Deploy als Pages-Projekt |

Für Cloudflare Pages werden die KV-Bindings `AUTH_KV`, `SESSIONS_KV`,
`VISITORS_KV` und `AUDIT_KV` gesetzt.

## On-Premises-Appliance

Für den Betrieb auf einer eigenen VM liegt in [`appliance/`](appliance/) ein
Container-Setup mit systemd-Service, TLS ab Werk, Backup, Update und Rollback.
Einzelheiten in [appliance/README.md](appliance/README.md).

## Datenschutz

- Besucherdaten verbleiben vollständig auf der eigenen Infrastruktur
- Aufbewahrungsfrist einstellbar, Löschung automatisch
- Passwörter mit PBKDF2, Backups AES-GCM-verschlüsselt
- keine externen Aufrufe im Betrieb (Schriften und Logo lokal)

## Aufbau

```
index.html              Besucherübersicht
login.html              Anmeldung
admin.html              Benutzer, Einstellungen, Branding, TLS, Backup, 2FA, Audit
stats.html              Statistik (eigenes Canvas-Diagramm, kein CDN)
functions/[[path]].js   portabler Request-Handler (die gesamte API)
server.mjs              Node-Einstieg: SQLite, Static-Serving, TLS, Löschlauf
branding.js             lädt Logo und Farbpalette zur Laufzeit
assets/                 Stylesheet, Outfit-Schriften, Favicons, Platzhalterlogo
appliance/              Container-Setup für den On-Prem-Betrieb
```

Weitere Details zu Architektur und API: [DOKUMENTATION.md](DOKUMENTATION.md).

## Sicherheitslücken melden

Bitte **vertraulich** an `kontakt@integrisec.de`, nicht als öffentliches Issue.
Einzelheiten in [SECURITY.md](SECURITY.md).

## Lizenz

Der Quellcode steht unter der **Apache License, Version 2.0** – der vollständige
Lizenztext liegt in [LICENSE](LICENSE).

Übernommene Fremdbestandteile sind in [NOTICE](NOTICE) mit Urheber und Lizenz
aufgeführt; diese Angaben sind bei einer Weitergabe mitzuführen.

Apache 2.0 räumt nach Abschnitt 6 **keine Markenrechte** ein: Name, Wortmarke
und mitgelieferte Favicons sind nicht von der Lizenz erfasst (siehe
[NOTICE](NOTICE)). Das Platzhalterlogo ist bewusst neutral und für eigene
Installationen austauschbar.
