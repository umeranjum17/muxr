import { expect, it, vi } from 'vitest';

const { request, ssh } = vi.hoisted(() => ({
    request: vi.fn(),
    ssh: { active: false, open: vi.fn(async (port: number) => port + 1000), close: vi.fn(async () => undefined) },
}));
vi.mock('@/catalog', () => ({ sync: { request } }));
vi.mock('@/connection', () => ({
    sshRouteActive: () => ssh.active,
    openSshForward: ssh.open,
    closeSshForward: ssh.close,
}));

import { createDesktopSignaling } from './desktopSignaling';

it('delivers the initial offer, candidate and revocation even when polling wins the subscription race', async () => {
    let polled!: () => void;
    const pollFinished = new Promise<void>((resolve) => { polled = resolve; });
    request.mockImplementation(async (method: string) => {
        if (method === 'desktop.open') return { desktopId: 'desktop-1', generation: 1, source: {}, geometry: {} };
        if (method === 'desktop.poll') {
            polled();
            return { cursor: 3, events: [
                { kind: 'offer', sdp: 'v=0 offer' },
                { kind: 'candidate', candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0 },
                { kind: 'revoked', reason: 'the desktop ended' },
            ] };
        }
        throw new Error(`unexpected request: ${method}`);
    });
    const signaling = createDesktopSignaling({ permissions: ['view'] });
    await signaling.request('session.open');
    await pollFinished;
    await new Promise((resolve) => setTimeout(resolve, 0));

    const received: unknown[] = [];
    signaling.subscribe((event) => received.push(event));
    expect(received).toEqual([
        { kind: 'description', description: { type: 'offer', sdp: 'v=0 offer' } },
        { kind: 'candidate', candidate: { candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0 } },
        { kind: 'revoked', reason: 'the desktop ended' },
    ]);
    expect(request).toHaveBeenCalledTimes(2);
    await signaling.request('session.close');
    request.mockReset();
});

it('carries the picture through the SSH connection when that is the only way to the computer', async () => {
    const loopback = 'candidate:5 1 tcp 1671430143 127.0.0.1 43519 typ host tcptype passive';
    const run = async (active: boolean) => {
        ssh.active = active;
        let polled!: () => void;
        const pollFinished = new Promise<void>((resolve) => { polled = resolve; });
        request.mockImplementation(async (method: string) => {
            if (method === 'desktop.open') return { desktopId: 'desktop-2', generation: 1, source: {}, geometry: {} };
            if (method === 'desktop.poll') {
                polled();
                return { cursor: 2, events: [
                    { kind: 'offer', sdp: `v=0\r\na=${loopback}\r\na=mid:0` },
                    { kind: 'candidate', candidate: loopback, sdpMid: '0', sdpMLineIndex: 0 },
                ] };
            }
            return { closed: true };
        });
        const signaling = createDesktopSignaling({ permissions: ['view'] });
        const received: Array<{ kind: string; description?: { sdp: string }; candidate?: { candidate: string } }> = [];
        signaling.subscribe((event) => received.push(event as (typeof received)[number]));
        await signaling.request('session.open');
        await pollFinished;
        await new Promise((resolve) => setTimeout(resolve, 0));
        await signaling.request('session.close');
        return { received, open: request.mock.calls.find(([method]) => method === 'desktop.open')?.[1] };
    };

    // On the Direct SSH route: asked for, forwarded over the tunnel, dialled locally.
    const tunnelled = await run(true);
    expect(tunnelled.open).toMatchObject({ loopbackTcp: true });
    expect(tunnelled.received[0]?.description?.sdp).toBe('v=0\r\na=mid:0');
    expect(tunnelled.received[1]?.candidate?.candidate).toBe('candidate:5 1 tcp 1671430143 127.0.0.1 44519 typ host tcptype passive');
    expect(ssh.open).toHaveBeenCalledWith(43519);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ssh.close).toHaveBeenCalledWith(44519);

    // Any other route: not asked for, and a loopback port on the computer is never dialled here.
    request.mockReset();
    ssh.open.mockClear();
    const direct = await run(false);
    expect(direct.open).not.toHaveProperty('loopbackTcp');
    expect(direct.received.map((event) => event.kind)).toEqual(['description']);
    expect(ssh.open).not.toHaveBeenCalled();
    request.mockReset();
});
