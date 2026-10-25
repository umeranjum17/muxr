// Task-owned lab for Home's herd sentence: a private fake-Herdr stack (real
// relay, host and E2EE pairing) whose one agent's Herdr lifecycle this harness
// holds, so each state the card can speak can be captured and held still.
// Run from the repo root: node <this file> (its perf/lib import is repo-relative)
//   LAB_TRANSPORT=adb SERIAL=<emulator> node <this>   (native phone lab)
// stdin lines: "<agent number> <status>" sets a lifecycle ("1 blocked"),
// "1 off" closes that agent's pane (the empty-Herdr case), and
// "browser" mints a browser pairing link for the installed PWA.
import { createConnection } from 'node:net';
import { startFakeStack } from '../../../../perf/lib/fakeStack.mjs';

const agents = Number(process.env.LAB_AGENTS ?? 1);
const stack = await startFakeStack({ transport: process.env.LAB_TRANSPORT ?? 'loopback', panes: agents, agents, titleChurnHz: 0 });
// A pane with no Herdr title falls back to its folder, which on a lab machine
// is a scratch path: give it the words a person reads instead.
const LAB_TITLE = process.env.LAB_TITLE ?? 'Billing import';
let pairing;
const stop = (code = 0) => { pairing?.release(); stack.stop(); process.exit(code); };
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => stop());

let requestId = 0;
const rpc = (method, params) => new Promise((resolve, reject) => {
    const socket = createConnection(stack.cellMetricsJsonl.replace(/\.cell-metrics\.jsonl$/, ''));
    const id = `lab_${requestId += 1}`;
    let buffer = '';
    socket.on('error', reject);
    socket.on('connect', () => socket.write(`${JSON.stringify({ id, method, params })}\n`));
    socket.on('data', (chunk) => {
        buffer += String(chunk);
        for (const line of buffer.split('\n').slice(0, -1)) {
            const message = JSON.parse(line);
            if (message.id !== id) continue;
            socket.destroy();
            message.error == null ? resolve(message.result) : reject(new Error(JSON.stringify(message.error)));
        }
    });
});

const mint = async (kind) => {
    pairing?.release();
    pairing = await stack.mintPairing({ kind });
    console.log(`${kind} code: ${pairing.code}`);
};

process.stdin.setEncoding('utf8').on('data', (chunk) => {
    for (const line of chunk.split('\n').map((text) => text.trim()).filter(Boolean)) {
        if (line === 'browser' || line === 'native') { void mint(line).catch((error) => console.error(error)); continue; }
        const [index, status] = line.split(/\s+/);
        const pane = stack.world.agents[Number(index) - 1]?.pane_id;
        if (pane === undefined || status === undefined) { console.error(`set: no agent ${index}`); continue; }
        const call = status === 'off'
            ? rpc('pane.close', { pane_id: pane })
            : rpc('lab.set_agent_status', { pane_id: pane, agent_status: status, title: LAB_TITLE });
        void call.then(() => console.log(`set: ${pane} ${status}`), (error) => console.error(error));
    }
});

console.log(`lab ready: relay port ${stack.relayPort}, agent panes ${stack.world.agents.map((a) => a.pane_id).join(',')}, pid ${process.pid}`);
