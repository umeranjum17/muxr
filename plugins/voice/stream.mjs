#!/usr/bin/env node
/**
 * xAI Grok speech-to-speech adapter behind the provider-neutral realtime stream.
 *
 * stdin: one `realtime.open` line, then generic realtime client frames.
 * stdout: generic realtime host frames, one JSON per line.
 * All xAI auth, model, event and prompt detail lives here; the phone and relay
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

const MODEL = 'grok-voice-think-fast-2.0';
const RATE = 24_000;
const PROVIDER_URL = process.env.NODE_ENV === 'test' && process.env.MUXR_TEST_XAI_REALTIME_URL
    ? process.env.MUXR_TEST_XAI_REALTIME_URL
    : `wss://api.x.ai/v1/realtime?model=${MODEL}`;
const root = process.env.MUXR_HOME?.trim() || join(homedir(), '.muxr');
const keyFile = join(root, 'xai.key');
let endAfterResponse = false;
export const providerTools = codingTools;

const MAX_STDOUT_BYTES = 256 * 1024;
const MAX_REFUSAL_BODY_BYTES = 16 * 1024;
const stdoutQueue = [];
let stdoutBytes = 0;
let stdoutBlocked = false;
let stdoutOverflowed = false;
function syncProviderReadState() {
    if (ws?.readyState !== WebSocket.OPEN) return;
    if (stdoutBlocked || stdoutQueue.length > 0 || outputPausedByClient) ws.pause();
    else ws.resume();
}
const flushStdout = () => {
    while (!stdoutBlocked && stdoutQueue.length > 0) {
        const item = stdoutQueue.shift();
        stdoutBytes -= item.line.length;
        stdoutBlocked = !process.stdout.write(item.line, item.done);
    }
    syncProviderReadState();
};
process.stdout.on('drain', () => { stdoutBlocked = false; flushStdout(); });
const emit = (frame, done, force = false) => {
    const line = `${JSON.stringify(frame)}\n`;
    if (!force && stdoutBytes + line.length > MAX_STDOUT_BYTES) {
        if (!stdoutOverflowed) {
            stdoutOverflowed = true;
            stopped = true;
            ws?.close();
            close('Voice output buffer overflowed.', true);
        }
        return false;
    }
    if (!stdoutBlocked && stdoutQueue.length === 0) {
        stdoutBlocked = !process.stdout.write(line, done);
        syncProviderReadState();
    } else {
        stdoutQueue.push({ line, done });
        stdoutBytes += line.length;
        syncProviderReadState();
    }
    return true;
};
// Provider deltas may exceed the public frame bound after tool calls. Base64 is
// independently decodable when split on four-character boundaries.
export function chunkAudio(audio) {
    const chunks = [];
    const chunkSize = 64 * 1024;
    for (let offset = 0; offset < audio.length; offset += chunkSize) chunks.push(audio.slice(offset, offset + chunkSize));
    return chunks;
}
const emitAudio = (audio) => {
    let emitted = false;
    for (const data of chunkAudio(audio)) emitted = emit({ type: 'realtime.audio', data }) || emitted;
    return emitted;
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
        if (cause?.code === 'ENOENT') throw new Error('No xAI key. Configure the provider from muxr Settings.');
        throw cause;
    }
    if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) !== 0 || !info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
        throw new Error('xAI key store must be owner-only');
    }
    const value = (await readFile(keyFile, 'utf8')).trim();
    if (!value) throw new Error('No xAI key. Configure the provider from muxr Settings.');
    return value;
}

let closing = false;
const close = (reason, forceExit = false) => {
    if (closing) return;
    closing = true;
    clearTimeout(reconnectTimer);
    clearTimeout(stableTimer);
    clearTimeout(inputPoll);
    const timer = setTimeout(() => process.exit(forceExit ? 1 : 0), 1_000);
    emit({ type: 'realtime.closed', reason }, () => {
        clearTimeout(timer);
        process.exit(forceExit ? 1 : 0);
    }, true);
    flushStdout();
};

let ws;
let stopped = false;
let providerReconnects = 0;
let reconnectTimer;
let stableTimer;
let providerEpoch = 0;
let providerReady = false;
let inputPoll;
let outputFenced = false;
let responseActive = false;
let responseGeneration = 0;
let clearedGeneration = -1;
let deferredClearGeneration;
let deferredClearContinuation;
let deferredClearPending = false;
const playbackGenerations = new Set();
const playbackDrainQueue = [];
let gracefulEndPending = false;
let outputPausedByClient = false;
const MAX_INPUT_BYTES = 96_000;
const PROVIDER_BUFFER_LIMIT = 512 * 1024;
const clientQueue = [];
let clientQueueBytes = 0;
let inputOverflowPending = false;
/** A provider link alive this long was healthy; forget its retries. */
const PROVIDER_STABLE_AFTER_MS = 30_000;

