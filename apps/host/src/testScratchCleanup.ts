import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

export default function setupHostTestScratch(): () => void {
    const inherited = process.env.TMPDIR;
    const owned = !inherited || !basename(inherited).startsWith('muxr-host-test-');
    const root = owned ? mkdtempSync(join(tmpdir(), 'muxr-host-test-')) : inherited;
    process.env.TMPDIR = root;
    return () => {
        const leftovers: string[] = [];
        for (const name of readdirSync(root)) {
            if (/^(?:muxr-|desklink-|v-|x-)/.test(name)) rmSync(join(root, name), { recursive: true, force: true });
            else if (name !== 'owner') leftovers.push(join(root, name));
        }
        if (owned) {
            rmSync(root, { recursive: true, force: true });
            if (inherited === undefined) delete process.env.TMPDIR;
            else process.env.TMPDIR = inherited;
        }
        if (leftovers.length) throw new Error(`host test scratch leftovers:\n${leftovers.join('\n')}`);
    };
}
