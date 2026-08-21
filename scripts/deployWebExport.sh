#!/usr/bin/env bash
# Export the paired browser client and atomically replace the served document root.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DOC_ROOT="${MUXR_WEB_EXPORT_DIR:-$HOME/.muxr/web-public}"

cd "$ROOT"
env -u EXPO_PUBLIC_MUXR_TOKEN \
    -u EXPO_PUBLIC_MUXR_E2EE_KEY \
    -u EXPO_PUBLIC_MUXR_MACHINE_ID \
    -u EXPO_PUBLIC_MUXR_MODE \
    npm run web:export
cp "$ROOT/install.sh" apps/mobile/dist/install.sh

mkdir -p "$DOC_ROOT"
rm -rf "$DOC_ROOT.new"
mv apps/mobile/dist "$DOC_ROOT.new"
rm -rf "$DOC_ROOT.old"
[ -d "$DOC_ROOT" ] && cp -r "$DOC_ROOT" "$DOC_ROOT.old" 2>/dev/null || true
rsync -a --delete "$DOC_ROOT.new/" "$DOC_ROOT/"
rm -rf "$DOC_ROOT.new"
echo "deployed credential-free browser export to $DOC_ROOT"
