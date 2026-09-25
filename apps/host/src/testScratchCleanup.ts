import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { cleanTestScratch, processGroup, processStart, scratchBase, scratchEntries, scratchUnused, testScratchOwner } from '../../../scripts/diagnostics/application/testScratchOwner.mjs';

export default function setupHostTestScratch(): () => void {
    const inherited = process.env.TMPDIR;
    const owned = !inherited || !basename(inherited).startsWith('muxr-host-test-');
    if (owned) testScratchOwner(scratchBase());
    const birth = owned ? processStart(process.pid) : undefined;
    if (owned && !birth) throw new Error('Cannot identify test scratch owner');
    const root = owned ? mkdtempSync(join(scratchBase(), `muxr-host-test-${process.pid}-`)) : inherited!;
    // A shared process group stays occupied until its long-lived parent exits; the sweep conservatively waits for it.
    if (owned) {
        const group = processGroup(process.pid);
        writeFileSync(join(root, 'owner'), `${process.pid} ${birth}${group ? `\n${group}` : ''}`);
    }
    process.env.TMPDIR = root;
    return () => {
        const unused = owned || scratchUnused(root);
        const leftovers: string[] = [];
        if (unused) {
            cleanTestScratch(root);
            if (owned) {
                for (const name of scratchEntries(root)) {
                    if (name !== 'owner') leftovers.push(join(root, name));
                }
                rmSync(root, { recursive: true, force: true });
            }
        }
        if (owned) {
            if (inherited === undefined) delete process.env.TMPDIR;
            else process.env.TMPDIR = inherited;
        }
        if (leftovers.length) throw new Error(`host test scratch leftovers:\n${leftovers.join('\n')}`);
    };
}
