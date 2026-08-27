import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { PluginStreamManager } from './pluginStreamManager.js';

/**
 * Realtime voice regression: a provider reply bursts multi-megabyte audio far
 * faster than a phone's downlink drains it. Every frame must still arrive,
 * exactly once and in order — dropped frames are audible mid-sentence cutoffs.
 */

const FRAME_COUNT = 120;
const FRAME_BYTES = 48 * 1024;

const root = mkdtempSync(join(tmpdir(), 'muxr-stream-test-'));
writeFileSync(join(root, 'plugin.mjs'), `
const frames = ${FRAME_COUNT};
process.stdin.once('data', () => {
    let out = '';
    for (let i = 0; i < frames; i++) {
        const chunk = Buffer.alloc(${FRAME_BYTES}, i % 251);
        out += JSON.stringify({ type: 'realtime.audio', data: chunk.toString('base64') }) + '\\n';
    }
    process.stdout.write(out, () => {
        process.stdout.write(JSON.stringify({ type: 'realtime.closed', reason: 'burst done' }) + '\\n');
    });
});
`);

afterAll(() => rmSync(root, { recursive: true, force: true }));

it('delivers a bursty provider reply completely and in order through a slow relay socket', async () => {
    const received: string[] = [];
    let closedReason: string | undefined;
    let done: () => void;
    const finished = new Promise<void>((resolve) => { done = resolve; });

    const server = new WebSocketServer({ port: 0 });
    server.on('connection', (socket: WebSocket) => {
        // A phone on a weak downlink: stop reading for a while so the host's
        // socket backpressure builds past the old 512 KiB drop threshold.
        socket.pause();
        setTimeout(() => socket.resume(), 500);
        socket.on('message', (data) => {
            const frame = JSON.parse(String(data)) as { type: string; data?: string; reason?: string };
            if (frame.type === 'realtime.audio') received.push(frame.data ?? '');
            if (frame.type === 'realtime.closed') {
                closedReason = frame.reason;
                done();
            }
        });
    });
    await new Promise<void>((resolve) => server.on('listening', resolve));
    const { port } = server.address() as { port: number };

    const manager = new PluginStreamManager({
        relayUrl: `ws://127.0.0.1:${port}`,
        machineId: 'machine-test',
    });
    await manager.attach({
        target: { pluginId: 'voice-test', pluginRoot: root, entry: 'plugin.mjs' },
        channel: 'rs_burst_test',
        stateDir: join(root, 'state'),
        signal: new AbortController().signal,
        onClosed: () => undefined,
    });

    await Promise.race([
        finished,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out with ${received.length}/${FRAME_COUNT} frames`)), 15_000)),
    ]);
    manager.closeAll();
    server.close();

    expect(closedReason).toBe('burst done');
    expect(received).toHaveLength(FRAME_COUNT);
    const sequence = received.map((data) => Buffer.from(data, 'base64')[0]);
    expect(sequence).toEqual([...Array(FRAME_COUNT).keys()].map((i) => i % 251));
}, 30_000);
