/**
 * Browser preview, device end.
 *
 * The listener lives on the phone's own loopback and the relay only forwards
 * frames, so the preview URL is `http://127.0.0.1:<port>/`: a secure context to
 * the WebView, private to the device, and reachable no matter how the relay is
 * published. A relay-side ephemeral port cannot do that -- it is unreachable
 * behind a tunnel that proxies 443 only, and plain HTTP across the internet
 * where it is reachable.
 */

import TcpSocket from 'react-native-tcp-socket';
import { deriveV2Key, openPreviewPayload, sealPreviewPayload } from '@muxr/crypto';
import { decodePreviewFrame, encodePreviewFrame, PREVIEW_CLOSE, PREVIEW_DATA } from '@muxr/contract';

export interface PreviewBridge {
    port: number;
    close: () => void;
}

export const previewBridgeAvailable = true;

type Server = ReturnType<typeof TcpSocket.createServer>;
type Connection = InstanceType<typeof TcpSocket.Socket>;

function toBytes(data: string | Buffer): Uint8Array {
    if (typeof data !== 'string') return new Uint8Array(data);
    // The library hands text back as base64 only when asked; a string here is
    // binary read as latin1, so map it back byte for byte.
    const bytes = new Uint8Array(data.length);
    for (let index = 0; index < data.length; index += 1) bytes[index] = data.charCodeAt(index) & 0xff;
    return bytes;
}

export async function startPreviewBridge(socket: WebSocket, key: string): Promise<PreviewBridge> {
    const clientToHostKey = deriveV2Key(key, 'client->host');
    const hostToClientKey = deriveV2Key(key, 'host->client');
    const connections = new Map<number, Connection>();
    let nextConnId = 0;
    let server: Server | undefined;

    const send = (connId: number, flag: number, payload?: Uint8Array): void => {
        const body = payload === undefined ? undefined : sealPreviewPayload(payload, clientToHostKey);
        if (socket.readyState === WebSocket.OPEN) socket.send(encodePreviewFrame(connId, flag, body));
    };

    socket.onmessage = (event) => {
        if (typeof event.data === 'string') return;
        const frame = decodePreviewFrame(new Uint8Array(event.data as ArrayBuffer));
        if (frame === undefined) return;
        const connection = connections.get(frame.connId);
        if (connection === undefined) return;
        if (frame.flag === PREVIEW_CLOSE) {
            connections.delete(frame.connId);
            connection.destroy();
            return;
        }
        if (frame.payload.length > 0) {
            try {
                connection.write(Buffer.from(openPreviewPayload(frame.payload, hostToClientKey)));
            } catch {
                connections.delete(frame.connId);
                connection.destroy();
                send(frame.connId, PREVIEW_CLOSE);
            }
        }
    };

    const close = (): void => {
        for (const connection of connections.values()) connection.destroy();
        connections.clear();
        server?.close();
        if (socket.readyState === WebSocket.OPEN) socket.close();
    };

    const port = await new Promise<number>((resolve, reject) => {
        server = TcpSocket.createServer((connection) => {
            nextConnId += 1;
            const connId = nextConnId;
            connections.set(connId, connection);
            connection.on('data', (data) => send(connId, PREVIEW_DATA, toBytes(data)));
            connection.on('close', () => { connections.delete(connId); send(connId, PREVIEW_CLOSE); });
            connection.on('error', () => { connections.delete(connId); send(connId, PREVIEW_CLOSE); });
        });
        server.on('error', (error: Error) => reject(error));
        // Loopback only: nothing else on the network may reach the dev server.
        server.listen({ port: 0, host: '127.0.0.1' }, () => {
            const address = server?.address();
            if (address === undefined || address === null || typeof address === 'string') {
                reject(new Error('The preview listener did not report a port.'));
                return;
            }
            resolve(address.port);
        });
    }).catch((error: unknown) => {
        close();
        throw error;
    });

    return { port, close };
}
