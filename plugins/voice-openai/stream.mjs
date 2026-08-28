#!/usr/bin/env node
/**
 * OpenAI Realtime speech-to-speech adapter behind the provider-neutral realtime stream.
 *
 * stdin: one `realtime.open` line, then generic realtime client frames.
 * stdout: generic realtime host frames, one JSON per line.
 * All OpenAI auth, model, event and prompt detail lives here; the phone and relay
 * only ever see the generic frame vocabulary.
 */
import WebSocket from 'ws';
import { lstat, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
    cleanProviderProse,
    codingTools,
    isExplicitHangup,
    runCodingTool,
    voiceCoordinationInstructions,
} from './coordinatorPolicy.mjs';

const MODEL = 'gpt-realtime-2.1';
const RATE = 24_000;
const root = process.env.MUXR_HOME?.trim() || join(homedir(), '.muxr');
const keyFile = join(root, 'openai.key');
let endAfterResponse = false;
export const providerTools = codingTools;

const emit = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
// Provider deltas may exceed the public frame bound after tool calls. Base64 is
// independently decodable when split on four-character boundaries.
export function chunkAudio(audio) {
    const chunks = [];
    const chunkSize = 64 * 1024;
    for (let offset = 0; offset < audio.length; offset += chunkSize) chunks.push(audio.slice(offset, offset + chunkSize));
    return chunks;
}
const emitAudio = (audio) => {
    for (const data of chunkAudio(audio)) emit({ type: 'realtime.audio', data });
};
const state = (value, detail) => emit(detail === undefined
    ? { type: 'realtime.state', state: value }
    : { type: 'realtime.state', state: value, detail });

const PROMPT = `You are the voice interface to a herd of coding agents. You are direct and brief. Speak with bright, upbeat energy and brisk enthusiasm; sound alert and helpful, never sultry or sleepy.

<important>
- Answer in one short sentence unless asked to elaborate. The user understands this work better than you do.
${voiceCoordinationInstructions}
- You do not do the work. The coding agent does. You carry instructions to it and report back what it did.
- Assume the user is thinking out loud until they clearly ask for something.
- Let them finish. A pause is thinking, not an invitation to speak: wait through it rather than filling it.
- Never answer a request you only half heard. If the sentence stopped short, wait for the rest.
- This is speech, so it arrives imperfectly: dictation garbles technical words, and people restart sentences, trail off and correct themselves. Work out what they meant and act on that, rather than on the literal words.
- Terms that come through wrong: herdr (heard as "herder"/"header"), pi ("pie"), pane ("pain"), repo, muxr, git, npm, async, auth.
</important>

# Ending
- End the conversation only when the user clearly hangs up: "go to sleep", "stop listening", "goodbye". Say one short goodbye first.
- Do not hang up on ordinary thanks or small talk.`;

async function readKey() {
    let directory;
    let info;
    try { directory = await lstat(root); info = await lstat(keyFile); }
    catch (cause) {
        if (cause?.code === 'ENOENT') throw new Error('No OpenAI key. Configure the provider from muxr Settings.');
        throw cause;
    }
    if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) !== 0 || !info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
        throw new Error('OpenAI key store must be owner-only');
    }
    const value = (await readFile(keyFile, 'utf8')).trim();
    if (!value) throw new Error('No OpenAI key. Configure the provider from muxr Settings.');
    return value;
}

let closing = false;
const close = (reason) => {
    if (closing) return;
    closing = true;
    process.stdout.write(`${JSON.stringify({ type: 'realtime.closed', reason })}\n`, () => process.exit(0));
};

let ws;
let stopped = false;
let providerReady = false;

const text = (value) => String(value ?? '').trim();
export function providerError(error) {
    const raw = typeof error === 'string' ? error : error?.message ?? error?.code ?? 'provider error';
    const detail = cleanProviderProse(raw, 'provider error', 200);
    return { detail, terminal: /api key|auth|credit|quota|billing|permission|forbidden|invalid json|invalid payload|unknown name|unsupported/i.test(detail) };
}
const runTool = (name, input, operationId) => runCodingTool(name, input, operationId);

