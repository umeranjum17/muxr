#!/usr/bin/env node
/**
 * Gemini Live speech-to-speech adapter behind the provider-neutral realtime stream.
 *
 * stdin: one `realtime.open` line, then generic realtime client frames.
 * stdout: generic realtime host frames, one JSON per line.
 * All Gemini auth, model, event and prompt detail lives here; the phone and relay
 * only ever see the generic frame vocabulary.
 */
import WebSocket from 'ws';
import { lstat, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import {
    cleanProviderProse,
    codingTools,
    isExplicitHangup,
    runCodingTool,
    voiceCoordinationInstructions,
} from '../coordinatorPolicy.mjs';

const MODEL = 'gemini-3.1-flash-live-preview';
const ENDPOINT = process.env.NODE_ENV === 'test' && process.env.MUXR_TEST_GEMINI_REALTIME_URL
    ? process.env.MUXR_TEST_GEMINI_REALTIME_URL
    : 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const INPUT_RATE = 16_000;
const OUTPUT_RATE = 24_000;
const root = process.env.MUXR_HOME?.trim() || join(homedir(), '.muxr');
const keyFile = join(root, 'gemini.key');
let endAfterResponse = false;
export const providerTools = codingTools;

const geminiSchema = (value) => {
    if (Array.isArray(value)) return value.map(geminiSchema);
    if (value === null || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value)
        .filter(([key]) => key !== 'additionalProperties')
        .map(([key, entry]) => [
            key,
            key === 'type' && typeof entry === 'string' ? entry.toUpperCase() : geminiSchema(entry),
        ]));
};
const GEMINI_TOOLS = [{
    functionDeclarations: providerTools.map(({ type: _type, ...tool }) => ({ ...tool, parameters: geminiSchema(tool.parameters) })),
}];

const OUTPUT_FRAME_MS = 20;
const AUDIO_CHUNK_SIZE = OUTPUT_RATE * 2 * OUTPUT_FRAME_MS / 1000 * 4 / 3;
const MAX_PENDING_OUTPUT_BYTES = 4 * 1024 * 1024;
const outputQueue = [];
let outputBytes = 0;
let outputBlocked = false;
let outputTimer;
let outputDeadline = 0;
let outputPausedByClient = false;

function syncProviderReadState() {
    if (ws?.readyState !== WebSocket.OPEN) return;
    if (outputBlocked || outputQueue.length > 0 || outputPausedByClient) ws.pause();
    else ws.resume();
}
function flushOutput() {
    outputTimer = undefined;
    if (outputBlocked || outputQueue.length === 0) {
        if (outputQueue.length === 0) outputDeadline = 0;
        syncProviderReadState();
        return;
    }
    const index = outputPausedByClient ? outputQueue.findIndex((item) => item.force) : 0;
    if (index === -1) {
        syncProviderReadState();
        return;
    }
    const [item] = outputQueue.splice(index, 1);
    outputBytes -= item.line.length;
    outputBlocked = !process.stdout.write(item.line, item.done);
    if (item.delayMs > 0) {
        if (outputDeadline === 0) outputDeadline = performance.now();
        outputDeadline += item.delayMs;
    }
    const delayMs = item.delayMs > 0 ? Math.max(0, outputDeadline - performance.now()) : 0;
    outputTimer = setTimeout(flushOutput, delayMs);
    syncProviderReadState();
}
process.stdout.on('drain', () => {
    outputBlocked = false;
    outputDeadline = 0;
    if (outputTimer === undefined) flushOutput();
});
const emit = (frame, done, force = false) => {
    const line = `${JSON.stringify(frame)}\n`;
    if (!force && outputBytes + line.length > MAX_PENDING_OUTPUT_BYTES) {
        stopped = true;
        ws?.close();
        outputQueue.length = 0;
        outputBytes = 0;
        outputDeadline = 0;
        close('Voice output buffer overflowed.', true);
        return false;
    }
    const delayMs = frame.type === 'realtime.audio'
        ? Math.max(1, Math.round(frame.data.length / 4 * 3 / (OUTPUT_RATE * 2) * 1000))
        : 0;
    outputQueue.push({ line, delayMs, done, force, audio: frame.type === 'realtime.audio' });
    outputBytes += line.length;
    if (outputTimer === undefined) outputTimer = setTimeout(flushOutput, 0);
    syncProviderReadState();
    return true;
};
function clearQueuedAudio() {
    for (let index = outputQueue.length - 1; index >= 0; index -= 1) {
        if (!outputQueue[index].audio) continue;
        outputBytes -= outputQueue[index].line.length;
        outputQueue.splice(index, 1);
    }
    if (!outputQueue.some((item) => item.audio)) outputDeadline = 0;
}
// Gemini can deliver several seconds in one provider event. Twenty-millisecond
// frames keep native admission smooth while the paced queue backpressures the
// provider WebSocket whenever the phone or app is not draining.
export function chunkAudio(audio) {
    const chunks = [];
    for (let offset = 0; offset < audio.length; offset += AUDIO_CHUNK_SIZE) chunks.push(audio.slice(offset, offset + AUDIO_CHUNK_SIZE));
    return chunks;
}
const emitAudio = (audio) => {
    for (const data of chunkAudio(audio)) {
        if (!emit({ type: 'realtime.audio', data })) break;
    }
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
        if (cause?.code === 'ENOENT') throw new Error('No Gemini key. Configure the provider from muxr Settings.');
        throw cause;
    }
    if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) !== 0 || !info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
        throw new Error('Gemini key store must be owner-only');
    }
    const value = (await readFile(keyFile, 'utf8')).trim();
    if (!value) throw new Error('No Gemini key. Configure the provider from muxr Settings.');
    return value;
}

