import React from 'react';
import TestRenderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

const act = TestRenderer.act;
import type { PlanProviderAccounts } from '@trymuxr/contract';

// An agent on Work, which is out of room: the agent screen must say so and
// offer Move. Umer still has room, so only Work's agents warn.
const request = vi.hoisted(() => vi.fn());
const connection = vi.hoisted(() => ({ machineId: 'computer-a', relayUrl: 'ws://lab', token: 'fake' }));
vi.mock('@/connection', () => ({ getCachedConnectionSettings: () => connection }));
vi.mock('@/catalog/sync', () => ({ sync: { request } }));
vi.mock('@/catalog/store', () => ({
    storage: { subscribe: () => () => {} },
    useSocketStatus: () => ({ status: 'connected' }),
    useHerdrTree: () => ({ workspaces: [] }),
}));
vi.mock('react-native-mmkv', () => ({
    MMKV: class {
        getString() { return undefined; }
        getBoolean() { return undefined; }
        set() {}
    },
}));
vi.mock('react-native', () => ({
    Pressable: 'Pressable', Text: 'Text', View: 'View',
    useWindowDimensions: () => ({ width: 270, height: 594 }),
    StyleSheet: { hairlineWidth: 1 },
}));
const theme = vi.hoisted(() => ({ colors: {
    text: '#fff', textSecondary: '#aaa', textLink: '#0af', surfaceHigh: '#111',
    surfaceHighest: '#222', divider: '#333', fab: { icon: '#000', background: '#0af', backgroundPressed: '#0af' },
    box: { warning: { background: '#220', border: '#fa0', text: '#fa0' } },
} }));
vi.mock('react-native-unistyles', () => ({
    StyleSheet: { create: (make: (value: typeof theme) => unknown) => make(theme), hairlineWidth: 1 },
    useUnistyles: () => ({ theme }),
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn(), back: vi.fn(), canGoBack: () => false }), usePathname: () => '/' }));
vi.mock('react-native-reanimated', () => {
    const enter = { duration: () => enter, reduceMotion: () => enter };
    return { default: { View: 'Animated.View' }, FadeInDown: enter, FadeInUp: enter, FadeOutDown: enter, FadeOutUp: enter, ReduceMotion: { System: 'system' } };
});
vi.mock('@/components/OptionSheet', () => ({
    OptionSheet: (props: { body: React.ReactNode }) => React.createElement('OptionSheet', props, props.body),
}));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}), mono: () => ({}) } }));
vi.mock('@/modal', () => ({ Modal: { alert: vi.fn(), confirm: vi.fn() } }));
vi.mock('@/herd', () => ({ navigateToSession: vi.fn() }));

const { AgentEmptyBanner } = await import('./EmptyRoomBanner');
const { usePlansStore, refreshPlans } = await import('../application/plansStore');

const entry = (workRoom: number): PlanProviderAccounts => ({
    provider: 'claude',
    label: 'Claude',
    accounts: [
        { id: 'found-claude', provider: 'claude', name: 'Umer', email: 'umer@example.com', foundOnComputer: true, signedIn: true, roomLeftPercent: 72, roomLabel: '72% left this week' },
        { id: 'pa_work', provider: 'claude', name: 'Work', email: 'umer.work@example.com', signedIn: true, roomLeftPercent: workRoom, roomLabel: `${workRoom}% left this week` },
    ],
    auto: { accountId: 'found-claude', reason: "Right now that's Umer: 72% left this week" },
});

const texts = (tree: any): string[] =>
    tree.root.findAllByType('Text').map((node: any) => ([] as unknown[]).concat(node.props.children).join(''));

async function showBanner(workRoom = 0, agentAccountId: string | undefined = 'pa_work'): Promise<any> {
    request.mockImplementation((type: string) => {
        if (type === 'plans.list') return Promise.resolve({ providers: [entry(workRoom)] });
        if (type === 'plans.agent') return Promise.resolve({ accountId: agentAccountId });
        return Promise.reject(new Error(`unexpected ${type}`));
    });
    await refreshPlans();
    let tree!: any;
    await act(async () => {
        tree = TestRenderer.create(<AgentEmptyBanner sessionId="sess-1" agentKind="claude" working={false} />);
        // Let the recorded-account read resolve and re-render.
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
    return tree;
}

describe('the out-of-room banner on a running agent', () => {
    it('names the empty account it runs on, offers Move, and clears when the room refills', async () => {
        const tree = await showBanner();
        expect(texts(tree)).toContain('Out of room on Work');
        const move = tree.root.findAllByType('Pressable')
            .find((node: any) => String(node.props.accessibilityLabel ?? '').startsWith('Move to another account'));
        expect(move).toBeDefined();

        // The room refills: the next read takes the banner down.
        request.mockImplementation((type: string) => {
            if (type === 'plans.list') return Promise.resolve({ providers: [entry(41)] });
            if (type === 'plans.agent') return Promise.resolve({ accountId: 'pa_work' });
            return Promise.reject(new Error(`unexpected ${type}`));
        });
        await act(async () => { await refreshPlans(); });
        expect(texts(tree)).not.toContain('Out of room on Work');
        tree.unmount();
    });

    it('stays hidden until the recorded account is known, and with no choice of accounts', async () => {
        let answerAgent!: (value: unknown) => void;
        request.mockImplementation((type: string) => {
            if (type === 'plans.list') return Promise.resolve({ providers: [entry(0)] });
            if (type === 'plans.agent') return new Promise((resolve) => { answerAgent = resolve; });
            return Promise.reject(new Error(`unexpected ${type}`));
        });
        await refreshPlans();
        let tree!: any;
        await act(async () => {
            tree = TestRenderer.create(<AgentEmptyBanner sessionId="sess-9" agentKind="claude" working={false} />);
        });
        // The list knows Work is empty, but not that this agent runs on it.
        expect(texts(tree)).not.toContain('Out of room on Work');
        await act(async () => {
            answerAgent({ accountId: 'pa_work' });
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
        expect(texts(tree)).toContain('Out of room on Work');
        tree.unmount();

        // One account: the host lists nothing to choose from, so nothing warns.
        request.mockImplementation((type: string) => {
            if (type === 'plans.list') return Promise.resolve({ providers: [] });
            return Promise.reject(new Error(`unexpected ${type}`));
        });
        await act(async () => { await refreshPlans(); });
        usePlansStore.setState({ discovery: 'ready' });
        let lone!: any;
        await act(async () => {
            lone = TestRenderer.create(<AgentEmptyBanner sessionId="sess-1" agentKind="claude" working={false} />);
        });
        expect(texts(lone)).not.toContain('Out of room on Work');
        lone.unmount();
    });
});
