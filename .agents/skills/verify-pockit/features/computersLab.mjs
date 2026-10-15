// A two-host lab for the Computers sheet. Each instance owns one fake-Herdr
// stack (real relay, host and E2EE pairing) and takes its machine name from the
// process hostname, so run one instance per host inside its own UTS namespace:
//
//   unshare -Ur --uts -- sh -c 'hostname Study-PC; exec node <abs>/computersLab.mjs A'
//   unshare -Ur --uts -- sh -c 'hostname Desk-Mac; exec node <abs>/computersLab.mjs B'
//
// Run from the repo root (the fake stack is imported from ./perf/lib). Each
// instance prints `host <label> (<name>) ready: relay <port>` and a pairing
// link; PAIR_KIND=native prints a code the pair screen pastes, PAIR_KIND=browser
// prints a link for `window.__MUXR_LAB_PAIR__`. Stdin commands: `mint`
// (re-print a fresh link), `stop` (stop this host — its paired row then reads
// Offline, or Asleep when it is the connected one), `quit`.
import { createServer } from 'node:net';
import { hostname } from 'node:os';

const { startFakeStack } = await import(`${process.cwd()}/perf/lib/fakeStack.mjs`);

const label = process.argv[2] ?? 'A';
const kind = process.env.PAIR_KIND ?? 'browser';
const name = hostname();
const panes = Number(process.env.LAB_PANES ?? 4);
const agents = Number(process.env.LAB_AGENTS ?? 4);
const socketPath = process.env.LAB_SOCK ?? `/tmp/muxr-computers-lab-${label}.sock`;

const stack = await startFakeStack({ transport: 'loopback', panes, agents, titleChurnHz: 0 });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const online = () => stack.hostLog().includes('link relay: online');
for (let i = 0; i < 200 && !online(); i += 1) await sleep(200);
if (!online()) { process.stderr.write(`host ${label} never came online\n`); stack.stop(); process.exit(1); }

let pairing;
const mint = async () => {
    pairing?.release();
    pairing = await stack.mintPairing({ kind });
    console.log(`pairing link: ${pairing.code}`);
};

// A control socket mirrors the host's own control surface: `mint`, `stop`.
const server = createServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk) => {
        buffer += String(chunk);
        for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
            const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
            let request; try { request = JSON.parse(line); } catch { socket.write('{"error":"bad json"}\n'); continue; }
            if (request.cmd === 'mint') void mint().then(() => socket.write(`${JSON.stringify({ ok: true })}\n`));
            else if (request.cmd === 'stop') { socket.write(`${JSON.stringify({ ok: true })}\n`); shutdown(0); }
            else socket.write(`${JSON.stringify({ error: `unknown ${request.cmd}` })}\n`);
        }
    });
});
server.listen(socketPath);

function shutdown(code = 0) {
    pairing?.release();
    try { stack.stop(); } catch { /* already gone */ }
    try { server.close(); } catch { /* already closed */ }
    process.exit(code);
}
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => shutdown());

console.log(`host ${label} (${name}) ready: relay ${stack.relayPort}, link kind ${kind}, sock ${socketPath}`);
await mint();

process.stdin.setEncoding('utf8').on('data', (chunk) => {
    for (const command of chunk.split('\n').map((text) => text.trim()).filter(Boolean)) {
        if (command === 'mint') void mint().catch((error) => console.error(error));
        else if (command === 'stop') shutdown();
        else if (command === 'quit') process.exit(0);
        else console.error(`unknown command: ${command}`);
    }
});