let closing = false;
const close = (reason, force = false) => {
    if (closing) return;
    closing = true;
    emit({ type: 'realtime.closed', reason }, () => process.exit(0), force);
};

let ws;
let stopped = false;
let providerReady = false;
let sessionHandle = '';
const cancelledToolCalls = new Set();
const activeToolCalls = new Map();
let providerReconnects = 0;
let reconnectTimer;
let stableTimer;
/** A provider link alive this long was healthy; forget its retries. */
const PROVIDER_STABLE_AFTER_MS = 30_000;

const text = (value) => String(value ?? '').trim();
export function providerError(error) {
    const raw = typeof error === 'string' ? error : error?.message ?? error?.code ?? 'provider error';
    const detail = cleanProviderProse(raw, 'provider error', 200);
    return { detail, terminal: /api key|auth|credit|quota|billing|permission|forbidden|invalid json|invalid payload|unknown name|unsupported/i.test(detail) };
}
const runTool = (name, input, operationId, signal) => runCodingTool(name, input, operationId, signal);

let inputTranscript = '';
let outputTranscript = '';
let turnThinking = false;
let finishTimer;

function finishTurn() {
    if (isExplicitHangup(inputTranscript)) endAfterResponse = true;
    if (inputTranscript.trim()) emit({ type: 'realtime.transcript', role: 'user', text: inputTranscript.trim() });
    if (outputTranscript.trim()) emit({ type: 'realtime.transcript', role: 'agent', text: outputTranscript.trim() });
    inputTranscript = '';
    outputTranscript = '';
    turnThinking = false;
    if (endAfterResponse) {
        stopped = true;
        ws?.close();
        close('ended', true);
    } else {
        state('connected');
    }
}

function handleGeminiEvent(raw) {
    let message;
    try { message = JSON.parse(raw); } catch { return; }
    if (message.setupComplete) {
        providerReady = true;
        emit({ type: 'realtime.ready', inputRate: INPUT_RATE, outputRate: OUTPUT_RATE });
        state('connected', providerReconnects === 0 ? undefined : 'Voice provider reconnected');
        clearTimeout(stableTimer);
        stableTimer = setTimeout(() => { providerReconnects = 0; }, PROVIDER_STABLE_AFTER_MS);
    }
    const content = message.serverContent;
    if (content) {
        if (content.interrupted === true) {
            clearQueuedAudio();
            emit({ type: 'realtime.audio.clear' }, undefined, true);
        }
        if (typeof content.inputTranscription?.text === 'string') inputTranscript += content.inputTranscription.text;
        if (typeof content.outputTranscription?.text === 'string') outputTranscript += content.outputTranscription.text;
        for (const part of content.modelTurn?.parts ?? []) {
            const audio = part.inlineData?.data;
            if (typeof audio === 'string' && audio) {
                if (!turnThinking) { state('thinking'); turnThinking = true; }
                emitAudio(audio);
            }
        }
        if (content.turnComplete === true) {
            // Transcription chunks are independent and have no final bit; give late chunks one short grace window.
            clearTimeout(finishTimer);
            finishTimer = setTimeout(finishTurn, 150);
        }
    }
    if (typeof message.sessionResumptionUpdate?.newHandle === 'string' && message.sessionResumptionUpdate.resumable === true) {
        sessionHandle = message.sessionResumptionUpdate.newHandle;
    }
    if (Array.isArray(message.toolCallCancellation?.ids)) {
        // ponytail: completed Herdr side effects cannot be undone; cancellation aborts work still in flight.
        for (const id of message.toolCallCancellation.ids) {
            cancelledToolCalls.add(id);
            activeToolCalls.get(id)?.abort();
        }
    }
    if (Array.isArray(message.toolCall?.functionCalls)) {
        void (async () => {
            const functionResponses = (await Promise.all(message.toolCall.functionCalls.map(async (call) => {
                if (cancelledToolCalls.delete(call.id)) return undefined;
                const controller = new AbortController();
                activeToolCalls.set(call.id, controller);
                let output;
                try {
                    output = await runTool(call.name, call.args, call.id, controller.signal);
                } catch (error) {
                    if (cancelledToolCalls.delete(call.id) || error?.name === 'AbortError') return undefined;
                    output = 'Voice coordination could not confirm that request. Please try again.';
                } finally {
                    activeToolCalls.delete(call.id);
                }
                if (cancelledToolCalls.delete(call.id)) return undefined;
                return { id: call.id, name: call.name, response: { result: text(output).slice(0, 24_000) } };
            }))).filter(Boolean);
            if (stopped || ws?.readyState !== WebSocket.OPEN || functionResponses.length === 0) return;
            ws.send(JSON.stringify({ toolResponse: { functionResponses } }));
        })();
    }
    if (message.goAway && ws?.readyState === WebSocket.OPEN) {
        const current = ws;
        const milliseconds = Math.max(0, (Number.parseFloat(message.goAway.timeLeft) || 1) * 1000 - 500);
        setTimeout(() => { if (!stopped && ws === current) current.close(1000, 'Session rotation'); }, milliseconds);
    }
    if (message.error) {
        const { detail, terminal } = providerError(message.error);
        if (!providerReady || terminal) {
            stopped = true;
            ws?.close();
            close(`Voice provider error: ${detail}`, true);
        } else {
            state('connected', detail);
        }
    }
}

