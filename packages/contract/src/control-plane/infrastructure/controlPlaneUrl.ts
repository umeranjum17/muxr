export function isWebSocketRelayUrl(value: string): boolean {
    try {
        const protocol = new URL(value).protocol;
        return protocol === 'ws:' || protocol === 'wss:';
    } catch {
        return false;
    }
}

export function relayControlUrl(relayUrl: string, path = ''): string {
    const relay = new URL(relayUrl);
    if (!isWebSocketRelayUrl(relayUrl)) {
        throw new TypeError('relay URL must use ws:// or wss://');
    }
    if (relay.username !== '' || relay.password !== '') {
        throw new TypeError('Unsafe relay URL: text before “@” is treated as login information, not as part of the computer name. muxr did not connect.');
    }
    if (path !== '' && !path.startsWith('/')) {
        throw new TypeError('control path must start with /');
    }
    const httpProtocol = relay.protocol === 'ws:' ? 'http:' : 'https:';
    relay.protocol = httpProtocol;
    // Control routes are mounted at origin /v1; relay path/query belong only to websocket ingress.
    return `${relay.origin}${path}`;
}
