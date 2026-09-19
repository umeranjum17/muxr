import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

process.env.TZ = 'UTC';

/** Drives the real plugin script end to end against a machine where every
 *  collector fails or answers empty and no plan is connected. */
describe('usage plugin flow', () => {
    const root = mkdtempSync(join(tmpdir(), 'muxr-usage-'));
    const home = join(root, 'home');
    const data = join(root, 'data');
    const bin = join(root, 'bin');
    const claude = join(root, 'claude');
    const codex = join(root, 'codex');
    for (const dir of [home, data, bin, claude, codex]) mkdirSync(dir, { recursive: true });
    const ccusage = join(bin, 'ccusage-stub');
    writeFileSync(ccusage, '#!/bin/sh\necho \'{"daily":[]}\'\n');
    chmodSync(ccusage, 0o755);
    // OMP's profile name is invalid, so its collector refuses; Pi's sessions
    // root is a file, so its collector throws instead of measuring empty.
    writeFileSync(join(home, 'sessions'), '');
    const env = {
        PATH: bin,
        HOME: home,
        TZ: 'UTC',
        XDG_DATA_HOME: data,
        CLAUDE_CONFIG_DIR: claude,
        CODEX_HOME: codex,
        PI_AGENT_DIR: home,
        PI_CONFIG_DIR: join(home, '.omp'),
        OMP_PROFILE: 'bad.',
        MUXR_CCUSAGE_BIN: ccusage,
        MUXR_USAGE_NOW: '2026-09-05T12:00:00Z',
    };

    afterAll(() => { rmSync(root, { recursive: true, force: true }); });

    it('announces no supported providers when nothing could be measured or connected', () => {
        const child = spawnSync(process.execPath, [fileURLToPath(new URL('./usage.mjs', import.meta.url))], {
            input: '{}', encoding: 'utf8', timeout: 20_000, env,
        });
        expect(child.status).toBe(0);
        const output = JSON.parse(child.stdout);
        expect(output.providers).toEqual([]);
        expect(output.noProvidersTitle).toBe('No supported providers detected');
        expect(output.noProviders).toBe('Run a coding agent on this computer or connect a plan.');
    });
});
