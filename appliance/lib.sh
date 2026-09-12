#!/usr/bin/env bash
# Gemeinsame Konfiguration + Helfer für die Besucherlogin-Appliance-Scripts.
# Wird von setup.sh / update.sh / rollback.sh / backup.sh per `source` geladen.

set -euo pipefail

# ---- Konfiguration (alles per Umgebungsvariable überschreibbar) -------------
# Hinweis: Der GHCR-Namespace richtet sich nach dem GitHub-Owner. Das Repo liegt
# unter der Organisation "integrisec-de" -> Default unten. Fuer einen eigenen
# Namespace entsprechend setzen:
#   export BESUCHERLOGIN_IMAGE=ghcr.io/<eigener-owner>/besucherlogin
IMAGE="${BESUCHERLOGIN_IMAGE:-ghcr.io/integrisec-de/besucherlogin}"
DATA_DIR="${BESUCHERLOGIN_DATA:-/opt/besucherlogin/data}"
BACKUP_DIR="${BESUCHERLOGIN_BACKUPS:-/opt/besucherlogin/backups}"
ENV_FILE="${BESUCHERLOGIN_ENVFILE:-/etc/besucherlogin/besucherlogin.env}"
UNIT_FILE="${BESUCHERLOGIN_UNIT:-/etc/systemd/system/besucherlogin.service}"
CONTAINER="besucherlogin"
SERVICE="besucherlogin.service"
APP_UID=10001
APP_GID=10001

# ---- Ausgabe ----------------------------------------------------------------
c_blue=$'\033[34m'; c_green=$'\033[32m'; c_red=$'\033[31m'; c_yellow=$'\033[33m'; c_0=$'\033[0m'
log()  { printf '%s==>%s %s\n' "$c_blue"   "$c_0" "$*"; }
ok()   { printf '%s  ok%s %s\n' "$c_green"  "$c_0" "$*"; }
warn() { printf '%s  !!%s %s\n' "$c_yellow" "$c_0" "$*" >&2; }
die()  { printf '%sFehler:%s %s\n' "$c_red" "$c_0" "$*" >&2; exit 1; }

require_root() { [ "$(id -u)" -eq 0 ] || die "Bitte als root ausführen (rootful Podman/Docker), z. B. mit sudo."; }

detect_runtime() {
  if   command -v podman >/dev/null 2>&1; then CR=podman; CR_BIN="$(command -v podman)"
  elif command -v docker >/dev/null 2>&1; then CR=docker; CR_BIN="$(command -v docker)"
  else die "Weder podman noch docker gefunden. Container-Runtime installieren."; fi
}

# Einzelnen Wert aus dem Env-File lesen (z. B. aktuelles Tag).
env_get() { [ -f "$ENV_FILE" ] && sed -n "s/^$1=//p" "$ENV_FILE" | tail -n1 || true; }

# Schlüssel im Env-File idempotent setzen/ersetzen.
env_set() {
  local key="$1" val="$2"
  install -d -m 700 "$(dirname "$ENV_FILE")"
  [ -f "$ENV_FILE" ] || { : > "$ENV_FILE"; }
  chmod 600 "$ENV_FILE"
  if grep -q "^$key=" "$ENV_FILE"; then
    sed -i "s|^$key=.*|$key=$val|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$val" >> "$ENV_FILE"
  fi
}

# Schlüssel aus dem Env-File entfernen. Rueckgabe 0 = entfernt, 1 = war nicht da.
env_unset() {
  local key="$1"
  [ -f "$ENV_FILE" ] || return 1
  grep -q "^$key=" "$ENV_FILE" || return 1
  sed -i "/^$key=/d" "$ENV_FILE"
}

# Wartet, bis die App im laufenden Container gesund antwortet (Default 30x2s).
wait_healthy() {
  local tries="${1:-30}" i
  for ((i=1; i<=tries; i++)); do
    if "$CR" exec "$CONTAINER" node -e \
      "process.env.NODE_TLS_REJECT_UNAUTHORIZED='0';fetch('https://127.0.0.1:8443/branding').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
      >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  return 1
}
