import { describe, expect, it } from 'vitest';
import { insideProject, processCwd } from './preview.js';
// @ts-expect-error bundled plugins are executable public fixtures, not TS packages
import { insideProject as pluginInsideProject, parseLsofListeners as parsePluginLsof, parseSsListeners as parsePluginSs } from '../../../../plugins/run-server/rpc.mjs';

describe('insideProject', () => {
    it('matches a server running in the project root', () => {
        expect(insideProject('/home/u/app', '/home/u/app')).toBe(true);
    });

    it('matches a server in a package below the session directory', () => {
        expect(insideProject('/home/u/app', '/home/u/app/apps/web')).toBe(true);
    });

    it('matches a server at the root when the session sits in a package', () => {
        expect(insideProject('/home/u/app/apps/web', '/home/u/app')).toBe(true);
    });

    it('rejects a sibling project', () => {
        expect(insideProject('/home/u/app', '/home/u/other')).toBe(false);
    });

    it('rejects a directory that only shares a name prefix', () => {
        expect(insideProject('/home/u/app', '/home/u/app-store')).toBe(false);
    });
});

describe('bundled run-server discovery', () => {
    it('parses Linux/macOS listeners and rejects sibling or prefix-only projects', () => {
        expect(parsePluginSs('LISTEN 0 511 127.0.0.1:3000 0.0.0.0:* users:(("node",pid=123,fd=21))')).toEqual([
            { port: 3000, command: 'node', pid: 123 },
        ]);
        expect(parsePluginLsof('node 456 user 21u IPv4 0x1 0t0 TCP 127.0.0.1:4173 (LISTEN)')).toEqual([
            { port: 4173, command: 'node', pid: 456 },
        ]);
        expect(pluginInsideProject('/home/u/app', '/home/u/app/apps/web')).toBe(true);
        expect(pluginInsideProject('/home/u/app/apps/web', '/home/u/app')).toBe(true);
        expect(pluginInsideProject('/home/u/app', '/home/u/app-store')).toBe(false);
        expect(pluginInsideProject('/home/u/app', '/home/u/other')).toBe(false);
    });
});

describe('processCwd', () => {
    it('resolves this process', async () => {
        expect(await processCwd(process.pid)).toBe(process.cwd());
    });

    it('stays undefined without a pid', async () => {
        expect(await processCwd(undefined)).toBeUndefined();
    });
});
