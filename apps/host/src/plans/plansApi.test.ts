/**
 * P1 flow: the accounts store plus `plans.list` over throwaway folders and
 * stub tools. No real account: one folder's credentials
 * are chmod 000 and the list still works.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { preparePlanSignIn, planAccountStatus, finishPlanSignIn, cancelPlanSignIn } from './planSignIn.js';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AUTO_TERMS_NOTE, acknowledgeAutoTerms, listPlans, removePlanAccount, renamePlanAccount, resolvePlanEnv, resolvePlanLaunch } from './plansApi.js';
import { loadPlanAccounts, plansDir, savePlanAccounts } from './planStore.js';

const mockState = vi.hoisted(() => ({ failRename: false, failRefreshAllocation: false, failRefreshCleanup: false }));
vi.mock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs')>();
    return {
        ...actual,
        mkdtempSync: (...args: Parameters<typeof actual.mkdtempSync>) => {
            if (mockState.failRefreshAllocation && String(args[0]).includes('muxr-usage-refresh-')) throw new Error('crash allocating the usage refresh scratch');
            return actual.mkdtempSync(...args);
        },
        rmSync: (...args: Parameters<typeof actual.rmSync>) => {
            actual.rmSync(...args);
            if (mockState.failRefreshCleanup && String(args[0]).includes('muxr-usage-refresh-')) throw new Error('crash clearing the usage refresh scratch');
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
if [[ -f "$CLAUDE_CONFIG_DIR/fixture-name" ]]; then base=$(cat "$CLAUDE_CONFIG_DIR/fixture-name"); fi
if [[ "$base" == *-out ]]; then echo '{"loggedIn":false,"authMethod":"none"}';
elif [[ "$base" == weird ]]; then echo '{"loggedIn":true,"email":"weird@example.com","subscriptionId":"sub_abc","subscriptionStatus":"active"}';
else echo "{\\"loggedIn\\":true,\\"email\\":\\"$base@example.com\\",\\"plan\\":\\"Pro\\"}"; fi
`);
    writeFileSync(join(bin, 'codex'), `#!/bin/bash
read -r line
echo '{"id":1,"result":{}}'
read -r line
base="\${CODEX_HOME##*/}"
if [[ -f "$CODEX_HOME/fixture-name" ]]; then base=$(cat "$CODEX_HOME/fixture-name"); fi
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
    const folder = join(root, 'muxr', 'plans', 'claude', Buffer.from(name).toString('hex'));
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'fixture-name'), name);
    return folder;
}

/** The kit names every managed folder with a hex basename, so the fixture
 *  carries its own human name inside the folder. */
function addedCodex(name: string): string {
    const folder = join(root, 'muxr', 'plans', 'codex', Buffer.from(name).toString('hex'));
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'fixture-name'), name);
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

/** A second account added beside the first one: each name comes from its own
 *  email, and neither row lands on the name the person already chose. */
it('never shows a second account under the first account name', async () => {
    foundClaude();
    const personal = addedClaude('umer');
    const work = addedClaude('umer.work');
    savePlanAccounts(env, [
        { id: 'pa_umer', provider: 'claude', name: 'Umer', folder: personal, found: false },
        { id: 'pa_umer_work', provider: 'claude', name: '', folder: work, found: false },
    ]);
    const accounts = (await listPlans(env)).providers[0]!.accounts;
    expect(accounts.map((account) => account.email)).toEqual(['.claude@example.com', 'umer@example.com', 'umer.work@example.com']);
    expect(accounts.map((account) => account.name)).toEqual(['Claude', 'Umer', 'Umer Work']);
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

    expect(await removePlanAccount(env, 'pa_work')).toEqual({ deletedFolder: true });
    expect(existsSync(added)).toBe(false);
    expect(await removePlanAccount(env, 'found-claude')).toEqual({ deletedFolder: false });
    expect(existsSync(found)).toBe(true);
    expect(await listPlans(env)).toEqual({ providers: [], autoTermsAcknowledged: false, autoTermsNote: AUTO_TERMS_NOTE });
});

