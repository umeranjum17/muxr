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

    it("opens the filesystem root itself when '/' is tapped outside every repository", async () => {
        mocks.filesRepos.mockResolvedValue({ repos: [] });
        // A directory is not a readable file: the real host refuses the
        // read, and the folder listing verifies it instead.
        mocks.filesRead.mockRejectedValueOnce(new Error('outside repository'));
        mocks.filesList.mockResolvedValue({ tree: [] });

        const target = await locateTerminalPath('/', {
            sessionId: 'session-1',
            cwd: '/home/umer/project',
            observe: true,
        });

        expect(target).toEqual({ kind: 'folder', path: '/' });
        expect(mocks.filesList).toHaveBeenCalledWith('session-1', { root: '/', path: '' });
        expect(mocks.request).not.toHaveBeenCalled();
        expect(mocks.sessionReadFile).not.toHaveBeenCalled();
    });

    it('returns a missing repository file as a file so Files shows its missing state', async () => {
        // The read refuses and no folder claims the name: the tap still
        // named a file, so Files (not an alert) says it is gone.
        mocks.filesRead.mockRejectedValue(new Error('file unavailable'));
        mocks.filesList.mockResolvedValue({ tree: [] });

        const target = await locateTerminalPath('/home/umer/project/src/gone.ts', {
            sessionId: 'session-1',
            cwd: '/home/umer/project',
            observe: true,
        });

        expect(target).toEqual({
            kind: 'file',
            path: '/home/umer/project/src/gone.ts',
            repo: { root: '/home/umer/project', relative: 'src/gone.ts' },
        });
        expect(mocks.sessionReadFile).not.toHaveBeenCalled();
    });
});
