// Self-naming on the host, no phone: a real (lab) Herdr, this checkout's built host and the scripted
// lab client. A lane alone in the lead's workspace runs the real `muxr name --workspace`; the
// workspace must keep its label and only the lane's own tab and pane take the name. The tree the
// phone draws spaces from must carry a path-labelled workspace beside Herdr's folder-named one as
// Herdr has them. Writes gate.log and steps.json. See agent-naming.md.
//   HERDR_LAB_HELPER=<helper> node .agents/skills/done-done-verify-pockit/features/workspaceNameHostLab.mjs <evidenceDir>
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const [evidence] = process.argv.slice(2);
// Short: the lab host's pairing socket lives under it.
mkdirSync(join(homedir(), '.cache', 'fms'), { recursive: true });
const root = mkdtempSync(join(homedir(), '.cache', 'fms', 'wnh.'));
const repo = process.cwd();
const { linkHerdrLab } = await import(join(repo, 'scripts/diagnostics/application/linkHerdrLab.mjs'));
const { requestLab } = await import(join(repo, 'scripts/diagnostics/application/linkLabClient.mjs'));
mkdirSync(evidence, { recursive: true });
const out = join(evidence, 'gate.log');
const log = (m) => { console.log(m); appendFileSync(out, `${m}\n`); };
let session;
const herdr = (...args) => execFileSync(process.env.HERDR_LAB_HELPER, ['run', session, ...args], { encoding: 'utf8', timeout: 30_000 });
const labDir = join(root, 'lab');
const labels = () => JSON.parse(herdr('workspace', 'list')).result.workspaces.map((w) => w.label);
const tabs = () => JSON.parse(herdr('tab', 'list')).result.tabs.map((t) => `${t.tab_id}=${t.label}`);
const folder = (name) => { const dir = join(root, 'w', name); mkdirSync(dir, { recursive: true }); return dir; };
const seed = () => {
    herdr('workspace', 'create', '--cwd', folder('lead'), '--label', '2ndmate-muxr', '--no-focus');
    herdr('workspace', 'create', '--cwd', folder('a/firstmate'), '--label', 'firstmate', '--no-focus');
    herdr('workspace', 'create', '--cwd', folder('b/firstmate'), '--label', join(root, 'w', 'b', 'firstmate'), '--no-focus');
};
let lab; let ok = false;
try {
    lab = await linkHerdrLab(labDir, 'wnh', undefined, (_h, s) => { session = s; seed(); });
    log(`lab host up (relay port ${lab.port}), host build ${execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()}`);
    const before = labels();
    log(`before: workspaces ${before.join(' | ')}; tabs ${tabs().join(' ')}`);
    const lane = JSON.parse(herdr('pane', 'list')).result.panes.find((p) => p.workspace_id === 'w1' || p.tab_id.startsWith('w1:'));
    const said = execFileSync(process.execPath, [join(repo, 'scripts/cli.mjs'), 'name', '--workspace', 'boat-live-cli', '--pane', 'Boat live CLI'], {
        encoding: 'utf8', timeout: 60_000,
        env: { ...process.env, HERDR_PANE_ID: lane.pane_id, HERDR_BIN_PATH: join(labDir, 'herdr-lab.sh') },
    }).trim();
    log(`the lane alone in the lead's workspace runs muxr name --workspace boat-live-cli --pane 'Boat live CLI' -> ${said}`);
    const after = labels();
    log(`after: workspaces ${after.join(' | ')}; tabs ${tabs().join(' ')}`);
    const tree = await requestLab(lab.link, 'herdr.tree', {});
    const shown = tree.workspaces.map((w) => w.label);
    log(`host herdr.tree workspace labels: ${shown.join(' | ')}`);
    const pathLabel = join(root, 'w', 'b', 'firstmate');
    ok = JSON.stringify(after) === JSON.stringify(before) && tabs().some((t) => t.endsWith('=boat-live-cli'))
        && JSON.parse(said).results.tab === true && shown.includes(pathLabel) && shown.includes('firstmate') && shown.includes('2ndmate-muxr');
    log(ok ? 'PASS: the lead workspace keeps 2ndmate-muxr, the lane named only its own tab, and the host sends the path label as Herdr has it' : 'FAIL: see above');
    writeFileSync(join(evidence, 'steps.json'), `${JSON.stringify({
        target: { version: `the muxr host built from ${execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()} on a private lab Herdr` },
        start: 'a lab Herdr with the lead\'s workspace 2ndmate-muxr holding one lane, a workspace Herdr named firstmate, and a workspace Herdr labelled with its folder\'s path',
        steps: ['List the workspaces', 'The lane runs muxr name --workspace boat-live-cli --pane from its own pane', 'List the workspaces and tabs again', 'Read the tree the phone draws spaces from (herdr.tree)'],
        result: `a worker naming itself renames only its own pane and tab, never the workspace: gate.log shows the lead's workspace still 2ndmate-muxr and the lane's own tab now boat-live-cli, and the host's tree carries the path-labelled workspace as Herdr has it; ${ok ? 'pass' : 'fail'}`,
    }, null, 2)}\n`);
} finally {
    await lab?.stop();
    rmSync(root, { recursive: true, force: true });
    log(`lab stopped; ${ok ? 'pass' : 'fail'}`);
}
process.exit(ok ? 0 : 1);
