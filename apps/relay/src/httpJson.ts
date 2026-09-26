import type { IncomingMessage, ServerResponse } from 'node:http';

export function readJsonBody(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        req.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > 256 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
            chunks.push(Buffer.from(chunk));
        });
        req.on('end', () => {
            if (chunks.length === 0) { resolve({}); return; }
            try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
            catch (error) { reject(error); }
        });
        req.on('error', reject);
    });
}

export function writeJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
}

export function writeJsonError(res: ServerResponse, status: number, message: string): void {
    res.writeHead(status, { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: message }));
}
