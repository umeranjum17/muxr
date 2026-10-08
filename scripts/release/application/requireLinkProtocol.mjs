import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Read the app's existing health gate, not the unrelated host-update protocol. */
export function appLinkProtocol(root = process.cwd()) {
    const source = readFileSync(resolve(root, 'apps/mobile/sources/pairing/infrastructure/linkFirstClient.ts'), 'utf8');
    const matches = [...source.matchAll(/health\.linkProtocol\s*!==\s*(\d+)\b/g)];
    if (matches.length !== 1) throw new Error('Cannot identify the app link protocol gate');
    return Number(matches[0][1]);
}

export function requireLinkProtocol(tarball, root = process.cwd()) {
    const required = appLinkProtocol(root);
    // Inspect the retained artifact, never this checkout's relay or the
    // muxrCompatibility stamp: legacy 0.2.0 also stamped protocol: 1.
    const relay = execFileSync('tar', ['-xOf', resolve(tarball), 'package/relay.js'], {
        encoding: 'utf8', timeout: 10000, maxBuffer: 16 * 1024 * 1024,
    });
    const matches = [...relay.matchAll(/\blinkProtocol\s*:\s*(\d+)\b/g)];
    const protocols = new Set(matches.map((match) => Number(match[1])));
    if (protocols.size > 1) throw new Error('Candidate advertises ambiguous link protocols');
    // Before link-first, the relay advertised no linkProtocol (legacy offers).
    const advertised = protocols.size === 0 ? 0 : [...protocols][0];
    if (advertised < required) {
        throw new Error(`Store app requires link protocol ${required}; candidate CLI advertises ${advertised}. Refusing an incompatible release.`);
    }
    console.log(`Link protocol compatible: app requires ${required}; candidate CLI advertises ${advertised}.`);
}
