import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createHerdrSessionSource } from './herdrSessionSource.js';

/**
 * The Applications flow, end to end through the real session source: the
 * catalog lists only enabled plugins' global actions, a launch runs the
 * declared argv in its own new tab with the plugin invocation context, the
 * opened pane is returned as a shell route, and a failed launch cleans its
 * anchor unless the action already opened a pane. This is the host-owned
 * replacement for the old panes plugin's tools/launch RPCs.
 */
type StatePane = { pane_id: string; tab_id: string; workspace_id: string; cwd: string };

function fakeHerdr(dir: string, plugins: unknown[]) {
    const stateFile = join(dir, 'panes.json');
    const initial: StatePane[] = [
        { pane_id: 'shell-0', tab_id: 'source-tab', workspace_id: 'work', cwd: join(dir, 'work') },
        { pane_id: 'shell-1', tab_id: 'source-tab', workspace_id: 'work', cwd: '/work' },
    ];
    const reset = () => writeFileSync(stateFile, JSON.stringify(initial));
    reset();
    const panes = (): StatePane[] => JSON.parse(readFileSync(stateFile, 'utf8') as string);
    const save = (list: StatePane[]) => writeFileSync(stateFile, JSON.stringify(list));

    const server = createServer((socket: Socket) => {
        let buffer = '';
        socket.on('data', (chunk) => {
            buffer += chunk.toString('utf8');
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) {
                if (line.trim() === '') continue;
                const { id, method, params } = JSON.parse(line) as { id: string; method: string; params?: Record<string, unknown> };
                const p = params ?? {};
                let reply: unknown;
                switch (method) {
                    case 'events.subscribe':
                        reply = {};
                        break;
                    case 'session.snapshot':
                        reply = {
                            snapshot: {
                                workspaces: [{ workspace_id: 'work', label: 'Work' }],
                                tabs: [{ tab_id: 'source-tab', workspace_id: 'work' }, { tab_id: 'owned-tab', workspace_id: 'work' }],
                                panes: panes(),
                                agents: [],
                            },
                        };
                        break;
                    case 'plugin.list':
                        reply = { plugins };
                        break;
                    case 'workspace.list':
                        reply = { workspaces: [{ workspace_id: 'work', label: 'Work' }] };
                        break;
                    case 'tab.create': {
                        const list = panes();
                        const anchor: StatePane = { pane_id: 'owned-anchor', tab_id: 'owned-tab', workspace_id: 'work', cwd: p.cwd as string };
                        list.push(anchor);
                        save(list);
                        reply = { tab: { tab_id: 'owned-tab' }, root_pane: anchor };
                        break;
                    }
                    case 'pane.close': {
                        save(panes().filter((pane) => (pane as { pane_id: string }).pane_id !== p.pane_id));
                        reply = {};
                        break;
                    }
                    default:
                        reply = { error: { code: 'method_not_found', message: method } };
                        break;
                }
                const payload = reply as { result?: unknown; error?: unknown };
                socket.end(`${JSON.stringify(payload.error !== undefined ? { id, error: payload.error } : { id, result: payload.result ?? payload })}\n`);
            }
        });
        socket.on('error', () => {});
    });
    const socketPath = join(dir, 'herdr.sock');
    server.listen(socketPath);
    return { socketPath, stateFile, reset, initial, panes, close: () => server.close() };
}

