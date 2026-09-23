import { expect, it, vi } from 'vitest';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('@/catalog', () => ({ sync: { request } }));

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
