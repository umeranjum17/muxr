#!/bin/sh
set -eu

package='@trymuxr/cli'
version=${1:-${MUXR_VERSION:-latest}}
node_bin=${MUXR_NODE_BIN:-node}
npm_bin=${MUXR_NPM_BIN:-npm}

case ${version} in
    ''|*[!A-Za-z0-9._+-]*)
        printf '%s\n' "muxr installer: invalid version '$version'" >&2
        exit 2
        ;;
esac

case $(uname -s) in
    Linux|Darwin) ;;
    *) printf '%s\n' 'muxr supports Linux and macOS hosts.' >&2; exit 1 ;;
esac

if ! command -v "$node_bin" >/dev/null 2>&1; then
    printf '%s\n' 'muxr needs Node.js 22 or newer. Install it from https://nodejs.org, then rerun this command.' >&2
    exit 1
fi
if ! "$node_bin" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'; then
    printf '%s\n' "muxr needs Node.js 22 or newer; found $("$node_bin" --version 2>/dev/null || printf unknown)." >&2
    exit 1
fi
if ! command -v "$npm_bin" >/dev/null 2>&1; then
    printf '%s\n' 'muxr needs npm on PATH (normally included with Node.js).' >&2
    exit 1
fi

prefix=$("$npm_bin" prefix --global)
printf '%s\n' "Installing ${package}@${version} with npm (lifecycle scripts disabled)…"
if ! "$npm_bin" install --global --ignore-scripts "${package}@${version}"; then
    printf '%s\n' "npm could not write its global prefix (${prefix}). Use a user-owned Node installation or npm prefix; this installer will not use sudo." >&2
    exit 1
fi

muxr_bin=${prefix}/bin/muxr
if [ ! -x "$muxr_bin" ]; then
    printf '%s\n' "muxr installed, but ${muxr_bin} was not found." >&2
    exit 1
fi

installed=$("$muxr_bin" version)
printf '%s\n' "Installed muxr ${installed}."
printf '%s\n' 'Next: run `muxr` for guided setup.'
if [ "$(command -v muxr 2>/dev/null || true)" != "$muxr_bin" ]; then
    printf '%s\n' "Add ${prefix}/bin to PATH first."
fi
