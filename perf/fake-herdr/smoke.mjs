/**
 * Flow-level smoke: start the fake, talk like the host, prove snapshot/churn/
 * unknown-method/close. No framework.
 */
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeHerdr } from './server.mjs';

function fail(message) {
    throw new Error(message);
}

function call(socketPath, method, params = {}, timeoutMs = 2000) {
    const id = `pph_${Math.random().toString(16).slice(2)}`;
    return new Promise((resolve, reject) => {
        const socket = connect(socketPath);
        let buffer = '';
        const timer = setTimeout(() => {
            socket.destroy();
            reject(new Error(`${method} timed out`));
        }, timeoutMs);
        const settle = (error, value) => {
            clearTimeout(timer);
            socket.destroy();
            if (error !== undefined) reject(error);
            else resolve(value);
        };
        socket.once('error', (error) => settle(error));
        socket.on('connect', () => socket.write(`${JSON.stringify({ id, method, params })}\n`));
        socket.on('data', (chunk) => {
            buffer += chunk.toString('utf8');
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) {
                if (line.trim().length === 0) continue;
                let message;
                try { message = JSON.parse(line); } catch { continue; }
                if (message.id !== id) continue;
                settle(undefined, message);
                return;
            }
        });
        socket.once('close', () => settle(new Error(`${method}: connection closed without a response`)));
    });
}

function collectTitleFrames(socketPath, needed, timeoutMs) {
    return new Promise((resolve, reject) => {
        const socket = connect(socketPath);
        const frames = [];
        let buffer = '';
        const timer = setTimeout(() => {
            socket.destroy();
            reject(new Error(`events.subscribe delivered ${frames.length} pane.updated frames, need ${needed}`));
        }, timeoutMs);
        socket.on('connect', () => {
            socket.write(`${JSON.stringify({
                id: 'pph_sub',
                method: 'events.subscribe',
                params: { subscriptions: [{ type: 'pane.updated' }] },
            })}\n`);
        });
        socket.on('data', (chunk) => {
            buffer += chunk.toString('utf8');
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) {
                if (line.trim().length === 0) continue;
                let message;
                try { message = JSON.parse(line); } catch { continue; }
                if (typeof message.id === 'string') continue;
                const type = typeof message.event === 'string' ? message.event : message.data?.type;
                if (type !== 'pane.updated') continue;
                const title = message.data?.pane?.terminal_title ?? message.data?.terminal_title;
                if (typeof title === 'string') frames.push(title);
                if (frames.length >= needed) {
                    clearTimeout(timer);
                    socket.destroy();
                    resolve(frames);
                    return;
                }
            }
        });
        socket.on('error', (error) => {
            clearTimeout(timer);
            reject(error);
        });
    });
}

const dir = await mkdtemp(join(tmpdir(), 'fake-herdr-smoke-'));
const handle = await startFakeHerdr({ dir, panes: 8, agents: 4, titleChurnHz: 4, graphicsFrameHz: 0 });
try {
    const snapshotReply = await call(handle.socketPath, 'session.snapshot');
    const snapshot = snapshotReply.result?.snapshot;
    if (snapshotReply.error != null) fail(`session.snapshot error: ${snapshotReply.error.message}`);
    if ((snapshot?.panes ?? []).length !== 8) fail(`expected 8 panes, got ${snapshot?.panes?.length}`);
    if ((snapshot?.agents ?? []).length !== 4) fail(`expected 4 agents, got ${snapshot?.agents?.length}`);
    if ((snapshot?.workspaces ?? []).length !== 1 || snapshot.workspaces[0].workspace_id !== 'w1') {
        fail('expected workspace w1');
    }
    for (const pane of snapshot.panes) {
        if (!/^w1:p\d+$/.test(pane.pane_id) || !/^w1:t\d+$/.test(pane.tab_id)) {
            fail(`unexpected pane ids ${pane.pane_id} ${pane.tab_id}`);
        }
    }
    for (const agent of snapshot.agents) {
        const session = agent.agent_session;
        if (session?.source === undefined || session.agent === undefined || session.kind !== 'id' || !session.value) {
            fail(`agent ${agent.pane_id} missing parseable agent_session`);
        }
        if (typeof agent.name !== 'string' || agent.name.length === 0 || /^pph?_/i.test(agent.name)) {
            fail(`agent ${agent.pane_id} has unlistable name ${agent.name}`);
        }
    }
    if (handle.world.panes.length !== 8 || handle.world.agents.length !== 4) {
        fail('handle.world does not match the requested herd');
    }

    const titles = await collectTitleFrames(handle.socketPath, 2, 3000);
    if (titles.length < 2) fail('title churn did not deliver two pane.updated frames');

    const unknown = await call(handle.socketPath, 'no.such.method');
    if (unknown.error == null) fail('unknown method returned success');

    await handle.close();
    await handle.close();
    if (existsSync(handle.socketPath)) fail(`socket still exists: ${handle.socketPath}`);
    if (existsSync(handle.clientSocketPath)) fail(`client socket still exists: ${handle.clientSocketPath}`);
    process.stdout.write('fake-herdr smoke ok\n');
} catch (error) {
    await handle.close().catch(() => {});
    throw error;
} finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
}
