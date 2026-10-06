import React from 'react';
import TestRenderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

const act = TestRenderer.act;
import type { PlanAccount, PlanProviderAccounts } from '@trymuxr/contract';

// Two Claude accounts, both unnamed on the computer, so the host names them
// "Umer" and "Umer 2" — the list and the "Added" notice have to agree on that.
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
    Pressable: 'Pressable', Text: 'Text', TextInput: 'TextInput', View: 'View',
    useWindowDimensions: () => ({ width: 270, height: 594 }),
}));
const theme = vi.hoisted(() => ({ colors: {
    text: '#fff', textSecondary: '#aaa', textLink: '#0af', surface: '#000', surfaceHigh: '#111',
    surfaceHighest: '#222', surfacePressed: '#222', divider: '#333', fab: { icon: '#000' },
    box: { warning: { text: '#fa0' } }, success: '#0a0',
} }));
vi.mock('react-native-unistyles', () => ({
    StyleSheet: { create: (make: (value: typeof theme) => unknown) => make(theme), hairlineWidth: 1 },
    useUnistyles: () => ({ theme }),
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => '/' }));
vi.mock('react-native-reanimated', () => {
    const enter = { duration: () => enter, reduceMotion: () => enter };
    return { default: { View: 'Animated.View' }, FadeInDown: enter, FadeInUp: enter, FadeOutDown: enter, FadeOutUp: enter, ReduceMotion: { System: 'system' } };
});
vi.mock('@/components/OptionSheet', () => ({
    OptionSheet: (props: { body: React.ReactNode }) => React.createElement('OptionSheet', props, props.body),
}));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}), mono: () => ({}) } }));
vi.mock('@/modal', () => ({ Modal: { alert: vi.fn(), prompt: vi.fn(), confirm: vi.fn() } }));
vi.mock('@/herd', () => ({ navigateToSession: vi.fn() }));

const { useFlows } = await import('./AccountFlows');
const { NameAccountSheet } = await import('./AccountFlows');
const { usePlansStore, refreshPlans } = await import('../application/plansStore');

const named = (personal: string, work: string): PlanProviderAccounts => ({
    provider: 'claude',
    label: 'Claude',
    accounts: [
        { id: 'found-claude', provider: 'claude', name: personal, email: 'umer@example.com', foundOnComputer: true, signedIn: true },
        { id: 'pa_work', provider: 'claude', name: work, email: 'umer.work@example.com', signedIn: true },
    ],
    auto: { accountId: 'pa_work', reason: 'Work has the most room left' },
});

const byLabel = (screen: any, label: string) =>
    screen.root.findAll((node: any) => node.props?.accessibilityLabel === label && typeof node.props.onPress === 'function')[0];

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('the notice after naming an added account', () => {
    it('names the provider\'s accounts exactly as the list below it does', async () => {
        // The list the person is looking at, then what the host answers once
        // the new account has taken the name "Umer" the first one held by default.
        let renamed = false;
        request.mockImplementation(async (type: string) => {
            if (type === 'plans.rename') { renamed = true; return {}; }
            return { providers: [named(renamed ? 'Umer 2' : 'Umer', renamed ? 'Umer' : 'Umer 2')] };
        });
        await refreshPlans();
        const list = usePlansStore.getState().list!;
        const account = list.providers[0].accounts.find((one: PlanAccount) => one.id === 'pa_work')!;

        await act(async () => { useFlows.setState({ naming: { account, again: false } }); });
        let screen: any;
        await act(async () => { screen = TestRenderer.create(<NameAccountSheet />); });
        // The person names the new account exactly as the first one already answers to.
        await act(async () => { screen.root.findByType('TextInput').props.onChangeText('Umer'); });
        await act(async () => { byLabel(screen, 'Save').props.onPress(); });

        const notice = useFlows.getState().notice!;
        expect(notice.title).toBe('Added Umer');
        const shown = notice.detail.replace('Claude accounts: ', '').split(', ');
        const listed = usePlansStore.getState().list!.providers[0].accounts.map((one: PlanAccount) => one.name).sort();
        expect(shown).toEqual(listed);
        expect(shown).toEqual(['Umer', 'Umer 2']);
    });
});
