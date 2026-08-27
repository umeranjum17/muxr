import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { describe, expect, it } from 'vitest';
import { providerError, providerRefusal } from './stream.mjs';

const waitFor = async (predicate, message, timeoutMs = 4_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const value = predicate();
        if (value) return value;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(message);
};

/**
 * A close code alone sent someone hunting a version mismatch for an account
 * that had simply run out of credits. The body is the only place that says so.
 */
describe('providerRefusal', () => {
    it('surfaces the provider explanation the close code loses', () => {
        const body = JSON.stringify({
            code: 'The caller does not have permission to execute the specified operation',
            error: 'Your team has either used all available credits or reached its monthly spending limit.',
        });
        expect(providerRefusal(403, body)).toBe(
            'Voice provider refused the connection (HTTP 403): Your team has either used all available credits or reached its monthly spending limit.',
        );
    });

    it('falls back to code when there is no error field', () => {
        expect(providerRefusal(403, JSON.stringify({ code: 'forbidden' })))
            .toBe('Voice provider refused the connection (HTTP 403): forbidden');
    });

    it('falls back to the raw body when it is not JSON', () => {
        expect(providerRefusal(502, '  upstream boom  '))
            .toBe('Voice provider refused the connection (HTTP 502): upstream boom');
    });

    it('still names the status when the body is empty', () => {
        expect(providerRefusal(429, '')).toBe('Voice provider refused the connection (HTTP 429).');
    });

    it('does not retry a provider billing event after the socket opens', () => {
        expect(providerError({ message: 'You have no credits remaining. Add credits to continue.' })).toEqual({
            detail: 'You have no credits remaining. Add credits to continue.',
            terminal: true,
        });
        expect(providerError('API key not valid. Please pass a valid API key.').terminal).toBe(true);
    });

    it('keeps reconnect and bounded mic admission live until a preserved playback tail drains', async () => {
        const muxrHome = await mkdtemp(join(tmpdir(), 'muxr-voice-provider-'));
        await writeFile(join(muxrHome, 'xai.key'), 'test-only-key\n', { mode: 0o600 });
        const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
        await new Promise((resolve, reject) => {
            server.once('listening', resolve);
            server.once('error', reject);
        });
        const address = server.address();
        if (address === null || typeof address === 'string') throw new Error('provider fixture did not bind a TCP port');

        const connections = [];
        server.on('connection', (socket) => {
            const connection = { socket, frames: [] };
            connections.push(connection);
            socket.on('message', (data) => connection.frames.push(JSON.parse(String(data))));
        });

        const child = spawn(process.execPath, [fileURLToPath(new URL('./stream.mjs', import.meta.url))], {
            cwd: fileURLToPath(new URL('../..', import.meta.url)),
            env: {
                ...process.env,
                NODE_ENV: 'test',
                MUXR_HOME: muxrHome,
                MUXR_TEST_XAI_REALTIME_URL: `ws://127.0.0.1:${address.port}`,
            },
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        const frames = [];
        const stderr = [];
        createInterface({ input: child.stdout }).on('line', (line) => frames.push(JSON.parse(line)));
        createInterface({ input: child.stderr }).on('line', (line) => stderr.push(line));
        const sendClient = (frame) => child.stdin.write(`${JSON.stringify(frame)}\n`);
        const sendProvider = (connection, frame) => connection.socket.send(JSON.stringify(frame));

        try {
            sendClient({ type: 'realtime.open', paneId: 'voice-test' });
            const first = await waitFor(() => connections[0], 'initial provider connection was not opened');
            await waitFor(() => first.frames.some((frame) => frame.type === 'session.update'), 'initial provider session was not configured');
            await waitFor(() => frames.some((frame) => frame.type === 'realtime.ready'), 'initial ready frame was not emitted');

            sendProvider(first, { type: 'response.created' });
            sendProvider(first, { type: 'response.output_audio.delta', delta: Buffer.alloc(4_800, 1).toString('base64') });
            sendProvider(first, { type: 'response.done' });
            await waitFor(() => frames.filter((frame) => frame.type === 'realtime.audio').length === 1, 'completed audio was not emitted');

            sendProvider(first, { type: 'response.created' });
            sendProvider(first, { type: 'response.output_audio.delta', delta: Buffer.alloc(4_800, 2).toString('base64') });
            await waitFor(() => frames.filter((frame) => frame.type === 'realtime.audio').length === 2, 'active tail audio was not emitted');
            first.socket.close(1011, 'transient provider drop');
            sendClient({ type: 'realtime.audio', data: Buffer.alloc(960, 3).toString('base64') });

            const replacement = await waitFor(() => connections[1], 'provider reconnect waited for playback drain', 2_000);
            await waitFor(() => replacement.frames.some((frame) => frame.type === 'session.update'), 'replacement provider session was not configured');
            await waitFor(
                () => replacement.frames.some((frame) => frame.type === 'input_audio_buffer.append'),
                'queued microphone audio did not flush to the replacement provider',
            );
            expect(frames.filter((frame) => frame.type === 'realtime.ready')).toHaveLength(1);
            expect(frames.some((frame) => frame.type === 'realtime.audio.clear')).toBe(false);

            replacement.socket.close(1011, 'second transient provider drop');
            const finalProvider = await waitFor(() => connections[2], 'second provider retry waited for playback drain', 2_500);
            await waitFor(() => finalProvider.frames.some((frame) => frame.type === 'session.update'), 'final provider session was not configured');
            finalProvider.socket.close(1011, 'retry budget exhausted');
            for (let index = 0; index < 101; index += 1) {
                sendClient({ type: 'realtime.audio', data: Buffer.alloc(960, index).toString('base64') });
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
            expect(child.exitCode).toBeNull();
            expect(frames.some((frame) => frame.type === 'realtime.closed')).toBe(false);
            expect(frames.some((frame) => frame.type === 'realtime.audio.clear')).toBe(false);

            const boundary = frames.length;
            sendClient({ type: 'realtime.control', action: 'output_drained' });
            await waitFor(() => frames.slice(boundary).some((frame) => frame.type === 'realtime.closed'), 'bounded overflow close did not follow playback drain');
            const clearIndex = frames.findIndex((frame, index) => index >= boundary && frame.type === 'realtime.audio.clear');
            const closedIndex = frames.findIndex((frame, index) => index >= boundary && frame.type === 'realtime.closed');
            expect(clearIndex).toBeGreaterThanOrEqual(boundary);
            expect(closedIndex).toBeGreaterThan(clearIndex);

            const exit = await waitFor(
                () => child.exitCode !== null ? { code: child.exitCode } : undefined,
                `provider adapter did not exit cleanly: ${stderr.join('\n')}`,
            );
            expect(exit.code).toBe(0);
        } finally {
            if (child.exitCode === null) child.kill('SIGKILL');
            for (const connection of connections) connection.socket.terminate();
            await new Promise((resolve) => server.close(resolve));
            await rm(muxrHome, { recursive: true, force: true });
        }
    }, 10_000);
});
