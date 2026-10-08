import { EngineRefused } from '@desklink/host';
import type { DesktopCapabilities, DesktopEvent, PreviewPresence, SessionInfo } from '@trymuxr/contract';

import { DesktopSessions, type DesktopEngineOptions } from '../infrastructure/desktopSessions.js';
import { PreviewLeaseTracker } from './previewLease.js';

/**
 * Presence + target sessions for an agent's own screen (P1.3).
 *
 * Keeper events say which windows are mapped on a pane's private screen; this
 * turns them into `PreviewPresence` per pane (class → kind, title cleanup,
 * hysteresis) and routes `desktop.open { target }` to a lazily created
 * `DesktopSessions` per pane. The client names a session, never a display: an
 * unknown or unscreened target is refused with `permission-denied`, never
 * fallen back to the whole desktop.
 *
 * Production no longer allocates private Browser screens. With no screen
 * provider, no screen presence is published and every such target is refused.
 * Device mirrors have their own discovery and target owners.
 */

/** One top-level window the keeper sees on a pane's screen.
 *
 * The keeper may report `class` as a string or array; accept both because the
 * wire owns the shape, not this interface. */
export interface PreviewScreenWindow {
    title?: string | null;
    class?: string[] | string | null;
    pid?: number;
    width?: number;
    height?: number;
}

/**
 * A screen provider for target routing. Absent in production after retiring
 * generic private Browser screens; retained while screen target admission is
 * removed separately.
 */
export interface PreviewScreens {
    screenFor(paneId: string): { display: string; env: Record<string, string> } | undefined;
    onWindows(listener: (paneId: string, windows: PreviewScreenWindow[]) => void): () => void;
}

/** A window big enough to be something the phone could show. */
const MIN_SHOWABLE_SIDE = 200;
/** A mapped window counts only once it stays put this long. */
const DEFAULT_ANNOUNCE_AFTER_MS = 1500;
/** A closed window takes the chip with it only after this long. */
const DEFAULT_WITHDRAW_AFTER_MS = 3000;
/** Titles are client-facing; bound what one presence broadcast may carry. */
const MAX_TITLE_LENGTH = 140;

const BROWSER_CLASS = /chrome|chromium|firefox|brave|edge/i;
const ANDROID_CLASS = /emulator/i;

const BROWSER_TITLE_SUFFIXES = [
    ' - Google Chrome',
    ' - Chromium',
    ' — Mozilla Firefox',
    ' - Brave',
    ' - Microsoft Edge',
];

/** WM_CLASS → what the phone can show. Anything else is ignored in v1. */
export function previewKindForClass(classes: readonly string[] | string | undefined | null): PreviewPresence['kind'] | undefined {
    if (classes === undefined || classes === null) return undefined;
    const joined = typeof classes === 'string' ? classes : classes.join(' ');
    if (ANDROID_CLASS.test(joined)) return 'android';
    if (BROWSER_CLASS.test(joined)) return 'browser';
    return undefined;
}

/**
 * A chip subtitle, never an id: the page title without its browser suffix, or
 * the AVD name for an emulator (`Android Emulator - <AVD>[:<port>]`).
 */
export function cleanPreviewTitle(title: string | undefined | null, kind: PreviewPresence['kind']): string | undefined {
    if (title === undefined || title === null) return undefined;
    let cleaned = title;
    if (kind === 'browser') {
        for (const suffix of BROWSER_TITLE_SUFFIXES) {
            if (cleaned.endsWith(suffix)) {
                cleaned = cleaned.slice(0, -suffix.length);
                break;
            }
        }
    } else {
        const emulator = /^Android Emulator\s*-\s*(.+?)(?::\d+)?$/.exec(cleaned);
        if (emulator?.[1] !== undefined) cleaned = emulator[1].replace(/_/g, ' ').trim();
    }
    cleaned = cleaned.trim();
    if (cleaned === '') return undefined;
    return cleaned.length > MAX_TITLE_LENGTH ? cleaned.slice(0, MAX_TITLE_LENGTH) : cleaned;
}

function showable(window: PreviewScreenWindow): boolean {
    return (window.width ?? 0) >= MIN_SHOWABLE_SIDE && (window.height ?? 0) >= MIN_SHOWABLE_SIDE;
}

export interface PreviewPresenceTrackerOptions {
    announceAfterMs?: number;
    withdrawAfterMs?: number;
    now?: () => number;
}

