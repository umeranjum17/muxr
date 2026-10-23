// A host built on the pinned @desklink/host starts and pairs. Starts this
// checkout's relay (port 0) and host in an isolated Herdr lab session through
// the guarded helper, pairs a lab client over the link, and tears everything
// down. Needs HERDR_LAB_HELPER; a short scratch root under ~/.cache/fms.
//   node .agents/skills/done-done-verify-pockit/features/desklinkPinLab.mjs <evidence-dir>
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { linkHerdrLab } from '../../../../scripts/diagnostics/application/linkHerdrLab.mjs';

const evidence = process.argv[2];
if (!evidence) throw new Error('usage: desklinkPinLab.mjs <evidence-dir>');
const pinned = (app) => JSON.parse(readFileSync(`apps/${app}/package.json`, 'utf8')).dependencies['@desklink/host'];
const installed = JSON.parse(readFileSync('node_modules/@desklink/host/package.json', 'utf8')).version;
const root = join(homedir(), '.cache', 'fms', 'desklink-pin');
mkdirSync(root, { recursive: true });
const lines = [];
const say = (line) => { lines.push(line); console.log(line); };
let result = 'fail';
try {
    say(`pinned: host ${pinned('host')}, desktop ${pinned('desktop')}; installed ${installed}`);
    const lab = await linkHerdrLab(root, 'desklink-pin', () => {});
    say(`relay up on port ${lab.port}; lab client paired over the link`);
    say(`host output:\n${lab.hostOutput().trim()}`);
    const online = lab.hostOutput().includes('pairing: ready') && lab.hostOutput().includes('link relay: online');
    await lab.stop();
    say('lab torn down');
    if (!online || pinned('host') !== installed || pinned('desktop') !== installed) throw new Error('host did not start and pair on the pinned version');
    result = 'pass';
} finally {
    say(`RESULT ${result}`);
    writeFileSync(join(evidence, 'pin.log'), `${lines.join('\n')}\n`);
    writeFileSync(join(evidence, 'steps.json'), `${JSON.stringify({
        target: { desklinkHost: installed },
        start: 'this checkout\'s relay and host in an isolated Herdr lab session',
        steps: ['host starts', 'link relay online', 'lab client pairs', 'lab torn down'],
        result: result === 'pass' ? `host on @desklink/host ${installed} started, reached the relay and paired` : 'fail',
    }, null, 2)}\n`);
    rmSync(root, { recursive: true, force: true });
}
if (result !== 'pass') process.exitCode = 1;
