/**
 * Isolated pi agent home for tests and diagnostics that launch a real pi.
 *
 * A real pi resolves its agent directory (sessions, auth, projects-memory,
 * memory extensions) from the `PI_CODING_AGENT_DIR` environment variable and
 * falls back to `~/.pi/agent` when it is unset (see pi's own
 * `packages/coding-agent/src/config.ts`: `getAgentDir()` reads
 * `PI_CODING_AGENT_DIR`, default `join(homedir(), '.pi', 'agent')`). Every
 * real-pi run without that variable writes per-cwd folders into the user's
 * real `~/.pi/agent/projects-memory`, which once accumulated ~900 stale
 * folders and slowed every new pi startup.
 *
 * Every check that launches a real pi must call `isolatePiAgentDir()` first
 * and `releasePiAgentDir()` afterwards. The host forwards a set
 * `PI_CODING_AGENT_DIR` into every Herdr pane it creates (see
 * `paneEnvironment` in `apps/host/src/agent/infrastructure/herdrSessionSource.ts`),
 * so pi processes Herdr spawns for these checks inherit the temp dir.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const PI_AGENT_DIR_ENV = 'PI_CODING_AGENT_DIR';

/** Point pi at a fresh per-run temp agent dir. Returns the dir for cleanup. */
export function isolatePiAgentDir() {
    const dir = mkdtempSync(join(tmpdir(), 'pock-pi-agent-'));
    const previous = process.env[PI_AGENT_DIR_ENV];
    process.env[PI_AGENT_DIR_ENV] = dir;
    return { dir, previous };
}

/** Remove the temp agent dir and restore the previous env value, if any. */
export function releasePiAgentDir(isolation) {
    if (!isolation) return;
    rmSync(isolation.dir, { recursive: true, force: true });
    if (isolation.previous === undefined) delete process.env[PI_AGENT_DIR_ENV];
    else process.env[PI_AGENT_DIR_ENV] = isolation.previous;
}
