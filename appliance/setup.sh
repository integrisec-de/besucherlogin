#!/usr/bin/env bash
# Erstinstallation der Besucherlogin-Appliance auf einer frischen VM.
# Idempotent: erneutes Ausführen aktualisiert Unit/Konfig, ohne Daten zu verlieren.
#
#   sudo ./setup.sh [TAG]        # TAG z. B. v1.0.0 (Default: latest)
#
# Voraussetzungen: rootful podman (bevorzugt) oder docker, systemd, openssl.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/lib.sh"

TAG="${1:-${BESUCHERLOGIN_TAG:-latest}}"

require_root
detect_runtime
log "Container-Runtime: $CR ($CR_BIN)"
command -v systemctl >/dev/null 2>&1 || die "systemd (systemctl) nicht gefunden."

# 1) Persistentes Datenverzeichnis außerhalb des Containers --------------------
log "Datenverzeichnis: $DATA_DIR"
install -d "$DATA_DIR" "$BACKUP_DIR"
chown -R "$APP_UID:$APP_GID" "$DATA_DIR"
ok "angelegt (Eigentümer UID $APP_UID)"

# 2) Image holen --------------------------------------------------------------
log "Hole Image $IMAGE:$TAG"
"$CR" pull "$IMAGE:$TAG" || die "Image-Pull fehlgeschlagen. Ist $IMAGE:$TAG erreichbar?"
DIGEST="$("$CR" image inspect "$IMAGE:$TAG" --format '{{ index .RepoDigests 0 }}' 2>/dev/null || true)"
ok "Image bereit${DIGEST:+  ($DIGEST)}"

# 3) Konfiguration / Env-File -------------------------------------------------
ADMIN_SHOW=""
if [ -f "$DATA_DIR/besucher.db" ]; then
  log "Bestehende Datenbank gefunden – kein neues Admin-Passwort nötig."
else
  ADMIN_PW="$(openssl rand -base64 24 2>/dev/null | tr -dc 'A-Za-z0-9' | cut -c1-24)"
  [ -n "$ADMIN_PW" ] || die "Konnte kein Passwort erzeugen (openssl vorhanden?)."
  env_set ADMIN_PASSWORD "$ADMIN_PW"
  ADMIN_SHOW="$ADMIN_PW"
fi
env_set BESUCHERLOGIN_IMAGE "$IMAGE"
env_set BESUCHERLOGIN_TAG   "$TAG"
env_set BESUCHERLOGIN_DATA  "$DATA_DIR"
env_set BESUCHERLOGIN_PORT  "$HOST_PORT"
ok "Konfiguration: $ENV_FILE"

# 3b) TLS: self-signed Zertifikat erzeugen, falls noch keins vorhanden → HTTPS ab Werk
TLS_DIR_HOST="$DATA_DIR/tls"
if [ ! -f "$TLS_DIR_HOST/cert.pem" ]; then
  log "Erzeuge self-signed TLS-Zertifikat…"
  install -d "$TLS_DIR_HOST"
  HOST="${BESUCHERLOGIN_HOSTNAME:-$(hostname -f 2>/dev/null || hostname)}"
  IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
  SAN="DNS:${HOST},DNS:localhost"
  [ -n "$IP" ] && SAN="${SAN},IP:${IP}"
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
    -keyout "$TLS_DIR_HOST/key.pem" -out "$TLS_DIR_HOST/cert.pem" \
    -subj "/CN=${HOST}" -addext "subjectAltName=${SAN}" >/dev/null 2>&1 \
    || die "openssl-Zertifikatserstellung fehlgeschlagen."
  ok "self-signed Zertifikat für ${HOST}"
fi
chown -R "$APP_UID:$APP_GID" "$TLS_DIR_HOST"
chmod 600 "$TLS_DIR_HOST/key.pem"; chmod 644 "$TLS_DIR_HOST/cert.pem"

# 4) systemd-Service (Autostart bei Boot, Neustart bei Absturz) ---------------
log "Installiere systemd-Service: $SERVICE"
install -d "$(dirname "$UNIT_FILE")"
cat > "$UNIT_FILE" <<UNIT
[Unit]
Description=Besucherlogin (integrisec) – On-Prem Besuchermanagement
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=$ENV_FILE
TimeoutStartSec=120
Restart=always
RestartSec=5
ExecStartPre=-$CR_BIN rm -f $CONTAINER
ExecStart=$CR_BIN run --rm --name $CONTAINER -p 443:8443 -p 80:8787 -v \${BESUCHERLOGIN_DATA}:/data:Z -e DB_PATH=/data/besucher.db -e TLS_DIR=/data/tls -e ADMIN_PASSWORD=\${ADMIN_PASSWORD} \${BESUCHERLOGIN_IMAGE}:\${BESUCHERLOGIN_TAG}
ExecStop=-$CR_BIN stop -t 10 $CONTAINER

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now "$SERVICE"
ok "Service aktiviert"

# 5) Health + Persistenz prüfen ----------------------------------------------
log "Warte auf Health (/branding)…"
if wait_healthy 30; then ok "App antwortet"; else
  warn "App wurde nicht rechtzeitig gesund. Logs:  journalctl -u $SERVICE -e"
  die "Setup unvollständig."
fi
if [ -f "$DATA_DIR/besucher.db" ]; then ok "SQLite-DB persistent: $DATA_DIR/besucher.db"
else warn "DB-Datei noch nicht sichtbar (entsteht beim ersten Schreibzugriff)."; fi

echo
ok "Fertig. App erreichbar auf  https://<VM-IP>/  (self-signed; eigenes Zertifikat im Adminbereich unter „TLS“ einspielbar)."
if [ -n "$ADMIN_SHOW" ]; then
cat <<BOX

  ====================================================
   Erst-Login    Benutzer:  admin
                 Passwort:  $ADMIN_SHOW
   (einmalig – nach dem ersten Login ändern.
    Hinterlegt in $ENV_FILE)
  ====================================================
BOX
fi
