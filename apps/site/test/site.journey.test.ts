import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSiteServer } from '../src/site.js';

// One end-to-end journey over the real product: the actual site server from
// src/site.ts, listening on a real socket, answering real HTTP requests. It
// replaces the stubbed unit tests for the download routes, media ranges and the
// landing/pages content with a single drive of the served site.

let server: Server;
let base: string;

beforeAll(async () => {
    server = createSiteServer();
    await new Promise<void>((ready) => server.listen(0, '127.0.0.1', () => ready()));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('site server did not bind a TCP port');
    base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
    if (server.listening) await new Promise<void>((closed) => server.close(() => closed()));
});

const get = (path: string, init?: RequestInit) => fetch(`${base}${path}`, init);

describe('published site journey', () => {
    it('serves every page, resolves every asset it points at, and streams range-capable media', async () => {
        const landing = await get('/');
        expect(landing.status).toBe(200);
        expect(landing.headers.get('content-type')).toContain('text/html');
        const html = await landing.text();
        expect(html).toContain('<h1>');
        expect(html).toContain('id="install"');

        // Every same-origin asset and internal link the landing page renders must
        // resolve on the real server — the regression that let assets 404.
        const refs = [...html.matchAll(/(?:src|href)="(\/[^"]*)"/g)].map((match) => match[1]!);
        expect(refs.length).toBeGreaterThan(8);
        const assets = [...new Set(refs)].filter((ref) => !ref.startsWith('/downloads'));
        for (const ref of assets) {
            const res = await get(ref);
            expect(res.status, ref).toBeLessThan(400);
            await res.arrayBuffer();
        }

        // The other pages the site serves render as HTML.
        for (const path of ['/docs', '/docs/quickstart', '/pair', '/privacy', '/support', '/opensource']) {
            const res = await get(path);
            expect(res.status, path).toBe(200);
            expect(res.headers.get('content-type'), path).toContain('text/html');
            await res.text();
        }

        // Unknown routes: a page for people, JSON for probes.
        const pageMiss = await get('/does-not-exist', { headers: { accept: 'text/html' } });
        expect(pageMiss.status).toBe(404);
        expect(pageMiss.headers.get('content-type')).toContain('text/html');
        await pageMiss.text();
        const jsonMiss = await get('/does-not-exist');
        expect(jsonMiss.status).toBe(404);
        expect(await jsonMiss.json()).toEqual({ error: 'not_found' });

        // Range-capable media answer on the real socket, so a <video> probe works.
        const probe = await get('/demo.mp4', { headers: { range: 'bytes=0-1' } });
        expect(probe.status).toBe(206);
        expect(probe.headers.get('content-range')).toMatch(/^bytes 0-1\/\d+$/);
        expect((await probe.arrayBuffer()).byteLength).toBe(2);

        // The hero film ships as WebM beside the MP4 fallback.
        const film = await get('/film/gate-16x9.webm');
        expect(film.status).toBe(200);
        expect(film.headers.get('content-type')).toBe('video/webm');

        // Download routes are wired: served when the catalog reads, 503 when it
        // cannot be read from here, and a redirect (never a 404) for the channel.
        const index = await get('/downloads');
        expect([200, 503]).toContain(index.status);
        await index.text();
        const android = await get('/downloads/stable/android', { redirect: 'manual' });
        expect([302, 503]).toContain(android.status);
    }, 60_000);
});
