/**
 * What an agent is in Herdr Core, read from the terminal record alone.
 *
 * Core keeps no agent concept: an agent is a terminal that carries the `muxr.kind` label, its
 * space and tab are the `herdr.space` and `herdr.tab` labels, and its status is the word the
 * program itself reported (OSC 7501). Nothing here touches a socket, so every rule is plain data.
 */

import { rollupLifecycle } from './lifecycle.js';
import type { AgentLifecycle, HerdrTreeWorkspace, SessionInfo, SessionStatus } from '@trymuxr/contract';

/** The Herdr Core status record (`Status` in its schema): the program's own words. */
export interface CoreStatus {
    state: string;
    app?: string;
    kind?: string | null;
}

/** The part of Core's `Terminal` record muxr reads. Unknown fields ride along untouched. */
export interface CoreTerminal {
    address: string;
    name: string | null;
    cwd: string;
    labels: Record<string, string>;
    state: 'live' | 'finished' | string;
    exit_code: number | null;
    reported: boolean;
    status: CoreStatus | null;
    status_ms: number | null;
    created_ms: number;
    turn: number;
}

export const KIND_LABEL = 'muxr.kind';
export const SPACE_LABEL = 'herdr.space';
export const TAB_LABEL = 'herdr.tab';
const DEFAULT_SPACE = 'Agents';

/** The host's session id for a Core terminal. Local computer only; later slices prefix the machine. */
export const sessionIdFor = (address: string): string => `hc_${address}`;

export function addressFor(sessionId: string): string | undefined {
    return sessionId.startsWith('hc_') ? sessionId.slice(3) : undefined;
}

export const isAgentTerminal = (terminal: CoreTerminal): boolean => typeof terminal.labels?.[KIND_LABEL] === 'string';

/**
 * The lifecycle a terminal is in. A live terminal that has never reported is `starting`:
 * silence is never read as working or done, which is what makes a stopped reporter visible.
 */
export function lifecycleOf(terminal: CoreTerminal): AgentLifecycle {
    if (terminal.state === 'finished') return terminal.exit_code === 0 ? 'done' : 'failed';
    if (terminal.status === null || terminal.status === undefined) return terminal.reported ? 'unknown' : 'starting';
    switch (terminal.status.state) {
        case 'idle': return 'idle';
        case 'working': return 'working';
        case 'done': return 'done';
        case 'blocked': return 'blocked';
        case 'error': return 'failed';
        default: return 'unknown';
    }
}

export const promptableOf = (terminal: CoreTerminal): boolean => terminal.state === 'live';

const spaceOf = (terminal: CoreTerminal): string => terminal.labels[SPACE_LABEL] ?? DEFAULT_SPACE;
const tabOf = (terminal: CoreTerminal): string => terminal.labels[TAB_LABEL] ?? terminal.name ?? terminal.address;

export function infoOf(terminal: CoreTerminal): SessionInfo {
    const space = spaceOf(terminal);
    const tab = tabOf(terminal);
    const kind = terminal.labels[KIND_LABEL];
    return {
        id: sessionIdFor(terminal.address),
        cwd: terminal.cwd,
        created: new Date(terminal.created_ms).toISOString(),
        modified: new Date(terminal.status_ms ?? terminal.created_ms).toISOString(),
        messageCount: 0,
        firstMessage: '',
        paneId: terminal.address,
        agentName: terminal.name ?? terminal.address,
        ...(kind === undefined ? {} : { agentKind: kind }),
        agentStatus: lifecycleOf(terminal),
        promptable: promptableOf(terminal),
        workspaceId: `space:${space}`,
        workspaceLabel: space,
        tabId: `tab:${space}/${tab}`,
        tabLabel: tab,
    };
}

export function statusOf(terminal: CoreTerminal): SessionStatus {
    const agentStatus = lifecycleOf(terminal);
    return {
        sessionId: sessionIdFor(terminal.address),
        agentStatus,
        promptable: promptableOf(terminal),
        isStreaming: agentStatus === 'working',
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
}

/** Spaces, tabs and panes from labels, in the order the terminals were created. */
export function treeOf(terminals: readonly CoreTerminal[]): HerdrTreeWorkspace[] {
    const spaces = new Map<string, Map<string, CoreTerminal[]>>();
    for (const terminal of [...terminals].filter(isAgentTerminal).sort((a, b) => a.created_ms - b.created_ms)) {
        const tabs = spaces.get(spaceOf(terminal)) ?? new Map<string, CoreTerminal[]>();
        tabs.set(tabOf(terminal), [...(tabs.get(tabOf(terminal)) ?? []), terminal]);
        spaces.set(spaceOf(terminal), tabs);
    }
    return [...spaces].map(([space, tabs], order): HerdrTreeWorkspace => {
        const treeTabs = [...tabs].map(([tab, members]) => {
            const tabId = `tab:${space}/${tab}`;
            const panes = members.map((terminal) => {
                const info = infoOf(terminal);
                return {
                    paneId: terminal.address,
                    tabId,
                    ...(terminal.name === null ? {} : { label: terminal.name }),
                    tabLabel: tab,
                    cwd: terminal.cwd,
                    ...(info.agentKind === undefined ? {} : { agentKind: info.agentKind }),
                    ...(info.agentName === undefined ? {} : { agentName: info.agentName }),
                    agentStatus: info.agentStatus,
                    promptable: info.promptable,
                    focused: false,
                    sessionId: info.id,
                };
            });
            return { tabId, label: tab, focused: false, agentStatus: rollupLifecycle(panes.map((pane) => pane.agentStatus)), panes };
        });
        return {
            workspaceId: `space:${space}`,
            label: space,
            focused: false,
            order,
            agentStatus: rollupLifecycle(treeTabs.map((tab) => tab.agentStatus)),
            tabs: treeTabs,
        };
    });
}
