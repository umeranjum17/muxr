/**
 * Working directories drawn from the host's sanitized session snapshot.
 *
 * The host already holds Herdr's topology and passes it in when the manifest
 * declares `context: ["sessions"]`, so this needs no herdr binary on PATH and
 * spawns nothing.
 */
export function sessionCwds() {
    try {
        const { sessions } = JSON.parse(process.env.MUXR_PLUGIN_CONTEXT_JSON ?? '{}');
        return [...new Set((Array.isArray(sessions) ? sessions : [])
            .map((session) => session?.cwd)
            .filter((cwd) => typeof cwd === 'string' && cwd !== '' && !cwd.includes('\0')))];
    } catch {
        return [];
    }
}
