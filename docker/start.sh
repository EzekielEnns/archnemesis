#!/bin/sh
# Start Archnemesis. With ARCHNM_LITESTREAM_URL set (gs://bucket/path), the database is restored
# from that replica when the disk is empty (a host whose disk does not last) and every change is
# copied there as it's written; without it, Archnemesis runs as before.
set -eu
# Reads the old names: ATLAS_* wins over the image's own ARCHNM_* defaults (server/env-compat.ts
# can't, they're set), and a volume that still holds atlas.sqlite is opened in place.
for old in $(env | sed -n 's/^\(ATLAS_[A-Za-z0-9_]*\)=.*/\1/p'); do
  new="ARCHNM_${old#ATLAS_}"
  eval "export $new=\"\${$old}\""
  echo "archnm: $old is the old name; use $new instead (still read for now)" >&2
done
if [ ! -e "$ARCHNM_DB" ] && [ -e "$(dirname "$ARCHNM_DB")/atlas.sqlite" ]; then
  export ARCHNM_DB="$(dirname "$ARCHNM_DB")/atlas.sqlite"
fi
if [ -n "${ARCHNM_LITESTREAM_URL:-}" ]; then
  mkdir -p "$(dirname "$ARCHNM_DB")"
  litestream restore -if-db-not-exists -if-replica-exists -o "$ARCHNM_DB" "$ARCHNM_LITESTREAM_URL"
  exec litestream replicate -exec "node server/main.ts" "$ARCHNM_DB" "$ARCHNM_LITESTREAM_URL"
fi
exec node server/main.ts
