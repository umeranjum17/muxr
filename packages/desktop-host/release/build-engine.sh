#!/usr/bin/env bash
# Build the prebuilt Linux x64 (glibc) engine from this checkout's source in the
# pinned container of linux-x64-gnu.Dockerfile. Needs Docker with BuildKit and
# network access; needs no Rust toolchain or system libraries on this machine.
#
#   release/build-engine.sh [output-dir]
#
# Writes desklink-host, THIRD_PARTY_LICENSES.txt and provenance.json to
# output-dir (default: dist-desklink/engine-linux-x64-gnu at the repository
# root). Publishes nothing.
set -euo pipefail

release="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
package="$(dirname "$release")"
out="${1:-$(git -C "$package" rev-parse --show-toplevel)/dist-desklink/engine-linux-x64-gnu}"
commit="$(git -C "$package" rev-parse HEAD)"
dirty=false
if [ -n "$(git -C "$package" status --porcelain -- .)" ]; then dirty=true; fi

rm -rf "$out"
DOCKER_BUILDKIT=1 docker build \
    --platform linux/amd64 \
    --file "$release/linux-x64-gnu.Dockerfile" \
    --build-arg "SOURCE_COMMIT=$commit" \
    --build-arg "SOURCE_DIRTY=$dirty" \
    --output "type=local,dest=$out" \
    "$package"

echo "engine  $out/desklink-host"
echo "sha256  $(sha256sum "$out/desklink-host" | cut -d' ' -f1)"
