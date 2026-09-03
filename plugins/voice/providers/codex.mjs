#!/usr/bin/env node
/**
 * Experimental Codex Voice signaling adapter.
 *
 * Media is mobile-to-OpenAI WebRTC. This process handles only bounded SDP and
 * opaque data-channel control. The owner-approved Codex OAuth bearer is read
 * into this process for one signaling request and never enters muxr frames,
 * arguments, logs, environment, or storage.
 */
import { spawn, spawnSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import {
    cleanProviderProse,
    isExplicitHangup,
} from '../coordinatorPolicy.mjs';

const CODEX_CLIENT_VERSION = '0.144.1';
const SIGNALING_URL = process.env.NODE_ENV === 'test' && process.env.MUXR_TEST_CODEX_SIGNALING_URL
    ? process.env.MUXR_TEST_CODEX_SIGNALING_URL
    : 'https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas';
const CODEX_BIN = process.env.NODE_ENV === 'test' && process.env.MUXR_TEST_CODEX_BIN
    ? process.env.MUXR_TEST_CODEX_BIN
    : process.env.MUXR_CODEX_BIN?.trim() || 'codex';
const codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex');
const authFile = join(codexHome, 'auth.json');
const MAX_SDP_BYTES = 128 * 1024;
const MAX_DATA_BYTES = 32 * 1024;
const PROMPT = `You are Codex Voice inside muxr. Be direct and brief. Speak in one short sentence unless asked to elaborate.

- Delegate coding work to the client instead of pretending to perform it yourself.
- Never speak internal ids, including thread, session, pane, operation, provider, or delegation ids.
- Report progress and blockers accurately. Never invent completion.
- Treat pauses and incomplete speech as the user thinking; do not interrupt.
- End only when the user clearly says goodbye or asks you to stop listening.`;

let closing = false;
let stopped = false;
let offerAccepted = false;
let endAfterResponse = false;

const emit = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
const state = (value, detail) => emit(detail === undefined
    ? { type: 'realtime.state', state: value }
    : { type: 'realtime.state', state: value, detail });
const safe = (value, fallback = 'provider error', max = 500) => cleanProviderProse(value, fallback, max);

function close(reason) {
    if (closing) return;
    closing = true;
    stopped = true;
    process.stdout.write(`${JSON.stringify({ type: 'realtime.closed', reason: safe(reason, 'ended') })}\n`, () => process.exit(0));
}

export function approvedSignalingUrl(value) {
    try {
        const url = new URL(value);
        return url.origin === 'https://chatgpt.com' && url.pathname === '/backend-api/codex/realtime/calls';
    } catch { return false; }
}

function assertSignalingOrigin() {
    if (process.env.NODE_ENV === 'test') return;
    if (!approvedSignalingUrl(SIGNALING_URL)) throw new Error('Codex Voice refused an unapproved credential destination.');
}

async function boundedResponseBody(response) {
    if (!response.body) return '';
    const reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_SDP_BYTES) {
            await reader.cancel();
            throw new Error('Codex Voice signaling returned an oversized response.');
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
}

async function refreshCodexAuth() {
    if (process.env.NODE_ENV === 'test' && process.env.MUXR_TEST_CODEX_TOKEN) return;
    const { promise, resolve, reject } = Promise.withResolvers();
    const child = spawn(CODEX_BIN, ['app-server', '--listen', 'stdio://'], { stdio: ['pipe', 'pipe', 'ignore'] });
    let output = '';
    let initialized = false;
    let settled = false;
    const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill();
        error ? reject(error) : resolve();
    };
    const timer = setTimeout(() => finish(new Error('Codex credential refresh timed out.')), 15_000);
    child.once('error', finish);
    child.once('exit', (code) => { if (!settled) finish(new Error(`Codex credential refresh exited (${code ?? 'signal'}).`)); });
    child.stdout.on('data', (chunk) => {
        output += chunk;
        if (output.length > 256 * 1024) return finish(new Error('Codex app-server returned oversized refresh output.'));
        while (output.includes('\n')) {
            const index = output.indexOf('\n');
            const line = output.slice(0, index); output = output.slice(index + 1);
            let message;
            try { message = JSON.parse(line); } catch { continue; }
            if (message.id === 1 && !initialized) {
                if (message.error) return finish(new Error(`Codex initialization failed: ${safe(message.error.message)}`));
                initialized = true;
                child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
                child.stdin.write(`${JSON.stringify({ id: 2, method: 'account/read', params: { refreshToken: true } })}\n`);
            } else if (message.id === 2) {
                return message.error
                    ? finish(new Error(`Codex credential refresh failed: ${safe(message.error.message)}`))
                    : finish();
            }
        }
    });
    child.stdin.write(`${JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'muxr', title: 'muxr', version: '0.1.0' } } })}\n`);
    await promise;
}

