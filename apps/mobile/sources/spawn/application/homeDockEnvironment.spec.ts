import { expect, it, vi } from 'vitest';

vi.mock('react-native-mmkv', () => ({
    MMKV: class {
        getString() { return undefined; }
        set() {}
        delete() {}
    },
}));
vi.mock('react-native', () => ({
    Platform: { OS: 'ios', select: (options: Record<string, unknown>) => options.ios },
    NativeModules: {},
}));
vi.mock('@/herd', () => ({ formatPathRelativeToHome: vi.fn() }));
vi.mock('./worktree', () => ({ listWorktrees: vi.fn() }));
vi.mock('@/catalog', async () => import('@/catalog/application/persistence'));

import { agentInstallPhase, dockInstallPhase } from './homeDockEnvironment';

it('shows an install phase only for an installed first-start installer', () => {
    expect(agentInstallPhase({ kind: 'pi', availability: 'installed', installState: 'installs-on-first-start' })).toBe('Installing Pi');
    expect(agentInstallPhase({ kind: 'claude', availability: 'installed', installState: 'installed' })).toBeUndefined();
    expect(agentInstallPhase({ kind: 'grok', availability: 'unavailable', installState: 'installs-on-first-start' })).toBeUndefined();
    expect(agentInstallPhase(undefined)).toBeUndefined();
    expect(dockInstallPhase({ name: 'Pi', installState: 'installs-on-first-start' })).toBe('Installing Pi');
    expect(dockInstallPhase({ name: 'Pi' })).toBeUndefined();
});
