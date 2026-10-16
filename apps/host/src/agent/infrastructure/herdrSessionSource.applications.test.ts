import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PluginsInvalidatedFrame, SessionEventBody } from '@trymuxr/contract';
import { createHerdrSessionSource } from './herdrSessionSource.js';

/**
 * The Applications flow, end to end through the real session source: the
 * catalog lists only enabled plugins' global actions, a launch runs the
 * declared argv in its own new tab with the plugin invocation context, the
 * opened pane is returned as a shell route, and a failed launch cleans its
 * anchor unless the action already opened a pane. This is the host-owned
 * replacement for the old panes plugin's tools/launch RPCs.
 *
 * The second flow covers the same source's Shared Artifacts publish: one share
 * emits exactly one canonical update, never the pre-rename duplicate. The third
 * covers the reconnect resend: every hello re-sends the full artifact history.
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
                        // The kit holds the event socket open for pushes; only
                        // the ack carries the subscribe id it waits for.
                        socket.write(`${JSON.stringify({ id, result: {} })}\n`);
                        continue;
                    case 'ping':
                        reply = { id, result: { protocol: 22 } };
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
                    // The kit's guarded closes read the live tree before closing.
                    case 'pane.get': {
                        const pane = panes().find((entry) => entry.pane_id === p.pane_id);
                        reply = pane === undefined ? { error: { code: 'pane_not_found', message: 'gone' } } : { pane };
                        break;
                    }
                    case 'tab.get': {
                        const count = panes().filter((entry) => entry.tab_id === p.tab_id).length;
                        reply = count === 0 ? { error: { code: 'tab_not_found', message: 'gone' } } : { tab: { tab_id: p.tab_id, workspace_id: 'work', pane_count: count } };
                        break;
                    }
                    case 'workspace.get':
                        reply = { workspace: { workspace_id: 'work', label: 'Work', tab_count: new Set(panes().map((entry) => entry.tab_id)).size } };
                        break;
                    case 'tab.close':
                        save(panes().filter((entry) => entry.tab_id !== p.tab_id));
                        reply = {};
                        break;
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

describe('Shared Artifacts: one canonical publish per share, full state per reconnect', () => {
    const PIXEL_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

    async function shareSource(dir: string) {
        mkdirSync(join(dir, 'work'));
        const herdr = fakeHerdr(dir, []);
        const source = await createHerdrSessionSource({
            socketPath: herdr.socketPath,
            dataDir: join(dir, 'data'),
            artifactsDir: join(dir, 'attachments'),
            hostHttpPort: 0,
        });
        return { herdr, source };
    }

    it('publishes exactly one artifacts.update from one share and no legacy duplicate', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'muxr-artifact-publish-'));
        mkdirSync(join(dir, 'attachments', 'shell-0'), { recursive: true });
        const { herdr, source } = await shareSource(dir);
        const published: SessionEventBody[] = [];
        source.subscribe((sessionId, event) => {
            if (sessionId === 'shell:shell-0') published.push(event);
        });
        try {
            writeFileSync(join(dir, 'attachments', 'shell-0', 'shared.png'), Buffer.from(PIXEL_B64, 'base64'));
            const deadline = Date.now() + 20_000;
            while (Date.now() < deadline && !published.some((event) => event.type === 'artifacts.update')) {
                await new Promise((resolve) => setTimeout(resolve, 100));
            }
            // Settle: the duplicate rode the same watcher pass, so anything
            // extra would already have arrived.
            await new Promise((resolve) => setTimeout(resolve, 1_500));

            const legacy = published.filter((event) => event.type === 'attachments.update');
            expect(legacy).toEqual([]);
            const canonical = published.filter((event) => event.type === 'artifacts.update');
            expect(canonical).toHaveLength(1);
            const event = canonical[0];
            if (event === undefined || event.type !== 'artifacts.update') {
                throw new Error(`the host published no artifacts.update (saw ${published.map((entry) => entry.type).join(', ')})`);
            }
            expect(event.artifacts.map((artifact) => artifact.name)).toEqual(['shared.png']);
            expect(event.total).toBe(1);
        } finally {
            await source.dispose();
            herdr.close();
            rmSync(dir, { recursive: true, force: true });
        }
    }, 30_000);

    it('resends full artifact state on every hello, including a reconnect', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'muxr-artifact-resend-'));
        mkdirSync(join(dir, 'attachments', 'shell-0'), { recursive: true });
        mkdirSync(join(dir, 'attachments', 'shell-1'), { recursive: true });
        writeFileSync(join(dir, 'attachments', 'shell-0', 'a.png'), Buffer.from(PIXEL_B64, 'base64'));
        writeFileSync(join(dir, 'attachments', 'shell-1', 'b.png'), Buffer.from(PIXEL_B64, 'base64'));
        const { herdr, source } = await shareSource(dir);
        const delivered: Array<{ sessionId: string; event: SessionEventBody }> = [];
        const machine: PluginsInvalidatedFrame[] = [];
        const resend = async (): Promise<void> => {
            await source.resendCumulativeState?.(
                (sessionId, event) => delivered.push({ sessionId, event }),
                (frame) => machine.push(frame),
            );
        };
        const artifactUpdates = () => delivered.filter((entry) => entry.event.type === 'artifacts.update');
        const expectFullState = () => {
            expect(artifactUpdates()).toHaveLength(2);
            expect(delivered.some((entry) => entry.event.type === 'attachments.update')).toBe(false);
            for (const [sessionId, name] of [['shell:shell-0', 'a.png'], ['shell:shell-1', 'b.png']] as const) {
                const update = artifactUpdates().find((entry) => entry.sessionId === sessionId);
                if (update?.event.type !== 'artifacts.update') {
                    throw new Error(`${sessionId} missed its artifact state (saw ${delivered.map((entry) => `${entry.sessionId}:${entry.event.type}`).join(', ')})`);
                }
                expect(update.event.artifacts.map((artifact) => artifact.name)).toEqual([name]);
            }
        };
        try {
            await resend();
            expectFullState();
            expect(machine).toHaveLength(1);

            delivered.length = 0;
            machine.length = 0;
            await resend();
            expectFullState();
            expect(machine).toHaveLength(1);
        } finally {
            await source.dispose();
            herdr.close();
            rmSync(dir, { recursive: true, force: true });
        }
    }, 30_000);
});
