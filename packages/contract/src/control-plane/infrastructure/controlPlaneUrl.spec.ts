import { expect, it } from 'vitest';
import { relayControlUrl } from './controlPlaneUrl.js';

it('derives account and enrollment control routes at the relay origin without accepting URL credentials', () => {
    const relay = 'wss://relay.example/relay?tenant=one#socket';
    expect(['/v1/auth/email/start', '/v1/session', '/v1/selfhost/enrollments']
        .map((path) => relayControlUrl(relay, path)))
        .toEqual(['/v1/auth/email/start', '/v1/session', '/v1/selfhost/enrollments']
            .map((path) => `https://relay.example${path}`));
    for (const invalid of ['not a URL', 'http://relay.example/relay', 'ftp://relay.example/relay']) {
        expect(() => relayControlUrl(invalid, '/v1/session')).toThrow();
    }
    expect(() => relayControlUrl('wss://name@relay.example/relay', '/v1/session'))
        .toThrow('text before “@” is treated as login information');
    expect(() => relayControlUrl(relay, 'v1/session')).toThrow('control path must start with /');
});