interface PanePresence {
    candidate: { kind: PreviewPresence['kind']; title: string | undefined; firstSeen: number } | undefined;
    announced: PreviewPresence | undefined;
    announceTimer: ReturnType<typeof setTimeout> | undefined;
    withdrawTimer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * Keeper events → one announced presence per pane.
 *
 * Hysteresis ("done properly"): a window is announced only after it has been
 * mapped for `announceAfterMs`, and withdrawn `withdrawAfterMs` after the last
 * one unmaps, so a browser restart never flickers the chip. `handleWindows`
 * returns true when the announced presence changed and the host should push it.
 */
export class PreviewPresenceTracker {
    private readonly announceAfterMs: number;
    private readonly withdrawAfterMs: number;
    private readonly now: () => number;
    private readonly panes = new Map<string, PanePresence>();
    private readonly listeners = new Set<(paneId: string) => void>();

    constructor(options: PreviewPresenceTrackerOptions = {}) {
        this.announceAfterMs = options.announceAfterMs ?? DEFAULT_ANNOUNCE_AFTER_MS;
        this.withdrawAfterMs = options.withdrawAfterMs ?? DEFAULT_WITHDRAW_AFTER_MS;
        this.now = options.now ?? Date.now;
    }

    /** The announced presence, or undefined when the pane shows nothing. */
    previewFor(paneId: string): PreviewPresence | undefined {
        return this.panes.get(paneId)?.announced;
    }

    /** Every announced change, as it happens. Returns the unsubscribe. */
    onChange(listener: (paneId: string) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    handleWindows(paneId: string, windows: readonly PreviewScreenWindow[]): boolean {
        let state = this.panes.get(paneId);
        if (state === undefined) {
            state = { candidate: undefined, announced: undefined, announceTimer: undefined, withdrawTimer: undefined };
            this.panes.set(paneId, state);
        }
        const found = windows.find((window) => showable(window) && previewKindForClass(window.class) !== undefined);
        const kind = found === undefined ? undefined : previewKindForClass(found.class);
        if (found === undefined || kind === undefined) {
            state.candidate = undefined;
            if (state.announceTimer !== undefined) {
                clearTimeout(state.announceTimer);
                state.announceTimer = undefined;
            }
            if (state.announced === undefined) return false;
            // Still mapped a moment ago: give a restart the grace period, and
            // withdraw only if nothing comes back.
            if (state.withdrawTimer === undefined) {
                state.withdrawTimer = setTimeout(() => {
                    state.withdrawTimer = undefined;
                    state.announced = undefined;
                    this.emit(paneId);
                }, this.withdrawAfterMs);
                state.withdrawTimer.unref?.();
            }
            return false;
        }
        if (state.withdrawTimer !== undefined) {
            // The window came back inside the grace period: still announced.
            clearTimeout(state.withdrawTimer);
            state.withdrawTimer = undefined;
        }
        const title = cleanPreviewTitle(found.title, kind);
        const announced = state.announced;
        if (announced !== undefined && announced.kind === kind) {
            if (announced.title !== title) {
                // The same window navigated: the subtitle follows at once.
                state.announced = title === undefined
                    ? { kind: announced.kind, since: announced.since }
                    : { ...announced, title };
                this.emit(paneId);
                return true;
            }
            state.candidate = undefined;
            return false;
        }
        const firstSeen = state.candidate !== undefined && state.candidate.kind === kind && state.candidate.title === title
            ? state.candidate.firstSeen
            : this.now();
        state.candidate = { kind, title, firstSeen };
        if (this.now() - firstSeen < this.announceAfterMs) {
            // The pending timer always belongs to the current candidate, so a
            // replacement waits out its own hysteresis from its own first sight.
            if (state.announceTimer !== undefined) clearTimeout(state.announceTimer);
            const wait = this.announceAfterMs - (this.now() - firstSeen);
            state.announceTimer = setTimeout(() => {
                state.announceTimer = undefined;
                this.announce(paneId);
            }, Math.max(wait, 0));
            state.announceTimer.unref?.();
            return false;
        }
        return this.announce(paneId);
    }

    /** The pane is gone: forget it, and say so if anything was announced. */
    release(paneId: string): boolean {
        const state = this.panes.get(paneId);
        if (state === undefined) return false;
        if (state.announceTimer !== undefined) clearTimeout(state.announceTimer);
        if (state.withdrawTimer !== undefined) clearTimeout(state.withdrawTimer);
        this.panes.delete(paneId);
        if (state.announced === undefined) return false;
        this.emit(paneId);
        return true;
    }

    stop(): void {
        for (const state of this.panes.values()) {
            if (state.announceTimer !== undefined) clearTimeout(state.announceTimer);
            if (state.withdrawTimer !== undefined) clearTimeout(state.withdrawTimer);
            state.announceTimer = undefined;
            state.withdrawTimer = undefined;
        }
    }

    private announce(paneId: string): boolean {
        const state = this.panes.get(paneId);
        const candidate = state?.candidate;
        if (state === undefined || candidate === undefined) return false;
        state.candidate = undefined;
        const announced: PreviewPresence = candidate.title === undefined
            ? { kind: candidate.kind, since: candidate.firstSeen }
            : { kind: candidate.kind, title: candidate.title, since: candidate.firstSeen };
        state.announced = announced;
        this.emit(paneId);
        return true;
    }

    private emit(paneId: string): void {
        for (const listener of this.listeners) listener(paneId);
    }
}

/** Stamp one session list with the announced presence, by pane. */
export function withPreview(
    sessions: SessionInfo[],
    previewFor: (paneId: string) => PreviewPresence | undefined,
): SessionInfo[] {
    return sessions.map((session) => {
        const preview = session.paneId === undefined ? undefined : previewFor(session.paneId);
        // The host is the only producer of `preview`; an absent key means
        // nothing is shown, which is also what the phone reads as closed.
        if (preview === undefined) return session;
        return { ...session, preview };
    });
}

type DesktopOpenRequest = Parameters<DesktopSessions['open']>[0];
type DesktopOwner = Parameters<DesktopSessions['open']>[1];

/** A target session opened with control scope: its human holds the pane's lease. */
function controlsTarget(request: DesktopOpenRequest): boolean {
    return request.permissions.includes('control');
}

export interface PreviewDesktopsOptions {
    screens: PreviewScreens | undefined;
    listSessions: () => Promise<Array<{ id: string; paneId?: string }>>;
    makeDesktop: (environment: NodeJS.ProcessEnv) => DesktopSessions;
    /** How long a pane's engine wrapper idles with no sessions before it is dropped. */
    idleMs?: number;
    /**
     * Who is driving a pane's screen. Absent (tests, screenless hosts) means
     * target sessions route exactly as before, with no lease tracked.
     */
    lease?: PreviewLeaseTracker;
}

const TARGET_ID_PREFIX = 'pv';
const DEFAULT_TARGET_IDLE_MS = 10_000;

/**
 * One lazily created `DesktopSessions` per pane, speaking to that pane's own
 * screen. Desktop ids handed to clients carry a `pv` prefix so later
 * answer/candidate/poll/close route back to the owning instance; the prefix
 * alone never grants anything, the map does.
 */
export class PreviewDesktops {
    private readonly screens: PreviewScreens | undefined;
    private readonly listSessions: () => Promise<Array<{ id: string; paneId?: string }>>;
    private readonly makeDesktop: (environment: NodeJS.ProcessEnv) => DesktopSessions;
    private readonly idleMs: number;
    private readonly lease: PreviewLeaseTracker | undefined;
    private readonly panes = new Map<string, { desktop: DesktopSessions; lastUsed: number }>();
    private readonly targets = new Map<string, { desktop: DesktopSessions; desktopId: string; paneId: string; controlling: boolean; ownerDeviceId?: string }>();
    private counter = 0;
    private readonly reaper: ReturnType<typeof setInterval>;

