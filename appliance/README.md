# Besucherlogin – On-Prem-Appliance

Auslieferung als **Container-Image** auf einer schlanken Kunden-VM. Hypervisor-unabhängig
(VMware/Proxmox/Hyper-V – kein OVA), **Podman** bevorzugt, Docker-kompatibel.

```
appliance/
  Containerfile        schlankes Image (node:24-slim, node:sqlite eingebaut, kein Build-Step)
  setup.sh             Erstinstallation (Runtime-Check, Volume, Service, Health)
  update.sh            Update auf neues Tag – mit Backup + Auto-Rollback
  rollback.sh          zurück auf vorheriges/angegebenes Tag
  backup.sh            konsistentes DB-Backup (VACUUM INTO, ohne Downtime)
  lib.sh               gemeinsame Konfiguration/Helfer (per Env überschreibbar)
```

## Verantwortungsgrenze

| | |
|---|---|
| **integrisec** | App, Container-Image, diese Scripts, Updates |
| **Kunde** | Host-OS, VM, Netzwerk/TLS-Proxy, **Backup von `/opt/besucherlogin`** |

Die App ist vom Host entkoppelt: alles läuft im Container, einziger Host-Touchpoint ist
die systemd-Unit für den Autostart. Persistente Daten liegen **außerhalb** des Containers.

## Verzeichnisse

| Pfad | Inhalt |
|---|---|
| `/opt/besucherlogin/data` | SQLite-DB (`besucher.db` + WAL) — **das ist der zu sichernde Datenbestand** |
| `/opt/besucherlogin/backups` | Backups aus `backup.sh` / vor jedem Update |
| `/etc/besucherlogin/besucherlogin.env` | Konfiguration (aktuelles/voriges Tag, Erst-Passwort) |
| `/etc/systemd/system/besucherlogin.service` | Autostart-Service |

Ein Image-/Container-Tausch fasst `/opt/besucherlogin/data` **nie** an – die Daten
überstehen Updates unverändert.

## Voraussetzungen (Kunden-VM)

- Linux mit **systemd** und **rootful podman** (oder docker), `openssl`

## Dateien auf die VM holen

Gebraucht wird nur das Verzeichnis `appliance/`. Ohne Git, direkt aus dem Release:

```bash
VERSION=v1.0.1
curl -fsSL https://github.com/integrisec-de/besucherlogin/archive/refs/tags/$VERSION.tar.gz \
  | tar -xz --strip-components=1 besucherlogin-${VERSION#v}/appliance
cd appliance && chmod +x *.sh
```

Alternativ das ganze Repo per Git:

```bash
git clone --depth 1 --branch v1.0.1 https://github.com/integrisec-de/besucherlogin.git
cd besucherlogin/appliance && chmod +x *.sh
```

Das `chmod` ist nötig – im Archiv sind die Scripts nicht als ausführbar markiert.

## Installation (einmalig)

```bash
sudo ./setup.sh v1.0.1      # ohne Tag = latest
```

Das Script legt Volume + Service an, startet den Container, prüft Health und gibt das
**einmalige Admin-Passwort** aus. Danach erreichbar unter `https://<VM-IP>/`
(self-signed ab Werk; eigenes Zertifikat im Adminbereich unter „TLS" einspielbar, Live-Reload).

## Update (per Konsole)

```bash
sudo ./update.sh v1.1.0
```

Ablauf automatisch: **DB-Backup → neues Image ziehen → Tag umschalten → Service-Neustart →
Health-Check**. Wird die neue Version nicht gesund, erfolgt **automatischer Rollback** aufs
alte Tag. Daten bleiben unangetastet (gleiches Volume).

## Rollback (manuell)

```bash
sudo ./rollback.sh             # auf das zuletzt aktive Tag
sudo ./rollback.sh v1.0.0      # auf ein bestimmtes Tag
```

## Backup / Wiederherstellung

```bash
sudo ./backup.sh               # -> /opt/besucherlogin/backups/besucher-<ts>.db
```

Wiederherstellen (bewusst manuell, Container gestoppt – verhindert Schreibkonflikte):

```bash
sudo systemctl stop besucherlogin
sudo cp /opt/besucherlogin/backups/besucher-<ts>.db /opt/besucherlogin/data/besucher.db
sudo rm -f /opt/besucherlogin/data/besucher.db-wal /opt/besucherlogin/data/besucher.db-shm
sudo chown 10001:10001 /opt/besucherlogin/data/besucher.db
sudo systemctl start besucherlogin
```

> Zusätzlich kann der Kunde jederzeit das ganze Verzeichnis `/opt/besucherlogin` per
> VM-Snapshot/Backup sichern – das ist seine Verantwortung.

## Versionierung & Rollback-Logik

- Images werden **unveränderlich** als `vX.Y.Z` getaggt (plus bewegliches `latest`).
- **Produktiv immer per `vX.Y.Z`** ausrollen, nie `latest` – so ist der Rollback eindeutig.
- Das aktive und das vorherige Tag stehen in `besucherlogin.env`
  (`BESUCHERLOGIN_TAG`, `BESUCHERLOGIN_PREV_TAG`).

## Schema-Migrationen

Die DB besteht aus einer generischen `kv`-Tabelle (Daten als JSON) – echte Schema-Änderungen
sind selten. Falls nötig, laufen Migrationen **beim Container-Start** über `PRAGMA user_version`:
geordnet, idempotent, **nur additiv** (Spalten/Tabellen/Indizes ergänzen, nie droppen/umbenennen).
Dadurch kann ein Rollback auf ein älteres Image die neuere DB weiterlesen; das Pre-Update-Backup
ist das zusätzliche Netz.

## Image bauen/veröffentlichen (integrisec-seitig)

Automatisch per GitHub Actions beim Tag-Push:

```bash
git tag vX.Y.Z && git push origin vX.Y.Z
# -> ghcr.io/<owner>/besucherlogin:vX.Y.Z  +  :latest
```

Manuell/lokal:

```bash
podman build -f appliance/Containerfile -t ghcr.io/<owner>/besucherlogin:vX.Y.Z .
podman push ghcr.io/<owner>/besucherlogin:vX.Y.Z
```

> Der GHCR-Namespace richtet sich nach dem GitHub-Owner (aktuell `integrisec-de`).
> Für einen eigenen Namespace das Image dort hosten und `BESUCHERLOGIN_IMAGE` in
> `lib.sh` bzw. per Env entsprechend setzen.

## Docker statt Podman

Die Scripts erkennen die Runtime automatisch (`podman` bevorzugt, sonst `docker`). Der
Service nutzt in beiden Fällen dieselbe `run`-Befehlszeile.
