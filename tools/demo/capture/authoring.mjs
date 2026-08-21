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
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
            // Never put the scratch directory on camera. And the CLI's U+2713
            // is drawn as a bare `V` by IBM Plex Mono, which is the film's
            // terminal face — the word is what the mark means anyway.
            // The generated plugin id carries a random suffix. It is an id, it
            // means nothing to a reader, and the film never speaks ids.
            say(trimmed
                .split(work).join('.')
                .replace(/^\u2713 /, 'OK ')
                .replace(/(local\.[a-z0-9-]+?)-[0-9a-f]{6,}\b/g, '$1'));
        }
        say('');
    };

    // create -> check -> dev, and nothing else. A `cat` of the manifest only
    // fits on the plate as a truncated fragment — unbalanced braces and a
    // dangling key — which reads as a broken file rather than as a manifest.
    await run(`plugin create ${NAME}`, ['plugin', 'create', NAME]);
    await run(`plugin check ${NAME}`, ['plugin', 'check', NAME]);
    await run(`plugin dev ${NAME}`, ['plugin', 'dev', NAME]);

    // `plugin dev` links the scratch plugin into Herdr's registry, and the
    // registry keeps pointing at this directory after it is deleted. Left
    // alone, every run of this capture adds another enabled plugin whose root
    // no longer exists.
    const linkedId = lines.map((line) => line.match(/\(([a-z0-9][a-z0-9._-]*)\)/)?.[1]).filter(Boolean).at(-1);
    if (linkedId) {
        await exec(process.env.HERDR_BIN?.trim() || 'herdr', ['plugin', 'unlink', linkedId])
            .catch((error) => console.error(`warning: could not unlink ${linkedId}: ${error.message}`));
    }
    await rm(work, { recursive: true, force: true });

    const kept = lines.filter((l, i, all) => !(l === '' && all[i - 1] === ''));
    while (kept.at(-1) === '') kept.pop();
    const trimmed = kept;

    await writeFile(path.join(root, 'lib', 'authoring.json'), `${JSON.stringify({
        label: 'muxr plugin create',
        agent: 'cli',
        branch: NAME,
        // A trailing blank is a blank row on the plate, and the plate is sized
        // from the row count.
        lines: trimmed.slice(0, 26),
    }, null, 4)}\n`);
    console.log(`--> lib/authoring.json  ${lines.length} lines`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
