import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Who is driving an agent pane's screen: the agent, or a human who took
 * control of its browser or emulator from the phone.
 *
 * The mark lands on the first control-scoped target open (a `desktop.open`
 * whose permissions include `control`): input itself rides the WebRTC data
 * channel straight to the engine, so the open is the only control message the
 * host ever sees. View-only opens never mark, and a view-only grant can never
 * carry control (the link refuses it), so watching alone stays silent.
 *
 * The pane stays `human` while a controlling target session is live — every
 * routed target message (answer, candidate, poll) pushes the idle expiry out —
 * and clears on hand-back (the controlling session closes), revoke, or the
 * idle timeout when the phone vanishes without closing. Enforcement is soft:
 * the tracker only reports; pausing is the agent's etiquette.
 */
export const PREVIEW_LEASE_IDLE_MS = 30_000;

/** The lease file under the host state root, read by the naming loopback. */
export const PREVIEW_LEASE_FILENAME = 'preview/lease.json';

export type PreviewLeaseController = 'human';

export interface PreviewLeaseSnapshot {
    version: 1;
    panes: Record<string, { controller: PreviewLeaseController; expiresAt: number }>;
}

export interface PreviewLeaseTrackerOptions {
    /** Idle timeout before an unclosed lease clears; 30 s in production. */
    idleMs?: number;
    now?: () => number;
    /** Called with the live pane leases whenever they change; absent keeps them in memory. */
    persist?: (snapshot: PreviewLeaseSnapshot) => void;
}

interface PaneLease {
    expiresAt: number;
    timer: ReturnType<typeof setTimeout> | undefined;
}

interface ControlClaim {
    paneId: string;
    deviceId?: string;
}

export class PreviewLeaseTracker {
    private readonly idleMs: number;
    private readonly now: () => number;
    private readonly persist: ((snapshot: PreviewLeaseSnapshot) => void) | undefined;
    private readonly claims = new Map<string, ControlClaim>();
    private readonly panes = new Map<string, PaneLease>();

    constructor(options: PreviewLeaseTrackerOptions = {}) {
        this.idleMs = options.idleMs ?? PREVIEW_LEASE_IDLE_MS;
        this.now = options.now ?? Date.now;
        this.persist = options.persist;
    }

    /** The pane's live controller, or undefined when the agent may act. */
    controllerFor(paneId: string): PreviewLeaseController | undefined {
        const lease = this.panes.get(paneId);
        if (lease === undefined) return undefined;
        if (lease.expiresAt <= this.now()) {
            this.clearPane(paneId);
            return undefined;
        }
        return 'human';
    }
    /** A control-scoped target session opened: the human is driving this pane. */
    markControl(paneId: string, desktopId: string, deviceId?: string): void {
        this.claims.set(desktopId, {
            paneId,
            ...(deviceId === undefined ? {} : { deviceId }),
        });
        this.touch(paneId);
    }

    /**
     * A routed message on a controlling session: the human is still there.
     * It re-marks the pane, so a phone that returns after an expiry also
     * resumes the lease on its next message instead of driving silently.
     */
    refresh(paneId: string): void {
        this.touch(paneId);
    }

    /** A target session closed (hand-back, or leaving the view): drop its claim. */
    release(desktopId: string): void {
        const claim = this.claims.get(desktopId);
        if (claim === undefined) return;
        this.claims.delete(desktopId);
        if (![...this.claims.values()].some((other) => other.paneId === claim.paneId)) {
            this.clearPane(claim.paneId);
        }
    }

    /** A device lost trust: its claims clear at once, not after the idle wait. */
    revokeDevice(deviceId: string): void {
        const panes = new Set<string>();
        for (const [desktopId, claim] of [...this.claims]) {
            if (claim.deviceId !== deviceId) continue;
            this.claims.delete(desktopId);
            panes.add(claim.paneId);
        }
        for (const paneId of panes) {
            if (![...this.claims.values()].some((other) => other.paneId === paneId)) {
                this.clearPane(paneId);
            }
        }
    }

    /** Forget every claim and timer; the host is stopping. */
    stop(): void {
        for (const lease of this.panes.values()) {
            if (lease.timer !== undefined) clearTimeout(lease.timer);
        }
        this.claims.clear();
        this.panes.clear();
        this.saved();
    }

    private touch(paneId: string): void {
        let lease = this.panes.get(paneId);
        if (lease === undefined) {
            lease = { expiresAt: 0, timer: undefined };
            this.panes.set(paneId, lease);
        }
        if (lease.timer !== undefined) clearTimeout(lease.timer);
        lease.expiresAt = this.now() + this.idleMs;
        lease.timer = setTimeout(() => this.clearPane(paneId), this.idleMs);
        lease.timer.unref?.();
        this.saved();
    }

    private clearPane(paneId: string): void {
        const lease = this.panes.get(paneId);
        if (lease === undefined) return;
        if (lease.timer !== undefined) clearTimeout(lease.timer);
        this.panes.delete(paneId);
        // Claims with no message for the whole idle window are dead: the
        // phone is gone, or it will re-mark on its next message.
        for (const [desktopId, claim] of [...this.claims]) {
            if (claim.paneId === paneId) this.claims.delete(desktopId);
        }
        this.saved();
    }

    private saved(): void {
        if (this.persist === undefined) return;
        const panes: PreviewLeaseSnapshot['panes'] = {};
        for (const [paneId, lease] of this.panes) {
            if (lease.expiresAt <= this.now()) continue;
            panes[paneId] = { controller: 'human', expiresAt: lease.expiresAt };
        }
        this.persist({ version: 1, panes });
    }
}

/**
 * The `persist` half that shares leases with the naming loopback: one atomic,
 * owner-only file both processes derive from `$MUXR_HOME`. A restart starts
 * with no claims — the sessions are gone with the old host, and a still-open
 * phone re-marks on reopen — and the reader treats an expired entry as none,
 * so a dead host can never pin a pane as human.
 */
export function filePreviewLeaseSink(file: string, onError?: (error: unknown) => void): (snapshot: PreviewLeaseSnapshot) => void {
    return (snapshot) => {
        try {
            mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
            const staging = `${file}.${process.pid}.tmp`;
            writeFileSync(staging, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
            renameSync(staging, file);
        } catch (error) {
            onError?.(error);
        }
    };
}
