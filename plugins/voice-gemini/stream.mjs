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
import { fileURLToPath } from 'node:url';
import {
    codingTools,
    isExplicitHangup,
    runCodingTool,
    voiceCoordinationInstructions,
} from './coordinatorPolicy.mjs';

const MODEL = 'gemini-3.1-flash-live-preview';
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
const close = (reason) => {
    if (closing) return;
    closing = true;
    process.stdout.write(`${JSON.stringify({ type: 'realtime.closed', reason })}\n`, () => process.exit(0));
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
    const detail = String(typeof error === 'string' ? error : error?.message ?? error?.code ?? 'provider error').replace(/[\u0000-\u001F]/g, ' ').slice(0, 200);
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
        close('ended');
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
        if (content.interrupted === true) emit({ type: 'realtime.audio.clear' });
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
            close(`Voice provider error: ${detail}`);
        } else {
            state('connected', detail);
        }
    }
}

function handleClientFrame(frame) {
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
    return detail === ''
        ? `Voice provider refused the connection (HTTP ${status}).`
        : `Voice provider refused the connection (HTTP ${status}): ${detail.slice(0, 300)}`;
}

function connectProvider(key) {
    if (stopped) return;
    providerReady = false;
    state('connecting', providerReconnects === 0 ? undefined : 'Voice provider reconnecting');
    const endpoint = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
    const current = new WebSocket(`${endpoint}?key=${encodeURIComponent(key)}`, { maxPayload: 4 * 1024 * 1024 });
    ws = current;
    const onDown = (reason) => {
        if (stopped || ws !== current) return;
        if (providerReconnects >= 2) {
            close(reason);
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
            if (response.statusCode === 401 || response.statusCode === 403) close(reason);
            else onDown(reason);
        });
    });
    current.on('close', (code, reasonBuffer) => {
        const reason = String(reasonBuffer).trim();
        const detail = `The voice provider disconnected (${code})${reason ? `: ${reason}` : '.'}`;
        if (providerError(reason).terminal) {
            stopped = true;
            close(detail);
        } else {
            onDown(detail);
        }
    });
    current.on('error', (error) => {
        if (!stopped && ws === current) state('connecting', `Voice provider connection interrupted: ${String(error.message).slice(0, 160)}`);
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
    main().catch((error) => close(error instanceof Error ? error.message.slice(0, 300) : String(error)));
}
