import { describe, expect, it, vi } from 'vitest';

vi.mock('@/connection', () => ({
    getCachedConnectionSettings: () => ({ lastSessionCwd: '' }),
}));

import { machineInfoToMachine } from '@/catalog/infrastructure/sessionMapping';
import { dockStartPath } from './startFolder';

describe('dock start folder', () => {
    it('keeps the setup folder even when it is outside the phone home directory', () => {
        expect(dockStartPath(null, '/home/user', '/mnt/work/project')).toBe('/mnt/work/project');
    });

    it('falls back to the setup folder when the last folder is from another computer', () => {
        const machine = machineInfoToMachine({ machineId: 'm', online: true, homeDir: '/home/b', defaultStartFolder: '/mnt/work/project' });
        expect(dockStartPath('/home/a/api', machine.metadata?.homeDir, machine.metadata?.defaultStartFolder)).toBe('/mnt/work/project');
    });
});
