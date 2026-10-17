import type { TcpCarrier } from './linkTcpBridge';

/**
 * Browser WebRTC dials only the network, never a socket this page holds, so a
 * browser has no way to carry the picture over the link: it needs a direct path.
 */
export const linkTcpBridgeSupported = false;

export function openLinkTcpBridge(): Promise<TcpCarrier> {
    return Promise.reject(new Error('the browser cannot carry the desktop picture over the link'));
}
