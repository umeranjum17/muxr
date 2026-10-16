// A private browser-pairing lab: a fake-Herdr stack (real relay, host and E2EE
// pairing) that mints a browser pairing link and can drive a pane's Herdr
// lifecycle. Serve the exported web client separately with `serveWebExport.mjs`
// and pair it with `window.__MUXR_LAB_PAIR__(<browser link>)` or the pair
// screen. Run from the repo root (`node --input-type=module -e "$(< …/browserPairLab.mjs)"`)
// so `./perf/lib` resolves. See lab-browser-pairing.md.
import { createConnection } from 'node:net';
import { startFakeStack } from './perf/lib/fakeStack.mjs';

// No status churn: the lab drives the agents' status itself so a proof can
// hold the exact needs-you count it wants. LAB_AGENTS raises the herd above two.
const agents = Number(process.env.LAB_AGENTS ?? 2);
const stack = await startFakeStack({ transport: 'loopback', panes: agents, agents, titleChurnHz: 0 });
let pairing;
const stop = (code = 0) => { pairing?.release(); stack.stop(); process.exit(code); };
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => stop());

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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

// Each SIGUSR1 mints one browser pairing link (eight hours), approved by this
// throwaway host. The socket stays open so the PWA can finish the claim.
const mint = async () => {
    pairing?.release();
    pairing = await stack.mintPairing({ kind: 'browser' });
    console.log(`browser link: ${pairing.code}`);
};
process.on('SIGUSR1', () => void mint().catch((error) => console.error(error)));

// SIGUSR2 walks the needs-you count 0 → 1 → 2 → 1 → 0 by blocking then idling
// the two agents in turn, so a badge proof records setAppBadge(1), (2), (1),
// clearAppBadge().
const drive = async () => {
    const panes = stack.world.agents.map((agent) => agent.pane_id);
    if (panes.length < 2) throw new Error('the lab needs two agents');
    for (const [pane, status, hold] of [
        [panes[0], 'blocked', 4_000], [panes[1], 'blocked', 30_000], [panes[0], 'idle', 4_000], [panes[1], 'idle', 1_000],
    ]) {
        await rpc('lab.set_agent_status', { pane_id: pane, agent_status: status });
        console.log(`drive: ${pane} ${status}`);
        await sleep(hold);
    }
    console.log('drive: done');
};
process.on('SIGUSR2', () => void drive().catch((error) => console.error(error)));

// A stdin line `<agent number> <status>` ("1 blocked", "3 idle") sets one
// agent's lifecycle, for a proof that needs its own order and holds.
process.stdin.setEncoding('utf8').on('data', (chunk) => {
    for (const line of chunk.split('\n').map((text) => text.trim()).filter(Boolean)) {
        const [index, status] = line.split(/\s+/);
        const pane = stack.world.agents[Number(index) - 1]?.pane_id;
        if (pane === undefined || status === undefined) { console.error(`set: no agent ${index}`); continue; }
        void rpc('lab.set_agent_status', { pane_id: pane, agent_status: status })
            .then(() => console.log(`set: ${pane} ${status}`), (error) => console.error(error));
    }
});

console.log(`lab ready: relay port ${stack.relayPort}, agent panes ${stack.world.agents.map((a) => a.pane_id).join(',')}, pid ${process.pid}`);
try {
    await mint();
} catch (error) {
    console.error(error);
    stop(1);
}
