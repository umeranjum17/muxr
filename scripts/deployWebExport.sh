#!/usr/bin/env bash
# Export the paired browser client and update the served document root
# without ever taking it offline or orphaning already-loaded pages.
#
# Strategy: fingerprinted (content-hashed) assets sync first with no
# deletion, then each mutable entry file is renamed over last — renames are
# atomic, so a browser always reads the old or the new entry, never a mix.
# Old hashed assets stay until they age out, so HTML loaded before the
# deploy keeps resolving its chunks.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DOC_ROOT="${MUXR_WEB_EXPORT_DIR:-$HOME/.muxr/web-public}"
# Mutable entry files: revalidated (no-store) on every load.
ENTRIES="index.html sw.js manifest.webmanifest install.sh"
# Stale hashed assets older than this are pruned (already-loaded pages hold
# no server-side state, so age-out only needs to cover long-lived tabs).
PRUNE_DAYS="${MUXR_WEB_PRUNE_DAYS:-7}"

cd "$ROOT"
# Self-host export mode: credential-free production web with no marketing
# origin baked in. The installed PWA's origin is the owner's own machine.
npm run web:export:selfhost
cp "$ROOT/install.sh" apps/mobile/dist/install.sh

DIST="$ROOT/apps/mobile/dist"
mkdir -p "$DOC_ROOT"

# 1. Fingerprinted assets first (everything except the mutable entries).
# No deletion: old hashed assets stay so already-loaded pages keep working.
rsync -a \
    $(printf -- '--exclude=%s ' $ENTRIES) \
    "$DIST/" "$DOC_ROOT/"

# 2. Mutable entries last, one atomic rename each.
for entry in $ENTRIES; do
    if [ -f "$DIST/$entry" ]; then
        mv "$DIST/$entry" "$DOC_ROOT/$entry"
    fi
done

# 3. Prune files this export no longer ships, but only once they are old
# enough that no loaded page can still want them. Everything just deployed
# carries a fresh mtime, so age selects exactly the orphaned past.
find "$DOC_ROOT" -type f -mtime "+$PRUNE_DAYS" \
    ! -name 'index.html' ! -name 'sw.js' ! -name 'manifest.webmanifest' ! -name 'install.sh' \
    -delete 2>/dev/null || true

rm -rf "$DIST"
echo "deployed credential-free browser export to $DOC_ROOT"
