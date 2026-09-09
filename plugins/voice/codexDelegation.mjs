import { createHash } from 'node:crypto';
import { voiceTools } from './toolRuntime.mjs';
import { appControlInstructions, cleanProviderProse, voiceCoordinationInstructions } from './coordinatorPolicy.mjs';

/**
 * Client-side Codex delegation over the Codex subscription Responses API.
 *
 * The native speech-to-speech session stays direct WebRTC. Only a natural-language
 * delegation from it is routed here: a bounded, tool-planning turn against the
 * approved endpoint https://chatgpt.com/backend-api/codex/responses with the
 * account-bound Codex OAuth token, restricted to the exact voiceTools catalog.
 *
 */

// The one production credential destination. Never overridden outside tests.
const PRODUCTION_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';
// Test-only override: with NODE_ENV=test, MUXR_TEST_CODEX_RESPONSES_URL may point
// at a literal loopback http URL for a local SSE fixture. Test mode fails closed
// without a valid loopback override so tests can never reach the real provider;
// production always uses the fixed HTTPS endpoint.
const RESPONSES_URL = (() => {
    if (process.env.NODE_ENV !== 'test') return PRODUCTION_RESPONSES_URL;
    try {
        const candidate = new URL(process.env.MUXR_TEST_CODEX_RESPONSES_URL ?? '');
        if (candidate.protocol !== 'http:' || candidate.username || candidate.password) return null;
        return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(candidate.hostname) ? candidate.toString() : null;
    } catch {
        return null;
    }
})();
const DEFAULT_MODEL = 'gpt-5.6-sol';

// Finite bounds: a run may issue at most MAX_MODEL_TURNS planning requests and
// execute at most MAX_TOOL_CALLS tool calls; history is a capped in-memory
// window so long voice sessions cannot grow the context without limit.
const MAX_REQUEST_BYTES = 16000;
const MAX_OPERATION_ID_CHARS = 160;
const MAX_MODEL_TURNS = 4;
const MAX_TOOL_CALLS = 8;
const TURN_TIMEOUT_MS = 90000;
// Covers the longest host watch (290s) plus one further planning turn.
const RUN_DEADLINE_MS = 340000;
const ANSWER_MAX_CHARS = 1200;
const TOOL_OUTPUT_MAX_BYTES = 8000;
const HISTORY_MAX_ITEMS = 30;
const HISTORY_MAX_BYTES = 256 * 1024;
const RESPONSE_MAX_BYTES = 1024 * 1024;

const PLANNER_INSTRUCTIONS = `You are the restricted work coordinator for a native realtime voice session. Use only the supplied function tools; you have no shell, filesystem or other execution tools. Keep the pending user message and confirmed target across follow-ups. Answer in at most three short spoken sentences, using actual tool results.
${voiceCoordinationInstructions}
${appControlInstructions}`;
const catalog = voiceTools.map(({ type, name, description, parameters }) => ({ type, name, description, parameters }));

const byteLength = (value) => Buffer.byteLength(String(value ?? ''));

function pushCapped(history, item) {
    if (byteLength(JSON.stringify(item)) > HISTORY_MAX_BYTES) throw new Error('Delegation context exceeded its bound.');
    history.push(item);
    while (history.length > HISTORY_MAX_ITEMS || history.reduce((sum, entry) => sum + byteLength(JSON.stringify(entry)), 0) > HISTORY_MAX_BYTES) {
        const nextTurn = history.findIndex((entry, index) => index > 0 && entry.type === 'message' && entry.role === 'user');
        if (nextTurn === -1) {
            history.pop();
            throw new Error('Delegation context exceeded its bound.');
        }
        history.splice(0, nextTurn);
    }
}

function messageItem(role, text) {
    return { type: 'message', role, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }] };
}

function itemText(item) {
    return (Array.isArray(item?.content) ? item.content : [])
        .map((part) => (typeof part?.text === 'string' ? part.text : ''))
        .join(' ').trim();
}

/** One SSE data block -> parsed event, or null for comments/keep-alives/bad JSON. */
function parseEventBlock(block) {
    const data = block.split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('\n');
    if (!data || data === '[DONE]') return null;
    try { return JSON.parse(data); } catch { return null; }
}

async function providerErrorDetail(response) {
    const reader = response.body?.getReader();
    if (!reader) return '';
    const chunks = [];
    let bytes = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > 8192) return '';
            chunks.push(value);
        }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        return cleanProviderProse(body?.error?.message ?? body?.detail ?? body?.error?.code, '', 200);
    } catch {
        return '';
    } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
    }
}

/**
 * Streams one planning turn. Returns { items, terminal } where terminal.kind is
 * 'completed' on success, otherwise one of 'failed' | 'incomplete' (provider
 * terminal events), 'http' (non-2xx), 'unreachable' (connection failure),
 * 'disconnected' (stream ended without a terminal event), or the caller-facing
 * 'cancelled' | 'timeout'. No output item authorizes a tool until the planning
 * response completes successfully.
 */
