// Boat sign-in stand-in for the phone: byokit's fake Boat server behind a proxy on a fixed port,
// so a lab APK built with EXPO_PUBLIC_MUXR_BOAT_API=http://127.0.0.1:<port>/api/v1 can link an
// account with no real Boat claim. Token polls answer `authorization_pending` until the phone
// opens the sign-in page (the person approving); BOAT_LAB_APPROVE=never keeps them pending.
// Accepts the email umer@example.com, code 123456. Usage: node boatSignInLab.mjs <port>
// (run from the repo root after `yarn install`) -> prints "boat lab listening on <port>".
import { createServer } from 'node:http';
import { startFakeSandboxServer } from '@byokit/cloud/testing';

const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port <= 0) throw new Error('usage: node boatSignInLab.mjs <port>');
const fake = await startFakeSandboxServer({ claimInterval: 2 });
const fakeOrigin = new URL(fake.url).origin;
const ownOrigin = `http://127.0.0.1:${port}`;
let approved = false;

createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const path = req.url ?? '/';
    console.log(`${req.method} ${path.split('?')[0]}`);
    if (req.method === 'GET' && path.startsWith('/api/boat/agent/identity/claim')) {
        approved = process.env.BOAT_LAB_APPROVE !== 'never';
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><meta name="viewport" content="width=device-width"><body style="font:20px sans-serif;padding:24px">'
            + '<h1>Boat (lab)</h1><p>Code 123456 accepted. muxr can use your Boat account.</p><p>Go back to muxr.</p></body>');
        return;
    }
    if (req.method === 'POST' && path === '/api/boat/agent/identity') approved = false; // each new sign-in waits for its own approval
    if (!approved && path === '/api/boat/oauth2/token' && body.toString().includes('grant-type%3Aclaim')) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'authorization_pending' }));
        return;
    }
    const answer = await fetch(`${fakeOrigin}${path}`, { method: req.method, headers: { 'content-type': req.headers['content-type'] ?? '', authorization: req.headers.authorization ?? '' }, body: req.method === 'GET' ? undefined : body });
    // The fake names its own address in metadata and links; the phone only reaches this proxy.
    const text = (await answer.text()).replaceAll(fakeOrigin, ownOrigin);
    res.writeHead(answer.status, { 'content-type': answer.headers.get('content-type') ?? 'application/json' });
    res.end(text);
}).listen(port, '127.0.0.1', () => console.log(`boat lab listening on ${port}`));
