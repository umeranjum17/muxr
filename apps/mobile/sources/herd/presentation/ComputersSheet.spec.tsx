import { expect, it, vi } from 'vitest';
import React from 'react';
import TestRenderer from 'react-test-renderer';

/*
 * The sheet is the one place the app lists computers, and it is dark whatever
 * the phone's theme is. Rows only appear after the stored pairings and their
 * liveness probes answer, so they mount on a later, local re-render of the
 * sheet's own body. On a light phone those late rows used to mount outside the
 * sheet's dark scope and take the light theme, painting light surfaces under
 * the sheet's white names. This drives the real sheet through that late mount
 * and reads the theme each row's Item actually wears.
 */

// react-native-unistyles 3 in brief: ScopedTheme sets its theme only while its
// own children render, and a component mounted by a later, local re-render
// reads whatever scope was in force then. A scope in a parent wrapper never
// re-runs on the sheet body's state, which was exactly this leak.
const h = vi.hoisted(() => {
    const scope = { current: undefined as string | undefined };
    const light = { colors: { text: '#000000', textSecondary: '#555555', surface: '#ffffff', groupped: { sectionTitle: '#333333' }, status: { connected: '#0a0', disconnected: '#999' } } };
    const dark = { colors: { text: '#ffffff', textSecondary: '#999999', surface: '#1c1c1e', groupped: { sectionTitle: '#aaaaaa' }, status: { connected: '#0a0', disconnected: '#999' } } };
    return { scope, light, dark, resolve: (name: string | undefined) => (name === 'dark' ? dark : light) };
});

vi.mock('react-native-unistyles', () => {
    const Apply = ({ name }: { name: string | undefined }) => { h.scope.current = name; return null; };
    return {
        ScopedTheme: ({ name, children }: { name: string; children: React.ReactNode }) => {
            const previous = h.scope.current;
            return <><Apply name={name} />{children}<Apply name={previous} /></>;
        },
        useUnistyles: () => {
            const [name] = React.useState(() => h.scope.current);
            return { theme: h.resolve(name) };
        },
    };
});

vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('expo-router', () => ({ useRouter: () => ({ back: () => undefined }) }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('@/components/Item', () => ({
    Item: ({ title, titleStyle }: { title: string; titleStyle?: { color?: string } }) => {
        // What the real Item draws its own surface from: the scoped theme.
        const [name] = React.useState(() => h.scope.current);
        return React.createElement('ItemSurface', {
            title,
            scopeSurface: h.resolve(name).colors.surface,
            titleColor: titleStyle?.color,
        });
    },
}));
vi.mock('@/components/ItemGroup', () => ({ ItemGroup: ({ children }: { children?: React.ReactNode }) => <>{children}</> }));
vi.mock('@/components/OptionSheet', () => ({ OptionSheet: ({ body }: { body?: React.ReactNode }) => <>{body}</> }));
vi.mock('@/modal', () => ({ Modal: { alert: vi.fn() } }));
vi.mock('@/modal/components/WebAlertModal', () => ({ WebAlertModal: () => null }));
vi.mock('@/connection', () => ({ getCachedConnectionSettings: () => ({ machineId: 'm' }) }));
vi.mock('@/collaboration', () => ({ openPairedMachine: async () => ({ close: () => undefined }) }));
vi.mock('@/pairing', () => ({ pairMachine: vi.fn() }));
vi.mock('@/pairing/e2ee', () => ({
    listPairedGrants: async () => [
        { machineId: 'm', machineName: 'Study-PC' },
        { machineId: 'b', machineName: 'Desk-Mac' },
    ],
}));
vi.mock('@/account/ui', () => ({ useAuth: () => ({ login: async () => undefined }) }));
vi.mock('@/catalog/store', () => ({
    useAllMachines: () => [],
    useSession: () => ({ metadata: { machineId: 'm' } }),
    useSocketStatus: () => ({ status: 'connected' }),
}));
vi.mock('@/conversation/session', () => ({ realtimeMachineSwitchGuard: () => ({ allowed: true }) }));

// These resolve the mocked modules, so they must stay below the vi.mock calls.
import { ComputersSheet } from './ComputersSheet';
import { ScopedTheme } from 'react-native-unistyles';

it('keeps rows mounted by a later re-render in the sheet dark theme on a light phone', async () => {
    let renderer!: ReturnType<typeof TestRenderer.create>;
    await TestRenderer.act(async () => {
        // The sheet is opened over the terminal, whose own dark scope the app
        // has already left by the time the pairing read answers.
        renderer = TestRenderer.create(<ScopedTheme name="dark"><ComputersSheet visible sessionId="s" onClose={() => undefined} /></ScopedTheme>);
        await Promise.resolve();
        await Promise.resolve();
    });

    const surfaces = (renderer.root as any).findAllByType('ItemSurface');
    const byTitle = new Map<string, any>(surfaces.map((node: any) => [node.props.title, node.props]));
    // Both paired computers arrived on the late re-render, not the first paint.
    expect(byTitle.has('Study-PC')).toBe(true);
    expect(byTitle.has('Desk-Mac')).toBe(true);
    // Each row's Item wears the sheet's dark surface, never the phone's light one.
    expect(byTitle.get('Study-PC').scopeSurface).toBe(h.dark.colors.surface);
    expect(byTitle.get('Desk-Mac').scopeSurface).toBe(h.dark.colors.surface);
    // The sheet's own overrides stay dark under them.
    expect(byTitle.get('Study-PC').titleColor).toBe(h.dark.colors.text);
    renderer.unmount();
});