function tokenAccountId(token) {
    try {
        const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'));
        return payload['https://api.openai.com/auth']?.chatgpt_account_id;
    } catch { return undefined; }
}

function bindCredential(token, account) {
    if (typeof token !== 'string' || !token) throw new Error('Codex ChatGPT sign-in is unavailable. Run codex login.');
    const boundAccount = tokenAccountId(token);
    if (typeof account === 'string' && typeof boundAccount === 'string' && account !== boundAccount) {
        throw new Error('Codex credential account binding is inconsistent.');
    }
    const resolvedAccount = typeof account === 'string' && account ? account : boundAccount;
    if (typeof resolvedAccount !== 'string' || !resolvedAccount) throw new Error('Codex credential has no ChatGPT account binding.');
    return { token, account: resolvedAccount };
}

async function codexCredential() {
    if (process.env.NODE_ENV === 'test' && process.env.MUXR_TEST_CODEX_TOKEN) {
        return bindCredential(process.env.MUXR_TEST_CODEX_TOKEN, process.env.MUXR_TEST_CODEX_ACCOUNT_ID);
    }
    await refreshCodexAuth();
    const [root, file] = await Promise.all([lstat(codexHome), lstat(authFile)]);
    const owner = typeof process.getuid === 'function' ? process.getuid() : file.uid;
    if (!root.isDirectory() || root.isSymbolicLink() || (root.mode & 0o022) !== 0 || root.uid !== owner
        || !file.isFile() || file.isSymbolicLink() || (file.mode & 0o077) !== 0 || file.uid !== owner) {
        throw new Error('Codex credential file must be owner-only in a non-writable store.');
    }
    const auth = JSON.parse(await readFile(authFile, 'utf8'));
    return bindCredential(auth.tokens?.access_token, auth.tokens?.account_id);
}

function signalingHeaders(credential) {
    const session = randomUUID();
    return {
        Authorization: `Bearer ${credential.token}`,
        'OpenAI-Alpha': 'quicksilver=v2',
        'User-Agent': `Codex Desktop/${CODEX_CLIENT_VERSION}`,
        'x-session-id': session,
        originator: 'Codex Desktop',
        version: CODEX_CLIENT_VERSION,
        'session-id': session,
        'thread-id': session,
        'chatgpt-account-id': credential.account,
    };
}

function sendData(value) {
    const data = JSON.stringify(value);
    if (Buffer.byteLength(data) > MAX_DATA_BYTES) throw new Error('Codex Voice control message exceeded its bound.');
    emit({ type: 'realtime.webrtc.data', data });
}

function contextChunks(value) {
    const text = safe(value, '', 8_000);
    const chunks = [];
    let current = '';
    for (const character of text) {
        if (Buffer.byteLength(current + character) > 500) { chunks.push(current); current = ''; }
        current += character;
    }
    if (current || chunks.length === 0) chunks.push(current);
    return chunks;
}

function appendContext(text, delegationId) {
    for (const chunk of contextChunks(text)) {
        sendData(delegationId ? {
            type: 'delegation.context.append', delegation_item_id: delegationId, channel: 'speakable',
            content: [{ type: 'input_text', text: chunk }],
        } : {
            type: 'session.context.append', channel: 'speakable', content: [{ type: 'input_text', text: chunk }],
        });
    }
}

async function delegate(event) {
    const id = typeof event.item?.id === 'string' ? event.item.id : '';
    const request = Array.isArray(event.item?.content)
        ? event.item.content.filter((item) => item?.type === 'input_text' && typeof item.text === 'string').map((item) => item.text).join('\n')
        : '';
    if (!id || !request.trim()) return;
    state('thinking');
    const result = 'Codex Voice could not queue that instruction. An explicit Agent Name or Task Title is required.';
    if (!stopped) appendContext(result, id);
}