it('never deletes the plans root itself when a record points at it', async () => {
    const added = addedClaude('work');
    savePlanAccounts(env, [
        { id: 'pa_root', provider: 'claude', name: '', folder: plansDir(env), found: false },
        { id: 'pa_work', provider: 'claude', name: '', folder: added, found: false },
    ]);
    await expect(removePlanAccount(env, 'pa_root')).rejects.toMatchObject({ code: 'unknown-plan-account' });
    expect(existsSync(plansDir(env))).toBe(true);
    expect(existsSync(added)).toBe(true);
    expect(loadPlanAccounts(env).map((record) => record.id)).toEqual(['pa_root', 'pa_work']);
});

/** P1: two Codex sign-ins stay separate through a switch, and a usage refresh
 *  that cannot allocate or clear its scratch never drops or invents an
 *  account's room. Ported from the pre-kit local implementation onto the
 *  published kit's managed folders. */
it('keeps selected Codex sign-ins separate through switches and failed reads', async () => {
    const fetch = vi.fn(async () => new Response('{}', { status: 503 }));
    vi.stubGlobal('fetch', fetch);
    const home = join(root, '.codex');
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'auth.json'), JSON.stringify({ tokens: { access_token: 'fixture-a' } }));
    const second = addedCodex('tight');
    writeFileSync(join(second, 'auth.json'), JSON.stringify({ tokens: { access_token: 'fixture-b' } }));
    savePlanAccounts(env, [{ id: 'pa_x', provider: 'codex', name: 'Tight', folder: second, found: false }]);
    const listed = await listPlans(env);
    expect(listed.providers.map((entry) => entry.provider)).toEqual(['codex']);
    expect(listed.providers[0]!.accounts.map((account) => account.email)).toEqual(['.codex@example.com', 'tight@example.com']);
    expect(listed.providers[0]!.accounts.map((account) => account.roomLeftPercent)).toEqual([75, 10]);
    expect(listed.providers[0]!.auto.accountId).toBe('found-codex');

    // The refresh scratch cannot be allocated: both accounts still list, still
    // report their own sign-in, and simply have no room to quote.
    mockState.failRefreshAllocation = true;
    const unavailable = (await listPlans(env)).providers[0]!.accounts;
    expect(unavailable.map((account) => account.email)).toEqual(['.codex@example.com', 'tight@example.com']);
    expect(unavailable.map((account) => account.signedIn)).toEqual([true, true]);
    expect(unavailable.map((account) => account.roomLeftPercent)).toEqual([undefined, undefined]);
    expect((await resolvePlanLaunch(env, 'pa_x', 'codex'))?.id).toBe('pa_x');
    expect(await resolvePlanLaunch(env, 'auto', 'codex')).toBeDefined();

    // The scratch allocates but cannot be cleared: the reading still lands and
    // Auto still ranks on it, rather than losing the account.
    mockState.failRefreshAllocation = false;
    mockState.failRefreshCleanup = true;
    expect((await listPlans(env)).providers[0]!.accounts.map((account) => account.roomLeftPercent)).toEqual([75, 10]);
    expect((await resolvePlanLaunch(env, 'auto', 'codex'))?.id).toBe('found-codex');
    mockState.failRefreshCleanup = false;

    // Each account is read through its own folder, so one account's quota can
    // never be reported against the other's sign-in.
    const { collectUsage } = await import('../usage/index.js');
    const selected = { ...env, ...resolvePlanEnv(env, 'pa_x') };
    const selectedWindows = (await collectUsage({ provider: 'codex', refresh: true }, selected)).limits.windows;
    const foundWindows = (await collectUsage({ provider: 'codex', refresh: true }, { ...env, CODEX_HOME: home })).limits.windows;
    expect(selectedWindows.length).toBeGreaterThan(0);
    expect(foundWindows.length).toBeGreaterThan(0);
    expect(selectedWindows.map((window) => window.used)).toEqual([90]);
    expect(foundWindows.map((window) => window.used)).toEqual([25]);
    expect(selectedWindows.map((window) => window.used)).not.toEqual(foundWindows.map((window) => window.used));

    // A provider that stops answering yields no window for the account that
    // still reports, rather than a stale or borrowed one.
    env.MUXR_USAGE_NOW = new Date(Date.now() + 600_000).toISOString();
    writeFileSync(join(home, 'fail'), '');
    expect((await listPlans(env)).providers[0]!.accounts.map((account) => account.roomLeftPercent)).toEqual([undefined, 10]);
    rmSync(join(home, 'fail'));

    // Neither the computer's own sign-in nor the managed folder is disturbed by
    // any of the above.
    expect(existsSync(home)).toBe(true);
    expect(existsSync(second)).toBe(true);
    expect(loadPlanAccounts(env).map((record) => record.id).sort()).toEqual(['found-codex', 'pa_x']);
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
    // Pi keeps its previous Auto mapping onto these Claude accounts until the Pi kind is a product decision.
    expect((await resolvePlanLaunch(env, 'auto', 'pi'))?.id).toBe('found-claude');
    expect((await resolvePlanLaunch(env, 'pa_work', 'pi'))?.id).toBe('pa_work');
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
    claudeSnapshot(found, 100, 100);
    const unknown = (await listPlans(env)).providers[0]!;
    expect(unknown.auto.accountId).toBe('pa_work');
    expect(unknown.auto.reason).toBe("Right now that's Work (no recent reading)");
});