const pendingToolCalls = new Map();

function handleOpenAiEvent(raw) {
    let message;
    try { message = JSON.parse(raw); } catch { return; }
    switch (message.type) {
        case 'session.updated':
            providerReady = true;
            emit({ type: 'realtime.ready', inputRate: RATE, outputRate: RATE });
            state('connected');
            break;
        case 'input_audio_buffer.speech_started':
            // ponytail: the generic stream has no playback clock; add a playback-progress frame before truncating provider history.
            emit({ type: 'realtime.audio.clear' });
            break;
        case 'response.created':
            state('thinking');
            break;
        case 'response.output_audio.delta':
        case 'response.audio.delta': {
            const audio = typeof message.delta === 'string' ? message.delta : typeof message.audio === 'string' ? message.audio : '';
            if (audio) emitAudio(audio);
            break;
        }
        case 'response.done': {
            const responseId = message.response?.id;
            const calls = typeof responseId === 'string' ? pendingToolCalls.get(responseId) ?? [] : [];
            if (typeof responseId === 'string') pendingToolCalls.delete(responseId);
            if (message.response?.status === 'completed' && calls.length > 0) {
                void (async () => {
                    const outputs = [];
                    for (const call of calls) {
                        let output;
                        try { output = await runTool(call.name, call.args, call.callId); }
                        catch { output = 'Voice coordination could not confirm that request. Please try again.'; }
                        outputs.push({ callId: call.callId, output });
                    }
                    if (stopped || ws?.readyState !== WebSocket.OPEN) return;
                    for (const output of outputs) {
                        ws.send(JSON.stringify({
                            type: 'conversation.item.create',
                            item: { type: 'function_call_output', call_id: output.callId, output: text(output.output).slice(0, 24_000) },
                        }));
                    }
                    ws.send(JSON.stringify({ type: 'response.create' }));
                })();
            } else if (message.response?.status === 'completed' && endAfterResponse) {
                stopped = true;
                ws?.close();
                close('ended');
            } else {
                state('connected');
            }
            break;
        }
        case 'conversation.item.input_audio_transcription.completed':
            if (typeof message.transcript === 'string' && message.transcript.trim() !== '') {
                if (isExplicitHangup(message.transcript)) endAfterResponse = true;
                emit({ type: 'realtime.transcript', role: 'user', text: message.transcript });
            }
            break;
        case 'response.output_audio_transcript.done':
            if (typeof message.transcript === 'string' && message.transcript.trim() !== '') {
                emit({ type: 'realtime.transcript', role: 'agent', text: message.transcript });
            }
            break;
        case 'response.function_call_arguments.done': {
            if (typeof message.response_id !== 'string') break;
            let args = {};
            try { args = JSON.parse(message.arguments || '{}'); } catch { /* interrupted arguments */ }
            const calls = pendingToolCalls.get(message.response_id) ?? [];
            calls.push({ name: message.name, callId: message.call_id, args });
            pendingToolCalls.set(message.response_id, calls);
            break;
        }
        case 'error': {
            const { detail, terminal } = providerError(message.error);
            if (!providerReady || terminal) {
                stopped = true;
                ws?.close();
                close(`Voice provider error: ${detail}`);
            } else {
                state('connected', detail);
            }
            break;
        }
    }
}

function handleClientFrame(frame) {
    if (ws?.readyState !== WebSocket.OPEN) return;
    if (frame.type === 'realtime.audio') {
        ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: frame.data }));
    } else if (frame.type === 'realtime.say') {
        ws.send(JSON.stringify({
            type: 'conversation.item.create',
            item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: frame.text }] },
        }));
        ws.send(JSON.stringify({ type: 'response.create' }));
    } else if (frame.type === 'realtime.control' && frame.action === 'stop') {
        stopped = true;
        ws.close();
        close('ended');
    }
    // mute/unmute are enforced on the phone's capture side; nothing to forward.
}

