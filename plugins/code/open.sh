#!/usr/bin/env bash
# Tools entry for the Code plugin: review the worktree root beside the focused
# agent pane as a muxr surface. No pane, PTY, Kitty graphics or CDP session
# is created; muxr Tools runs this in place with the originating agent
# context (declared under [surface] in herdr-plugin.toml).
set -euo pipefail
# Plugin actions run with a minimal PATH, so the muxr CLI is located the
# way a login shell would find it: MUXR_BIN wins when set, then PATH, then
# well-known install locations. Fails plainly instead of running nothing.
resolve_muxr() {
    if [ -n "${MUXR_BIN:-}" ]; then printf '%s' "$MUXR_BIN"; return 0; fi
    if command -v muxr >/dev/null 2>&1; then command -v muxr; return 0; fi
    for candidate in "$HOME/.local/bin/muxr" "$HOME/.local/share/mise/shims/muxr" /usr/local/bin/muxr /usr/bin/muxr; do
        if [ -x "$candidate" ]; then printf '%s' "$candidate"; return 0; fi
    done
    return 1
}

MUXR_CLI="$(resolve_muxr)" || { echo "code: the muxr CLI was not found; install @trymuxr/cli or set MUXR_BIN" >&2; exit 1; }
exec "$MUXR_CLI" code open --beside -- .
