import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
    handleNotifyRequest,
    notifyTokenPath,
    readOrCreateNotifyToken,
    type GeneralNotice,
} from './notifyEndpoint.js';

/** One flow: real token file + real loopback HTTP -> 202/400/401. */
describe('POST /v1/notify', () => {
    const servers: Server[] = [];
    afterEach(async () => {
        await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    });

    async function serve(deps: { tokenPath: string; send: (notice: GeneralNotice) => number }): Promise<string> {
        const server = createServer((req, res) => {
            void handleNotifyRequest(req, res, deps);
        });
        servers.push(server);
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        if (typeof address !== 'object' || address === null) throw new Error('no loopback address');
        return `http://127.0.0.1:${address.port}/v1/notify`;
    }

    it('mints an owner-only token, then answers 401/400/202 through it', async () => {
        const home = mkdtempSync(join(tmpdir(), 'muxr-notify-'));
        const tokenPath = notifyTokenPath(home);
        const sent: GeneralNotice[] = [];
        const url = await serve({ tokenPath, send: (notice) => (sent.push(notice), 1) });
        const post = (body: unknown, token?: string) =>
            fetch(url, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
                },
                body: typeof body === 'string' ? body : JSON.stringify(body),
            });

        expect(await (await post({ title: 'Hello' })).status).toBe(401);

        const token = readOrCreateNotifyToken(tokenPath);
        expect(token.length).toBeGreaterThan(31);
        expect(statSync(tokenPath).mode & 0o777).toBe(0o600);

        expect(await (await post({ title: '' }, token)).status).toBe(400);
        expect(await (await post({ title: 'Hello', url: 'ftp://x/y' }, token)).status).toBe(400);
        expect(await (await post('not json', token)).status).toBe(400);

        const ok = await post({ title: 'Hello', body: 'World', url: 'https://example.com/a', id: 'k-1', future: 1 }, token);
        expect(ok.status).toBe(202);
        expect(await ok.json()).toEqual({ id: 'k-1', delivered_to: 1 });
        expect(sent).toEqual([{ title: 'Hello', body: 'World', url: 'https://example.com/a', id: 'k-1' }]);

        const tailnet = await post({ title: 'T', url: 'http://desk.ts.net/x' }, token);
        expect(tailnet.status).toBe(202);
    });
});
