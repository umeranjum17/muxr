/**
 * P1 flow: the accounts store plus `plans.list` over throwaway folders and
 * stub tools. No real account: one folder's credentials
 * are chmod 000 and the list still works.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AUTO_TERMS_NOTE, acknowledgeAutoTerms, listPlans, removePlanAccount, renamePlanAccount, resolvePlanEnv, resolvePlanLaunch } from './plansApi.js';
import { autoTermsAcknowledged, loadPlanAccounts, plansDir, savePlanAccounts } from './planStore.js';

const mockState = vi.hoisted(() => ({ failRename: false, failRefreshAllocation: false, failRefreshCleanup: false }));
vi.mock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs')>();
    return {
        ...actual,
        mkdtempSync: (...args: Parameters<typeof actual.mkdtempSync>) => {
            if (mockState.failRefreshAllocation && String(args[0]).includes('muxr-usage-refresh-')) throw new Error('temporary storage unavailable');
            return actual.mkdtempSync(...args);
        },
        rmSync: (...args: Parameters<typeof actual.rmSync>) => {
            actual.rmSync(...args);
            if (mockState.failRefreshCleanup && String(args[0]).includes('muxr-usage-refresh-')) throw new Error('temporary cleanup failed');
        },
        renameSync: (...args: Parameters<typeof actual.renameSync>) => {
            if (mockState.failRename) throw new Error('crash before rename');
            return actual.renameSync(...args);
        },
    };
});

let root = '';
let env: NodeJS.ProcessEnv;

function stubBin(): string {
    const bin = join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'claude'), `#!/bin/bash
base="\${CLAUDE_CONFIG_DIR##*/}"
if [[ "$base" == *-out ]]; then echo '{"loggedIn":false,"authMethod":"none"}';
elif [[ "$base" == weird ]]; then echo '{"loggedIn":true,"email":"weird@example.com","subscriptionId":"sub_abc","subscriptionStatus":"active"}';
else echo "{\\"loggedIn\\":true,\\"email\\":\\"$base@example.com\\",\\"plan\\":\\"Pro\\"}"; fi
`);
    writeFileSync(join(bin, 'codex'), `#!/bin/bash
read -r line
echo '{"id":1,"result":{}}'
read -r line
base="\${CODEX_HOME##*/}"
if [[ "$line" == *rateLimits* ]]; then
  if [[ -f "$CODEX_HOME/fail" || "$base" == *-out ]]; then echo '{"id":2,"result":{"rateLimitsByLimitId":{}}}';
  elif [[ "$base" == tight ]]; then echo "{\\"id\\":2,\\"result\\":{\\"rateLimitsByLimitId\\":{\\"plan\\":{\\"limitName\\":\\"Codex\\",\\"primary\\":{\\"usedPercent\\":90,\\"windowDurationMins\\":10080,\\"resetsAt\\":1893456000}}}}}";
  else echo "{\\"id\\":2,\\"result\\":{\\"rateLimitsByLimitId\\":{\\"plan\\":{\\"limitName\\":\\"Codex\\",\\"primary\\":{\\"usedPercent\\":25,\\"windowDurationMins\\":10080,\\"resetsAt\\":1893456000}}}}}"; fi
