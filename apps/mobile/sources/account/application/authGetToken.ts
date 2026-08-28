/** Local muxr auth. Token is device-local metadata only. */
export async function authGetToken(_secret: Uint8Array): Promise<string> {
    return `muxr-local-${Date.now().toString(36)}`;
}
