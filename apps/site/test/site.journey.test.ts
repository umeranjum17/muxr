import { createServer, type Server } from 'node:http';
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

    it('lands the phone\'s Add your computer link on a desktop download only the catalog vouches for', async () => {
        const tag = 'v0.2.9';
        const asset = (name: string) => `https://github.com/umeranjum17/muxr/releases/download/${tag}/${name}`;
        const stable = (linux: unknown) => ({ schema: 1, channels: { stable: {
            version: '0.2.9', appVersion: '0.2.9', tag, releaseUrl: `https://github.com/umeranjum17/muxr/releases/tag/${tag}`,
            npmDistTag: 'latest', publishedAt: '2026-10-14T10:00:00.000Z', manifestUrl: asset('release-manifest.json'),
            android: { url: asset('muxr-0.2.9-400.apk'), sha256: 'a'.repeat(64), bytes: 170_000_000, versionCode: 400, applicationId: 'com.trymuxr.app' },
            ...(linux === undefined ? {} : { linux }),
        } } });
        let catalog: unknown = stable({ url: asset('muxr-0.2.9.AppImage'), sha256: 'b'.repeat(64), bytes: 120_000_000 });
        const fixture = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(catalog)); });
        await new Promise<void>((ready) => fixture.listen(0, '127.0.0.1', () => ready()));
        const fixtureAddress = fixture.address();
        if (fixtureAddress === null || typeof fixtureAddress === 'string') throw new Error('catalog fixture did not bind');
        process.env.MUXR_RELEASE_CATALOG_URL = `http://127.0.0.1:${fixtureAddress.port}/channels.json`;
        // A fresh server per catalog: each one caches its own read.
        const desktopPage = async () => {
            const site = createSiteServer();
            await new Promise<void>((ready) => site.listen(0, '127.0.0.1', () => ready()));
            const address = site.address();
            if (address === null || typeof address === 'string') throw new Error('site did not bind');
            try {
                const res = await fetch(`http://127.0.0.1:${address.port}/desktop`);
                expect(res.status).toBe(200);
                return await res.text();
            } finally {
                await new Promise<void>((closed) => site.close(() => closed()));
            }
        };
        try {
            const offered = await desktopPage();
            expect(offered).toContain(`href="${asset('muxr-0.2.9.AppImage')}"`);
            expect(offered).toContain('Download for Linux');
            expect(offered).toContain('npm install -g --ignore-scripts @trymuxr/cli@latest');

            // A download pointing anywhere but the release's own asset is never offered.
            catalog = stable({ url: 'https://example.com/muxr-0.2.9.AppImage', sha256: 'b'.repeat(64), bytes: 120_000_000 });
            const foreign = await desktopPage();
            expect(foreign).not.toContain('example.com');
            expect(foreign).toContain('not published yet');

            catalog = stable(undefined);
            const unpublished = await desktopPage();
            expect(unpublished).not.toContain('Download for Linux');
            expect(unpublished).toContain('not published yet');
            expect(unpublished).toContain('npm install -g --ignore-scripts @trymuxr/cli@latest');

            // The channel's linux route redirects at the record's own asset,
            // and answers 404 — never another channel's bytes — when the
            // record carries no validated desktop download.
            const linuxLocation = async () => {
                const site = createSiteServer();
                await new Promise<void>((ready) => site.listen(0, '127.0.0.1', () => ready()));
                const address = site.address();
                if (address === null || typeof address === 'string') throw new Error('site did not bind');
                try {
                    const res = await fetch(`http://127.0.0.1:${address.port}/downloads/stable/linux`, { redirect: 'manual' });
                    await res.arrayBuffer();
                    return res;
                } finally {
                    await new Promise<void>((closed) => site.close(() => closed()));
                }
            };
            catalog = stable({ url: asset('muxr-0.2.9.AppImage'), sha256: 'b'.repeat(64), bytes: 120_000_000 });
            const linuxRedirect = await linuxLocation();
            expect(linuxRedirect.status).toBe(302);
            expect(linuxRedirect.headers.get('location')).toBe(asset('muxr-0.2.9.AppImage'));

            catalog = stable({ url: 'https://example.com/muxr-0.2.9.AppImage', sha256: 'b'.repeat(64), bytes: 120_000_000 });
            const foreignLinux = await linuxLocation();
            expect(foreignLinux.status).toBe(404);
            expect(foreignLinux.headers.get('location')).toBeNull();

            catalog = stable(undefined);
            const missingLinux = await linuxLocation();
            expect(missingLinux.status).toBe(404);
        } finally {
            delete process.env.MUXR_RELEASE_CATALOG_URL;
            await new Promise<void>((closed) => fixture.close(() => closed()));
        }
    }, 30_000);
});
