import type { DownloadableArtifact } from './artifactTransfer';

function shortHash(value: string): string {
    let hash = 0xcbf29ce484222325n;
    for (const byte of new TextEncoder().encode(value)) {
        hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
    }
    return hash.toString(16).padStart(16, '0');
}

export function artifactDownloadKey(sessionId: string, artifact: DownloadableArtifact): string {
    const id = /^[0-9a-f]{64}$/.test(artifact.id) ? artifact.id : shortHash(artifact.id);
    return `${id}-${artifact.at ?? 'unknown'}-${shortHash(JSON.stringify([sessionId, artifact.name]))}-${artifact.size}`;
}
