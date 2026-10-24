// Pane account chip on the host, no phone: a real (lab) Herdr, this checkout's built host and the
// scripted lab client. A Claude pane muxr recorded on the computer's own sign-in, then relaunched in
// the same pane under the Work folder, must read Work in herdr.tree (the chip) and plans.agent (the
// Out of room banner and Move). Writes gate.log and steps.json. See pane-account-chip.md.
//   HERDR_LAB_HELPER=<helper> node .agents/skills/done-done-verify-pockit/features/paneAccountHostLab.mjs <evidenceDir>
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const [evidence] = process.argv.slice(2);
// Short: the lab host's pairing socket lives under it.
mkdirSync(join(homedir(), '.cache', 'fms'), { recursive: true });
const root = mkdtempSync(join(homedir(), '.cache', 'fms', 'pah.'));
const repo = process.cwd();
const { linkHerdrLab } = await import(join(repo, 'scripts/diagnostics/application/linkHerdrLab.mjs'));
const { requestLab } = await import(join(repo, 'scripts/diagnostics/application/linkLabClient.mjs'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(evidence, { recursive: true });
const out = join(evidence, 'gate.log');
const log = (m) => { console.log(m); appendFileSync(out, `${m}\n`); };
let session;
const herdr = (...args) => execFileSync(process.env.HERDR_LAB_HELPER, ['run', session, ...args], { encoding: 'utf8', timeout: 30_000 });
const labDir = join(root, 'lab'); const bin = join(root, 'bin'); const hostBin = join(root, 'hostbin');
const ownFolder = join(labDir, 'home', 'own-signin');
const workFolder = join(labDir, 'muxr', 'plans', 'claude', Buffer.from('work').toString('hex'));
const STATUS = '#!/bin/sh\ndir="$CLAUDE_CONFIG_DIR"\n[ "$1" = auth ] && [ "$2" = status ] && [ -f "$dir/lab-account.json" ] && { cat "$dir/lab-account.json"; exit 0; }\necho \'{"loggedIn":false}\'; exit 1\n';
const seed = () => {
    for (const dir of [bin, hostBin, workFolder, ownFolder]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(hostBin, 'claude'), STATUS, { mode: 0o755 });
    writeFileSync(join(bin, 'claude'), '#!/bin/sh\nprintf "\\033]2;Account chip lab\\007"\nwhile :; do sleep 3600; done\n', { mode: 0o755 });
    const account = (email) => `{"loggedIn":true,"authMethod":"claude.ai","email":"${email}","subscriptionType":"max"}\n`;
    writeFileSync(join(ownFolder, 'lab-account.json'), account('umer@example.com'));
    writeFileSync(join(workFolder, 'lab-account.json'), account('work@example.com'));
    writeFileSync(join(labDir, 'muxr', 'plans', 'accounts-v1.json'),
        JSON.stringify({ version: 1, accounts: [{ id: 'pa_work', provider: 'claude', name: 'Work', folder: workFolder, found: false }] }), { mode: 0o600 });
    const cwd = join(root, 'w'); mkdirSync(cwd, { recursive: true });
    herdr('workspace', 'create', '--cwd', cwd, '--label', 'chip-lab', '--no-focus');
    herdr('tab', 'rename', 'w1:t1', 'work-pane');
    herdr('tab', 'create', '--workspace', 'w1', '--cwd', cwd, '--label', 'own-pane', '--no-focus');
};
let lab; let ok = false;
try {
    mkdirSync(join(labDir, 'muxr', 'plans'), { recursive: true });
    lab = await linkHerdrLab(labDir, 'chip', undefined, (_h, s) => { session = s; seed(); },
        { PATH: `${hostBin}:${process.env.PATH}`, CLAUDE_CONFIG_DIR: ownFolder });
    log(`lab host up (relay port ${lab.port}), host build ${execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()}`);
    const panes = JSON.parse(herdr('pane', 'list')).result.panes;
    const at = (tab) => panes.find((entry) => entry.tab_id === tab).pane_id;
    herdr('pane', 'send-text', at('w1:t1'), `clear; CLAUDE_CONFIG_DIR=${workFolder} ${join(bin, 'claude')}\n`);
    herdr('pane', 'send-text', at('w1:t2'), `clear; ${join(bin, 'claude')}\n`);
    writeFileSync(join(labDir, 'muxr', 'plans', 'agent-panes-v1.json'), JSON.stringify([[at('w1:t1'), 'found-claude']]), { mode: 0o600 });
    log(`stale record: ${at('w1:t1')} (work-pane) -> found-claude (the computer's own sign-in)`);
    const ask = (type, params = {}) => requestLab(lab.link, type, params);
    const listed = await ask('plans.list');
    log(`plans.list: ${listed.providers.flatMap((p) => p.accounts.map((a) => `${a.id}=${a.name}`)).join(', ')}`);
    let tree;
    for (let i = 0; i < 30; i += 1) {
        tree = await ask('herdr.tree');
        const all = tree.workspaces.flatMap((w) => w.tabs.flatMap((t) => t.panes.map((p) => ({ ...p, tab: t.label }))));
        if (all.filter((p) => p.agentKind === 'claude').length >= 2) break;
        await sleep(2000);
    }
    const all = tree.workspaces.flatMap((w) => w.tabs.flatMap((t) => t.panes.map((p) => ({ ...p, tab: t.label, ws: w.label }))));
    for (const p of all) log(`herdr.tree: workspace "${p.ws}" tab "${p.tab}" agentKind=${p.agentKind} planAccount=${p.planAccount ?? '(none)'}`);
    const sessions = await ask('session.list');
    const items = sessions.sessions ?? sessions.items ?? sessions;
    const agent = {};
    for (const s of Array.isArray(items) ? items : []) {
        const id = s.id ?? s.info?.id;
        const paneId = s.paneId ?? s.info?.paneId ?? s.metadata?.paneId;
        const tab = all.find((p) => p.paneId === paneId)?.tab;
        if (tab === undefined) continue;
        const answer = await ask('plans.agent', { sessionId: id });
        agent[tab] = answer.accountId ?? '(computer own)';
        log(`plans.agent: tab "${tab}" accountId=${answer.accountId ?? '(none: computer own)'} movable=${answer.movable}`);
    }
    const chip = (tab) => all.find((p) => p.tab === tab)?.planAccount;
    ok = chip('work-pane') === 'Work' && chip('own-pane') === 'Umer' && agent['work-pane'] === 'pa_work';
    log(ok ? 'PASS: work-pane names Work (chip + plans.agent) over the stale record; own-pane names Umer' : 'FAIL: see above');
    writeFileSync(join(evidence, 'steps.json'), `${JSON.stringify({
        target: { version: `the muxr host built from ${execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()} on a private lab Herdr` },
        start: 'a lab Herdr with two Claude panes: work-pane, which muxr recorded on the computer\'s own account and whose agent was then relaunched in the same pane on the Work account, and own-pane on the computer\'s own account',
        steps: ['List the accounts (plans.list)', 'Read the tree the phone draws chips from (herdr.tree)', 'Ask each pane\'s account, which the Out of room banner and Move read (plans.agent)'],
        result: `a pane's account chip and Out of room banner name the account the pane's own agent runs on, even after it was relaunched on another account in the same pane: gate.log shows work-pane with planAccount=Work and accountId=pa_work, and own-pane with planAccount=Umer and no account of its own; ${ok ? 'pass' : 'fail'}`,
    }, null, 2)}\n`);
} finally {
    await lab?.stop();
    rmSync(root, { recursive: true, force: true });
    log(`lab stopped; ${ok ? 'pass' : 'fail'}`);
}
process.exit(ok ? 0 : 1);