function handleClientFrame(frame) {
    if (frame.type === 'realtime.control') {
        if (frame.action === 'stop') {
            stopped = true;
            ws?.close();
            outputQueue.length = 0;
            outputBytes = 0;
            outputDeadline = 0;
            close('ended', true);
        } else if (frame.action === 'pause_output') {
            outputPausedByClient = true;
            outputDeadline = 0;
            syncProviderReadState();
        } else if (frame.action === 'resume_output') {
            outputPausedByClient = false;
            if (outputTimer === undefined) outputTimer = setTimeout(flushOutput, 0);
            syncProviderReadState();
        }
        return;
    }
    if (ws?.readyState !== WebSocket.OPEN) return;
    if (frame.type === 'realtime.audio') {
        ws.send(JSON.stringify({ realtimeInput: { audio: { data: frame.data, mimeType: `audio/pcm;rate=${INPUT_RATE}` } } }));
    } else if (frame.type === 'realtime.say') {
        ws.send(JSON.stringify({
            clientContent: {
                turns: [{ role: 'user', parts: [{ text: frame.text }] }],
                turnComplete: true,
            },
        }));
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
    providerReady = false;
    state('connecting', providerReconnects === 0 ? undefined : 'Voice provider reconnecting');
    const current = new WebSocket(`${ENDPOINT}?key=${encodeURIComponent(key)}`, { maxPayload: 4 * 1024 * 1024 });
    ws = current;
    const onDown = (reason) => {
        if (stopped || ws !== current) return;
        if (providerReconnects >= 2) {
            close(reason, true);
            return;
        }
        providerReconnects += 1;
        reconnectTimer = setTimeout(() => connectProvider(key), providerReconnects * 500);
    };
    current.on('open', () => {
        if (stopped || ws !== current) return;
        current.send(JSON.stringify({
            setup: {
                model: `models/${MODEL}`,
                generationConfig: {
                    responseModalities: ['AUDIO'],
                    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
                },
                systemInstruction: { parts: [{ text: PROMPT }] },
                inputAudioTranscription: {},
                outputAudioTranscription: {},
                sessionResumption: sessionHandle ? { handle: sessionHandle } : {},
                contextWindowCompression: { slidingWindow: {} },
                tools: GEMINI_TOOLS,
            },
        }));
    });
    current.on('message', (data) => { if (ws === current) handleGeminiEvent(String(data)); });
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
            if (response.statusCode === 401 || response.statusCode === 403) close(reason, true);
            else onDown(reason);
        });
    });
    current.on('close', (code, reasonBuffer) => {
        const reason = cleanProviderProse(String(reasonBuffer), '', 160);
        const detail = `The voice provider disconnected (${code})${reason ? `: ${reason}` : '.'}`;
        if (providerError(reason).terminal) {
            stopped = true;
            close(detail, true);
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

/** Entry point; the plugin's stream.mjs selects and starts one adapter. */
export function start() {
    return main().catch((error) => close(cleanProviderProse(error instanceof Error ? error.message : error, 'Voice session could not start.', 300), true));
}
