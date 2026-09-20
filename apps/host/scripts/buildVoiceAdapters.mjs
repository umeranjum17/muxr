/**
 * The realtime voice adapters stay ESM: `stream.mjs` is spawned as a child
 * process and imports its providers by relative path. tsc only emits the
 * TypeScript facade, so stage the runtime next to it. Only runtime files are
 * touched; the compiled facade is left alone.
 */
import { cpSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, '..', 'src', 'voice');
const target = join(here, '..', 'dist', 'voice');

const isRuntime = (path) => (path.endsWith('.mjs') && !path.endsWith('.spec.mjs')) || path.endsWith('README.md');
const isStaging = (path) => path.endsWith('.mjs') || path.endsWith('README.md');

/** Drop runtime files this build no longer ships; never touch tsc's output. */
function prune(directory, counterpart) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        const mirror = join(counterpart, entry.name);
        if (!isStaging(entry.name)) continue;
        if (entry.isDirectory()) {
            prune(path, mirror);
            rmSync(path, { recursive: true, force: true });
            continue;
        }
        if (!isRuntime(path)) continue;
        try {
            statSync(mirror);
        } catch {
            rmSync(path, { force: true });
        }
    }
}

mkdirSync(target, { recursive: true });
prune(target, source);
cpSync(source, target, { recursive: true, filter: (path) => statSync(path).isDirectory() || isRuntime(path) });
process.stdout.write('Realtime voice adapter runtime staged\n');
