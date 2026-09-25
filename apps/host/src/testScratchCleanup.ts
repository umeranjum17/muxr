import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { processStart, reclaimScratch, scratchUnused } from '../../../scripts/diagnostics/application/testScratchOwner.mjs';

export default function setupHostTestScratch(): () => void {
    const inherited = process.env.TMPDIR;
    const owned = !inherited || !basename(inherited).startsWith('muxr-host-test-');
    if (owned) reclaimScratch(tmpdir());
    const birth = owned ? processStart(process.pid) : undefined;
    if (owned && !birth) throw new Error('Cannot identify test scratch owner');
    const root = owned ? mkdtempSync(join(tmpdir(), `muxr-host-test-${process.pid}-`)) : inherited!;
    if (owned) writeFileSync(join(root, 'owner'), `${process.pid} ${birth}`);
    process.env.TMPDIR = root;
    return () => {
        const unused = scratchUnused(root);
        const leftovers: string[] = [];
        if (unused) {
            for (const name of readdirSync(root)) {
                if (/^(?:muxr-|desklink-|v-|x-|attention-)/.test(name)) rmSync(join(root, name), { recursive: true, force: true });
                else if (name !== 'owner') leftovers.push(join(root, name));
            }
            if (owned) rmSync(root, { recursive: true, force: true });
        }
        if (owned) {
            if (inherited === undefined) delete process.env.TMPDIR;
            else process.env.TMPDIR = inherited;
        }
        if (leftovers.length) throw new Error(`host test scratch leftovers:\n${leftovers.join('\n')}`);
    };
}