function handleWebRtcData(data) {
    let event;
    try { event = JSON.parse(data); } catch { return; }
    switch (event.type) {
        case 'session.started':
        case 'session.updated':
            state('connected');
            break;
        case 'output_audio.delta':
            state('speaking');
            break;
        case 'turn.done': {
            const role = event.turn?.role === 'assistant' ? 'agent' : 'user';
            const transcript = safe(event.turn?.transcript, '', 4_000);
            if (!transcript) break;
            if (role === 'user') {
                emit({ type: 'realtime.audio.clear' });
                if (isExplicitHangup(transcript)) endAfterResponse = true;
                else state('thinking');
            } else if (endAfterResponse) {
                emit({ type: 'realtime.transcript', role, text: transcript });
                close('ended');
                break;
            } else state('connected');
            emit({ type: 'realtime.transcript', role, text: transcript });
            break;
        }
        case 'delegation.created':
            void delegate(event);
            break;
        case 'error':
            close(`Codex Voice error: ${safe(event.message ?? event.error?.message)}`);
            break;
    }
}

async function signalOffer(sdp) {
    if (offerAccepted) throw new Error('Codex Voice received a duplicate WebRTC offer.');
    offerAccepted = true;
    assertSignalingOrigin();
    const credential = await codexCredential();
    const response = await fetch(SIGNALING_URL, {
        method: 'POST',
        redirect: 'manual',
        signal: AbortSignal.timeout(20_000),
        headers: { ...signalingHeaders(credential), accept: '*/*', 'content-type': 'application/json' },
        body: JSON.stringify({
            sdp,
            session: {
                model: 'gpt-live-1-codex', instructions: PROMPT,
                audio: { output: { voice: 'sol' } }, delegation: { type: 'client' },
            },
        }),
    });
    const answer = await boundedResponseBody(response);
    if (!response.ok) throw new Error(`Codex Voice signaling failed (${response.status}): ${safe(answer)}`);
    if (!answer.startsWith('v=0')) throw new Error('Codex Voice signaling returned an invalid SDP answer.');
    emit({ type: 'realtime.webrtc.answer', sdp: answer });
}

function handleClientFrame(frame) {
    if (frame.type === 'realtime.webrtc.offer') void signalOffer(frame.sdp).catch((error) => close(error.message));
    else if (frame.type === 'realtime.webrtc.data') handleWebRtcData(frame.data);
    else if (frame.type === 'realtime.say') appendContext(frame.text);
    else if (frame.type === 'realtime.control' && frame.action === 'stop') {
        try { sendData({ type: 'session.close' }); } catch { /* closing */ }
        close('ended');
    }
}

async function main() {
    const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
    const { promise, resolve } = Promise.withResolvers();
    input.once('line', resolve);
    const first = await promise;
    let open;
    try { open = JSON.parse(first); } catch { throw new Error('realtime stream missing open frame'); }
    if (open?.type !== 'realtime.open') throw new Error('realtime stream expected realtime.open first');
    input.on('line', (line) => {
        if (!line.trim()) return;
        try { handleClientFrame(JSON.parse(line)); } catch { /* host validates frames before delivery */ }
    });
    state('connecting');
    emit({ type: 'realtime.webrtc.start', dataChannelLabel: 'oai-events' });
}

/** Entry point; the plugin's stream.mjs selects and starts one adapter. */
export function start() {
    return main().catch((error) => close(error instanceof Error ? error.message : 'Codex Voice could not start.'));
}

/**
 * Codex authenticates through an existing ChatGPT CLI login, so there is no key
 * to store; the settings screen reports the login instead.
 */
export function status() {
    const binary = process.env.MUXR_CODEX_BIN?.trim() || 'codex';
    const login = spawnSync(binary, ['login', 'status'], { encoding: 'utf8', timeout: 10_000, maxBuffer: 256 * 1024 });
    const authenticated = login.status === 0 && /logged in using chatgpt/i.test(`${login.stdout}${login.stderr}`);
    let privateStore = false;
    try {
        const root = lstatSync(codexHome);
        const file = lstatSync(authFile);
        const owner = typeof process.getuid === 'function' ? process.getuid() : file.uid;
        privateStore = root.isDirectory() && !root.isSymbolicLink() && (root.mode & 0o022) === 0 && root.uid === owner
            && file.isFile() && !file.isSymbolicLink() && (file.mode & 0o077) === 0 && file.uid === owner;
    } catch { privateStore = false; }
    let statusLabel = 'Experimental subscription access ready';
    if (!authenticated) statusLabel = 'Run codex login with ChatGPT';
    else if (!privateStore) statusLabel = 'Codex credential file is not owner-only';
    return { configured: authenticated && privateStore, statusLabel };
}
