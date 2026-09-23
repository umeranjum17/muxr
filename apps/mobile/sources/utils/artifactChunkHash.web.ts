export async function artifactChunkHash(bytes: Uint8Array): Promise<string> {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)));
    return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
