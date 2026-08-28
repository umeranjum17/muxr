export function stripTrailingSlashes(value: string): string {
    let end = value.length;
    while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
    return value.slice(0, end);
}

export function isWebSocketRelayUrl(value: string): boolean {
    try {
        const protocol = new URL(value).protocol;
        return protocol === 'ws:' || protocol === 'wss:';
    } catch {
        return false;
    }
}

export function relayChannelSocketUrl(
    relayUrl: string,
    channelPath: 'terminal' | 'preview' | 'stream',
    options: { machineId: string; channel: string; role: 'machine' | 'client'; token?: string; extraQuery?: readonly string[] },
): string {
    // Hand-built rather than URLSearchParams: this runs on React Native too,
    // where that polyfill is partial.
    const parts = [
        `role=${options.role}`,
        `machineId=${encodeURIComponent(options.machineId)}`,
        `channel=${encodeURIComponent(options.channel)}`,
    ];
    if (options.token !== undefined && options.token !== '') {
        parts.push(`token=${encodeURIComponent(options.token)}`);
    }
    if (options.extraQuery !== undefined) parts.push(...options.extraQuery);
    return `${stripTrailingSlashes(relayUrl)}/${channelPath}?${parts.join('&')}`;
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
