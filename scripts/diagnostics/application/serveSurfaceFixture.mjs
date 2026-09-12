/**
 * Loopback fixture for the Web Surface feasibility path.
 *
 * Stands in for a dev server with hot reload: one HTTP page, one same-origin
 * WebSocket that pushes live updates and echoes what the page sends. Bound to
 * 127.0.0.1 on purpose -- reaching it from a phone at all is the thing the
 * encrypted preview tunnel is being tested for.
 *
 *   node scripts/diagnostics/application/serveSurfaceFixture.mjs [port]
 */
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>muxr surface fixture</title>
<style>body{margin:0;font:17px/1.5 system-ui,sans-serif;background:#101014;color:#f4efe4;padding:20px}
h1{font-size:22px;margin:0 0 4px}.pill{display:inline-block;padding:6px 10px;border-radius:999px;background:#d14523;font:600 13px ui-monospace,monospace}
#live{margin:18px 0;padding:16px;border-radius:12px;background:#1d1d24;font:15px/1.6 ui-monospace,monospace;word-break:break-all}
input,button{font:inherit;padding:12px;border-radius:10px;border:1px solid #3a3a45;background:#1d1d24;color:inherit;width:100%;margin:6px 0}
#log{white-space:pre-wrap;font:13px/1.5 ui-monospace,monospace;color:#b9b3a5}</style></head>
<body><h1>muxr surface fixture</h1><span class="pill" id="state">connecting</span>
<div id="live">waiting for the first push</div>
<p>Type here to check the software keyboard, selection and paste:</p>
<input id="typing" placeholder="type, select, paste, undo" autocapitalize="off" autocorrect="off">
<button id="send">Send this text over the WebSocket</button>
<div id="log"></div>
<script>
var state=document.getElementById('state'),live=document.getElementById('live'),log=document.getElementById('log');
var socket=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'/hmr');
var pushes=0;
socket.onopen=function(){state.textContent='websocket open';state.style.background='#5f7a5a';};
socket.onclose=function(){state.textContent='websocket closed';state.style.background='#9c2f17';};
socket.onerror=function(){state.textContent='websocket error';state.style.background='#9c2f17';};
socket.onmessage=function(event){
  pushes+=1;
  live.textContent=event.data;
  live.style.background=pushes%2?'#22303a':'#1d1d24';
  log.textContent='pushes received: '+pushes+'\\n'+log.textContent.split('\\n').slice(0,6).join('\\n');
};
document.getElementById('send').onclick=function(){
  if(socket.readyState===1)socket.send(document.getElementById('typing').value||'(empty)');
};
</script></body></html>`;

/** Serve the fixture on `port` (0 picks a free one). Resolves with the port. */
export async function serveSurfaceFixture(port = 0) {
    const http = createServer((request, response) => {
        if (request.url === '/health') {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ ok: true, url: request.url }));
            return;
        }
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        response.end(PAGE);
    });
    const sockets = new WebSocketServer({ server: http, path: '/hmr' });
    let tick = 0;
    // The push loop is the hot-reload stand-in: a real update arriving on the
    // page without the phone asking for it.
    const timer = setInterval(() => {
        tick += 1;
        for (const socket of sockets.clients) {
            if (socket.readyState === socket.OPEN) socket.send(`update ${tick} at ${new Date().toISOString()}`);
        }
    }, 1000);
    timer.unref();
    sockets.on('connection', (socket) => {
        socket.send(`connected at ${new Date().toISOString()}`);
        socket.on('message', (raw) => socket.send(`echo: ${String(raw).slice(0, 200)}`));
    });

    await new Promise((resolve) => http.listen(port, '127.0.0.1', resolve));
    return http.address().port;
}

if (process.argv[1]?.endsWith('serveSurfaceFixture.mjs')) {
    const requested = Number(process.argv[2] ?? 0);
    const bound = await serveSurfaceFixture(Number.isInteger(requested) ? requested : 0);
    process.stdout.write(`surface fixture on http://127.0.0.1:${bound}/  (websocket at /hmr)\n`);
    process.stdout.write(`open the muxr Web Surface and enter port ${bound}\n`);
}
