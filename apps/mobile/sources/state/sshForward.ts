/** Tracks the active SSH port-forward so pairing can rewrite relay URLs through it. */
let activeForward: { localPort: number } | undefined;

export function setActiveSshForward(forward: { localPort: number } | undefined): void {
    activeForward = forward;
}

export function getActiveSshForward(): { localPort: number } | undefined {
    return activeForward;
}
