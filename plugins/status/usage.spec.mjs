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

/** The captain's false-disconnected case: the most recently used agent has no
 *  plan integration (Pi), while a connected plan sits one tab over. Drives the
 *  real plugin end to end with the default `{}` view the Home card opens. */
describe('usage plugin flow · connected plan on a planless default tab', () => {
    const root = mkdtempSync(join(tmpdir(), 'muxr-usage-plan-'));
    const home = join(root, 'home');
    const data = join(root, 'data');
    const bin = join(root, 'bin');
    const claude = join(root, 'claude');
    const codex = join(root, 'codex');
    for (const dir of [home, data, bin, claude, codex]) mkdirSync(dir, { recursive: true });
    const ccusage = join(bin, 'ccusage-stub');
    writeFileSync(ccusage, '#!/bin/sh\necho \'{"daily":[]}\'\n');
    chmodSync(ccusage, 0o755);
    // Pi is the most recently used agent: one usage record inside the pinned
    // window gives it recency over every plan tab. Written at run time so the
    // scan's mtime gate and the real clock both see it as current.
    const sessions = join(home, 'sessions');
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, 'session.jsonl'), `${JSON.stringify({
        id: 'u1',
        message: {
            role: 'assistant', model: 'pi/glm-x', timestamp: '2026-09-05T11:30:00Z',
            usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: { total: 0 } },
        },
    })}\n`);
    // A connected Claude plan: unexpired OAuth credentials plus a fresh
    // statusline snapshot carrying both quota windows. The snapshot short-
    // circuits before any network call, so the run stays offline.
    writeFileSync(join(claude, '.credentials.json'), JSON.stringify({
        claudeAiOauth: { accessToken: 'test-token', expiresAt: Date.now() + 3_600_000 },
    }));
    writeFileSync(join(claude, 'last-statusline-input.json'), JSON.stringify({
        rate_limits: { five_hour: { utilization: 12 }, seven_day: { utilization: 30 } },
    }));
    const env = {
        PATH: bin,
        HOME: home,
        TZ: 'UTC',
        XDG_DATA_HOME: data,
        CLAUDE_CONFIG_DIR: claude,
        CODEX_HOME: codex,
        PI_AGENT_DIR: home,
        MUXR_CCUSAGE_BIN: ccusage,
        MUXR_USAGE_NOW: '2026-09-05T12:00:00Z',
    };

    const run = (extra = {}) => {
        const child = spawnSync(process.execPath, [fileURLToPath(new URL('./usage.mjs', import.meta.url))], {
            input: '{}', encoding: 'utf8', timeout: 20_000, env: { ...env, ...extra },
        });
        expect(child.status).toBe(0);
        return JSON.parse(child.stdout);
    };

    afterAll(() => { rmSync(root, { recursive: true, force: true }); });

    it('answers the planless default tab with the connected plan instead of a false not-connected', () => {
        const output = run();
        expect(output.provider).toBe('pi');
        expect(output.limits.message).toBeUndefined();
        expect(output.limits.plan).toBe('Claude plan');
        expect(output.limits.verdict).toBe('go');
        expect(output.limits.windows.map((window) => [window.label, window.used])).toEqual([['5-hour limit', 12], ['7-day limit', 30]]);
        // The Home card's strip: one bounded entry per provider with real
        // windows, remaining = 100 - used (88 / 70 from 12 / 30 used).
        expect(output.connected).toEqual([
            {
                id: 'claude', label: 'Claude', glyph: 'claude', plan: 'Claude plan',
                windows: [
                    { label: '5-hour limit', window: '5h', used: 12 },
                    { label: '7-day limit', window: '7d', used: 30 },
                ],
            },
        ]);
    });

    it('keeps the honest not-connected line on a machine with no connected plan', () => {
        const output = run({ CLAUDE_CONFIG_DIR: join(root, 'empty-claude') });
        expect(output.provider).toBe('pi');
        expect(output.limits.windows).toEqual([]);
        expect(output.limits.message).toBe('Plan limits aren’t connected in muxr');
        expect(output.connected).toBeUndefined();
    });
});
