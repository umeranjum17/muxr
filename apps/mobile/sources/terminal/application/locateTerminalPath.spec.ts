import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    filesList: vi.fn(),
    filesRead: vi.fn(),
    filesRepos: vi.fn(),
    sessionReadFile: vi.fn(),
    request: vi.fn(),
}));

vi.mock('@/catalog/ops', () => ({
    filesList: mocks.filesList,
    filesRead: mocks.filesRead,
    filesRepos: mocks.filesRepos,
    sessionReadFile: mocks.sessionReadFile,
}));
vi.mock('@/catalog/sync', () => ({ sync: { request: mocks.request } }));

import { locateTerminalPath } from './locateTerminalPath';

describe('locateTerminalPath in observe mode', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.filesRepos.mockResolvedValue({ repos: [{ root: '/home/umer/project' }] });
        mocks.filesRead.mockResolvedValue({ name: 'main.ts' });
    });

    it('resolves a repository file using only Files read requests', async () => {
        const target = await locateTerminalPath('$HOME/project/src/main.ts', {
            sessionId: 'session-1',
            cwd: '/home/umer/project',
            observe: true,
        });

        expect(target).toEqual({
            kind: 'file',
            path: '/home/umer/project/src/main.ts',
            repo: { root: '/home/umer/project', relative: 'src/main.ts' },
        });
        expect(mocks.filesRead).toHaveBeenCalledWith('session-1', {
            root: '/home/umer/project', path: 'src/main.ts',
        });
        expect(mocks.request).not.toHaveBeenCalled();
        expect(mocks.sessionReadFile).not.toHaveBeenCalled();
    });
});
