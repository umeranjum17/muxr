/**
 * Wait until a spawned relay is actually listening.
 *
 * The checks used fixed sleeps, which are fine on an idle box and flake the
 * moment anything else is running -- failures that look like real regressions.
 */
export async function waitForRelay(port, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
            if (res.ok) return;
        } catch {
            // not up yet
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`relay on port ${port} did not come up within ${timeoutMs}ms`);
}
