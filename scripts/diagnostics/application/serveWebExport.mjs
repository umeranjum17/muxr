/** Static server for the Expo web export. SPA fallback so expo-router routes resolve. */
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';

const env = (name) => process.env[name]?.trim() || undefined;
const root = env('MUXR_WEB_EXPORT_DIR') || '/tmp/muxr-web-export';
const port = Number(process.env.MUXR_WEB_PORT?.trim() || 8790);
const mime = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.json': 'application/json',
    '.webmanifest': 'application/manifest+json',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.css': 'text/css',
    '.map': 'application/json',
    '.ttf': 'font/ttf',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.wasm': 'application/wasm',
    '.svg': 'image/svg+xml',
};

// Served here, this port is a second origin: the IndexedDB-wrapped browser
// device is keyed by origin, so only the TLS proxy should expose it remotely.
const redirect = env('MUXR_WEB_REDIRECT');
const isLoopback = (address) =>
    address === '::1' || (address ?? '').replace('::ffff:', '').startsWith('127.');

// Diagnostics only: a throwaway TLS pair lets a browser flow exercise the
// HTTPS-only pairing paths against the export. Production TLS is the proxy's.
const tlsKey = env('MUXR_WEB_TLS_KEY');
const tlsCert = env('MUXR_WEB_TLS_CERT');
const createServer = tlsKey !== undefined && tlsCert !== undefined
    ? (handler) => createHttpsServer({ key: readFileSync(tlsKey), cert: readFileSync(tlsCert) }, handler)
    : createHttpServer;
createServer(async (req, res) => {
    if (redirect !== undefined && !isLoopback(req.socket.remoteAddress)) {
        res.writeHead(302, { location: redirect + (req.url ?? '/') });
        res.end();
        return;
    }
    const raw = (req.url ?? '/').split('?')[0] ?? '/';
    let path;
    try { path = normalize(decodeURIComponent(raw)).replace(/^(\.\.[/\\])+/, ''); }
    catch {
        res.writeHead(400);
        res.end('bad request');
        return;
    }
    // SPA fallback: any route without a file extension serves index.html so the
    // client-side router can match it.
    if (path === '/' || extname(path) === '') path = '/index.html';
    const hashedAsset = (file) => /[.-][0-9a-f]{8,}(?:[.-]|$)/i.test(file.split('/').pop() ?? '');
    try {
        const body = await readFile(join(root, path));
        // Mutable entries revalidate so a cached index.html can never pin the
        // client to chunks a re-export deleted. Mirrors the relay serveWeb rule.
        const entry = path === '/index.html' || path === '/sw.js' || path === '/manifest.webmanifest';
        let cacheControl = 'public, max-age=0, must-revalidate';
        if (entry) cacheControl = 'no-store';
        else if (hashedAsset(path)) cacheControl = 'public, max-age=31536000, immutable';
        res.writeHead(200, {
            'content-type': mime[extname(path)] ?? 'application/octet-stream',
            'content-security-policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws: wss:; media-src 'self' blob:; frame-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
            'x-content-type-options': 'nosniff',
            'referrer-policy': 'no-referrer',
            'cache-control': cacheControl,
        });
        res.end(body);
    } catch {
        try {
            const body = await readFile(join(root, 'index.html'));
            res.writeHead(200, {
                'content-type': 'text/html',
                'cache-control': 'no-store',
                'content-security-policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws: wss:; media-src 'self' blob:; frame-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
                'x-content-type-options': 'nosniff',
                'referrer-policy': 'no-referrer',
            });
            res.end(body);
        } catch {
            res.writeHead(404);
            res.end('not found');
        }
    }
}).listen(port, env('MUXR_WEB_HOST') ?? '127.0.0.1');
process.stdout.write(`web export on ${tlsKey === undefined ? 'http' : 'https'}://127.0.0.1:${port}\n`);
