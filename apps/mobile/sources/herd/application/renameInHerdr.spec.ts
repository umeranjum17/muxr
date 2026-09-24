import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HerdrTreeWorkspace } from '@muxr/contract';

/**
 * Rename, from the sheet to what the screens draw, against a scripted host:
 * what is typed reaches Herdr (an agent's name typed into Herdr's handle
 * alphabet), and the terminal header and the Spaces list read the new names
 * from the refreshed tree. A refused rename says why and keeps the old name.
 */

const host = vi.hoisted(() => ({ tree: [] as HerdrTreeWorkspace[], app: [] as HerdrTreeWorkspace[], typed: [] as (string | null)[] }));
const alert = vi.hoisted(() => vi.fn());

vi.mock('@/modal', () => ({
    Modal: {
        // Types the next scripted answer into the sheet, through its transform.
        prompt: async (_title: string, _message?: string, options?: { transform?: (text: string) => string }) => {
            const text = host.typed.shift() ?? null;
            return text === null || options?.transform === undefined ? text : options.transform(text);
        },
        alert,
    },
}));
vi.mock('@/catalog/sync', () => ({
    sync: {
        request: async (type: string, params: { target: string; id: string; name: string }) => {
            if (type !== 'herdr.rename') throw new Error(type);
            const workspace = host.tree[0]!;
            const tab = workspace.tabs[0]!;
            if (params.target === 'workspace') workspace.label = params.name;
            if (params.target === 'tab') tab.label = params.name;
            const pane = tab.panes.find((entry) => entry.paneId === params.id);
            if (params.target === 'pane' && pane !== undefined) pane.label = params.name;
            if (params.target === 'agent' && pane !== undefined) {
                if (tab.panes.some((entry) => entry.agentName === params.name)) throw new Error(`agent name ${params.name} is already in use`);
                pane.agentName = params.name;
            }
            return null;
        },
        refreshHerdTree: async () => { host.app = structuredClone(host.tree); },
    },
}));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('react-native', () => ({ Platform: { OS: 'web' } }));

import { renameInHerdr, renamePane } from './renameInHerdr';
import { agentLabels, herdrPaneForSession, tabLabel } from '../domain/agentPresentation';
import { buildSpaceRows, displayedWorkspaceNames } from '../domain/herdTree';

function header(sessionId: string): string {
    return agentLabels(herdrPaneForSession(host.app, sessionId)).title;
}
function list(): { spaces: string[]; tabs: string[] } {
    const rows = buildSpaceRows(host.app, new Set(), '');
    return {
        spaces: [...displayedWorkspaceNames(rows).values()],
        tabs: host.app[0]!.tabs.map((tab, index) => tabLabel(tab, index)),
    };
}

describe('rename flow', () => {
    beforeEach(() => {
        alert.mockReset();
        host.tree = [{
            workspaceId: 'w1', label: 'muxr', focused: true, agentStatus: 'idle', tabs: [{
                tabId: 'w1:t1', label: '1', focused: true, agentStatus: 'idle', panes: [
                    { paneId: 'w1:p1', tabId: 'w1:t1', sessionId: 'agent-1', agentName: 'alpha', agentKind: 'pi', taskTitle: 'Fix login', agentStatus: 'idle', promptable: true, focused: true },
                    { paneId: 'w1:p2', tabId: 'w1:t1', sessionId: 'shell:w1:p2', terminalTitle: 'umer@desk:~', agentStatus: 'idle', promptable: true, focused: false },
                    { paneId: 'w1:p3', tabId: 'w1:t1', sessionId: 'agent-2', agentName: 'bravo', agentKind: 'claude', agentStatus: 'idle', promptable: true, focused: false },
                ],
            }],
        }];
        host.app = structuredClone(host.tree);
    });

    it('shows each new name in the header and the list, and keeps the old one when refused', async () => {
        expect(header('agent-1')).toBe('alpha');

        host.typed = ['Auth Fixer', 'Dev server', 'Review', 'Auth rework'];
        await renamePane(herdrPaneForSession(host.app, 'agent-1')!);
        await renamePane(herdrPaneForSession(host.app, 'shell:w1:p2')!);
        await renameInHerdr('tab', 'w1:t1', tabLabel(host.app[0]!.tabs[0]!, 0));
        await renameInHerdr('workspace', 'w1', 'muxr');

        expect(header('agent-1')).toBe('auth-fixer');
        expect(header('shell:w1:p2')).toBe('Dev server');
        expect(list()).toEqual({ spaces: ['Auth rework'], tabs: ['Review'] });

        // Cancel and blank change nothing; a name Herdr refuses is said plainly.
        host.typed = [null, '   ', 'auth-fixer'];
        await renameInHerdr('tab', 'w1:t1', 'Review');
        await renameInHerdr('tab', 'w1:t1', 'Review');
        await renamePane(herdrPaneForSession(host.app, 'agent-2')!);
        expect(alert).toHaveBeenCalledWith('Could not rename', 'agent name auth-fixer is already in use');
        expect(header('agent-2')).toBe('bravo');
        expect(list().tabs).toEqual(['Review']);
    });
});