async function planTurn({ credential, input, model, signal }) {
    let response;
    try {
        response = await fetch(RESPONSES_URL, {
            method: 'POST',
            redirect: 'error',
            headers: {
                Authorization: `Bearer ${credential.token}`,
                'chatgpt-account-id': credential.account,
                'Content-Type': 'application/json',
                Accept: 'text/event-stream',
                'User-Agent': 'muxr-voice-delegation/1.0',
                originator: 'muxr-voice-delegation',
            },
            body: JSON.stringify({
                model,
                instructions: PLANNER_INSTRUCTIONS,
                input,
                tools: catalog,
                tool_choice: 'auto',
                parallel_tool_calls: false,
                store: false,
                stream: true,
                reasoning: { effort: 'low' },
            }),
            signal,
        });
    } catch (error) {
        if (signal.aborted) return { items: [], terminal: { kind: signal.reason?.name === 'TimeoutError' ? 'timeout' : 'cancelled' } };
        return { items: [], terminal: { kind: 'unreachable' } };
    }
    if (!response.ok || !response.body) {
        const detail = await providerErrorDetail(response);
        return { items: [], terminal: { kind: 'http', status: response.status, detail } };
    }
    const items = [];
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let buffer = '';
    let terminal = null;
    const finish = (kind, detail) => { terminal = { kind, ...(detail ? { detail } : {}) }; };
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > RESPONSE_MAX_BYTES) return { items: [], terminal: { kind: 'oversized' } };
            buffer += decoder.decode(value, { stream: true });
            let separator;
            while ((separator = /\r?\n\r?\n/.exec(buffer)) !== null) {
                const event = parseEventBlock(buffer.slice(0, separator.index));
                buffer = buffer.slice(separator.index + separator[0].length);
                if (!event || typeof event.type !== 'string') continue;
                if (event.type === 'response.output_item.done' && event.item) items.push(event.item);
                else if (event.type === 'response.completed') {
                    if (items.length === 0 && Array.isArray(event.response?.output)) items.push(...event.response.output);
                    finish('completed');
                } else if (event.type === 'response.failed') {
                    finish('failed', cleanProviderProse(event.response?.error?.message ?? event.response?.error?.code, '', 200));
                } else if (event.type === 'response.incomplete') {
                    finish('incomplete', cleanProviderProse(event.response?.incomplete_details?.reason, '', 80));
                } else if (event.type === 'error') {
                    finish('failed', cleanProviderProse(event.message, '', 200));
                }
                if (terminal) break;
            }
            if (terminal) break;
        }
    } catch (error) {
        return { items, terminal: { kind: signal.aborted ? (signal.reason?.name === 'TimeoutError' ? 'timeout' : 'cancelled') : 'disconnected' } };
    } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
    }
    // A stream that ends without a terminal event is an error, never a result.
    if (!terminal) finish('disconnected');
    return { items, terminal };
}

const receiptAnswer = (executed) => executed
    .map(({ output }) => output)
    .join(' ')
    .slice(0, ANSWER_MAX_CHARS);

