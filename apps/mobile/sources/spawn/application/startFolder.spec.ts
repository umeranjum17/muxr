import { describe, expect, it, vi } from 'vitest';

vi.mock('@/connection', () => ({
    getCachedConnectionSettings: () => ({ lastSessionCwdByMachine: { a: '/home/a/api' } }),
}));

import { dockStartPath } from './startFolder';

describe('dock start folder', () => {
    it('starts in the setup folder, and a folder remembered on another machine does not follow', () => {
        expect(dockStartPath(null, 'b', '/mnt/work/project')).toBe('/mnt/work/project');
        expect(dockStartPath(null, 'a', '/mnt/work/project')).toBe('/home/a/api');
    });
});
