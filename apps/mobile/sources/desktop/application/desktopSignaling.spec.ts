import { createElement } from 'react';
import TestRenderer from 'react-test-renderer';
import { connect } from 'node:net';
import { expect, it, vi } from 'vitest';

const { request, ssh, linkStreams, openDesktopTcpStream } = vi.hoisted(() => {
    const linkStreams: unknown[] = [];
    return {
        request: vi.fn(),
        ssh: { active: false, open: vi.fn(async (port: number) => port + 1000), close: vi.fn(async () => undefined) },
        linkStreams,
        /** The link's `desktop.tcp` stream, played by an engine port that echoes. */
        openDesktopTcpStream: async (args: unknown) => {
            linkStreams.push(args);
            let reader: ((chunk: Uint8Array) => unknown) | undefined;
            let ender: (() => void) | undefined;
            return {
                set onData(fn: (chunk: Uint8Array) => unknown) { reader = fn; },
                set onEnd(fn: () => void) { ender = fn; },
                write: async (chunk: Uint8Array) => { await reader?.(chunk); },
                end: () => ender?.(),
            };
        },
    };
});
vi.mock('@/catalog', () => ({ sync: { request, openDesktopTcpStream } }));
// The phone's native TCP listener has node's own API.
vi.mock('react-native-tcp-socket', async () => ({ default: await import('node:net') }));
vi.mock('@/connection', () => ({
    sshRouteActive: () => ssh.active,
    openSshForward: ssh.open,
    closeSshForward: ssh.close,
}));

vi.mock('react-native', () => ({ Platform: { OS: 'android' }, AppState: { addEventListener: () => ({ remove: () => undefined }) } }));
vi.mock('expo-modules-core', () => ({
    requireOptionalNativeModule: () => ({ createSession: () => 'native-1', isAvailable: () => true, setInputEnabled: () => true, closeSession: () => true, addListener: () => ({ remove: () => undefined }) }),
}));

import { desktopCopy } from '../model/desktopCopy';
import { describeDesktopOverlay } from '../model/desktopOverlay';
import { useDesktopSession, type DesktopSession } from '../../../../../node_modules/@desklink/react-native/src/useDesktopSession';
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
                // The engine revoking the open for a lost phone, before any frame.
                { kind: 'revoked', reason: 'the connection to the phone was lost', code: 'transport' },
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
        { kind: 'revoked', reason: 'the connection to the phone was lost', code: 'transport' },
    ]);
    expect(request).toHaveBeenCalledTimes(2);
    await signaling.request('session.close');
    request.mockReset();
});

it('carries the picture over TCP through SSH, else through the link, when no direct path exists', async () => {
    const loopback = 'candidate:5 1 tcp 1671430143 127.0.0.1 43519 typ host tcptype passive';
    const run = async (active: boolean, whileOpen: (candidate: string) => Promise<void> = async () => undefined) => {
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
        await vi.waitFor(() => expect(received).toHaveLength(2));
        await whileOpen(received[1]!.candidate!.candidate);
        await signaling.request('session.close');
        return { received, open: request.mock.calls.find(([method]) => method === 'desktop.open')?.[1] };
    };
    const dial = (port: number) => new Promise<string>((resolve, reject) => {
        const socket = connect(port, '127.0.0.1', () => socket.write('dtls hello'));
        socket.on('data', (chunk) => { resolve(chunk.toString()); socket.destroy(); });
        socket.on('error', reject);
    });

    // On the Direct SSH route: asked for, forwarded over the tunnel, dialled locally.
    const tunnelled = await run(true);
    expect(tunnelled.open).toMatchObject({ loopbackTcp: true });
    expect(tunnelled.received[0]?.description?.sdp).toBe('v=0\r\na=mid:0');
    expect(tunnelled.received[1]?.candidate?.candidate).toBe('candidate:5 1 tcp 1671430143 127.0.0.1 44519 typ host tcptype passive');
    expect(ssh.open).toHaveBeenCalledWith(43519);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ssh.close).toHaveBeenCalledWith(44519);

    // Through the relay alone: a local port whose connections ride a link stream to the engine port.
    request.mockReset();
    ssh.open.mockClear();
    let bridgePort = 0;
    const linked = await run(false, async (candidate) => {
        bridgePort = Number(/127\.0\.0\.1 (\d+) typ/.exec(candidate)?.[1]);
        expect(candidate).toBe(`candidate:5 1 tcp 1671430143 127.0.0.1 ${bridgePort} typ host tcptype passive`);
        expect(await dial(bridgePort)).toBe('dtls hello');
    });
    expect(linked.open).toMatchObject({ loopbackTcp: true });
    expect(linkStreams).toEqual([{ desktopId: 'desktop-2', port: 43519 }]);
    expect(ssh.open).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(dial(bridgePort)).rejects.toThrow(/ECONNREFUSED/);
    request.mockReset();
});

it('ends a first open the engine revokes for a lost path as the no-connection message', async () => {
    let served = false;
    request.mockImplementation(async (method: string) => {
        if (method === 'desktop.open') return { desktopId: 'desktop-3', generation: 1, source: {}, geometry: {} };
        if (method === 'desktop.poll') {
            const events = served ? [] : [{ kind: 'revoked', reason: 'the connection to the phone was lost', code: 'transport' }];
            served = true;
            return { cursor: 1, events };
        }
        return { closed: true };
    });
    const signaling = createDesktopSignaling({ permissions: ['view'] });
    let session!: DesktopSession;
    const Probe = () => {
        session = useDesktopSession({ authorize: async () => ({ signaling, session: { permissions: ['view'] } }) });
        return null;
    };
    let renderer!: ReturnType<typeof TestRenderer.create>;
    TestRenderer.act(() => { renderer = TestRenderer.create(createElement(Probe)); });
    await TestRenderer.act(async () => { await session.connect(); });
    await vi.waitFor(() => expect(session.snapshot.status).toBe('failed'), { timeout: 5000 });
    expect(session.snapshot.failure?.code).toBe('never-connected');
    expect(describeDesktopOverlay(session.snapshot)).toMatchObject({ title: desktopCopy.unreachableTitle, detail: desktopCopy.unreachableBody });
    TestRenderer.act(() => renderer.unmount());
    request.mockReset();
});
