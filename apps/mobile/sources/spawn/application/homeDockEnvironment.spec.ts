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

import { agentInstallPhase, agentReadinessLabel, visibleDockAgents } from './homeDockEnvironment';

it('shows the install phase only for an installed first-start installer, and its at-rest readiness stays the sign-in state', () => {
    const pi = { kind: 'pi', availability: 'installed', installState: 'installs-on-first-start', signedIn: 'yes' } as const;
    expect(agentInstallPhase(pi)).toBe('Installing Pi');
    expect(agentReadinessLabel(pi, true)).toBe('Installing Pi');
    expect(agentReadinessLabel(pi)).toBe('Signed in');
    expect(visibleDockAgents([pi])[0].installPhase).toBe('Installing Pi');
    expect(agentInstallPhase({ kind: 'claude', availability: 'installed', installState: 'installed' })).toBeUndefined();
    expect(agentInstallPhase(undefined)).toBeUndefined();
    const absent = { kind: 'grok', availability: 'unavailable', installState: 'installs-on-first-start', installHint: 'npm i -g grok' } as const;
    expect(agentInstallPhase(absent)).toBeUndefined();
    expect(agentReadinessLabel(absent, true)).toBe('npm i -g grok');
    expect(visibleDockAgents([absent], true)[0].installPhase).toBeUndefined();
});
