#!/usr/bin/env bash
# Install the packed tarballs into a fresh project in a clean container — no
# Rust toolchain, no display, no D-Bus session, no /dev/uinput — and have the
# installed host package find the prebuilt engine, start it, and answer the
# protocol handshake and a capabilities probe. Opens no portal, captures
# nothing and creates no input device.
#
#   release/check-install.sh [tarball-dir]
#
# tarball-dir holds what release/pack.mjs --engine wrote (default:
# dist-desklink/ at the repository root).
set -euo pipefail

release="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tarballs="$(cd "${1:-$(git -C "$release" rev-parse --show-toplevel)/dist-desklink}" && pwd)"
image=node:22-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9

docker run --rm --platform linux/amd64 --volume "$tarballs:/tarballs:ro" "$image" bash -euo pipefail -c '
    # What a desktop running PipeWire already has.
    apt-get update -qq
    apt-get install -y -qq --no-install-recommends libpipewire-0.3-0 libxkbcommon0 libevdev2 >/dev/null
    if command -v cargo || command -v rustc; then echo "a Rust toolchain is on PATH" >&2; exit 1; fi

    mkdir /project && cd /project
    npm init -y >/dev/null
    npm install --ignore-scripts --no-audit --no-fund /tarballs/*.tgz
    ls -l node_modules/@desklink/host-linux-x64-gnu/desklink-host
    npx desklink-host path

    node --input-type=module -e "
        import { EngineClient, resolveEngine } from \"@desklink/host\";
        const engine = resolveEngine();
        if (engine?.origin !== \"prebuilt\") throw new Error(\"no prebuilt engine resolved: \" + JSON.stringify(engine));
        const client = await EngineClient.start(engine.command, engine.args, { onDiagnostic: (line) => console.error(line) });
        const capabilities = await client.capabilities();
        await client.stop();
        console.log(JSON.stringify({ resolved: engine, capabilities }, null, 2));
    "
'
