#!/usr/bin/env bash
# Update auf ein neues Image-Tag – mit DB-Backup davor und automatischem
# Rollback, falls die neue Version nicht gesund wird.
#
#   sudo ./update.sh v1.1.0
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/lib.sh"

NEW_TAG="${1:-}"; [ -n "$NEW_TAG" ] || die "Aufruf: update.sh <TAG>   (z. B. v1.1.0)"
require_root
detect_runtime
[ -f "$ENV_FILE" ] || die "Keine Installation gefunden ($ENV_FILE fehlt). Zuerst setup.sh ausführen."

# Migration: Die Lizenzierung ist entfallen. Veraltete Variablen und Unit-Flags
# werden aktiv entfernt - ein blosser Hinweis wuerde ueberlesen.
for k in LICENSE_MODE LICENSE_API; do
  if env_unset "$k"; then ok "Veraltete Variable $k aus $ENV_FILE entfernt."; fi
done
if [ -f "$UNIT_FILE" ] && grep -qE "LICENSE_MODE|LICENSE_API" "$UNIT_FILE"; then
  sed -i 's| -e LICENSE_MODE=${LICENSE_MODE}||g; s| -e LICENSE_API=${LICENSE_API}||g' "$UNIT_FILE"
  systemctl daemon-reload
  ok "Veraltete Lizenz-Parameter aus $UNIT_FILE entfernt."
fi

CUR_TAG="$(env_get BESUCHERLOGIN_TAG)"; [ -n "$CUR_TAG" ] || die "Aktuelles Tag nicht ermittelbar."
log "Aktuell: $CUR_TAG   →   Neu: $NEW_TAG"
[ "$CUR_TAG" = "$NEW_TAG" ] && warn "Ziel-Tag entspricht dem aktuellen Tag."

# 1) DB-Backup VOR dem Update
log "Erstelle DB-Backup…"
"$HERE/backup.sh" || die "Backup fehlgeschlagen – Update abgebrochen, nichts geändert."

# 2) Neues Image zuerst holen (Pull-Fehler stoppt VOR der Downtime)
log "Hole $IMAGE:$NEW_TAG"
"$CR" pull "$IMAGE:$NEW_TAG" || die "Pull fehlgeschlagen – nichts geändert."

# 3) Umschalten: vorheriges Tag merken, neues setzen, Service neu starten
env_set BESUCHERLOGIN_PREV_TAG "$CUR_TAG"
env_set BESUCHERLOGIN_TAG "$NEW_TAG"
log "Starte Service mit $NEW_TAG neu…"
systemctl restart "$SERVICE"

# 4) Health prüfen – sonst automatischer Rollback aufs alte Tag
if wait_healthy 30; then
  ok "Update auf $NEW_TAG erfolgreich (Backup unter $BACKUP_DIR, vorher $CUR_TAG)."
else
  warn "Neue Version nicht gesund – automatischer Rollback auf $CUR_TAG."
  env_set BESUCHERLOGIN_TAG "$CUR_TAG"
  systemctl restart "$SERVICE"
  if wait_healthy 30; then
    warn "Rollback auf $CUR_TAG erfolgreich. Das Update ($NEW_TAG) wurde verworfen."
    exit 1
  else
    die "Auch der Rollback ist nicht gesund. Manuell prüfen:  journalctl -u $SERVICE -e"
  fi
fi
