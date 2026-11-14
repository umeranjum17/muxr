/**
 * What an agent is in Herdr Core, read from the terminal record alone.
 *
 * Core keeps no agent concept: an agent is a terminal that carries the `muxr.kind` label, its
 * space and tab come from the Herdr app's layout document (the `herdr.space` and `herdr.tab`
 * labels when the document does not place it), and its status is the word the program itself
 * reported (OSC 7501). Nothing here touches a socket, so every rule is plain data.
 */

import { rollupLifecycle } from './lifecycle.js';
import { DEFAULT_SPACE, SPACE_LABEL, TAB_LABEL, type ArrangedSpace, type Placement } from './herdrAppLayout.js';
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

/** The host's session id for a Core terminal. Local computer only; later slices prefix the machine. */
export const sessionIdFor = (address: string): string => `hc_${address}`;

export function addressFor(sessionId: string): string | undefined {
    return sessionId.startsWith('hc_') ? sessionId.slice(3) : undefined;
}

/**
 * The labels a new agent is born with. Core keeps no agent concept, so these three labels ARE the
 * agent's place: its kind, its space (the folder's name) and its tab (the task, else the kind).
 */
export function launchLabels(options: { cwd: string; kind: string; label?: string; taskTitle?: string }): Record<string, string> {
    const slug = (text: string): string => text.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
    const space = options.cwd.split('/').filter((part) => part !== '').at(-1) ?? DEFAULT_SPACE;
    return {
        [KIND_LABEL]: options.kind,
        [SPACE_LABEL]: space,
        [TAB_LABEL]: slug(options.label ?? options.taskTitle ?? '') || options.kind,
    };
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

/** The session record for a terminal, placed in its space and tab by the layout (`herdrAppLayout.ts`). */
export function infoOf(terminal: CoreTerminal, placement: Placement): SessionInfo {
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
        workspaceId: placement.spaceId,
        workspaceLabel: placement.space,
        tabId: placement.tabId,
        tabLabel: placement.tab,
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

/** The tree Home shows: the arranged spaces, tabs and panes, each pane the terminal's own record. */
export function treeOf(arranged: readonly ArrangedSpace[], terminals: readonly CoreTerminal[], placementOf: (terminal: CoreTerminal) => Placement): HerdrTreeWorkspace[] {
    const byAddress = new Map(terminals.map((terminal) => [terminal.address, terminal]));
    return arranged.map((space, order): HerdrTreeWorkspace => {
        const tabs = space.tabs.map((tab) => {
            const panes = tab.terminals.flatMap((address) => {
                const terminal = byAddress.get(address);
                if (terminal === undefined) return [];
                const info = infoOf(terminal, placementOf(terminal));
                return [{
                    paneId: terminal.address,
                    tabId: tab.id,
                    ...(terminal.name === null ? {} : { label: terminal.name }),
                    tabLabel: tab.name,
                    cwd: terminal.cwd,
                    ...(info.agentKind === undefined ? {} : { agentKind: info.agentKind }),
                    ...(info.agentName === undefined ? {} : { agentName: info.agentName }),
                    agentStatus: info.agentStatus,
                    promptable: info.promptable,
                    focused: false,
                    sessionId: info.id,
                }];
            });
            return { tabId: tab.id, label: tab.name, focused: false, agentStatus: rollupLifecycle(panes.map((pane) => pane.agentStatus)), panes };
        });
        return { workspaceId: space.id, label: space.name, focused: false, order, agentStatus: rollupLifecycle(tabs.map((tab) => tab.agentStatus)), tabs };
    });
}
