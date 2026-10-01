import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { describe, expect, it } from 'vitest';
import { REALTIME_PLANNING_DETAIL } from '@trymuxr/contract';
import { RealtimeCodingCoordinator } from '../agent/infrastructure/realtimeCoordinator.ts';

const streamEntry = fileURLToPath(new URL('./stream.mjs', import.meta.url));

const waitFor = async (predicate, message, timeoutMs = 8_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const value = predicate();
        if (value) return value;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(message);
};

const listen = async (server) => {
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); server.listen(0, '127.0.0.1'); });
    return server.address().port;
};

/** A muxr home with a selected engine, and the real host coordinator over a scripted herd. */
async function voiceLab(providerId) {
    const root = await mkdtemp(join(tmpdir(), 'muxr-voice-stream-'));
    await mkdir(join(root, 'voice'), { recursive: true, mode: 0o700 });
    await writeFile(join(root, 'voice', 'provider'), `${providerId}\n`);
    const john = { sessionId: 'pp_summary_private', cwd: root, agentName: 'John', taskTitle: 'Repair voice', agentKind: 'codex', agentStatus: 'idle', promptable: true };
    const jane = { ...john, sessionId: 'pp_review_private', agentName: 'Jane', taskTitle: 'Review attachment polish', agentStatus: 'working' };
    const prompts = [];
    const refuse = async () => { throw new Error('No other mutation is authorized in this flow'); };
    const coordinator = new RealtimeCodingCoordinator(join(root, 'coding.sock'), {
        list: async () => ({ agents: [john, jane], freshness: 'fresh' }), kinds: async () => ['codex'], activity: async () => [],
        read: async () => ({ text: 'Implemented reconnect recovery.', truncated: false }), status: async () => 'idle',
        prompt: async (sessionId, text) => { prompts.push({ sessionId, text }); },
        start: refuse, sendKeys: refuse, watch: refuse, focus: refuse,
    });
    await coordinator.start();
    const access = coordinator.issueCapability({ provider: 'muxr.voice', sessionId: john.sessionId, cwd: root });
    const open = { type: 'realtime.open', sessionId: john.sessionId, publicContext: { sessions: [john, jane].map(({ sessionId, agentName, taskTitle, agentKind, agentStatus }) => ({ sessionId, agentName, taskTitle, agentKind, agentStatus })) } };
    const start = (env) => {
        const child = spawn(process.execPath, [streamEntry], {
            env: { PATH: process.env.PATH, HOME: root, MUXR_HOME: root, NODE_ENV: 'test',
                MUXR_VOICE_COORDINATOR_SOCKET: access.socketPath, MUXR_VOICE_COORDINATOR_CAPABILITY: access.capability, ...env },
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        const frames = [];
        const errors = [];
        createInterface({ input: child.stdout }).on('line', (line) => frames.push(JSON.parse(line)));
        createInterface({ input: child.stderr }).on('line', (line) => errors.push(line));
        return { child, frames, errors, send: (frame) => child.stdin.write(`${JSON.stringify(frame)}\n`) };
    };
    return { root, open, prompts, start, close: async () => { await coordinator.close(); await rm(root, { recursive: true, force: true }); } };
}

describe('voice stream on @byokit/realtime', () => {
    it('keeps the Codex sign-in on the host, prompts a named agent directly, plans the rest and ends on goodbye', async () => {
        const lab = await voiceLab('codex');
        const signaling = [];
        const planning = [];
        const [call, answer] = await Promise.all(['delegation-call', 'delegation-answer'].map((name) => readFile(new URL(`./fixtures/${name}.sse`, import.meta.url), 'utf8')));
        const server = createServer((request, response) => {
            let body = '';
            request.on('data', (chunk) => { body += chunk; });
            request.on('end', () => {
                const parsed = JSON.parse(body);
                if (request.url === '/codex/responses') {
                    planning.push(parsed);
                    response.writeHead(200, { 'content-type': 'text/event-stream' });
                    response.end(parsed.input.some((item) => item.type === 'function_call_output') ? answer : call);
                    return;
                }
                signaling.push({ headers: request.headers, body: parsed });
                response.writeHead(201, { 'content-type': 'application/sdp' });
                response.end('v=0\r\na=answer');
            });
        });
        const port = await listen(server);
        const account = 'acct-test';
        const token = `e30.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, 'https://api.openai.com/auth': { chatgpt_account_id: account } })).toString('base64url')}.test-signature`;
        const codexHome = join(lab.root, 'codex');
        await mkdir(codexHome, { mode: 0o700 });
        await writeFile(join(codexHome, 'auth.json'), JSON.stringify({ tokens: { access_token: token, account_id: account } }), { mode: 0o600 });
        const env = {
            CODEX_HOME: codexHome, MUXR_TEST_CODEX_BIN: join(lab.root, 'unused-codex'),
            MUXR_TEST_REALTIME_URL: `http://127.0.0.1:${port}/signal`,
            MUXR_TEST_CODEX_RESPONSES_URL: `http://127.0.0.1:${port}/codex/responses`,
        };
        const voice = lab.start(env);
        const channel = (type) => voice.frames.filter((frame) => frame.type === 'realtime.webrtc.data').map((frame) => JSON.parse(frame.data)).filter((event) => event.type === type);
        const appended = (id) => channel('delegation.context.append').find((event) => event.delegation_item_id === id);
        const delegate = (id, text) => voice.send({ type: 'realtime.webrtc.data', data: JSON.stringify({ type: 'delegation.created', item: { type: 'delegation', target: 'client', id, content: [{ type: 'input_text', text }] } }) });
        const planningCues = () => voice.frames.filter((frame) => frame.type === 'realtime.state' && frame.detail === REALTIME_PLANNING_DETAIL).length;
        const turn = (role, transcript) => voice.send({ type: 'realtime.webrtc.data', data: JSON.stringify({ type: 'turn.done', turn: { role, transcript } }) });
        try {
            voice.send(lab.open);
            await waitFor(() => voice.frames.some((frame) => frame.type === 'realtime.webrtc.start'), `Codex Voice did not start: ${voice.errors.join('\n')}`);
            voice.send({ type: 'realtime.webrtc.offer', sdp: 'v=0\r\na=offer' });
            await waitFor(() => voice.frames.some((frame) => frame.type === 'realtime.webrtc.answer'), 'Codex Voice did not answer the offer');
            expect(signaling).toHaveLength(1);
            expect(signaling[0].headers.authorization).toBe(`Bearer ${token}`);
            expect(signaling[0].headers['chatgpt-account-id']).toBe(account);
            expect(signaling[0].body.session.delegation.ack_filler).toBe(false);
            expect(signaling[0].body.session.instructions).toContain('Review attachment polish');

            // "Ask <agent in the roster> to …" is forwarded verbatim without a planning turn.
            delegate('direct-prompt', 'Ask Jane to rebase onto main.');
            await waitFor(() => appended('direct-prompt'), 'direct prompt did not return');
            expect(appended('direct-prompt').content[0].text).toBe('Queued: instruction for Jane.');
            expect(lab.prompts).toEqual([{ sessionId: 'pp_review_private', text: 'rebase onto main.\n\ncame from a real-time agent' }]);
            expect(planning).toHaveLength(0);

            // A structured request runs its catalogued tool without planning.
            delegate('structured', JSON.stringify({ name: 'prompt_agent', arguments: { agent: 'John', text: 'Check the logs.' } }));
            await waitFor(() => appended('structured'), 'structured request did not return');
            expect(lab.prompts.at(-1)).toEqual({ sessionId: 'pp_summary_private', text: 'Check the logs.\n\ncame from a real-time agent' });
            expect(planning).toHaveLength(0);
            // Quick requests get no "working on it" tone.
            expect(planningCues()).toBe(0);

            // A further step keeps the planner.
            delegate('planned-steps', 'Ask Jane to rebase onto main, then tell me when it is done.');
            await waitFor(() => appended('planned-steps'), 'planned request did not return');
            expect(planning.length).toBeGreaterThan(0);
            expect(planning[0].parallel_tool_calls).toBe(false);
            // A planner request tells the phone to play its tone, once.
            expect(planningCues()).toBe(1);
            expect(lab.prompts.at(-1)).toEqual({ sessionId: 'pp_review_private', text: 'Explain the review delay.\n\ncame from a real-time agent' });

            // The agent-stop report reaches the provider as speakable context.
            voice.send({ type: 'realtime.say', text: 'Jane finished Review attachment polish.' });
            await waitFor(() => channel('session.context.append').length === 1, 'report was not handed to the provider');

            // Internal ids never reach the phone, and neither does the sign-in.
            turn('assistant', 'Session pp_4f9a2c in w1:t2 is done.');
            await waitFor(() => voice.frames.some((frame) => frame.type === 'realtime.transcript'), 'transcript was not forwarded');
            const spoken = voice.frames.find((frame) => frame.type === 'realtime.transcript').text;
            expect(spoken).not.toContain('pp_4f9a2c');
            expect(spoken).not.toContain('w1:t2');
            expect(JSON.stringify(voice.frames)).not.toContain(token);
            expect(JSON.stringify(voice.frames)).not.toContain(account);

            turn('user', 'Okay, goodbye.');
            turn('assistant', 'Bye.');
            await waitFor(() => voice.frames.at(-1)?.type === 'realtime.closed', 'goodbye did not end the call');
            expect(voice.frames.at(-1)).toEqual({ type: 'realtime.closed', reason: 'ended' });
            await waitFor(() => voice.child.exitCode !== null, 'voice child did not exit');

            // A sign-in others can read is refused before anything leaves the host, with its remedy.
            await chmod(join(codexHome, 'auth.json'), 0o644);
            const exposed = lab.start(env);
            exposed.send(lab.open);
            await waitFor(() => exposed.frames.some((frame) => frame.type === 'realtime.closed'), 'exposed sign-in was not refused');
            // Phone media starts while the kit resolves access; only the refusal follows it.
            expect(exposed.frames).toEqual([
                { type: 'realtime.webrtc.start', dataChannelLabel: 'oai-events' },
                { type: 'realtime.closed', reason: 'Codex credential file must be owner-only in a non-writable store.' },
            ]);
            expect(signaling).toHaveLength(1);
        } finally {
            voice.child.kill('SIGKILL');
            server.close();
            await lab.close();
        }
    }, 30_000);

    it('runs an API-key engine with the key on the host and Herdr tools through the coordinator', async () => {
        const lab = await voiceLab('openai');
        await writeFile(join(lab.root, 'openai.key'), 'sk-test-secret-key-000000\n', { mode: 0o600 });
        const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
        await new Promise((resolve) => wss.once('listening', resolve));
        const provider = { authorization: undefined, received: [], socket: undefined };
        wss.on('connection', (socket, request) => {
            provider.authorization = request.headers.authorization;
            provider.socket = socket;
            socket.on('message', (raw) => provider.received.push(JSON.parse(String(raw))));
        });
        const voice = lab.start({ MUXR_TEST_REALTIME_URL: `ws://127.0.0.1:${wss.address().port}` });
        const toProvider = (event) => provider.socket.send(JSON.stringify(event));
        try {
            voice.send(lab.open);
            await waitFor(() => provider.received.some((event) => event.type === 'session.update'), `engine did not configure the session: ${voice.errors.join('\n')}`);
            expect(provider.authorization).toBe('Bearer sk-test-secret-key-000000');
            const session = provider.received.find((event) => event.type === 'session.update').session;
            expect(session.instructions).toContain('Review attachment polish');
            expect(session.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['prompt_agent', 'read_work_context', 'navigate_app']));
            toProvider({ type: 'session.updated' });
            await waitFor(() => voice.frames.some((frame) => frame.type === 'realtime.ready'), 'engine was not ready');

            toProvider({ type: 'response.created', response: { id: 'r1' } });
            toProvider({ type: 'response.function_call_arguments.done', response_id: 'r1', call_id: 'c1', name: 'prompt_agent', arguments: JSON.stringify({ agent: 'Jane', text: 'Rebase onto main.' }) });
            toProvider({ type: 'response.done', response: { id: 'r1', status: 'completed', usage: { input_tokens: 12, output_tokens: 3 } } });
            const output = await waitFor(() => provider.received.find((event) => event.item?.type === 'function_call_output'), 'tool result did not reach the provider');
            expect(output.item).toMatchObject({ call_id: 'c1', output: 'Queued: instruction for Jane.' });
            expect(lab.prompts).toEqual([{ sessionId: 'pp_review_private', text: 'Rebase onto main.\n\ncame from a real-time agent' }]);

            toProvider({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'Stop listening.' });
            toProvider({ type: 'response.created', response: { id: 'r2' } });
            toProvider({ type: 'response.output_audio_transcript.done', response_id: 'r2', transcript: 'Goodbye.' });
            // The goodbye plays out before the call ends.
            await waitFor(() => voice.frames.some((frame) => frame.type === 'realtime.transcript' && frame.text === 'Goodbye.'), 'goodbye was not forwarded');
            await new Promise((resolve) => setTimeout(resolve, 200));
            expect(voice.frames.some((frame) => frame.type === 'realtime.closed')).toBe(false);
            voice.send({ type: 'realtime.control', action: 'output_drained' });
            await waitFor(() => voice.frames.at(-1)?.type === 'realtime.closed', 'hangup did not end the call');
            expect(voice.frames.at(-1)).toEqual({ type: 'realtime.closed', reason: 'ended' });
            // Phones on the previous contract reject usage frames.
            expect(voice.frames.some((frame) => frame.type === 'realtime.usage')).toBe(false);
            expect(JSON.stringify(voice.frames)).not.toContain('sk-test-secret-key');
        } finally {
            voice.child.kill('SIGKILL');
            wss.close();
            await lab.close();
        }
    }, 30_000);
});
