import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDownloadRoutes } from './downloads.js';
import { ReleaseChannels } from './releaseChannels.js';
import {
    writeDoc,
    writeDocsIndex,
    writeLanding,
    writeLandingScript,
    writeMedia,
    writeNotFound,
    writeOpenSource,
    writePair,
    writeScreenshot,
    writeStorePage,
} from './website.js';

function json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, {
        'cache-control': 'no-store',
        'content-type': 'application/json; charset=utf-8',
        'strict-transport-security': 'max-age=31536000; includeSubDomains',
        'x-content-type-options': 'nosniff',
    });
    res.end(JSON.stringify(body));
}

function values(name: string): string[] {
    return (process.env[name] ?? '').split(',').map((value) => value.trim()).filter(Boolean);
}

/** The real site server, without starting it: entry points and tests both use this. */
export function createSiteServer(): Server {
    // A lab or staging site reads its own catalog; every entry is validated the same.
    const downloads = createDownloadRoutes(new ReleaseChannels({ url: process.env.MUXR_RELEASE_CATALOG_URL?.trim() || undefined }));
    return createServer((req, res) => { void route(req, res, downloads); });
}

async function route(req: IncomingMessage, res: ServerResponse, downloads: ReturnType<typeof createDownloadRoutes>): Promise<void> {
    const url = new URL(req.url ?? '/', 'https://trymuxr.com');
    const path = url.pathname;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        json(res, 405, { error: 'method_not_allowed' });
        return;
    }
    if (path === '/ready' || path === '/health') {
        json(res, 200, { ok: true });
        return;
    }
    if (path === '/.well-known/assetlinks.json') {
        const packageName = process.env.MUXR_APP_ID_BASE?.trim() || 'com.trymuxr.app';
        const fingerprints = [...new Set(values('MUXR_ANDROID_CERT_FINGERPRINTS').concat(values('MUXR_ANDROID_SHA256_CERT_FINGERPRINTS')))]
            .filter((value) => /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(value));
        if (!packageName || fingerprints.length === 0) json(res, 404, { error: 'not_configured' });
        else json(res, 200, [{
            relation: ['delegate_permission/common.handle_all_urls'],
            target: { namespace: 'android_app', package_name: packageName, sha256_cert_fingerprints: fingerprints },
        }]);
        return;
    }
    if (path === '/.well-known/apple-app-site-association') {
        const appId = process.env.MUXR_APP_ID_BASE?.trim();
        const teamId = process.env.MUXR_APPLE_TEAM_ID?.trim();
        if (!appId || !teamId) json(res, 404, { error: 'not_configured' });
        else json(res, 200, { applinks: { details: [{ appIDs: [`${teamId}.${appId}`], components: [{ '/': '/pair' }] }] } });
        return;
    }
    try {
        if (await downloads(path, res)) return;
    } catch {
        json(res, 503, { error: 'release_catalog_unavailable' });
        return;
    }
    if (path === '/') writeLanding(res);
    else if ((path === '/favicon.ico' || path === '/apple-touch-icon.png') && writeScreenshot(res, path.slice(1), 'docs/icons')) return;
    else if (path === '/landing.js' && writeLandingScript(res)) return;
    else if (path === '/opensource') writeOpenSource(res);
    else if ((path === '/privacy' || path === '/support') && writeStorePage(res, path.slice(1))) return;
    else if (path === '/docs') writeDocsIndex(res);
    else if (path === '/setup') writeDoc(res, 'quickstart');
    else if (path.startsWith('/docs/') && writeDoc(res, path.slice('/docs/'.length))) return;
    else if (path.startsWith('/marketing/') && writeScreenshot(res, path.slice('/marketing/'.length), 'docs/marketing')) return;
    else if (path.startsWith('/icons/') && writeScreenshot(res, path.slice('/icons/'.length), 'docs/icons')) return;
    else if (path === '/demo.mp4' && writeMedia(res, 'demo.mp4', 'docs/media', req.headers.range)) return;
    else if (path.startsWith('/film/') && (writeMedia(res, path.slice('/film/'.length), 'docs/film', req.headers.range)
        || writeScreenshot(res, path.slice('/film/'.length), 'docs/film'))) return;
    else if (path.startsWith('/herd/') && writeScreenshot(res, path.slice('/herd/'.length), 'docs/herd')) return;
    else if (path.startsWith('/screens/') && writeScreenshot(res, path.slice('/screens/'.length), 'docs/screens')) return;
    else if (path === '/pair') writePair(res);
    // People get a page; scripts and probes keep the JSON answer.
    else if (req.headers.accept?.includes('text/html')) writeNotFound(res);
    else json(res, 404, { error: 'not_found' });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const port = Number(process.env.PORT ?? 8080);
    createSiteServer().listen(port, '0.0.0.0', () => process.stdout.write(`trymuxr.com listening on :${port}\n`));
}
