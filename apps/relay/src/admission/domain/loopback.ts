const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

export function isLoopbackAddress(address: string | undefined): boolean {
    if (!address) return false;
    const normalized = address.replace(/^::ffff:/, '');
    return LOOPBACK.has(normalized);
}

export function isLoopbackHost(host: string): boolean {
    return LOOPBACK.has(host);
}
