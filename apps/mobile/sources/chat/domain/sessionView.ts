/** The agents whose conversation the host can read into a chat. */
const CHAT_AGENTS: ReadonlySet<string> = new Set(['claude', 'pi']);

export type SessionViewSetting = 'terminal' | 'chat' | 'phone';
export type PaneView = 'chat' | 'terminal';

/** Below this, the screen is a phone: the shorter side in dp. */
const PHONE_SHORT_SIDE = 600;

export const SESSION_VIEW_CHOICES: ReadonlyArray<{ key: SessionViewSetting; title: string; subtitle: string }> = [
    { key: 'terminal', title: 'Terminal', subtitle: 'Every agent opens as a terminal' },
    { key: 'chat', title: 'Chat', subtitle: 'Claude and Pi open as a chat; other agents open the terminal' },
    { key: 'phone', title: 'Chat on phone', subtitle: 'Chat on phones, terminal on tablets and larger screens' },
];

export function agentHasChat(agentKind: string | undefined): boolean {
    return agentKind !== undefined && CHAT_AGENTS.has(agentKind);
}

/**
 * Which view an agent shows: the choice made in its own header, else the
 * default from Settings. An agent without a chat is always the terminal.
 */
export function resolvePaneView(input: {
    agentKind: string | undefined;
    own: PaneView | undefined;
    setting: SessionViewSetting;
    shortSide: number;
}): PaneView {
    if (!agentHasChat(input.agentKind)) return 'terminal';
    if (input.own !== undefined) return input.own;
    if (input.setting === 'chat') return 'chat';
    return input.setting === 'phone' && input.shortSide < PHONE_SHORT_SIDE ? 'chat' : 'terminal';
}

/** Remembered choices are kept by agent, newest last, so the list cannot grow without end. */
const REMEMBERED_PANES = 200;

export function rememberPaneView(views: Record<string, PaneView>, id: string, view: PaneView): Record<string, PaneView> {
    const { [id]: _previous, ...rest } = views;
    return Object.fromEntries(Object.entries({ ...rest, [id]: view }).slice(-REMEMBERED_PANES));
}