/** A stalled provider must not hold up the other one: each account's sign-in
 *  is read concurrently, so one hanging tool cannot serialise the list. */
it('reads one stalled provider without waiting on the other', async () => {
    foundClaude();
    const secondClaude = addedClaude('work');
    const codexHome = join(root, '.codex');
    mkdirSync(codexHome, { recursive: true });
    const secondCodex = addedCodex('other');
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

/** Acknowledging must not report success it could not record. The terms
 *  record is the kit's own atomic file, so a store that cannot land it has to
 *  surface instead of leaving the note claiming it was accepted. */
it('refuses to acknowledge the Auto terms when the record cannot be written', async () => {
    foundClaude();
    const second = addedClaude('work');
    savePlanAccounts(env, [{ id: 'pa_work', provider: 'claude', name: '', folder: second, found: false }]);
    expect((await listPlans(env)).autoTermsAcknowledged).toBe(false);
    // A real fault the kit cannot route around: its atomic rename cannot land
    // on a path that is already a directory. (vi.mock('node:fs') never reaches
    // the kit, which vitest resolves from node_modules, so this is a disk fault
    // rather than an injected one.)
    rmSync(join(plansDir(env), 'auto-terms-v1.json'), { force: true });
    mkdirSync(join(plansDir(env), 'auto-terms-v1.json'), { recursive: true });
    expect(() => acknowledgeAutoTerms(env)).toThrow();
    rmSync(join(plansDir(env), 'auto-terms-v1.json'), { recursive: true, force: true });
    // Nothing was recorded, so the note is still owed.
    expect((await listPlans(env)).autoTermsAcknowledged).toBe(false);
    expect((await listPlans(env)).autoTermsNote).toBe(AUTO_TERMS_NOTE);
    // And a later acknowledgement still succeeds and is then remembered.
    expect(acknowledgeAutoTerms(env)).toEqual({ acknowledged: true });
    expect((await listPlans(env)).autoTermsAcknowledged).toBe(true);
    expect(loadPlanAccounts(env).map((record) => record.id).sort()).toEqual(['found-claude', 'pa_work']);
});

it('registers both found sign-ins without dropping either', async () => {
    foundClaude();
    const codexHome = join(root, '.codex');
    mkdirSync(codexHome, { recursive: true });
    const claudeSecond = addedClaude('work');
    const codexSecond = join(root, 'muxr', 'plans', 'codex', 'aabbcc');
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

/** A tool that never answers must not cost the other account its place in the
 *  list, and must not leave a half-read account behind once it does answer. */
it('keeps the sibling account listed while one tool stalls, then reads it whole', async () => {
    foundClaude();
    const second = addedClaude('work');
    savePlanAccounts(env, [{ id: 'pa_work', provider: 'claude', name: '', folder: second, found: false }]);
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let settled = false;
    const run = async (_command: string, _args: string[], runEnv: NodeJS.ProcessEnv) => {
        started.push(String(runEnv.CLAUDE_CONFIG_DIR));
        await gate;
        return { stdout: '{"loggedIn":false}' };
    };
    const pending = listPlans(env, { run }).then((listed) => { settled = true; return listed; });
    const deadline = Date.now() + 2_000;
    while (started.length < 1 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    // The stalled read is genuinely in flight, not already finished.
    expect(settled).toBe(false);
    expect(started).toHaveLength(1);
    release();
    const listed = await pending;
    // Once it answers, both accounts are present and each was read on its own.
    expect(listed.providers[0]!.accounts.map((account) => account.email)).toEqual([undefined, 'work@example.com']);
    expect(listed.providers[0]!.accounts.map((account) => account.signedIn)).toEqual([false, true]);
    expect(listed.providers[0]!.accounts.map((account) => account.id)).toEqual(['found-claude', 'pa_work']);
});



it('keeps the previous store when a crash lands mid-write', async () => {
    const second = addedClaude('work');
    savePlanAccounts(env, [{ id: 'pa_work', provider: 'claude', name: '', folder: second, found: false }]);
    mockState.failRename = true;
    try {
        expect(() => savePlanAccounts(env, [])).toThrow();
        expect(loadPlanAccounts(env).map((record) => record.id)).toEqual(['pa_work']);
        // A write that never landed acknowledges nothing: the Auto terms are
        // still owed rather than silently marked accepted.
        expect((await listPlans(env)).autoTermsAcknowledged).toBe(false);
        expect((await listPlans(env)).autoTermsNote).toBe(AUTO_TERMS_NOTE);
    } finally {
        mockState.failRename = false;
    }
});

/** A managed sign-in through the real adapter and published shell command, without real credentials or Herdr. */
it('keeps managed sign-ins isolated through completion, re-sign-in cancellation and removal', async () => {
    env.ANTHROPIC_API_KEY = 'fixture-token-unlogged';
    env.CLAUDE_CODE_OAUTH_TOKEN = 'fixture-token-unlogged';
    const own = foundClaude();
    const canary = join(own, 'canary');
    writeFileSync(canary, 'default-fixture-untouched');
    const prepared: string[] = [];
    const prepare = async (folder: string) => { prepared.push(folder); };
    const first = await preparePlanSignIn(env, 'claude', undefined, prepare);
    const second = await preparePlanSignIn(env, 'claude', undefined, prepare);
    expect(prepared).toEqual([first.record.folder, second.record.folder]);
    expect(first.record.folder).not.toBe(second.record.folder);
    expect((await planAccountStatus(env, first.record.id)).account.signedIn).toBe(false);
    execFileSync('/bin/sh', ['-c', first.launch.signIn], { env: { ...env, ...first.launch.planEnv } });
    expect((await planAccountStatus(env, first.record.id)).account.signedIn).toBe(true);
    expect((await planAccountStatus(env, second.record.id)).account.signedIn).toBe(false);
    finishPlanSignIn(first.record.id);
    await preparePlanSignIn(env, 'claude', first.record.id, prepare);
    expect((await planAccountStatus(env, first.record.id)).account.signedIn).toBe(false);
    expect(await cancelPlanSignIn(env, first.record.id)).toEqual({ removed: false });
    expect(existsSync(first.record.folder)).toBe(true);
    expect(await cancelPlanSignIn(env, second.record.id)).toEqual({ removed: true });
    expect(existsSync(second.record.folder)).toBe(false);
    const response = await renamePlanAccount(env, first.record.id, 'Umer');
    expect(response.account.name).toBe('Umer');
    expect(JSON.stringify(response)).not.toContain('fixture-token-unlogged');
    expect(await removePlanAccount(env, first.record.id)).toEqual({ deletedFolder: true });
    expect(readFileSync(canary, 'utf8')).toBe('default-fixture-untouched');
});

/** Signing in again from the found default row adopts into a managed folder and leaves the default alone. */
it('adopts a found default sign-in into its own managed folder', async () => {
    env.ANTHROPIC_API_KEY = 'fixture-token-unlogged';
    const own = foundClaude();
    const canary = join(own, 'canary');
    writeFileSync(canary, 'default-fixture-untouched');
    savePlanAccounts(env, [{ id: 'found-claude', provider: 'claude', name: '', folder: own, found: true }]);
    const prepared = await preparePlanSignIn(env, 'claude', 'found-claude', async () => {});
    expect(prepared.record.found).toBe(false);
    expect(prepared.record.folder).not.toBe(own);
    execFileSync('/bin/sh', ['-c', prepared.launch.signIn], { env: { ...env, ...prepared.launch.planEnv } });
    expect((await planAccountStatus(env, prepared.record.id)).account.signedIn).toBe(true);
    finishPlanSignIn(prepared.record.id);
    expect(readFileSync(canary, 'utf8')).toBe('default-fixture-untouched');
    expect(JSON.stringify(prepared)).not.toContain('fixture-token-unlogged');
});
