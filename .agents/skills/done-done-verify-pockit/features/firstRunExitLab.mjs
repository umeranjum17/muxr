// A bare `muxr` after a first run (first-run-exit.md): the real scripts/cli.mjs
// runs on a pty in a private MUXR_HOME. Only the setup wizard's apply step is
// stood in (the real one installs services); everything the fix decides after it
// is the real cli. Finished run: the CLI ends on its own line, no menu. Unfinished
// run (setup cancelled, exit 0, nothing saved): the menu still opens.
// Run from the repo root: node <this> <evidence-dir>
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const evidence = resolve(process.argv[2]);
mkdirSync(evidence, { recursive: true });
const root = mkdtempSync(join(tmpdir(), 'frx-'));
const failures = [];
try {
    for (const outcome of ['finish', 'cancel']) {
        const home = join(root, outcome);
        mkdirSync(home, { recursive: true });
        const run = spawnSync('python3', ['-I', join(here, 'firstRunExitPty.py'), resolve('scripts/cli.mjs'), join(here, 'firstRunExitSetup.mjs'), home, outcome], {
            encoding: 'utf8', timeout: 60_000, env: { ...process.env, HOME: home, MUXR_HOME: home, TERM: 'xterm-256color' },
        });
        const text = run.stdout.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
        writeFileSync(join(evidence, `first-run-${outcome}.txt`), text);
        const menu = text.includes('What would you like to do?');
        if (outcome === 'finish' && (menu || !text.includes('muxr exit 0') || !text.includes('Open muxr on your phone'))) failures.push(`finished first run did not end cleanly (menu ${menu})`);
        if (outcome === 'cancel' && !menu) failures.push('unfinished first run did not open the menu');
    }
} finally { rmSync(root, { recursive: true, force: true }); }
if (failures.length > 0) { console.error(failures.join('\n')); process.exit(1); }
console.log('first run exit: finished run ends without the menu; unfinished run opens it');