const text = (value) => String(value ?? '').trim();
export function providerError(error) {
    const raw = typeof error === 'string' ? error : error?.message ?? error?.code ?? 'provider error';
    const detail = cleanProviderProse(raw, 'provider error', 200);
    return { detail, terminal: /api key|auth|credit|quota|billing|permission|forbidden|invalid json|invalid payload|unknown name|unsupported/i.test(detail) };
}
const runTool = (name, input, operationId) => runCodingTool(name, input, operationId);

const currentProvider = (current, epoch) => !stopped && ws === current && providerEpoch === epoch;
const finishGracefulEndIfDrained = () => {
    if (!gracefulEndPending || playbackDrainQueue.length > 0 || deferredClearPending) return;
    stopped = true;
    ws?.close();
    close('ended');
};
const continueAfterClear = (continuation) => {
    if (gracefulEndPending) finishGracefulEndIfDrained();
    else continuation?.();
};
const finishDeferredClearIfDrained = () => {
    if (!deferredClearPending || playbackDrainQueue.length > 0) return;
    const generation = deferredClearGeneration;
    const continuation = deferredClearContinuation;
    deferredClearPending = false;
    deferredClearGeneration = undefined;
    deferredClearContinuation = undefined;
    if (generation !== undefined) playbackGenerations.delete(generation);
    if (generation !== undefined && clearedGeneration !== generation) {
        clearedGeneration = generation;
        emit({ type: 'realtime.audio.clear' });
    }
    syncProviderReadState();
    continueAfterClear(continuation);
};
const clearIncompleteOutput = () => {
    outputFenced = true;
    responseActive = false;
    const continuation = deferredClearContinuation;
    deferredClearPending = false;
    deferredClearGeneration = undefined;
    deferredClearContinuation = undefined;
    playbackGenerations.clear();
    playbackDrainQueue.length = 0;
    if (clearedGeneration !== responseGeneration) {
        clearedGeneration = responseGeneration;
        emit({ type: 'realtime.audio.clear' });
    }
    syncProviderReadState();
    continueAfterClear(continuation);
};
const fenceActiveResponse = (continuation) => {
    outputFenced = true;
    if (!responseActive) {
        if (deferredClearPending || playbackDrainQueue.length > 0) {
            deferredClearPending = true;
            deferredClearContinuation = continuation;
        }
        else continueAfterClear(continuation);
        return;
    }
    responseActive = false;
    if (!playbackGenerations.has(responseGeneration)) {
        if (playbackDrainQueue.length > 0) {
            deferredClearPending = true;
            deferredClearContinuation = continuation;
        } else continueAfterClear(continuation);
    } else if (playbackDrainQueue.length > 0) {
        deferredClearPending = true;
        deferredClearGeneration = responseGeneration;
        deferredClearContinuation = continuation;
        syncProviderReadState();
    } else {
        playbackGenerations.delete(responseGeneration);
        if (clearedGeneration !== responseGeneration) {
            clearedGeneration = responseGeneration;
            emit({ type: 'realtime.audio.clear' });
        }
        continueAfterClear(continuation);
    }
};
const deliverAfterClear = (continuation) => {
    if (deferredClearPending || playbackDrainQueue.length > 0) {
        deferredClearPending = true;
        deferredClearContinuation = continuation;
    } else continueAfterClear(continuation);
};

