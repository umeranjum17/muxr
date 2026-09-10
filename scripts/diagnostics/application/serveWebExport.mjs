/** Static server for the Expo web export. SPA fallback so expo-router routes resolve. */
import { createServer } from 'node:http';
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
    try {
        const body = await readFile(join(root, path));
        // Mutable entries revalidate so a cached index.html can never pin the
        // client to chunks a re-export deleted. Mirrors the relay serveWeb rule.
        const entry = path === '/index.html' || path === '/sw.js' || path === '/manifest.webmanifest';
        res.writeHead(200, {
            'content-type': mime[extname(path)] ?? 'application/octet-stream',
            'content-security-policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws: wss:; media-src 'self' blob:; frame-src 'none'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
            'x-content-type-options': 'nosniff',
            'referrer-policy': 'no-referrer',
            ...(entry ? { 'cache-control': 'no-store' } : {}),
        });
        res.end(body);
    } catch {
        try {
            const body = await readFile(join(root, 'index.html'));
            res.writeHead(200, {
                'content-type': 'text/html',
                'cache-control': 'no-store',
                'content-security-policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws: wss:; media-src 'self' blob:; frame-src 'none'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
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
process.stdout.write(`web export on http://127.0.0.1:${port}\n`);
