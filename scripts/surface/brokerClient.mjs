/**
 * Local client for the host Surface broker.
 *
 * Talks to the owner-only Unix socket under the host data directory, sending
 * one JSON line per connection and reading one back. `HERDR_PANE_ID` and the
 * cwd travel as context hints only; no relay token, tunnel key or capability
 * secret is read from the environment or written to any output.
 *
 * Replies never carry internal ids: the broker's visible face names the
 * logical surface only, and this client drops anything shaped like a handle,
 * lease, session, pane, device, token, secret or credential before printing,
 * in both human and JSON modes.
 */
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const MAX_REPLY_BYTES = 64 * 1024;
const CALL_TIMEOUT_MS = 30_000;

export function hostDataDir() {
    if (process.env.MUXR_DATA_DIR?.trim()) return process.env.MUXR_DATA_DIR.trim();
    const home = process.env.MUXR_HOME?.trim() || join(process.env.HOME?.trim() || homedir(), '.muxr');
    return join(home, 'host');
}

export function surfaceSocketPath() {
    return join(hostDataDir(), 'surface', 'broker.sock');
}

const DENIED_KEY = /(handle|lease|session|pane|device|token|secret|password|admission|credential|channel|expir)/i;

export function redactForDisplay(value) {
    if (Array.isArray(value)) return value.map(redactForDisplay);
    if (typeof value !== 'object' || value === null) return value;
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
        if (DENIED_KEY.test(key)) continue;
        out[key] = redactForDisplay(entry);
    }
    return out;
}

/**
 * Original action context from the trusted launcher environment.
 *
 * Herdr runs every plugin action from the plugin root with the invoking
 * context in `HERDR_PLUGIN_CONTEXT_JSON`: the focused live agent pane id,
 * its live cwd, workspace and tab. The action's own `process.cwd()` is
 * that plugin root -- never the agent's directory -- so forwarding it
 * would fail the broker's strict context check (or worse, resolve
 * somewhere unintended). The launcher wrote this JSON, not the caller:
 * it is a hint like `HERDR_PANE_ID`, validated against the live tree by
 * the broker, never trusted outright. Absent or malformed, fall back to
 * the process cwd exactly as before.
 */
function actionContextCwd() {
    const raw = process.env.HERDR_PLUGIN_CONTEXT_JSON?.trim();
    if (raw) {
        try {
            const parsed = JSON.parse(raw);
            const cwd = parsed?.focused_pane_cwd;
            if (typeof cwd === 'string' && cwd !== '' && cwd.startsWith('/')) return cwd;
        } catch {
            /* malformed launcher context is not a cwd; fall through */
        }
    }
    return process.cwd();
}

export async function callSurfaceBroker(request) {
    const id = `cli-${randomUUID().slice(0, 8)}`;
    const actionCwd = actionContextCwd();
    const message = {
        id,
        request,
        ...(process.env.HERDR_PANE_ID?.trim() ? { paneId: process.env.HERDR_PANE_ID.trim() } : {}),
        ...(actionCwd ? { cwd: actionCwd } : {}),
    };
    const encoded = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(encoded) > 32 * 1024) throw new Error('surface: that request is too large');
    const socketPath = surfaceSocketPath();
    return new Promise((resolvePromise, reject) => {
        let settled = false;
        const settle = (action) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            action();
        };
        const timer = setTimeout(() => {
            settle(() => reject(new Error('surface: the host did not answer; is it running?')));
            socket.destroy();
        }, CALL_TIMEOUT_MS);
        // This timer must stay ref'd: it is what keeps the standalone CLI
        // alive until the broker answers or the deadline fires. Top-level
        // await does not hold the loop on its own, and an unref here exits
        // the process with unsettled top-level await before the socket does.
        // Every settle path clears it, so nothing lingers on success.
        const socket = connect(socketPath);
        // Buffered until the socket connects: without this write the broker
        // waits for a newline that never comes and the call hangs to the
        // deadline above.
        socket.write(encoded);
        let input = '';
        socket.once('error', (error) => {
            settle(() => reject(new Error(`surface: cannot reach the host (${error.code ?? 'unavailable'})`)));
        });
        socket.on('data', (chunk) => {
            input += chunk.toString('utf8');
            if (Buffer.byteLength(input) > MAX_REPLY_BYTES) {
                settle(() => reject(new Error('surface: the host reply is too large')));
                socket.destroy();
                return;
            }
            const newline = input.indexOf('\n');
            if (newline === -1) return;
            const line = input.slice(0, newline);
            socket.end();
            let reply;
            try {
                reply = JSON.parse(line);
            } catch {
                settle(() => reject(new Error('surface: the host reply is invalid')));
                return;
            }
            if (typeof reply !== 'object' || reply === null || reply.id !== id) {
                settle(() => reject(new Error('surface: the host reply is invalid')));
                return;
            }
            if (reply.ok !== true) {
                settle(() => reject(new Error(`surface: ${typeof reply.error === 'string' && reply.error !== '' ? reply.error : 'request failed'}`)));
                return;
            }
            settle(() => resolvePromise(reply.data));
        });
    });
}
