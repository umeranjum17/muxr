export function stripTrailingSlashes(value: string): string {
    let end = value.length;
    while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
    return value.slice(0, end);
}

export function relayControlUrl(relayUrl: string, path = ''): string {
    const relay = new URL(relayUrl);
    if (relay.protocol !== 'ws:' && relay.protocol !== 'wss:') {
        throw new TypeError('relay URL must use ws:// or wss://');
    }
    if (relay.username !== '' || relay.password !== '') {
        throw new TypeError('relay URL must not contain credentials');
    }
    if (path !== '' && !path.startsWith('/')) {
        throw new TypeError('control path must start with /');
    }
    relay.protocol = relay.protocol === 'ws:' ? 'http:' : 'https:';
    // Control routes are mounted at origin /v1; relay path/query belong only to websocket ingress.
    return `${relay.origin}${path}`;
}
