// A private chat lab without Herdr: the fake-Herdr stack (real relay, host and
// E2EE pairing) with a Claude conversation seeded where the host reads Claude
// logs, so the chat view draws real `chat.read` answers: user bubbles, plain
// replies and tool chips. Run from the repo root
// (`node --input-type=module -e "$(< …/chatFakeLab.mjs)"`). CHAT_LAB_SERIAL
// (an emulator) switches to the adb transport for a native app. SIGUSR1 mints
// a browser link, SIGUSR2 a native one; SIGTERM stops the stack. See chat-view.md.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { startFakeStack } from './perf/lib/fakeStack.mjs';
import { setAndroidSerial } from './perf/lib/deviceTarget.mjs';

// The stack's host inherits this env: never let it find the person's own agent logs.
for (const key of Object.keys(process.env)) if (/^(CLAUDE_CONFIG_DIR|PI_CODING_AGENT_DIR|PI_CONFIG_DIR|CODEX_HOME|OPENCODE_\w+|XDG_(CONFIG|DATA|STATE|CACHE)_HOME)$/.test(key)) delete process.env[key];
const serial = process.env.CHAT_LAB_SERIAL;
if (serial) setAndroidSerial(serial);
const minute = (n) => new Date(Date.now() - (30 - n) * 60_000).toISOString();
const line = (value) => `${JSON.stringify(value)}\n`;
const user = (id, n, content) => line({ type: 'user', uuid: id, timestamp: minute(n), message: { role: 'user', content } });
const reply = (id, n, message, content) => line({ type: 'assistant', uuid: id, timestamp: minute(n), message: { id: message, role: 'assistant', content } });
const tool = (name, input) => ({ type: 'tool_use', id: `toolu_${name}`, name, input });
const conversation = [
    user('u1', 1, 'Review the checkout. Keep free shipping from $50.'),
    reply('a1', 2, 'm1', [tool('Read', { file_path: 'src/checkout/shipping.ts' }), tool('Read', { file_path: 'src/checkout/shipping.test.ts' })]),
    reply('a2', 3, 'm2', [{ type: 'text', text: 'Free shipping starts **above** $50, so an order of exactly `$50` still pays the flat $5.\n\n- An order of exactly $50 is charged today.\n- No test covers an empty cart.\n\nI will fix the first and add a test.' }]),
    reply('a3', 4, 'm3', [tool('Edit', { file_path: 'src/checkout/shipping.ts' }), tool('Bash', { command: 'yarn test shipping', description: 'Run the shipping tests' })]),
    reply('a4', 5, 'm4', [{ type: 'text', text: 'Changed `shipping()` to use `>= 50` and added a test for the $50 edge. All 3 tests pass.' }]),
    user('u2', 6, 'Good. Now check the empty cart, Umer here.'),
    reply('a5', 7, 'm5', [{ type: 'text', text: 'Checking the empty cart.' }, tool('Grep', { pattern: 'subtotal === 0' })]),
    reply('a6', 8, 'm5', [tool('Edit', { file_path: 'src/checkout/shipping.ts' })]),
    reply('a7', 9, 'm6', [{ type: 'text', text: 'An empty cart now pays **$0** shipping, and a test covers it.' }]),
].join('');

const stack = await startFakeStack({
    transport: serial ? 'adb' : 'loopback', panes: 2, agents: 2, titleChurnHz: 0,
    // The host reads Claude logs from the lab HOME, by the pane's cwd and session id.
    setupHome: (home) => {
        const cwd = join(dirname(home), 'herdr', 'project');
        const folder = join(home, '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
        mkdirSync(folder, { recursive: true });
        for (const id of ['gen-1', 'gen-2']) writeFileSync(join(folder, `${id}.jsonl`), conversation);
        return {};
    },
});
let pairing;
const stop = (code = 0) => { pairing?.release(); stack.stop(); process.exit(code); };
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => stop());
const mint = async (kind) => {
    pairing?.release();
    pairing = await stack.mintPairing({ kind });
    console.log(`${kind} link: ${pairing.code}`);
};
process.on('SIGUSR1', () => void mint('browser').catch((error) => console.error(error)));
process.on('SIGUSR2', () => void mint('native').catch((error) => console.error(error)));
console.log(`lab ready: agents ${stack.world.agents.map((agent) => `${agent.agent}=${agent.pane_id}`).join(', ')}, self ${process.pid}`);
setInterval(() => {}, 1 << 30);