describe('Applications: third-party launchers as typed host methods', () => {
    it('lists enabled global actions, launches one in an owned tab, and cleans up failures', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'muxr-applications-'));
        const fixtureCwd = join(dir, 'work');
        mkdirSync(fixtureCwd);
        const actionScript = join(dir, 'action.mjs');
        writeFileSync(actionScript, `import { readFileSync, writeFileSync } from 'node:fs';
const mode = process.argv[2];
const context = JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON ?? '{}');
if (process.cwd() !== ${JSON.stringify(fixtureCwd)}) throw new Error('wrong project folder');
if (context.focused_pane_id !== 'owned-anchor' || process.env.HERDR_PANE_ID !== 'owned-anchor') throw new Error('launch context missing');
if (context.invocation_source !== 'muxr' || process.env.HERDR_PLUGIN_ID !== 'example.browser') throw new Error('plugin identity missing');
if (!process.env.PATH?.includes('/.local/bin')) throw new Error('launcher PATH missing');
if (mode === 'fail') process.exit(7);
const state = ${JSON.stringify(join(dir, 'panes.json'))};
const panes = JSON.parse(readFileSync(state, 'utf8'));
panes.push({ pane_id: 'owned-tool', tab_id: 'owned-tab', workspace_id: 'work', cwd: '/work' });
writeFileSync(state, JSON.stringify(panes));
`);
        const herdr = fakeHerdr(dir, [
            { plugin_id: 'example.browser', name: 'Terminal Browser', enabled: true, plugin_root: dir, actions: [{ id: 'open', title: 'Terminal Browser', contexts: ['global'], command: [process.execPath, actionScript] }] },
            { plugin_id: 'example.code', name: 'Terminal Code', enabled: true, plugin_root: dir, actions: [{ id: 'open', title: 'Terminal Code', contexts: ['global'], command: [process.execPath, actionScript, 'fail'] }] },
            // Pane-context actions are setup surfaces, not launchers; disabled plugins are absent.
            { plugin_id: 'example.admin', name: 'Setup', enabled: true, plugin_root: dir, actions: [{ id: 'setup', title: 'Configure', contexts: ['pane'], command: ['true'] }] },
            { plugin_id: 'example.disabled', name: 'Disabled', enabled: false, plugin_root: dir, actions: [{ id: 'open', title: 'Nope', contexts: ['global'], command: ['true'] }] },
        ]);
        const source = await createHerdrSessionSource({
            socketPath: herdr.socketPath,
            dataDir: join(dir, 'data'),
            artifactsDir: join(dir, 'attachments'),
            hostHttpPort: 0,
        });
        try {
            // Catalog: only enabled plugins' global actions, sorted, attributed.
            const { items } = await source.applicationsList();
            expect(items.map((item) => item.title)).toEqual(['Terminal Browser', 'Terminal Code']);
            expect(items[0]).toMatchObject({ pluginName: 'Terminal Browser', pluginId: 'example.browser' });

            // Launch: owned tab, declared argv with plugin context, opened pane returned.
            herdr.reset();
            const launched = await source.applicationsLaunch({
                applicationId: 'action:example.browser:open',
                sessionId: 'shell:shell-0',
            });
            expect(launched).toEqual({ title: 'Terminal Browser', sessionId: 'shell:owned-tool' });
            const after = herdr.panes();
            expect(after.some((pane) => (pane as { pane_id: string }).pane_id === 'owned-anchor')).toBe(false);
            expect(after.filter((pane) => (pane as { tab_id: string }).tab_id === 'source-tab')).toHaveLength(2);

            // Failure with no pane: the anchor tab is cleaned, the error says retry.
            herdr.reset();
            await expect(source.applicationsLaunch({ applicationId: 'action:example.code:open', sessionId: 'shell:shell-0' }))
                .rejects.toThrow(/Could not open Terminal Code/);
            expect(herdr.panes()).toEqual(herdr.initial);

            // Failure after the pane opened: the pane stays findable in Panes.
            herdr.reset();
            const seeded = [...herdr.initial, { pane_id: 'owned-anchor', tab_id: 'owned-tab', workspace_id: 'work', cwd: '/work' }, { pane_id: 'owned-tool', tab_id: 'owned-tab', workspace_id: 'work', cwd: '/work' }];
            writeFileSync(herdr.stateFile, JSON.stringify(seeded));
            await expect(source.applicationsLaunch({ applicationId: 'action:example.code:open', sessionId: 'shell:shell-0' }))
                .rejects.toThrow(/available in Panes/);
            const kept = herdr.panes();
            expect(kept.some((pane) => (pane as { pane_id: string }).pane_id === 'owned-tool')).toBe(true);

            // Unknown application: refresh-and-retry guidance.
            await expect(source.applicationsLaunch({ applicationId: 'action:gone:open' })).rejects.toThrow(/no longer installed/);
        } finally {
            await source.dispose();
            herdr.close();
            rmSync(dir, { recursive: true, force: true });
        }
    }, 30_000);
});
