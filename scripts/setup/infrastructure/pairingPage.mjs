import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { qrMatrix } from '@byokit/ui-core/link';

// This is only a local display of the running host's BYOKit offer, not a
// pairing endpoint. Binding loopback and checking Host prevents DNS rebinding.
export async function startPairingPage() {
    const path = `/${randomBytes(16).toString('hex')}`;
    const nonce = randomBytes(24).toString('base64');
    let offer;
    let svg;
    let url;
    const server = createServer((req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`);
        if (req.method !== 'GET' || req.headers.host !== new URL(url).host) { res.writeHead(403).end(); return; }
        if (req.url === `${path}/offer`) {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(offer?.expires > Date.now() ? { text: offer.text, expires: offer.expires, svg } : null));
            return;
        }
        if (req.url !== path) { res.writeHead(404).end(); return; }
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Pair muxr</title><style nonce="${nonce}">
body{font:18px system-ui;max-width:680px;margin:24px auto;padding:0 16px;background:#fff;color:#111}
svg{display:block;width:min(100%,400px);height:auto;margin:16px auto}input{box-sizing:border-box;width:100%;font:14px monospace;padding:12px}button{font:inherit;margin-top:12px;padding:8px 16px}
</style><h1>Pair your phone</h1><p>Scan with the muxr app. Compare the two words, then approve on the computer. Keep this code private.</p>
<div id="qr"></div><p id="expiry" role="status">Waiting for a pairing code…</p>
<label for="token">Pairing string</label><input id="token" readonly spellcheck="false"><button id="copy" disabled>Copy pairing string</button>
<script nonce="${nonce}">
const token=document.getElementById('token'), qr=document.getElementById('qr'), expiry=document.getElementById('expiry'), copy=document.getElementById('copy');
let expires=0;
function clear(message){token.value='';qr.replaceChildren();copy.disabled=true;expiry.textContent=message;}
async function update(){
 try{const response=await fetch(location.pathname+'/offer',{cache:'no-store'});if(!response.ok)throw new Error('Pairing page unavailable');const offer=await response.json();
 if(!offer){clear('Code expired. Waiting for a fresh code…');return;}expires=offer.expires;
 if(token.value!==offer.text){token.value=offer.text;qr.innerHTML=offer.svg;copy.disabled=false;}
 expiry.textContent='Expires at '+new Date(expires).toLocaleTimeString()+'. Codes refresh here automatically.';
 }catch{clear('Pairing stopped. Run muxr pair again on the computer.');}
}
copy.onclick=async()=>{try{await navigator.clipboard.writeText(token.value);expiry.textContent='Pairing string copied.';}catch{token.focus();token.select();expiry.textContent='Copy the selected pairing string.';}};
setInterval(()=>{if(expires<=Date.now())clear('Code expired. Waiting for a fresh code…');void update();},1000);void update();
</script></html>`);
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    url = `http://127.0.0.1:${server.address().port}${path}`;
    return {
        url,
        update(next) {
            const matrix = qrMatrix(next.text, { border: 4 });
            const squares = matrix.flatMap((row, y) => row.flatMap((dark, x) => dark ? [`<rect x="${x}" y="${y}" width="1" height="1"/>`] : [])).join('');
            svg = `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Pairing QR" viewBox="0 0 ${matrix.length} ${matrix.length}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="white"/><g fill="black">${squares}</g></svg>`;
            offer = next;
        },
        close: () => new Promise((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections(); }),
    };
}
