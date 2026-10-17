// Helpers for computer-no-video-path.md, run with plain `node`.
//   bridge tcp2unix <port> <sock>  listen on 127.0.0.1:<port>, forward to a unix socket
//   bridge unix2tcp <sock> <port>  listen on a unix socket, forward to 127.0.0.1:<port>
//   tap <debug port> <aria-label>  a real CDP mouse click on the last visible element with that label
// A unix socket crosses network namespaces through the shared filesystem, so a
// browser in `unshare -rn` reaches the web export and the relay over TCP only:
// no UDP path, the same shape as a phone behind adb reverse.
import { createServer, connect } from 'node:net';
import { rmSync } from 'node:fs';

const [command, ...rest] = process.argv.slice(2);
if (command === 'bridge') {
    const [mode, a, b] = rest;
    const pipe = (incoming, outgoing) => {
        incoming.pipe(outgoing).pipe(incoming);
        const end = () => { incoming.destroy(); outgoing.destroy(); };
        incoming.on('error', end);
        outgoing.on('error', end);
    };
    if (mode === 'tcp2unix') createServer((socket) => pipe(socket, connect(b))).listen(Number(a), '127.0.0.1');
    else if (mode === 'unix2tcp') { rmSync(a, { force: true }); createServer((socket) => pipe(socket, connect(Number(b), '127.0.0.1'))).listen(a); }
    else throw new Error(`unknown bridge mode ${mode}`);
} else if (command === 'tap') {
    // chrome-devtools-axi `click` did not open Pane actions on the web build; a real mouse event does.
    const [port, label] = rest;
    const page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((target) => target.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve) => ws.addEventListener('open', resolve));
    let id = 0;
    const waiting = new Map();
    ws.addEventListener('message', (event) => { const message = JSON.parse(event.data); waiting.get(message.id)?.(message); });
    const send = (method, params) => new Promise((resolve) => { id += 1; waiting.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
    const found = await send('Runtime.evaluate', { returnByValue: true, expression: `(() => {
        const e = [...document.querySelectorAll('[aria-label]')].filter((n) => n.getAttribute('aria-label') === ${JSON.stringify(label)} && n.getClientRects().length).at(-1);
        if (!e) return null; const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()` });
    const at = found.result?.result?.value;
    if (!at) { console.log(`no element: ${label}`); process.exit(1); }
    for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: at[0], y: at[1], button: 'left', clickCount: 1 });
    console.log(`tapped ${label}`);
    ws.close();
} else {
    throw new Error('usage: bridge tcp2unix|unix2tcp … | tap <port> <label>');
}