    constructor(options: PreviewDesktopsOptions) {
        this.screens = options.screens;
        this.listSessions = options.listSessions;
        this.makeDesktop = options.makeDesktop;
        this.idleMs = options.idleMs ?? DEFAULT_TARGET_IDLE_MS;
        this.lease = options.lease;
        this.reaper = setInterval(() => {
            void this.reap().catch(() => undefined);
        }, this.idleMs);
        this.reaper.unref?.();
    }

    /** The pane's screen for a session, or a refusal when it cannot be shown. */
    async resolveTarget(sessionId: string): Promise<{ paneId: string; display: string }> {
        const sessions = await this.listSessions();
        const paneId = sessions.find((session) => session.id === sessionId)?.paneId;
        const display = paneId === undefined ? undefined : this.screens?.screenFor(paneId)?.display;
        if (paneId === undefined || display === undefined) {
            // Mandatory for preview opens: never fall back to the whole desktop.
            throw new EngineRefused('permission-denied', 'that session has no screen to watch');
        }
        return { paneId, display };
    }

    async openTarget(sessionId: string, request: DesktopOpenRequest, owner?: DesktopOwner) {
        const { paneId, display } = await this.resolveTarget(sessionId);
        const entry = this.paneEntry(paneId, display);
        const opened = await entry.desktop.open(request, owner);
        this.counter += 1;
        const desktopId = `${TARGET_ID_PREFIX}${this.counter.toString(36)}`;
        this.targets.set(desktopId, {
            desktop: entry.desktop,
            desktopId: opened.desktopId,
            paneId,
            controlling: controlsTarget(request),
            ...(owner?.deviceId === undefined ? {} : { ownerDeviceId: owner.deviceId }),
        });
        // The first control message marks the human lease; a view-only open
        // never does, so watching alone stays silent for the agent.
        if (controlsTarget(request)) this.lease?.markControl(paneId, desktopId, owner?.deviceId);
        return { desktopId, generation: opened.generation, geometry: opened.geometry, source: opened.source };
    }

