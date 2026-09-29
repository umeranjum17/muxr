/**
 * No-open-handles regression proof for Herdr session source teardown.
 *
 * Starts a minimal fake Herdr, creates a real session source against it,
 * arms a watch (the hang: one guard timer per session, up to an hour out),
 * then closes the source and RETURNS. Natural process exit is the
 * assertion -- a leftover socket, subscription or timer keeps node alive
 * and the caller (the vitest flow) kills us on timeout.
 *
 * Fails closed: any error prints to stderr and exits 1.
 *
 * Run only after `tsc --build` (the suite typechecks first): this imports
 * the compiled source from apps/host/dist.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const distSessionSource = pathToFileURL(
    join(here, '..', '..', '..', 'apps', 'host', 'dist', 'agent', 'infrastructure', 'herdrSessionSource.js'),
).href;

function startFakeHerdr(dir, cwd) {
    const workspaces = [{ workspace_id: 'w1', label: cwd }];
    const tabs = [];
    const panes = [];
    const agents = [];
    const subscribers = new Set();
    const openSockets = new Set();
    let next = 1;
    const server = createServer((socket) => {
        openSockets.add(socket);
        let buffer = '';
        socket.on('data', (chunk) => {
            buffer += chunk.toString('utf8');
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) {
                if (line.trim() === '') continue;
                const { id, method, params } = JSON.parse(line);
                if (method === 'events.subscribe') {
                    subscribers.add(socket);
                    socket.write(`${JSON.stringify({ id, result: {} })}\n`);
                    continue;
                }
                const p = params ?? {};
                let reply;
                switch (method) {
                    case 'ping':
                        reply = { id, result: { protocol: 22 } };
                        break;
                    case 'session.snapshot':
                        reply = { id, result: { snapshot: { workspaces, tabs, panes, agents } } };
                        break;
                    case 'plugin.list':
                        reply = { id, result: { plugins: [] } };
                        break;
                    case 'workspace.list':
                        reply = { id, result: { workspaces } };
                        break;
                    case 'pane.get':
                        reply = { id, result: { pane: panes.find((pane) => pane.pane_id === p.pane_id) } };
                        break;
                    case 'tab.create': {
                        const tabId = `t${next}`;
                        const paneId = `w1:p${next++}`;
                        tabs.push({ tab_id: tabId, workspace_id: 'w1', label: p.label ?? cwd, env: p.env });
                        panes.push({ pane_id: paneId, tab_id: tabId, workspace_id: 'w1', cwd });
                        reply = { id, result: { tab: { tab_id: tabId }, root_pane: { pane_id: paneId } } };
                        break;
                    }
                    case 'agent.start': {
                        const agent = { pane_id: p.pane_id, name: p.name, agent_status: 'idle' };
                        agents.push(agent);
                        reply = { id, result: { agent } };
                        break;
                    }
                    // Hold agent.wait open: the regression is about teardown
                    // with a watch in flight, so the reply must not arrive.
                    case 'agent.wait':
                        continue;
                    default:
                        reply = { id, error: { code: 'method_not_found', message: method } };
                        break;
                }
                socket.end(`${JSON.stringify(reply)}\n`);
            }
        });
        socket.on('error', () => {});
        socket.on('close', () => { subscribers.delete(socket); openSockets.delete(socket); });
    });
    const socketPath = join(dir, 'herdr.sock');
    return new Promise((resolve, reject) => {
        server.on('error', reject);
        server.listen(socketPath, () => resolve({
            socketPath,
            close: () => new Promise((done) => {
                for (const socket of subscribers) socket.destroy();
                subscribers.clear();
                for (const socket of openSockets) socket.destroy();
                openSockets.clear();
                server.close(() => done());
            }),
        }));
    });
}

try {
    const dir = mkdtempSync(join(tmpdir(), 'muxr-source-close-'));
    const cwd = join(dir, 'repo');
    const herdr = await startFakeHerdr(dir, cwd);
    const { createHerdrSessionSource } = await import(distSessionSource);
    const source = await createHerdrSessionSource({
        socketPath: herdr.socketPath,
        dataDir: join(dir, 'data'),
        artifactsDir: join(dir, 'attachments'),
        hostHttpPort: 0,
    });
    try {
        const started = await source.start({ cwd, kind: 'claude' });
        if (!('info' in started)) throw new Error('launch rejected');
        await source.agentWatch({ sessionId: started.info.id, timeoutMs: 60_000 });
        // Let the watch call reach the fake so the guard and the socket are
        // both live when teardown runs.
        await new Promise((resolve) => setTimeout(resolve, 500));
        await source.close();
    } finally {
        await source.dispose();
    }
    await herdr.close();
    rmSync(dir, { recursive: true, force: true });
    process.stdout.write('herdr-source-close: ok\n');
} catch (cause) {
    process.stderr.write(`herdr-source-close: FAIL ${cause instanceof Error ? cause.stack ?? cause.message : String(cause)}\n`);
    process.exit(1);
}
// No process.exit(0): falling off the end proves no handle is left open.
