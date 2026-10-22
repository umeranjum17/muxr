/** Real-host pane generations must not leave timestamp/sequence bookkeeping behind. */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { linkHerdrLab } from './linkHerdrLab.mjs';
import { requestLab } from './linkLabClient.mjs';
import { removeTestScratch } from './testScratchOwner.mjs';

const root = mkdtempSync(join(tmpdir(), 'muxr-retained-sessions-'));
const countsPath = join(root, 'retained.json');
const preload = join(root, 'count-retained.mjs');
// A debugger tap, not a fake source: the real host creates, publishes and retires
// every pane. Read the live owners' retained entry counts without adding a
// product API or retaining snapshots/terminal data in the test itself.
writeFileSync(preload, `
import { writeFile } from 'node:fs/promises';
if (process.argv[1]?.endsWith('/apps/host/dist/main.js')) {
    const maps = [];
    const set = Map.prototype.set;
    Map.prototype.set = function(key, value) {
        if (typeof key === 'string' && /^(shell:|pp_)/.test(key)
            && !maps.some(entry => entry.map === this)) {
            const stack = new Error().stack ?? '';
            if (typeof value === 'string' && /^\\d{4}-\\d\\d-\\d\\dT/.test(value)
                && stack.includes('publish') && stack.includes('/agent/infrastructure/herdrSessionSource.js:')) {
                maps.push({ name: 'modified', map: this });
            } else if (typeof value === 'number' && stack.includes('nextSeq') && stack.includes('/host.js:')) {
                maps.push({ name: 'sequence', map: this });
            }
        }
        return set.call(this, key, value);
    };
    let writing = false;
    setInterval(async () => {
        if (writing || maps.length !== 2) return;
        writing = true;
        try { await writeFile(${JSON.stringify(countsPath)}, JSON.stringify(Object.fromEntries(maps.map(entry => [entry.name, entry.map.size])))); }
        finally { writing = false; }
    }, 50).unref();
}
`);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        if (await check()) return;
        await sleep(100);
    }
    throw new Error(`timed out: ${label}`);
}
function counts() {
    try { return JSON.parse(readFileSync(countsPath, 'utf8')); }
    catch { return undefined; }
}
const panes = tree => tree.workspaces.flatMap(workspace => workspace.tabs.flatMap(tab => tab.panes));
let lab;
let removed = 0;
try {
    lab = await linkHerdrLab(root, 'session-retention', frame => {
        if (frame?.type === 'session.event' && frame.event.type === 'session.removed') removed++;
    }, undefined, { NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` });
    const anchor = JSON.parse(lab.herdr(['workspace', 'create', '--cwd', root, '--label', 'Umer retained anchor', '--no-focus'])).result.root_pane.pane_id;
    await until(async () => panes(await requestLab(lab.link, 'herdr.tree')).some(pane => pane.paneId === anchor), 'anchor discovered');
    await until(() => counts()?.modified > 0 && counts()?.sequence > 0, 'both real bookkeeping owners observed');
    const baseline = counts();
    for (let index = 0; index < 30; index++) {
        const created = JSON.parse(lab.herdr(['workspace', 'create', '--cwd', root, '--label', `Umer transient ${index}`, '--no-focus']));
        const paneId = created.result.root_pane.pane_id;
        await until(async () => panes(await requestLab(lab.link, 'herdr.tree')).some(pane => pane.paneId === paneId), 'transient pane discovered');
        lab.herdr(['workspace', 'close', created.result.workspace.workspace_id]);
        await until(() => removed > index, 'transient removal delivered');
    }
    // Topology removal alone passed while both maps still held every retired
    // route. Their live owner counts must return to the anchor's baseline too.
    await until(() => counts()?.modified === baseline.modified && counts()?.sequence === baseline.sequence, 'retired generation bookkeeping released');
    assert.deepEqual(counts(), baseline);
    console.log('PASS: 30 real pane generations close without retaining timestamp or sequence entries');
} finally {
    await lab?.stop();
    removeTestScratch(root);
}
