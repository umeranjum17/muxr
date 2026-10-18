import { describe, expect, it, vi } from 'vitest';

vi.mock('@/connection', () => ({
    getCachedConnectionSettings: () => ({ lastSessionCwd: '' }),
}));

import { dockStartPath } from './startFolder';

describe('dock start folder', () => {
    it('keeps the setup folder even when it is outside the phone home directory', () => {
        expect(dockStartPath(null, '/home/user', '/mnt/work/project')).toBe('/mnt/work/project');
    });
});
