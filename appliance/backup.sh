#!/usr/bin/env bash
# Konsistentes SQLite-Backup ohne Downtime via `VACUUM INTO` im laufenden
# Container. Ergebnis landet host-seitig unter $BACKUP_DIR.
#
#   sudo ./backup.sh
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/lib.sh"

require_root
detect_runtime
install -d "$BACKUP_DIR"

TS="$(date +%Y%m%d-%H%M%S)"
OUT="$BACKUP_DIR/besucher-$TS.db"

"$CR" ps --format '{{.Names}}' | grep -qx "$CONTAINER" \
  || die "Container '$CONTAINER' läuft nicht. (Alternativ DB-Datei bei gestopptem Container kalt kopieren.)"

log "Erzeuge konsistenten Snapshot…"
"$CR" exec "$CONTAINER" node --experimental-sqlite -e "
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(process.env.DB_PATH);
  db.exec(\"VACUUM INTO '/data/_backup-$TS.db'\");
  db.close();
" || die "VACUUM INTO fehlgeschlagen."

# Container-/data/ == Host-$DATA_DIR (Bind-Mount) -> Datei liegt direkt hier.
mv "$DATA_DIR/_backup-$TS.db" "$OUT"
chmod 600 "$OUT"
ok "Backup: $OUT  ($(du -h "$OUT" | cut -f1))"

# Aufräumen: Backups älter als 30 Tage entfernen.
find "$BACKUP_DIR" -name 'besucher-*.db' -mtime +30 -delete 2>/dev/null || true
