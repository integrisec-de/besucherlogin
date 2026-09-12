# besucherlogin — Dokumentation

Digitales Besuchermanagement von **integrisec**. Eine Codebasis, drei Betriebsarten.

| Modus | Zweck | Speicher | Deploy |
|---|---|---|---|
| **Lokal** | Entwicklung / Test | `node:sqlite`-Datei | `node server.mjs` |
| **VM** | Kunden-Produktivbetrieb (On-Prem) | `node:sqlite` auf Volume | Container + Scripts |

---

## 1. Lokal (Dev / Test)

```
ADMIN_PASSWORD="StarkesPasswort!" node --experimental-sqlite server.mjs
```
→ `http://localhost:8787` · erster Start legt `admin` an.

| Variable | Default | Bedeutung |
|---|---|---|
| `PORT` | `8787` | HTTP-Port |
| `DB_PATH` | `./besucher.db` | SQLite-Datei |
| `ADMIN_PASSWORD` | `admin` | Startpasswort (nur 1. Start) |
| `DEMO` | – | `true` = Demo-Modus |

---

## 2. VM — On-Prem-Appliance (Kundenprodukt)

Hypervisor-unabhängiges **Container-Image** (VMware/Proxmox/Hyper-V), Podman bevorzugt, Docker-kompatibel. Volldetails: [appliance/README.md](appliance/README.md).

**Voraussetzungen:** Linux + `systemd` + rootful `podman` (oder `docker`) + `openssl`.

**Erstinstallation**
```
sudo ./setup.sh v1.0.1
```
Legt Daten-Volume + systemd-Service an, zieht das Image, startet den Container, prüft Health und gibt das **einmalige Admin-Passwort** aus. Danach erreichbar unter `https://<VM-IP>/` (zunächst selbstsigniert).

**Update** (Backup + automatischer Rollback)
```
sudo ./update.sh v1.1.0
```
Backup → neues Image ziehen → Tag umschalten → `systemctl restart` → Health-Check → bei Fehler zurück aufs alte Tag.

**Weitere Befehle**
```
sudo ./rollback.sh [vX.Y.Z]    # zurück auf voriges/angegebenes Tag
sudo ./backup.sh               # konsistentes DB-Backup (VACUUM INTO, ohne Downtime)
```

| Pfad | Inhalt |
|---|---|
| `/opt/besucherlogin/data` | SQLite-DB (+ WAL) — **vom Kunden zu sichern** |
| `/opt/besucherlogin/backups` | Backups (Script + vor jedem Update) |
| `/etc/besucherlogin/besucherlogin.env` | Konfig (Tag, Erst-Passwort) |
| `/etc/systemd/system/besucherlogin.service` | Autostart bei Boot |

- **Container:** non-root (UID 10001), Daten als Bind-Mount → überstehen Image-/Container-Tausch.
- **HTTPS** terminiert die App selbst (Port 443, self-signed ab Werk; eigenes Zertifikat im Adminbereich unter „TLS", Live-Reload). HTTP/80 leitet auf HTTPS um.
- **Image bauen/releasen:** GitHub Actions bei `git tag vX.Y.Z && git push origin vX.Y.Z` → `ghcr.io/integrisec-de/besucherlogin:vX.Y.Z` + `:latest`. Manuell: `podman build -f appliance/Containerfile -t … .`.

---

## Querschnitt

- **Backup/Restore/Import:** verschlüsseltes Voll-Backup (AES-GCM + Passphrase); Restore mit automatischem Pre-Restore-Snapshot + `Rückgängig`; additiver CSV-Import. Zusätzlich VM-Backup von `/opt/besucherlogin` (Kunde).
- **Sicherheit & DSGVO:** PBKDF2-Passwörter, 2FA (TOTP), Backups AES-GCM-verschlüsselt, Aufbewahrungsfrist mit Auto-Löschung; inhouse bleiben alle Daten beim Kunden. **Externe Requests:** keine (Fonts/Logo/QR werden lokal ausgeliefert); optionale Logo-URL.
- **Funktionen:** Besuchererfassung + Check-in/out, Suche/Filter, Statistik + CSV, Audit-Log, Einstellungen (Session/Aufbewahrung), White-Label (Logo-URL + Farbpalette), 2FA, Backup.

---

## API-Endpunkte

**App** (Session über `x-session-token`-Header)

| Methode & Pfad | Zweck |
|---|---|
| `POST /auth/login` · `/auth/logout` · `GET /auth/me` | Anmeldung (mit `code` bei 2FA) |
| `POST /auth/change-password` · `GET/POST /auth/users` · `PUT/DELETE /auth/users/:name` | Passwort / Benutzer (admin) |
| `GET /auth/2fa/status` · `POST /auth/2fa/{setup,enable,disable}` | 2FA |
| `GET /auth/audit` | Audit-Log |
| `GET /branding` | öffentlich: Logo / Farben / Demo-Flag |
| `GET/PUT /settings` | Session-Timeout, Aufbewahrung, Branding |
| `POST /backup` · `/backup/restore` · `/backup/rollback` | Backup |
| `GET/POST /visitors` · `POST /visitors/checkout/:id` · `PUT /visitors/:id` · `POST /visitors/import` | Besucher |

---

*integrisec · besucherlogin.de*
