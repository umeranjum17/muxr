import type TcpSocket from 'react-native-tcp-socket';

import { sync } from '@/catalog';

/** A local port standing in for one of the computer's, until `close`. */
export interface TcpCarrier {
    port: number;
    close: () => void;
}

/**
 * A port on this phone's loopback for the desktop engine's passive TCP
 * candidate: each connection the phone's WebRTC makes to it is carried to that
 * engine port over one `desktop.tcp` link stream, through the relay if that is
 * the only way to the computer. Every byte crosses the JS bridge, so this is the
 * path of last resort; ICE prefers a direct one when it exists.
 */
export async function openLinkTcpBridge(desktopId: string, enginePort: number): Promise<TcpCarrier> {
    // Loaded on first use: most sessions never need the native listener.
    const { default: Tcp } = await import('react-native-tcp-socket');
    const sockets = new Set<TcpSocket.Socket>();
    const server = Tcp.createServer({ pauseOnConnect: true }, (socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        socket.on('error', () => socket.destroy());
        const opening = sync.openDesktopTcpStream({ desktopId, port: enginePort }) ?? Promise.resolve(undefined);
        opening.then((stream) => {
            if (stream === undefined || !sockets.has(socket)) { stream?.end(); socket.destroy(); return; }
            socket.on('data', (chunk) => {
                socket.pause();
                stream.write(typeof chunk === 'string' ? chunk : new Uint8Array(chunk)).then(() => socket.resume(), () => socket.destroy());
            });
            socket.on('end', () => stream.end());
            socket.on('close', () => stream.end());
            stream.onData = (chunk) => new Promise<void>((resolve) => {
                if (socket.write(chunk)) { resolve(); return; }
                const settle = (): void => { socket.off('drain', settle); socket.off('close', settle); resolve(); };
                socket.on('drain', settle);
                socket.on('close', settle);
            });
            stream.onEnd = () => { socket.destroy(); };
            socket.resume();
        }, () => socket.destroy());
    });
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen({ port: 0, host: '127.0.0.1' }, () => {
            const address = server.address();
            if (address === null) { server.close(); reject(new Error('the desktop bridge has no port')); return; }
            resolve({
                port: address.port,
                close: () => {
                    server.close();
                    for (const socket of sockets) socket.destroy();
                },
            });
        });
    });
}
