/**
 * The owner-only socket behind `muxr accounts`: a person at this computer, or
 * an agent in one of its panes, listing the Claude sign-ins and starting or
 * moving an agent on one by hand. It forwards a fixed set of requests to the
 * same dispatcher the phone uses, so a move here and a move on the phone are
 * one code path. Nothing here chooses an account: `auto` is refused.
 */
import { chmodSync, existsSync, lstatSync, renameSync, unlinkSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import type { ClientFrame, HostFrame } from '@trymuxr/contract';

/** What `muxr accounts` may ask. Reads plus the two by-hand changes. */
const ALLOWED = new Set(['plans.list', 'plans.agent', 'plans.move', 'session.list', 'session.start']);
const MAX_REQUEST_BYTES = 8192;

export type LocalAnswer = (frame: ClientFrame, senderId: string) => Promise<HostFrame | undefined>;

function refusal(error: string): string {
    return `${JSON.stringify({ ok: false, error })}\n`;
}

export async function startLocalAccountsServer(socketPath: string, answer: LocalAnswer): Promise<{ close(): Promise<void> }> {
    if (existsSync(socketPath)) {
        const info = lstatSync(socketPath);
        if (!info.isSocket() || info.isSymbolicLink() || info.uid !== process.getuid!()) throw new Error('unsafe accounts socket path');
        unlinkSync(socketPath);
    }
    const sockets = new Set<Socket>();
    let next = 0;
    const server = createServer((socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        socket.on('error', () => socket.destroy());
        let input = '';
        socket.on('data', (chunk) => {
            input += chunk.toString('utf8');
            if (input.length > MAX_REQUEST_BYTES) { socket.destroy(); return; }
            const end = input.indexOf('\n');
            if (end < 0) return;
            const line = input.slice(0, end);
            input = '';
            void (async () => {
                let request: { type?: unknown; params?: unknown };
                try { request = JSON.parse(line); } catch { socket.end(refusal('not a request')); return; }
                if (typeof request.type !== 'string' || !ALLOWED.has(request.type)) { socket.end(refusal('that request is not available here')); return; }
                const params = (typeof request.params === 'object' && request.params !== null ? request.params : {}) as Record<string, unknown>;
                // Choosing an account is the person's; Auto is a phone setting this socket never reaches.
                if (params.planAccount === 'auto' || params.accountId === 'auto') { socket.end(refusal('name an account; muxr does not choose one for you')); return; }
                try {
                    const reply = await answer({ type: request.type, requestId: `local-${next += 1}`, params } as unknown as ClientFrame, 'local');
                    if (reply?.type === 'result' && reply.ok) socket.end(`${JSON.stringify({ ok: true, data: reply.data })}\n`);
                    else if (reply?.type === 'result') socket.end(refusal(reply.error));
                    else socket.end(refusal('the host gave no answer'));
                } catch (error) {
                    socket.end(refusal(error instanceof Error ? error.message : String(error)));
                }
            })();
        });
    });
    // Bind under a private name and rename once it is owner-only, so the final
    // path never exists at the umask mode.
    const bindPath = `${socketPath}.${process.pid}`;
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(bindPath, () => { server.off('error', reject); chmodSync(bindPath, 0o600); renameSync(bindPath, socketPath); resolve(); });
    });
    return {
        close: async () => {
            for (const socket of sockets) socket.destroy();
            await new Promise((resolve) => server.close(resolve));
            if (existsSync(socketPath) && lstatSync(socketPath).isSocket()) unlinkSync(socketPath);
        },
    };
}
