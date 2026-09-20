#!/usr/bin/env node
/**
 * Realtime parity probe child.
 *
 * Runs as the real host's plugin-stream child, so it holds the real
 * MUXR_VOICE_COORDINATOR_SOCKET / MUXR_VOICE_COORDINATOR_CAPABILITY the host
 * issued for this stream. It drives the real provider-facing tool runtime
 * (apps/host/src/voice/toolRuntime.mjs -> coordinatorPolicy.mjs) exactly as a provider
 * adapter does, one tool call at a time, and reports the real coordinator
 * results over the real stream.
 *
 * Only the LLM's token choice is scripted here; every layer below the model is
 * production code talking to real Herdr.
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// The host passes PATH, HOME and the plugin state dir to a stream child; the
// probe's configuration travels in that state dir rather than the environment.
const stateDir = process.env.MUXR_PLUGIN_STATE_DIR;
const config = JSON.parse(readFileSync(join(stateDir, 'parity-config.json'), 'utf8'));
const root = process.cwd();
const agent = config.agent;
const evidencePath = join(stateDir, 'child-result.json');
const { createVoiceTools } = await import(`${root}/apps/host/src/voice/toolRuntime.mjs`);
const { runCodingTool } = await import(`${root}/apps/host/src/voice/coordinatorPolicy.mjs`);

const emit = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
const tools = createVoiceTools(emit, { timeoutMs: 150000 });
const results = [];
const record = (step, value, error) => {
    results.push({ step, ...(error === undefined ? { value } : { error: String(error) }) });
    // Stream frames are bounded and validated by the real host, so the probe
    // reports a short spoken summary and keeps the full result in its evidence.
    const summary = `${step}: ${error === undefined ? String(value).slice(0, 200) : `threw ${error}`}`;
    emit({ type: 'realtime.transcript', role: 'agent', text: summary.slice(0, 2000) });
};
const call = async (step, name, args, operationId) => {
    try {
        const value = String(await tools.run(name, args, operationId));
        record(step, value);
        return value;
    } catch (error) {
        record(step, undefined, error);
        return undefined;
    }
};

// The prompt carries the three parts separately, so the joined token exists in
// the transcript only if the agent really answered.
const first = 'KESTREL';
const second = '9f42';
const third = 'MIDNIGHT';
const joined = `${first}${second}${third}`;
const promptText = `Join these three parts with no spaces or punctuation and reply with only the joined token: part one is ${first}, part two is ${second}, part three is ${third}. Then stop.`;

let started = false;
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
    for (const line of chunk.split('\n')) {
        if (line.trim() === '') continue;
        appendFileSync(join(stateDir, 'stdin.log'), `${line}\n`);
        if (started) continue;
        let frame;
        try { frame = JSON.parse(line); } catch { continue; }
        if (frame.type !== 'realtime.say' || frame.text !== 'PARITY_RUN') continue;
        started = true;
        void (async () => {
            try {
                await call('list_agents', 'list_agents', { limit: 20 }, 'parity-list');
                await call('agent_status', 'agent_status', { agent }, 'parity-status');
                await call('read_agent_output', 'read_agent_output', { agent, lines: 200 }, 'parity-read');

                const queued = await call('prompt_agent', 'prompt_agent', { agent, text: promptText }, 'parity-prompt');
                // Same operation id through the provider-facing runtime: the
                // runtime must replay its own receipt, never re-issue the call.
                await call('prompt_agent_same_operation', 'prompt_agent', { agent, text: promptText }, 'parity-prompt');
                // Same operation id straight to the coordinator, bypassing the
                // runtime cache: the coordinator's replay fence must answer from
                // its receipt instead of sending a second Herdr prompt.
                try {
                    record('prompt_agent_coordinator_replay', String(await runCodingTool('prompt_agent', { agent, text: promptText }, 'parity-prompt')));
                } catch (error) {
                    record('prompt_agent_coordinator_replay', undefined, error);
                }
                record('prompt_receipts', JSON.stringify({ queued }));

                const deadline = Date.now() + 240_000;
                let answered;
                while (Date.now() < deadline) {
                    const text = await call('read_agent_output_poll', 'read_agent_output', { agent, lines: 400 }, `parity-read-${Date.now()}`) ?? '';
                    if (text.includes(joined)) { answered = joined; break; }
                    await new Promise((resolve) => setTimeout(resolve, 3000));
                }
                record('agent_answer', answered ?? 'NOT-FOUND');
            } finally {
                writeFileSync(evidencePath, `${JSON.stringify({ agent, joined, promptText, results }, null, 2)}\n`);
                emit({ type: 'realtime.transcript', role: 'agent', text: 'PARITY_DONE' });
                tools.close();
                setTimeout(() => process.exit(0), 200);
            }
        })();
    }
});
emit({ type: 'realtime.state', state: 'connected' });