/**
 * The provider explains a refusal in the HTTP body; the close code does not.
 * An out-of-credits 403 is otherwise indistinguishable from a dropped network,
 * and reporting only the code costs a debugging session to rediscover.
 */
export function providerRefusal(status, body) {
    let detail = '';
    try {
        const parsed = JSON.parse(body);
        if (typeof parsed?.error === 'string') detail = parsed.error;
        else if (typeof parsed?.error?.message === 'string') detail = parsed.error.message;
        else if (typeof parsed?.error?.status === 'string') detail = parsed.error.status;
        else if (typeof parsed?.code === 'string') detail = parsed.code;
    } catch { /* not JSON: fall back to the raw body */ }
    if (detail === '') detail = body.trim();
    const safe = cleanProviderProse(detail, '', 300);
    return safe === ''
        ? `Voice provider refused the connection (HTTP ${status}).`
        : `Voice provider refused the connection (HTTP ${status}): ${safe}`;
}

function connectProvider(key) {
    if (stopped) return;
    state('connecting');
    const current = new WebSocket(`wss://api.openai.com/v1/realtime?model=${MODEL}`, {
        headers: { Authorization: `Bearer ${key}` },
        maxPayload: 4 * 1024 * 1024,
    });
    ws = current;
    const onDown = (reason) => {
        if (stopped || ws !== current) return;
        stopped = true;
        close(reason);
    };
    current.on('open', () => {
        if (stopped || ws !== current) return;
        current.send(JSON.stringify({
            type: 'session.update',
            session: {
                type: 'realtime',
                model: MODEL,
                instructions: PROMPT,
                output_modalities: ['audio'],
                audio: {
                    input: {
                        format: { type: 'audio/pcm', rate: RATE },
                        transcription: { model: 'gpt-4o-mini-transcribe' },
                        turn_detection: {
                            type: 'server_vad',
                            threshold: 0.9,
                            silence_duration_ms: 700,
                            prefix_padding_ms: 300,
                            create_response: true,
                            interrupt_response: true,
                        },
                    },
                    output: { format: { type: 'audio/pcm' }, voice: 'marin' },
                },
                tools: providerTools,
            },
        }));
    });
    current.on('message', (data) => { if (ws === current) handleOpenAiEvent(String(data)); });
    // ws suppresses 'error' and 'close' once this is handled, so the failure
    // path is driven from here. Auth and permission refusals are terminal:
    // retrying an out-of-credits account only delays the real message.
    current.on('unexpected-response', (_request, response) => {
        let body = '';
        response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => {
            current.terminate();
            if (stopped || ws !== current) return;
            const reason = providerRefusal(response.statusCode, body);
            if (response.statusCode === 401 || response.statusCode === 403) close(reason);
            else onDown(reason);
        });
    });
    current.on('close', (code, reasonBuffer) => {
        const reason = cleanProviderProse(String(reasonBuffer), '', 160);
        const detail = `OpenAI session ended (${code})${reason ? `: ${reason}` : '.'}`;
        if (providerError(reason).terminal) {
            stopped = true;
            close(detail);
        } else {
            onDown(detail);
        }
    });
    current.on('error', (error) => {
        if (!stopped && ws === current) state('connecting', `Voice provider connection interrupted: ${cleanProviderProse(error.message, 'connection error', 160)}`);
    });
}

async function main() {
    const rl = createInterface({ input: process.stdin });
    const first = await new Promise((resolve) => rl.once('line', resolve));
    let open;
    try { open = JSON.parse(first); } catch { throw new Error('realtime stream missing open frame'); }
    if (open?.type !== 'realtime.open') throw new Error('realtime stream expected realtime.open first');
    rl.on('line', (line) => {
        if (line.trim() === '') return;
        try { handleClientFrame(JSON.parse(line)); } catch { /* malformed input line: ignore */ }
    });

    const key = await readKey();
    connectProvider(key);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    main().catch((error) => close(cleanProviderProse(error instanceof Error ? error.message : error, 'Voice session could not start.', 300)));
}
