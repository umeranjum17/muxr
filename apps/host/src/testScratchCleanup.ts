import { readdirSync, rmSync } from 'node:fs';
import { basename } from 'node:path';

export default function setupHostTestScratch(): () => void {
    return () => {
        const root = process.env.TMPDIR;
        if (!root || !basename(root).startsWith('muxr-host-test-')) return;
        for (const name of readdirSync(root)) {
            if (/^(?:muxr-|desklink-|v-|x-)/.test(name)) rmSync(`${root}/${name}`, { recursive: true, force: true });
        }
    };
}