elif [[ "$base" == *-out ]]; then echo '{"id":2,"result":{"account":null,"requiresOpenaiAuth":true}}';
else echo "{\\"id\\":2,\\"result\\":{\\"account\\":{\\"email\\":\\"$base@example.com\\"},\\"requiresOpenaiAuth\\":false}}"; fi
`);
    chmodSync(join(bin, 'claude'), 0o755);
    chmodSync(join(bin, 'codex'), 0o755);
    return bin;
}

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'muxr-plans-'));
    const bin = stubBin();
    env = {
        ...process.env,
        HOME: root,
        XDG_DATA_HOME: join(root, 'share'),
        CODEX_HOME: join(root, '.codex'),
        CLAUDE_CONFIG_DIR: join(root, '.claude'),
        PI_AGENT_DIR: join(root, 'pi'),
        OPENCODE_AUTH_CONTENT: undefined,
        MUXR_CCUSAGE_BIN: '/bin/false',
        MUXR_HOME: join(root, 'muxr'),
        PATH: `${bin}${process.env.PATH === undefined ? '' : `:${process.env.PATH}`}`,
    };
});

afterEach(() => {
    vi.unstubAllGlobals();
    mockState.failRefreshAllocation = false;
    mockState.failRefreshCleanup = false;
    rmSync(root, { recursive: true, force: true });
});

function foundClaude(name = '.claude'): string {
    const folder = join(root, name);
    mkdirSync(folder, { recursive: true });
    return folder;
}

function addedClaude(name: string): string {
    const folder = join(root, 'muxr', 'plans', 'claude', name);
    mkdirSync(folder, { recursive: true });
    return folder;
}

it('hides the feature with one account and lists two with names and emails', async () => {
    foundClaude();
    expect(await listPlans(env)).toEqual({ providers: [], autoTermsAcknowledged: false, autoTermsNote: AUTO_TERMS_NOTE });

    const second = addedClaude('work');
    savePlanAccounts(env, [{ id: 'pa_work', provider: 'claude', name: '', folder: second, found: false }]);
    const listed = await listPlans(env);
    expect(listed.autoTermsAcknowledged).toBe(false);
    expect(listed.autoTermsNote).toBe(AUTO_TERMS_NOTE);
    expect(listed.providers.map((entry) => entry.provider)).toEqual(['claude']);
    const accounts = listed.providers[0]!.accounts;
    expect(accounts.map((account) => account.signedIn)).toEqual([true, true]);
    expect(accounts.map((account) => account.email)).toEqual(['.claude@example.com', 'work@example.com']);
    expect(accounts[0]).toMatchObject({ foundOnComputer: true });
    expect(accounts[1]).toMatchObject({ name: 'Work' });
});

it('reports a signed-out account without choosing it when its credentials are unreadable', async () => {
    const folder = foundClaude();
    writeFileSync(join(folder, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'secret', accountUuid: 'u' } }));
    chmodSync(join(folder, '.credentials.json'), 0);
    const second = addedClaude('personal-out');
    savePlanAccounts(env, [{ id: 'pa_out', provider: 'claude', name: '', folder: second, found: false }]);
    const listed = await listPlans(env);
    expect(listed.providers).toHaveLength(1);
    expect(listed.providers[0]!.accounts.map((account) => account.signedIn)).toEqual([true, false]);
});

it('never shows an internal id or status as the plan', async () => {
    foundClaude();
    const weird = addedClaude('weird');
    savePlanAccounts(env, [{ id: 'pa_weird', provider: 'claude', name: '', folder: weird, found: false }]);
    const accounts = (await listPlans(env)).providers[0]!.accounts;
    expect(accounts.map((account) => account.email)).toEqual(['.claude@example.com', 'weird@example.com']);
    expect(accounts[0]).toMatchObject({ plan: 'Pro' });
    expect(accounts[1]).not.toHaveProperty('plan');
});

it('renames, resolves launch env, and removes without touching found folders', async () => {
    const found = foundClaude();
    const added = addedClaude('work');
    savePlanAccounts(env, [
        { id: 'found-claude', provider: 'claude', name: '', folder: found, found: true },
        { id: 'pa_work', provider: 'claude', name: '', folder: added, found: false },
    ]);
    const renamed = await renamePlanAccount(env, 'pa_work', 'Work');
    expect(renamed.account.name).toBe('Work');
    expect(resolvePlanEnv(env, 'pa_work')).toEqual({ CLAUDE_CONFIG_DIR: added });
    await expect(renamePlanAccount(env, 'pa_work', '')).rejects.toMatchObject({ code: 'invalid-plan-name' });
    expect(() => resolvePlanEnv(env, 'nope')).toThrowError(/Unknown account/);

    expect(removePlanAccount(env, 'pa_work')).toEqual({ deletedFolder: true });
    expect(existsSync(added)).toBe(false);
    expect(removePlanAccount(env, 'found-claude')).toEqual({ deletedFolder: false });
    expect(existsSync(found)).toBe(true);
    expect(await listPlans(env)).toEqual({ providers: [], autoTermsAcknowledged: false, autoTermsNote: AUTO_TERMS_NOTE });
});

it('never deletes the plans root itself when a record points at it', async () => {
    const added = addedClaude('work');
    savePlanAccounts(env, [
        { id: 'pa_root', provider: 'claude', name: '', folder: plansDir(env), found: false },
        { id: 'pa_work', provider: 'claude', name: '', folder: added, found: false },
    ]);
    expect(removePlanAccount(env, 'pa_root')).toEqual({ deletedFolder: false });
    expect(existsSync(plansDir(env))).toBe(true);
    expect(existsSync(added)).toBe(true);
    expect(loadPlanAccounts(env).map((record) => record.id)).toEqual(['pa_work']);
});

it('keeps selected Codex sign-ins separate through switches and failed reads', async () => {
    const home = join(root, '.codex');
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'auth.json'), JSON.stringify({ tokens: { access_token: 'fixture-a' } }));
    const second = join(root, 'muxr', 'plans', 'codex', 'tight');
    mkdirSync(second, { recursive: true });
    writeFileSync(join(second, 'auth.json'), JSON.stringify({ tokens: { access_token: 'fixture-b' } }));
    savePlanAccounts(env, [{ id: 'pa_x', provider: 'codex', name: 'Tight', folder: second, found: false }]);
    const listed = await listPlans(env);
    expect(listed.providers.map((entry) => entry.provider)).toEqual(['codex']);
    expect(listed.providers[0]!.accounts.map((account) => account.email)).toEqual(['.codex@example.com', 'tight@example.com']);
    expect(listed.providers[0]!.accounts.map((account) => account.roomLeftPercent)).toEqual([75, 10]);
    mockState.failRefreshAllocation = true;
    const unavailable = (await listPlans(env)).providers[0]!.accounts;
    expect(unavailable.map((account) => account.email)).toEqual(['.codex@example.com', 'tight@example.com']);
    expect(unavailable.map((account) => account.signedIn)).toEqual([true, true]);
    expect(unavailable.map((account) => account.roomLeftPercent)).toEqual([undefined, undefined]);
    expect((await resolvePlanLaunch(env, 'pa_x', 'codex'))?.id).toBe('pa_x');
    expect(await resolvePlanLaunch(env, 'auto', 'codex')).toBeDefined();
    mockState.failRefreshAllocation = false;
    mockState.failRefreshCleanup = true;
    expect((await listPlans(env)).providers[0]!.accounts.map((account) => account.roomLeftPercent)).toEqual([75, 10]);
    expect((await resolvePlanLaunch(env, 'auto', 'codex'))?.id).toBe('found-codex');
    mockState.failRefreshCleanup = false;
    const { collectUsage } = await import('../usage/index.js');
    const selected = { ...env, ...resolvePlanEnv(env, 'pa_x') };
    expect((await collectUsage({ provider: 'codex' }, selected)).limits.windows.map((window) => window.used)).toEqual([90]);
    expect((await collectUsage({ provider: 'codex' }, { ...env, CODEX_HOME: home })).limits.windows.map((window) => window.used)).toEqual([25]);
    writeFileSync(join(second, 'fail'), '');
    env.MUXR_USAGE_NOW = new Date(Date.now() + 120_000).toISOString();
    expect((await listPlans(env)).providers[0]!.accounts.map((account) => account.roomLeftPercent)).toEqual([75, undefined]);
    expect((await collectUsage({ provider: 'codex', refresh: true }, { ...selected, MUXR_USAGE_NOW: env.MUXR_USAGE_NOW })).limits.windows.map((window) => window.used)).toEqual([90]);
    writeFileSync(join(second, 'auth.json'), JSON.stringify({ tokens: { account_id: 'fixture-new-account' } }));
    const failed = await collectUsage({ provider: 'codex', refresh: true }, { ...selected, MUXR_USAGE_NOW: env.MUXR_USAGE_NOW });
    expect(failed.limits.windows).toEqual([]);
});

/** P2: room left per account plus the Auto rule, from snapshots the same
 *  reader Usage uses. Fake the ranking (swap the utilizations) and Auto
 *  follows the roomier account. */
function claudeSnapshot(folder: string, fiveHour: number, sevenDay: number): void {
    const resets = new Date(Date.now() + 3_600_000).toISOString();
    writeFileSync(join(folder, 'last-statusline-input.json'), JSON.stringify({
        five_hour: { utilization: fiveHour, resets_at: resets },
        seven_day: { utilization: sevenDay, resets_at: resets },
    }));
}

it('auto picks the roomier account and says which in one line', async () => {
    const fetch = vi.fn(async () => new Response('{}', { status: 503 }));
    vi.stubGlobal('fetch', fetch);
    const found = foundClaude();
    claudeSnapshot(found, 20, 70);
    const second = addedClaude('work');
    claudeSnapshot(second, 10, 40);
    for (const [folder, account] of [[found, 'found-account'], [second, 'work-account']] as const) {
        writeFileSync(join(folder, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'fixture-token', accountUuid: account } }));
    }
    savePlanAccounts(env, [{ id: 'pa_work', provider: 'claude', name: '', folder: second, found: false }]);
    const listed = await listPlans(env);
    const provider = listed.providers[0]!;
    expect(provider.accounts.map((account) => account.roomLeftPercent)).toEqual([30, 60]);
    expect(provider.auto.accountId).toBe('pa_work');
    expect(provider.auto.reason).toBe('Right now that\'s Work: 60% left this week');
    // Snapshot-only hints have no account identity and cannot seed the
    // standing quota cache, even though Auto can use their current room.
    expect(existsSync(join(env.MUXR_HOME!, 'usage', 'plans-v2.json'))).toBe(false);
    claudeSnapshot(second, 95, 99);
    expect((await resolvePlanLaunch(env, 'auto', 'claude'))?.id).toBe('found-claude');
    expect((await resolvePlanLaunch(env, 'pa_work', 'claude'))?.id).toBe('pa_work');
    rmSync(join(second, 'last-statusline-input.json'));
    const withoutSnapshot = (await listPlans(env)).providers[0]!;
    expect(withoutSnapshot.accounts.map((account) => account.roomLeftPercent)).toEqual([30, undefined]);
    expect(existsSync(join(env.MUXR_HOME!, 'usage', 'plans-v2.json'))).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
    env.MUXR_USAGE_NOW = new Date(Date.now() + 61_000).toISOString();
    fetch.mockImplementation(async () => Response.json({ seven_day: { utilization: 40, resets_at: new Date(Date.now() + 3_600_000).toISOString() } }));
    expect((await listPlans(env)).providers[0]!.accounts.map((account) => account.roomLeftPercent)).toEqual([30, 60]);
    env.MUXR_USAGE_NOW = new Date(Date.now() + 122_000).toISOString();
    fetch.mockImplementation(async () => new Response('{}', { status: 429 }));
    expect((await listPlans(env)).providers[0]!.accounts.map((account) => account.roomLeftPercent)).toEqual([30, undefined]);
    const attempts = fetch.mock.calls.length;
    expect((await listPlans(env)).providers[0]!.accounts.map((account) => account.roomLeftPercent)).toEqual([30, undefined]);
    expect(fetch).toHaveBeenCalledTimes(attempts);
    expect(existsSync(join(env.MUXR_HOME!, 'usage', 'plans-v2.json'))).toBe(false);
});

it('reads one stalled provider without waiting on the other', async () => {
    foundClaude();
    const secondClaude = addedClaude('work');
    const codexHome = join(root, '.codex');
    mkdirSync(codexHome, { recursive: true });
    const secondCodex = join(root, 'muxr', 'plans', 'codex', 'other');
    mkdirSync(secondCodex, { recursive: true });
    savePlanAccounts(env, [
        { id: 'pa_work', provider: 'claude', name: '', folder: secondClaude, found: false },
        { id: 'pa_x', provider: 'codex', name: 'Other', folder: secondCodex, found: false },
    ]);
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const run = async () => {
        started.push('claude');
        await gate;
        return { stdout: '{"loggedIn":false}' };
    };
    const codexRead = async () => {
        started.push('codex');
        await gate;
        return { account: null };
    };
    const pending = listPlans(env, { run, codexRead });
    const deadline = Date.now() + 2_000;
    while (!(started.includes('claude') && started.includes('codex')) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const overlapping = [...started];
    release();
    const listed = await pending;
    expect(overlapping).toContain('claude');
    expect(overlapping).toContain('codex');
    expect(listed.providers.map((entry) => entry.provider)).toEqual(['claude', 'codex']);
});

it('shows the Auto terms note until acknowledged, then remembers', async () => {
    foundClaude();
    const second = addedClaude('work');
    savePlanAccounts(env, [{ id: 'pa_work', provider: 'claude', name: '', folder: second, found: false }]);
    const before = await listPlans(env);
    expect(before.autoTermsAcknowledged).toBe(false);
    expect(before.autoTermsNote).toBe(AUTO_TERMS_NOTE);
    expect(acknowledgeAutoTerms(env)).toEqual({ acknowledged: true });
    const after = await listPlans(env);
    expect(after.autoTermsAcknowledged).toBe(true);
    expect(after.autoTermsNote).toBe(AUTO_TERMS_NOTE);
});

it('registers both found sign-ins without dropping either', async () => {
    foundClaude();
    const codexHome = join(root, '.codex');
    mkdirSync(codexHome, { recursive: true });
    const claudeSecond = addedClaude('work');
    const codexSecond = join(root, 'muxr', 'plans', 'codex', 'other');
    mkdirSync(codexSecond, { recursive: true });
    savePlanAccounts(env, [
        { id: 'pa_work', provider: 'claude', name: '', folder: claudeSecond, found: false },
        { id: 'pa_x', provider: 'codex', name: 'Other', folder: codexSecond, found: false },
    ]);
    await listPlans(env);
    expect(loadPlanAccounts(env).map((record) => record.id).sort())
        .toEqual(['found-claude', 'found-codex', 'pa_work', 'pa_x']);
    await listPlans(env);
    expect(loadPlanAccounts(env).map((record) => record.id).sort())
        .toEqual(['found-claude', 'found-codex', 'pa_work', 'pa_x']);
});

it('auto skips signed-out accounts and names the earliest refill when all are out', async () => {
    const found = foundClaude();
    claudeSnapshot(found, 100, 100);
    const second = addedClaude('personal-out');
    savePlanAccounts(env, [{ id: 'pa_out', provider: 'claude', name: '', folder: second, found: false }]);
    const listed = await listPlans(env);
    const provider = listed.providers[0]!;
    expect(provider.auto.accountId).toBe('found-claude');
    expect(provider.auto.reason).toMatch(/out of room/);
});

it('reads stalled accounts concurrently instead of one after another', async () => {
    foundClaude();
    const second = addedClaude('work');
    savePlanAccounts(env, [{ id: 'pa_work', provider: 'claude', name: '', folder: second, found: false }]);
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let inFlight = 0;
    let maxInFlight = 0;
    const run = async (_command: string, _args: string[], runEnv: NodeJS.ProcessEnv) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        started.push(String(runEnv.CLAUDE_CONFIG_DIR));
        try {
            await gate;
        } finally {
            inFlight -= 1;
        }
        return { stdout: '{"loggedIn":false}' };
    };
    const pending = listPlans(env, { run });
    const deadline = Date.now() + 2_000;
    while (started.length < 2 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    release();
    const listed = await pending;
    expect(maxInFlight).toBe(2);
    expect(listed.providers[0]!.accounts.map((account) => account.email)).toEqual([undefined, undefined]);
    expect(listed.providers[0]!.accounts.map((account) => account.signedIn)).toEqual([false, false]);
});

it('keeps the previous store when a crash lands mid-write', () => {
    const second = addedClaude('work');
    savePlanAccounts(env, [{ id: 'pa_work', provider: 'claude', name: '', folder: second, found: false }]);
    mockState.failRename = true;
    try {
        expect(() => savePlanAccounts(env, [])).toThrow();
        expect(loadPlanAccounts(env).map((record) => record.id)).toEqual(['pa_work']);
        expect(() => acknowledgeAutoTerms(env)).toThrow();
        expect(autoTermsAcknowledged(env)).toBe(false);
    } finally {
        mockState.failRename = false;
    }
});
