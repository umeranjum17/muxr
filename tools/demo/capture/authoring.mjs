#!/usr/bin/env node
// Snapshots a real plugin-authoring session into lib/authoring.json.
//
// The film claims you can write your own extension, so it shows one being
// written. Every line is this script actually running the CLI in a temp
// directory — nothing here is typed by hand, for the same reason none of the
// captures are mocked.
//
// Usage: node capture/authoring.mjs
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';

const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const NAME = 'field-notes';

async function main() {
    const work = await mkdtemp(path.join(tmpdir(), 'muxr-authoring-'));
    const lines = [];
    const say = (text) => lines.push(text);

    const run = async (label, args) => {
        say(`$ muxr ${label}`);
        const { stdout } = await exec('muxr', args, { cwd: work, maxBuffer: 1 << 22 });
        for (const line of stdout.split('\n')) {
            const trimmed = line.trimEnd();
            // `plugin dev` echoes the whole link record as JSON; the human line
            // after it is the one worth reading.
            if (trimmed === '' || trimmed.startsWith('{')) continue;
            // Never put the scratch directory on camera.
            say(trimmed.split(work).join('.'));
        }
        say('');
    };

    await run(`plugin create ${NAME}`, ['plugin', 'create', NAME]);

    const manifest = JSON.parse(await readFile(path.join(work, NAME, 'muxr-ui.json'), 'utf8'));
    const screen = manifest.contributions.find((c) => c.type === 'screen');
    say(`$ cat ${NAME}/muxr-ui.json`);
    for (const line of JSON.stringify(screen, null, 2).split('\n').slice(0, 12)) say(`  ${line}`);
    say('');

    await run(`plugin check ${NAME}`, ['plugin', 'check', NAME]);
    await run(`plugin dev ${NAME}`, ['plugin', 'dev', NAME]);

    await rm(work, { recursive: true, force: true });

    await writeFile(path.join(root, 'lib', 'authoring.json'), `${JSON.stringify({
        label: 'muxr plugin create',
        agent: 'cli',
        branch: NAME,
        lines: lines.filter((l, i, all) => !(l === '' && all[i - 1] === '')).slice(0, 26),
    }, null, 4)}\n`);
    console.log(`--> lib/authoring.json  ${lines.length} lines`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
