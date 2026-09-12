#!/usr/bin/env bash
# Zurück auf die vorherige (oder eine angegebene) Version.
#
#   sudo ./rollback.sh             # auf das zuletzt aktive Tag zurück
#   sudo ./rollback.sh v1.0.0      # auf ein bestimmtes Tag
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/lib.sh"

require_root
detect_runtime
[ -f "$ENV_FILE" ] || die "Keine Installation gefunden ($ENV_FILE fehlt)."

TARGET="${1:-$(env_get BESUCHERLOGIN_PREV_TAG)}"
[ -n "$TARGET" ] || die "Kein vorheriges Tag bekannt. Tag explizit angeben:  rollback.sh <TAG>"

CUR_TAG="$(env_get BESUCHERLOGIN_TAG)"
log "Rollback: $CUR_TAG   →   $TARGET"
"$CR" pull "$IMAGE:$TARGET" || warn "Pull fehlgeschlagen – versuche lokal vorhandenes Image."

env_set BESUCHERLOGIN_PREV_TAG "$CUR_TAG"
env_set BESUCHERLOGIN_TAG "$TARGET"
systemctl restart "$SERVICE"

if wait_healthy 30; then ok "Rollback auf $TARGET erfolgreich."
else die "Version $TARGET wird nicht gesund. Prüfen:  journalctl -u $SERVICE -e"; fi