function handleXaiEvent(raw, current, epoch) {
    if (!currentProvider(current, epoch)) return;
    let message;
    try { message = JSON.parse(raw); } catch { return; }
    if (deferredClearPending && message.type !== 'input_audio_buffer.speech_started' && message.type !== 'error') return;
    switch (message.type) {
        case 'input_audio_buffer.speech_started':
            if (playbackGenerations.size > 0 && clearedGeneration !== responseGeneration) clearIncompleteOutput();
            break;
        case 'response.created':
            responseGeneration += 1;
            responseActive = true;
            outputFenced = false;
            state('thinking');
            break;
        case 'response.output_audio.delta':
        case 'response.audio.delta': {
            const audio = typeof message.delta === 'string' ? message.delta : typeof message.audio === 'string' ? message.audio : '';
            if (audio && !outputFenced && emitAudio(audio)) playbackGenerations.add(responseGeneration);
            break;
        }
        case 'response.done':
            if (!responseActive) break;
            responseActive = false;
            if (playbackGenerations.has(responseGeneration) && !playbackDrainQueue.includes(responseGeneration)) {
                playbackDrainQueue.push(responseGeneration);
            }
            state('connected');
            if (endAfterResponse) {
                gracefulEndPending = true;
                finishGracefulEndIfDrained();
            }
            break;
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
            const callGeneration = responseGeneration;
            void (async () => {
                let args = {};
                try { args = JSON.parse(message.arguments || '{}'); } catch { /* interrupted arguments */ }
                let output;
                try { output = await runTool(message.name, args, message.call_id); }
                catch { output = 'Voice coordination could not confirm that request. Please try again.'; }
                if (!currentProvider(current, epoch) || current.readyState !== WebSocket.OPEN || outputFenced || callGeneration !== responseGeneration) return;
                current.send(JSON.stringify({
                    type: 'conversation.item.create',
                    item: { type: 'function_call_output', call_id: message.call_id, output: text(output).slice(0, 24_000) },
                }));
                if (currentProvider(current, epoch) && !outputFenced && callGeneration === responseGeneration) current.send(JSON.stringify({ type: 'response.create' }));
            })();
            break;
        }
        case 'error': {
            const { detail, terminal } = providerError(message.error);
            if (terminal) {
                providerReady = false;
                if (endAfterResponse) gracefulEndPending = true;
                fenceActiveResponse(() => close(`Voice provider error: ${detail}`));
                stopped = true;
                current.close();
            } else {
                if (endAfterResponse) gracefulEndPending = true;
                fenceActiveResponse(() => state('connected', detail));
            }
            break;
        }
    }
}

function sendClientFrame(current, frame) {
    if (frame.type === 'realtime.audio') {
        current.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: frame.data }));
    } else if (frame.type === 'realtime.say') {
        current.send(JSON.stringify({
            type: 'conversation.item.create',
            item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: frame.text }] },
        }));
        current.send(JSON.stringify({ type: 'response.create' }));
    }
}

function flushClientFrames(current = ws, epoch = providerEpoch) {
    clearTimeout(inputPoll);
    inputPoll = undefined;
    if (!current || !currentProvider(current, epoch) || !providerReady || current.readyState !== WebSocket.OPEN) return;
    while (clientQueue.length > 0 && current.bufferedAmount <= PROVIDER_BUFFER_LIMIT) {
        const item = clientQueue.shift();
        clientQueueBytes -= item.bytes;
        sendClientFrame(current, item.frame);
    }
    if (clientQueue.length > 0) inputPoll = setTimeout(() => flushClientFrames(current, epoch), 20);
}

const clientFrameBytes = (frame) => frame.type === 'realtime.audio'
    ? Math.floor(frame.data.length * 3 / 4)
    : Buffer.byteLength(JSON.stringify(frame));

