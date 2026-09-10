#!/usr/bin/env bash
# Export the paired browser client and atomically replace the served document root.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DOC_ROOT="${MUXR_WEB_EXPORT_DIR:-$HOME/.muxr/web-public}"

cd "$ROOT"
# Self-host exports must never bake the public marketing origin into the
# bundle: the installed PWA's origin is the owner's own machine. The npm
# release pack keeps MUXR_PUBLIC_BASE_URL via `yarn pack`.
env -u EXPO_PUBLIC_MUXR_TOKEN \
    -u EXPO_PUBLIC_MUXR_MACHINE_ID \
    -u EXPO_PUBLIC_MUXR_MODE \
    -u MUXR_PUBLIC_BASE_URL \
    npm run web:export
cp "$ROOT/install.sh" apps/mobile/dist/install.sh

mkdir -p "$DOC_ROOT"
rm -rf "$DOC_ROOT.new" "$DOC_ROOT.old"
mv apps/mobile/dist "$DOC_ROOT.new"
if [ -d "$DOC_ROOT" ]; then
    # Atomic rename swap: readers never see a half-written tree, and old HTML
    # can never reference chunks a concurrent re-export already deleted.
    mv "$DOC_ROOT" "$DOC_ROOT.old"
fi
mv "$DOC_ROOT.new" "$DOC_ROOT"
rm -rf "$DOC_ROOT.old"
echo "deployed credential-free browser export to $DOC_ROOT"
