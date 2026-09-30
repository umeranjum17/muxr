import { beforeEach, expect, it, vi } from 'vitest';

const values = vi.hoisted(() => new Map<string, string>());

vi.mock('react-native-mmkv', () => ({
    MMKV: class {
        getString(key: string) { return values.get(key); }
        set(key: string, value: string) { values.set(key, value); }
        delete(key: string) { values.delete(key); }
    },
}));

beforeEach(() => {
    values.clear();
    vi.resetModules();
});

it('replaces a legacy Pi default when the host only launches Claude', async () => {
    values.set('new-session-draft-v1', JSON.stringify({ agentType: 'pi', updatedAt: 1 }));
    const { useNewSessionDraft } = await import('./useNewSessionDraft');

    expect(useNewSessionDraft.getState().agentTypeExplicit).toBe(false);
    useNewSessionDraft.getState().setDefaultAgentType('claude');

    expect(useNewSessionDraft.getState().agentType).toBe('claude');
});

it('keeps an installed legacy Claude selection when Claude is the host default', async () => {
    values.set('new-session-draft-v1', JSON.stringify({ agentType: 'claude', updatedAt: 1 }));
    const { useNewSessionDraft } = await import('./useNewSessionDraft');

    expect(useNewSessionDraft.getState().agentTypeExplicit).toBe(false);
    expect(useNewSessionDraft.getState().agentType).toBe('claude');
    useNewSessionDraft.getState().setDefaultAgentType('claude');

    expect(useNewSessionDraft.getState().agentType).toBe('claude');
});
