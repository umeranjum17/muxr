import React from 'react';
import TestRenderer from 'react-test-renderer';
import { beforeEach, expect, it, vi } from 'vitest';

// Only the link to the computer is faked: the host's catalog answer and
// session.start. The card, the catalog reading, the offer and the start
// flow are the real modules.
const host = vi.hoisted(() => ({
    readiness: {} as Record<string, { signedIn: string }>,
    installed: [] as string[],
    started: [] as Array<Record<string, unknown>>,
    startFails: false,
    visibilityFails: false,
}));
const navigated = vi.hoisted(() => [] as string[]);
const pushed = vi.hoisted(() => [] as string[]);
const settings = vi.hoisted(() => new Map<string, unknown>());
// Any colour path resolves, so the styles of every shared component load.
const theme = vi.hoisted(() => {
    const colour: any = new Proxy(() => '#888', { get: (_target, key) => (key === Symbol.toPrimitive ? () => '#888' : colour) });
    return { colors: colour };
});

vi.mock('@/catalog/sync', () => ({
    sync: {
        request: vi.fn(async (method: string, params: Record<string, unknown>) => {
            if (method === 'herdr.agentKinds') {
                return { kinds: ['claude', 'codex', 'pi'], installed: [...host.installed], readiness: structuredClone(host.readiness) };
            }
            if (method === 'session.start') {
                if (host.startFails) throw new Error('session.start failed');
                host.started.push(params);
                return { info: { id: 'agent-1' } };
            }
            throw new Error(`unexpected ${method}`);
        }),
    },
}));
vi.mock('react-native-mmkv', () => ({
    MMKV: class { getString() { return undefined; } set() {} delete() {} },
}));
vi.mock('@/catalog/ops', () => ({
    refreshUntilSessionVisible: async () => {
        if (host.visibilityFails) throw new Error('Connection lost');
    },
}));
vi.mock('@/catalog/store', () => ({
    useLocalSettingMutable: (key: string) => {
        const [value, setValue] = React.useState<unknown>(settings.get(key) ?? false);
        return [value, (next: unknown) => { settings.set(key, next); setValue(next); }];
    },
    useHerdrTree: () => ({ workspaces: [] }), useSessions: () => [], useSocketStatus: () => ({ status: 'connected' }),
}));
vi.mock('@/catalog', async () => ({
    ...await import('@/catalog/domain/agentKinds'),
    ...await import('@/catalog/application/persistence'),
}));
// The real spawn modules the card uses, without the index's voice and dock siblings.
vi.mock('@/spawn', async () => ({
    ...await import('@/spawn/application/homeDockEnvironment'),
    ...await import('@/spawn/application/startNewAgent'),
    ...await import('@/spawn/application/useNewSessionDraft'),
}));
vi.mock('@/connection', () => ({
    getCachedConnectionSettings: () => ({ lastSessionCwd: '/home/umer/project' }),
    rememberSessionCwd: (value: unknown) => value,
    saveConnectionSettings: async () => {},
}));
vi.mock('@/herd', () => ({ navigateToSession: (_router: unknown, id: string) => { navigated.push(id); } }));
vi.mock('expo-router', () => ({ router: {}, useRouter: () => ({ push: (path: string) => pushed.push(path) }) }));
vi.mock('@/modal', () => ({ Modal: { confirm: async () => false } }));
vi.mock('react-native', () => ({
    ActivityIndicator: 'ActivityIndicator', AppState: { addEventListener: () => ({ remove() {} }) }, Linking: {},
    Platform: { OS: 'android', Version: 34, select: (options: Record<string, unknown>) => options.android },
    Pressable: 'Pressable', Text: 'Text', View: 'View',
}));
vi.mock('react-native-unistyles', () => ({
    StyleSheet: { create: (make: (value: typeof theme) => unknown) => make(theme) },
    useUnistyles: () => ({ theme }),
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('@/components/haptics', () => ({ hapticsLight: () => {} }));
vi.mock('@/components/ui', () => ({ cardStyle: () => ({}) }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('@/account/ui', () => ({ useAuth: () => ({ isAuthenticated: true }) }));
vi.mock('@/../modules/voice-overlay', () => ({ openBackgroundActivitySettings: () => {} }));
vi.mock('@/utils/microphonePermissions', () => ({}));
vi.mock('@/utils/webInstall', () => ({}));
vi.mock('@/settings', () => ({}));
vi.mock('@/text', () => ({ t: (key: string) => key }));

import { FirstAgentCard } from './HomeFirstRunCards';

type Screen = ReturnType<typeof TestRenderer.create>;

function texts(screen: Screen): string[] {
    return (screen.root as any).findAllByType('Text' as never).map((node: any) => [node.props.children].flat().join(''));
}

function button(screen: Screen, label: string) {
    return (screen.root as any).find((node: any) => (node.type as unknown) === 'Pressable' && node.props.accessibilityLabel === label);
}

async function render(): Promise<Screen> {
    let screen!: Screen;
    await TestRenderer.act(async () => { screen = TestRenderer.create(<FirstAgentCard />); });
    return screen;
}

beforeEach(() => {
    host.startFails = false;
    host.visibilityFails = false;
    host.started.length = 0;
    navigated.length = 0;
    pushed.length = 0;
    settings.clear();
});

it('starts a ready agent in one tap, with no picker', async () => {
    host.installed = ['claude', 'codex'];
    host.readiness = { claude: { signedIn: 'yes' }, codex: { signedIn: 'no' } };
    const screen = await render();

    expect(texts(screen)).toContain('Claude Code is ready on your computer.');
    await TestRenderer.act(async () => { button(screen, 'Start Claude Code').props.onPress(); });

    expect(host.started).toEqual([{ cwd: '/home/umer/project', kind: 'claude' }]);
    expect(navigated).toEqual(['agent-1']);
    expect(pushed).toEqual([]);
});

it('says plainly what to do when no agent is ready, and recovers in place', async () => {
    host.installed = ['claude', 'pi'];
    host.readiness = { claude: { signedIn: 'no' }, pi: { signedIn: 'yes' } };
    settings.clear();
    const screen = await render();

    // Pi is never the automatic offer, and Shell never is: the best candidate is Claude Code.
    expect(texts(screen)).toContain('Sign in to Claude Code on your computer, then tap Check again.');
    expect(() => button(screen, 'Start Claude Code')).toThrow();

    host.readiness = { claude: { signedIn: 'yes' }, pi: { signedIn: 'yes' } };
    await TestRenderer.act(async () => { button(screen, 'Check again').props.onPress(); });
    expect(button(screen, 'Start Claude Code')).toBeTruthy();

    await TestRenderer.act(async () => { button(screen, 'Choose another agent').props.onPress(); });
    expect(pushed).toEqual(['/new-agent']);
    // Only a started agent or Not now retires the card; a look at the picker does not.
    expect(button(screen, 'Start Claude Code')).toBeTruthy();
});

it('a failed one-tap start re-reads readiness and never offers the same Start again', async () => {
    host.installed = ['claude'];
    host.readiness = { claude: { signedIn: 'yes' } };
    const screen = await render();

    host.startFails = true;
    host.readiness = { claude: { signedIn: 'no' } };
    await TestRenderer.act(async () => { button(screen, 'Start Claude Code').props.onPress(); });

    expect(texts(screen)).toContain('session.start failed');
    expect(texts(screen)).toContain('Sign in to Claude Code on your computer, then tap Check again.');
    expect(() => button(screen, 'Start Claude Code')).toThrow();
    expect(button(screen, 'Check again')).toBeTruthy();

    host.readiness = { claude: { signedIn: 'yes' } };
    await TestRenderer.act(async () => { button(screen, 'Check again').props.onPress(); });
    expect(() => button(screen, 'Start Claude Code')).toThrow();
    expect(button(screen, 'Check again')).toBeTruthy();
});

it('a start that failed after its agent was created opens that agent, not a second Start', async () => {
    host.installed = ['claude'];
    host.readiness = { claude: { signedIn: 'yes' } };
    host.visibilityFails = true;
    const screen = await render();

    await TestRenderer.act(async () => { button(screen, 'Start Claude Code').props.onPress(); });

    expect(host.started).toHaveLength(1);
    expect(navigated).toEqual(['agent-1']);
    expect(texts(screen)).not.toContain('Connection lost');
});