    /** A client handle from a target open, never a Computer handle. */
    owns(desktopId: string): boolean {
        return desktopId.startsWith(TARGET_ID_PREFIX) && this.targets.has(desktopId);
    }

    /** The named session's own screen, never the whole desktop. */
    async capabilitiesFor(sessionId: string): Promise<DesktopCapabilities> {
        const { paneId, display } = await this.resolveTarget(sessionId);
        return this.paneEntry(paneId, display).desktop.capabilities();
    }

    /** The pane's engine wrapper, created on first use and reaped when idle. */
    private paneEntry(paneId: string, display: string): { desktop: DesktopSessions; lastUsed: number } {
        let entry = this.panes.get(paneId);
        if (entry === undefined) {
            const authority = this.screens?.screenFor(paneId)?.env.XAUTHORITY;
            entry = {
                desktop: this.makeDesktop({
                    MUXR_DESKTOP_SOURCE: 'x11',
                    MUXR_DESKTOP_X11_DISPLAY: display,
                    ...(authority === undefined ? {} : { XAUTHORITY: authority }),
                }),
                lastUsed: Date.now(),
            };
            this.panes.set(paneId, entry);
        }
        entry.lastUsed = Date.now();
        return entry;
    }

    private require(desktopId: string): { desktop: DesktopSessions; desktopId: string; paneId: string; controlling: boolean } {
        const target = this.targets.get(desktopId);
        if (target === undefined) throw new EngineRefused('session', 'that desktop session is not open');
        return target;
    }

    async answer(desktopId: string, sdp: string, connectionId?: string, deviceId?: string): Promise<{ accepted: boolean }> {
        const target = this.require(desktopId);
        const accepted = await target.desktop.answer(target.desktopId, sdp, connectionId, deviceId);
        // A routed message on a controlling session is the human still there:
        // it pushes the idle expiry out. View-only sessions never refresh.
        if (target.controlling) this.lease?.refresh(target.paneId);
        return accepted;
    }

    async candidate(
        desktopId: string,
        candidate: string,
        sdpMid: string | null,
        sdpMLineIndex: number | null,
        connectionId?: string,
        deviceId?: string,
    ): Promise<{ accepted: boolean }> {
        const target = this.require(desktopId);
        const accepted = await target.desktop.candidate(target.desktopId, candidate, sdpMid, sdpMLineIndex, connectionId, deviceId);
        if (target.controlling) this.lease?.refresh(target.paneId);
        return accepted;
    }

    async poll(
        desktopId: string,
        cursor: number,
        connectionId?: string,
        deviceId?: string,
    ): Promise<{ cursor: number; events: DesktopEvent[] }> {
        const target = this.require(desktopId);
        const polled = await target.desktop.poll(target.desktopId, cursor, connectionId, deviceId);
        if (target.controlling) this.lease?.refresh(target.paneId);
        return polled;
    }

    async close(desktopId: string, connectionId?: string, deviceId?: string): Promise<{ closed: boolean }> {
        const target = this.targets.get(desktopId);
        if (target === undefined) return { closed: true };
        // Hand-back (or leaving the view): the claim drops even when the
        // engine close itself fails, so the agent is never stuck paused.
        this.targets.delete(desktopId);
        this.lease?.release(desktopId);
        return target.desktop.close(target.desktopId, connectionId, deviceId);
    }

    setLinkDeviceConnected(deviceId: string, connected: boolean): void {
        for (const entry of this.panes.values()) entry.desktop.setLinkDeviceConnected(deviceId, connected);
    }

    /** A removed device loses its target sessions on every pane; other devices keep theirs. */
    async revokeDevice(deviceId: string): Promise<void> {
        for (const entry of this.panes.values()) await entry.desktop.revokeDevice(deviceId);
        for (const [desktopId, target] of [...this.targets]) {
            if (target.ownerDeviceId === deviceId) this.targets.delete(desktopId);
        }
        // Revocation clears the lease at once: a distrusted phone must not
        // hold the agent paused for the rest of the idle window.
        this.lease?.revokeDevice(deviceId);
    }

    /** Close every target session; called when the host stops. */
    async closeAll(): Promise<void> {
        clearInterval(this.reaper);
        this.targets.clear();
        this.lease?.stop();
        for (const [paneId, entry] of [...this.panes]) {
            this.panes.delete(paneId);
            await entry.desktop.closeAll();
        }
    }

    private async reap(): Promise<void> {
        const now = Date.now();
        for (const [paneId, entry] of [...this.panes]) {
            if (!entry.desktop.idle || now - entry.lastUsed < this.idleMs) continue;
            this.panes.delete(paneId);
            await entry.desktop.closeAll().catch(() => undefined);
        }
    }
}

export type { DesktopEngineOptions };