function handleClientFrame(frame) {
    if (frame.type === 'realtime.control') {
        if (frame.action === 'stop') {
            stopped = true;
            ws?.close();
            close('ended');
        } else if (frame.action === 'pause_output') {
            outputPausedByClient = true;
            syncProviderReadState();
        } else if (frame.action === 'resume_output') {
            outputPausedByClient = false;
            syncProviderReadState();
        } else if (frame.action === 'output_drained') {
            const drainedGeneration = playbackDrainQueue.shift();
            if (drainedGeneration !== undefined) playbackGenerations.delete(drainedGeneration);
            finishDeferredClearIfDrained();
            finishGracefulEndIfDrained();
        }
        return;
    }
    if (inputOverflowPending) return;
    if (frame.type !== 'realtime.audio' && frame.type !== 'realtime.say') return;
    const bytes = clientFrameBytes(frame);
    if (clientQueueBytes + bytes > MAX_INPUT_BYTES) {
        inputOverflowPending = true;
        providerReady = false;
        clearTimeout(inputPoll);
        inputPoll = undefined;
        fenceActiveResponse(() => close('Voice input buffer overflowed.'));
        stopped = true;
        ws?.close();
        return;
    }
    clientQueue.push({ frame, bytes });
    clientQueueBytes += bytes;
    flushClientFrames();
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
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    clearTimeout(stableTimer);
    stableTimer = undefined;
    providerReady = false;
    const epoch = ++providerEpoch;
    deliverAfterClear(() => state('connecting', providerReconnects === 0 ? undefined : 'Voice provider reconnecting'));
    const current = new WebSocket(PROVIDER_URL, {
        headers: { Authorization: `Bearer ${key}` },
        maxPayload: 4 * 1024 * 1024,
    });
    ws = current;
    let downHandled = false;
    const onDown = (reason) => {
        if (downHandled || stopped || ws !== current || providerEpoch !== epoch) return;
        downHandled = true;
        providerReady = false;
        clearTimeout(stableTimer);
        stableTimer = undefined;
        clearTimeout(inputPoll);
        inputPoll = undefined;
        if (endAfterResponse) gracefulEndPending = true;
        fenceActiveResponse(providerReconnects >= 2 ? () => close(reason) : undefined);
        if (!gracefulEndPending && providerReconnects < 2) {
            providerReconnects += 1;
            clearTimeout(reconnectTimer);
            reconnectTimer = setTimeout(() => connectProvider(key), providerReconnects * 500);
        }
    };
    current.on('open', () => {
        if (!currentProvider(current, epoch)) return;
        syncProviderReadState();
        current.send(JSON.stringify({
            type: 'session.update',
            session: {
                instructions: PROMPT,
                voice: 'ara',
                reasoning: { effort: 'none' },
                turn_detection: { type: 'server_vad', threshold: 0.9, silence_duration_ms: 700, prefix_padding_ms: 300 },
                audio: {
                    input: { format: { type: 'audio/pcm', rate: RATE }, transport: 'json' },
                    output: { format: { type: 'audio/pcm', rate: RATE }, transport: 'json' },
                },
                tools: providerTools,
            },
        }), (error) => {
            if (error) { onDown('Voice provider session setup failed.'); return; }
            if (!currentProvider(current, epoch)) return;
            providerReady = true;
            flushClientFrames(current, epoch);
            deliverAfterClear(() => {
                emit({ type: 'realtime.ready', inputRate: RATE, outputRate: RATE });
                state('connected', providerReconnects === 0 ? undefined : 'Voice provider reconnected');
            });
            // Reconnect budget is consecutive, not cumulative: a long healthy
            // call gets the full budget again after its next transient drop.
            clearTimeout(stableTimer);
            stableTimer = setTimeout(() => {
                if (currentProvider(current, epoch)) providerReconnects = 0;
            }, PROVIDER_STABLE_AFTER_MS);
        });
    });
    current.on('message', (data) => handleXaiEvent(String(data), current, epoch));
    // ws suppresses 'error' and 'close' once this is handled, so the failure
    // path is driven from here. Auth and permission refusals are terminal:
    // retrying an out-of-credits account only delays the real message.
    current.on('unexpected-response', (_request, response) => {
        const bodyBuffer = Buffer.alloc(MAX_REFUSAL_BODY_BYTES);
        let bodyBytes = 0;
        response.on('data', (chunk) => {
            const admitted = Math.min(chunk.length, MAX_REFUSAL_BODY_BYTES - bodyBytes);
            if (admitted > 0) bodyBytes += chunk.copy(bodyBuffer, bodyBytes, 0, admitted);
        });
        response.on('end', () => {
            if (!currentProvider(current, epoch)) return;
            const body = bodyBuffer.subarray(0, bodyBytes).toString('utf8');
            const reason = providerRefusal(response.statusCode, body);
            if (response.statusCode === 401 || response.statusCode === 403) {
                providerReady = false;
                if (endAfterResponse) gracefulEndPending = true;
                fenceActiveResponse(() => close(reason));
                stopped = true;
            } else onDown(reason);
            current.terminate();
        });
    });
    current.on('close', (code, reasonBuffer) => {
        const reason = cleanProviderProse(String(reasonBuffer), '', 160);
        const detail = `The voice provider disconnected (${code})${reason ? `: ${reason}` : '.'}`;
        if (providerError(reason).terminal) {
            providerReady = false;
            if (endAfterResponse) gracefulEndPending = true;
            fenceActiveResponse(() => close(detail));
            stopped = true;
        } else {
            onDown(detail);
        }
    });
    current.on('error', (error) => {
        if (currentProvider(current, epoch)) {
            deliverAfterClear(() => state('connecting', `Voice provider connection interrupted: ${cleanProviderProse(error.message, 'connection error', 160)}`));
        }
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
