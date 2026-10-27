import { lstatSync } from 'node:fs';
import { createConnection } from 'node:net';

/**
 * A computer's one pairing link, `http(s)://<tailnet address>/join#<secret>`
 * (`muxr link`). The relay never keeps the secret: opening the link loads the
 * page below, which keeps it in the fragment; the muxr app then posts it here,
 * and the relay hands it to the host on this computer over its owner-only
 * pair.sock. The host checks it against selfhost.json and opens one native
 * pairing that needs no approval; the relay returns that offer and holds the
 * socket until the phone finishes or the deadline passes.
 */

/** How long one redeemed offer may wait for its phone before the pairing closes. */
const REDEEM_MS = 150_000;

export type RedeemResult = { ok: true; offer: string } | { ok: false; status: number; error: string };

export function redeemPairLink(socketPath: string, secret: string): Promise<RedeemResult> {
    try {
        const info = lstatSync(socketPath);
        if (!info.isSocket() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) {
            return Promise.resolve({ ok: false, status: 503, error: 'This computer is not ready to pair. Start muxr on it and try again.' });
        }
    } catch {
        return Promise.resolve({ ok: false, status: 503, error: 'muxr is not running on this computer. Start it there, then open the link again.' });
    }
    return new Promise((resolve) => {
        let answered = false;
        const answer = (result: RedeemResult) => { if (!answered) { answered = true; resolve(result); } };
        const socket = createConnection(socketPath);
        const timer = setTimeout(() => socket.destroy(), REDEEM_MS);
        socket.on('connect', () => socket.write(`${JSON.stringify({ intent: { kind: 'native', authority: 'control', personal: false }, link: secret })}\n`));
        let input = '';
        socket.on('data', (chunk) => {
            input += chunk.toString('utf8');
            if (input.length > 65_536) { socket.destroy(); return; }
            const lines = input.split('\n');
            input = lines.pop() ?? '';
            for (const line of lines) {
                let event: { offer?: { text?: unknown }; error?: unknown };
                try { event = JSON.parse(line) as typeof event; } catch { socket.destroy(); return; }
                if (typeof event.offer?.text === 'string') answer({ ok: true, offer: event.offer.text });
                else if (typeof event.error === 'string') {
                    answer({ ok: false, status: /no longer works/.test(event.error) ? 403 : 409, error: event.error });
                }
            }
        });
        socket.on('error', () => answer({ ok: false, status: 503, error: 'muxr is not running on this computer. Start it there, then open the link again.' }));
        socket.on('close', () => {
            clearTimeout(timer);
            answer({ ok: false, status: 503, error: 'This computer stopped the pairing. Open the link again.' });
        });
    });
}

/** The page a browser shows for the link: open the app, or install it and come back. */
export const PAIR_LINK_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer"><meta name="color-scheme" content="light dark"><title>Pair with muxr</title>
<style>
:root{--bg:#f6f6f4;--card:#fff;--text:#161616;--muted:#5c5c5c;--accent:#161616;--on-accent:#fff;--line:#e2e2de}
@media (prefers-color-scheme:dark){:root{--bg:#0f0f0f;--card:#1b1b1b;--text:#f2f2f2;--muted:#a8a8a8;--accent:#f2f2f2;--on-accent:#111;--line:#2c2c2c}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:440px;margin:0 auto;padding:32px 16px 48px}h1{font-size:26px;line-height:1.2;margin:0 0 8px}h2{font-size:18px;margin:0 0 8px}
p,li{color:var(--muted);margin:0 0 10px}.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:20px 16px;margin-top:20px}
a.button{display:block;text-align:center;background:var(--accent);color:var(--on-accent);text-decoration:none;font-weight:600;border-radius:12px;padding:14px 16px;margin:14px 0 8px}
a.quiet{color:var(--text)}#missing{color:var(--text)}[hidden]{display:none}ol{padding-left:20px;margin:0}code{word-break:break-all}
</style></head><body><main>
<h1>Pair this phone with your computer</h1>
<p>This private link pairs the muxr app with the computer that made it. Keep it to yourself.</p>
<p class="card" id="missing" hidden>This link is cut off: the part after # is missing. Run <code>muxr link</code> on your computer and open it again.</p>
<div class="card" id="have"><h2>Have muxr?</h2>
<a class="button" id="open" href="#">Open in muxr</a>
<p>Using the preview app? <a class="quiet" id="preview" href="#">Open in muxr Preview</a></p>
<p>Or copy this page's address and paste it into muxr's first screen.</p></div>
<div class="card"><h2>Don't have muxr yet?</h2><ol>
<li>Install it: <a class="quiet" href="https://trymuxr.com/downloads/stable/android">Android</a> or <a class="quiet" href="https://testflight.apple.com/join/aJSbs8pN">iPhone (TestFlight)</a>.</li>
<li>Turn on Tailscale on this phone, signed in to the same account as your computer.</li>
<li>Come back to this link and tap Open in muxr. The link keeps working.</li></ol></div>
</main><script>
(function(){var to=encodeURIComponent(location.href);
if(location.hash.length<2){document.getElementById('missing').hidden=false;document.getElementById('have').hidden=true;}
document.getElementById('open').href='muxr://join?to='+to;
document.getElementById('preview').href='muxr-preview://join?to='+to;})();
</script></body></html>
`;
