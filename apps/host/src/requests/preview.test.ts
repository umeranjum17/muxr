import { describe, expect, it } from 'vitest';
// @ts-expect-error bundled plugins are executable public fixtures, not TS packages
import { insideProject as pluginInsideProject, parseLsofListeners as parsePluginLsof, parseSsListeners as parsePluginSs } from '../../../../plugins/servers/serve.mjs';

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
