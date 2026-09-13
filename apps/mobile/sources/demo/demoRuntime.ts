/**
 * Demo runtime selection (native + non-demo fallback). The replay is
 * web-only: anywhere else this refuses and the route redirects home, so the
 * deterministic backend never ships in the native graph.
 */
export async function ensureDemoRuntime(): Promise<boolean> {
    return false;
}

export function activateDemoTransport(): void {}

export function resetDemoRuntime(): void {}
