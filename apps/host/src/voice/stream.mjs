#!/usr/bin/env node
/**
 * The voice stream child: muxr's realtime.open in, @byokit/realtime's engine out.
 *
 * The kit owns the provider session, signaling, frame bounds and tool bounds,
 * and runs the provider in its own credential child. muxr supplies the
 * credential, prompt, tools, internal-id masks and hangup policy.
 */
import { createInterface } from 'node:readline';
import { appBridge, realtimeEngine, toolBridge } from '@byokit/realtime/node';
import { codexAccess, codexDelegate, DELEGATE_TOOL, DELEGATION_FAILURE, PROMPT as CODEX_PROMPT } from './codex.mjs';
import { RUN_DEADLINE_MS } from './codexDelegation.mjs';
import { appControlInstructions, INTERNAL_REFERENCES, isExplicitHangup, voiceCoordinationInstructions, workspaceContext } from './coordinatorPolicy.mjs';
import { secretFor } from './product.mjs';
import { selectedProvider } from './provider.mjs';
import { voiceToolFailure, voiceToolHandlers, voiceTools, voiceToolTimeout } from './voiceTools.mjs';

const PROMPT = `You are the voice interface to a herd of coding agents. You are direct and brief. Speak with bright, upbeat energy and brisk enthusiasm; sound alert and helpful, never sultry or sleepy.

<important>
- Answer in one short sentence unless asked to elaborate. The user understands this work better than you do.
${voiceCoordinationInstructions}
${appControlInstructions}
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

// muxr's model pins where they differ from the kit's defaults.
const MODELS = { gemini: 'gemini-3.1-flash-live-preview' };

// The phone words these for the person; the kit's ChatGPT route closes with bare codes.
const CLOSE_REASONS = {
    'Voice ended.': 'ended',
    'signed-out': 'Codex ChatGPT sign-in expired. Run codex login again.',
    'not-included': 'Codex Voice is not included with this ChatGPT sign-in.',
    'rate-limited': 'Codex Voice is rate limited. Try again later.',
    network: 'Codex Voice could not reach ChatGPT.',
};

const write = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
const closeWith = (reason) => write({ type: 'realtime.closed', reason });

async function main() {
    const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })[Symbol.asyncIterator]();
    const first = await lines.next();
    let open;
    try { open = JSON.parse(first.value ?? ''); } catch { /* checked below */ }
    if (open?.type !== 'realtime.open') throw new Error('realtime stream expected realtime.open first');

    const provider = selectedProvider();
    const codex = provider.id === 'codex';
    // The kit resolves Codex access while the call's media starts; a missing
    // sign-in still closes the call with its remedy. A missing key does too.
    const auth = codex ? { kind: 'plan', access: codexAccess } : { kind: 'key', key: await secretFor(provider).readKey() };

    let engine;
    let hangup = false;
    let drainedHangup;
    const emit = (frame) => {
        if (frame.type === 'realtime.closed') {
            process.stdout.write(`${JSON.stringify({ ...frame, reason: CLOSE_REASONS[frame.reason] ?? frame.reason })}\n`, () => process.exit(0));
            return;
        }
        // Phones on the previous contract reject frames they do not know, and muxr has no use for usage.
        if (frame.type === 'realtime.usage') return;
        write(frame);
        // Codex's hangup is the kit's. PCM goodbyes arrive faster than they play:
        // end once the phone reports the goodbye drained, never leaving the
        // microphone open for long.
        if (codex || frame.type !== 'realtime.transcript') return;
        if (frame.role === 'user') hangup = isExplicitHangup(frame.text);
        else if (hangup) drainedHangup ??= setTimeout(() => engine?.close('ended'), 10_000);
    };
    // stdout backpressure still queues the frame; only a throw means it was not sent.
    const app = appBridge((frame) => { write(frame); });
    const handlers = voiceToolHandlers(app);
    let delegation;
    let bridge;
    if (codex) {
        // Tools a delegation plans run on their own bridge: the delegate call's
        // bridge already reports thinking and awaits the spoken answer.
        const actions = toolBridge({ emit: () => undefined, tools: voiceTools, handlers, timeoutFor: voiceToolTimeout, failure: voiceToolFailure });
        delegation = codexDelegate({ open, actions });
        bridge = toolBridge({
            emit, tools: [DELEGATE_TOOL], handlers: { delegate: delegation.delegate },
            timeoutFor: () => RUN_DEADLINE_MS, failure: () => DELEGATION_FAILURE,
        });
    } else {
        bridge = toolBridge({ emit, tools: voiceTools, handlers, timeoutFor: voiceToolTimeout, failure: voiceToolFailure });
    }
    engine = realtimeEngine({
        engine: codex ? 'chatgpt' : provider.id,
        auth,
        instructions: (codex ? CODEX_PROMPT : PROMPT) + workspaceContext(open),
        tools: codex ? [DELEGATE_TOOL] : voiceTools,
        bridge,
        emit,
        redact: INTERNAL_REFERENCES,
        ...(codex ? { hangup: isExplicitHangup } : {}),
        ...(MODELS[provider.id] ? { model: MODELS[provider.id] } : {}),
        ...(process.env.NODE_ENV === 'test' && process.env.MUXR_TEST_REALTIME_URL ? { endpoint: process.env.MUXR_TEST_REALTIME_URL } : {}),
    });

    for await (const line of lines) {
        if (!line.trim()) continue;
        try {
            const frame = JSON.parse(line);
            if (drainedHangup && frame.type === 'realtime.control' && frame.action === 'output_drained') engine.close('ended');
            else if (!app.receive(frame)) engine.receive(frame);
        } catch { /* the host validates frames before delivery */ }
    }
    delegation?.close();
    engine.close('ended');
}

main().catch((error) => {
    process.stdout.write(`${JSON.stringify({ type: 'realtime.closed', reason: String(error?.message ?? 'Voice could not start.').slice(0, 500) })}\n`, () => process.exit(0));
});