export function createCodexDelegation({ getCredential, runTool } = {}) {
    if (typeof getCredential !== 'function' || typeof runTool !== 'function') {
        throw new Error('createCodexDelegation requires getCredential and runTool callbacks.');
    }
    const lifetime = new AbortController();
    let closed = false;
    // Bounded conversational memory for this voice session: pending targets,
    // messages and results survive across follow-up runs; closed() clears it.
    const history = [];
    let planning = Promise.resolve();

    const failureAnswer = (executed) => {
        if (executed.length > 0) {
            // Side effects already happened: report their exact receipts, never retry.
            return `The Codex planner stream ended early. Results so far — ${receiptAnswer(executed)}`;
        }
        return 'The Codex planning request failed. No action was performed.';
    };

    async function delegateToolCall(call, operationId, signal, executed) {
        const callId = call.call_id;
        const id = createHash('sha256').update(JSON.stringify([operationId, callId])).digest('hex');
        pushCapped(history, { type: 'function_call', name: call.name, arguments: typeof call.arguments === 'string' ? call.arguments : '{}', call_id: callId });
        let output;
        if (typeof call.name !== 'string' || !call.name) {
            output = 'The planned tool call had no name. No action was performed.';
        } else if (typeof call.arguments !== 'string') {
            output = 'The planned tool arguments were not JSON. No action was performed.';
        } else {
            try {
                output = await runTool(call.name, JSON.parse(call.arguments), id, signal);
            } catch (error) {
                output = signal.aborted ? 'The work request was cancelled.' : 'The work request could not be completed. No action was confirmed.';
            }
        }
        output = String(output).slice(0, TOOL_OUTPUT_MAX_BYTES);
        executed.push({ name: String(call.name ?? 'planned tool'), output });
        pushCapped(history, { type: 'function_call_output', call_id: callId, output });
        return output;
    }

    async function naturalTurn(request, operationId, callerSignal, deadline) {
        if (lifetime.signal.aborted || callerSignal?.aborted || deadline.aborted) return 'The delegated request was cancelled before starting.';
        if (!RESPONSES_URL) {
            return 'Voice delegation is disabled in test mode without a loopback endpoint override. No action was performed.';
        }
        let credential;
        try {
            credential = await getCredential();
        } catch {
            return 'Voice delegation is unavailable because the Codex credential could not be loaded. No action was performed.';
        }
        if (!credential || typeof credential.token !== 'string' || !credential.token
            || typeof credential.account !== 'string' || !credential.account) {
            return 'Voice delegation is unavailable because the Codex credential is incomplete. No action was performed.';
        }
        pushCapped(history, messageItem('user', request));
        const signal = AbortSignal.any([lifetime.signal, deadline, ...(callerSignal ? [callerSignal] : [])]);
        const executed = [];
        for (let turn = 0; turn < MAX_MODEL_TURNS; turn++) {
            const { items, terminal } = await planTurn({ credential, input: history, model: DEFAULT_MODEL, signal: AbortSignal.any([signal, AbortSignal.timeout(TURN_TIMEOUT_MS)]) });
            if (terminal.kind !== 'completed') {
                // Cancelled or timed out: run nothing new; report what already executed.
                if (terminal.kind === 'cancelled' || terminal.kind === 'timeout') {
                    const word = terminal.kind === 'cancelled' ? 'cancelled' : 'timed out';
                    return executed.length > 0 ? `The voice delegation was ${word}. Results so far — ${receiptAnswer(executed)}` : `The voice delegation was ${word} before completing. No action was performed.`;
                }
                if (terminal.kind === 'http') {
                    return executed.length > 0 ? failureAnswer(executed) : `The Codex planning request was rejected (HTTP ${terminal.status})${terminal.detail ? `: ${terminal.detail}` : ''}. No action was performed.`;
                }
                return failureAnswer(executed);
            }
            const calls = items.filter((item) => item?.type === 'function_call');
            if (calls.some((call) => typeof call.call_id !== 'string' || !call.call_id || call.call_id.length > 160
                || typeof call.arguments !== 'string' || byteLength(call.arguments) > MAX_REQUEST_BYTES)) return failureAnswer(executed);
            const text = items.filter((item) => item?.type === 'message').map(itemText).join(' ').trim();
            if (calls.length === 0) {
                const answer = cleanProviderProse(text, executed.length > 0 ? `Results — ${receiptAnswer(executed)}` : 'No answer was produced, and no action was performed.', ANSWER_MAX_CHARS);
                pushCapped(history, messageItem('assistant', answer));
                return answer;
            }
            for (const call of calls) {
                if (executed.length >= MAX_TOOL_CALLS) {
                    const callId = typeof call.call_id === 'string' && call.call_id ? call.call_id : `planned_${turn}`;
                    pushCapped(history, { type: 'function_call', name: String(call.name ?? ''), arguments: typeof call.arguments === 'string' ? call.arguments : '{}', call_id: callId });
                    pushCapped(history, { type: 'function_call_output', call_id: callId, output: 'The tool budget for this request is exhausted; no further tools may run.' });
                    continue;
                }
                if (signal.aborted) break;
                await delegateToolCall(call, operationId, signal, executed);
            }
        }
        // Turn budget exhausted after real tool work: return the exact receipts.
        return cleanProviderProse(`Here is the result — ${receiptAnswer(executed)}`, 'The delegation reached its turn limit. No action was performed.', ANSWER_MAX_CHARS);
    }

    return {
        async run(request, operationId, signal) {
            if (closed) return 'The voice delegation service is closed.';
            if (typeof request !== 'string' || !request.trim() || byteLength(request) > MAX_REQUEST_BYTES) {
                return 'The delegated request was empty or too large. No action was performed.';
            }
            if (typeof operationId !== 'string' || !operationId.trim() || operationId.length > MAX_OPERATION_ID_CHARS) {
                return 'The delegation operation identity was invalid. No action was performed.';
            }
            let structured;
            try { structured = JSON.parse(request); } catch { structured = undefined; }
            if (structured && typeof structured === 'object' && !Array.isArray(structured) && typeof structured.name === 'string') {
                // Structured catalog JSON runs directly through the existing
                // runtime: same authorization, bounds, dedupe and receipts.
                const deadline = AbortSignal.timeout(RUN_DEADLINE_MS);
                const combined = AbortSignal.any([lifetime.signal, deadline, ...(signal ? [signal] : [])]);
                try {
                    return String(await runTool(structured.name, structured.arguments ?? {}, operationId, combined));
                } catch {
                    return combined.aborted ? 'The work request was cancelled.' : 'The work request could not be completed. No action was confirmed.';
                }
            }
            try {
                const deadline = AbortSignal.timeout(RUN_DEADLINE_MS);
                const operation = planning.then(() => naturalTurn(request, operationId, signal, deadline));
                planning = operation.then(() => undefined, () => undefined);
                return await operation;
            } catch (error) {
                if (lifetime.signal.aborted) return 'The voice delegation was cancelled. Its outcome is unconfirmed; do not repeat an action automatically.';
                return 'The voice delegation could not be completed. Its outcome is unconfirmed; do not repeat an action automatically.';
            }
        },
        close() {
            if (closed) return;
            closed = true;
            lifetime.abort();
            history.length = 0;
        },
    };
}
