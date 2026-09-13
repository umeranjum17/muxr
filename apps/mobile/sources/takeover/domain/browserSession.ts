/**
 * Private protocol between this device and the browser service, and the
 * pure rules the device applies to it. Signaling rides
 * `browser.session.signal` sealed under the browser-service grant; once the
 * peer is up, `control` (ordered, reliable) carries permits, focus, status,
 * heartbeats and discrete input, and `pointer` (unordered, latest-only)
 * carries touch motion. Every discrete input names the generation, target,
 * document and focus it was made for plus the current permit; the service
 * rejects anything stale, so the device never retries or replays.
 */

import type { BrowserSessionStatus, BrowserSessionState } from '@muxr/contract';

/** Permits renew every 100 ms and die after 300 ms; input without a live one is dropped locally. */
export const PERMIT_TTL_MS = 300;
export const HEARTBEAT_MS = 1_000;

export interface FocusedField {
    kind: 'text' | 'password' | 'otp' | 'email' | 'tel' | 'number' | 'url' | 'search';
    label: string;
    /** Current ordinary text; never present for secret kinds. */
    value?: string;
    selection?: [number, number];
    enter?: 'enter' | 'next' | 'go' | 'search' | 'done';
}

/** Which target/document/focus an input was made for. */
export interface InputGenerations {
    generation: number;
    target: number;
    document: number;
    focus: number;
}

export type ServiceMessage =
    | { type: 'answer'; generation: number; sdp: string }
    | { type: 'permit'; generation: number; permit: string }
    | { type: 'geometry'; generation: number; target: number; document: number; width: number; height: number }
    | { type: 'focus'; generation: number; target: number; document: number; focus: number; field: FocusedField | null }
    | { type: 'status'; status: BrowserSessionStatus }
    | { type: 'heartbeat'; generation: number };

export type DeviceInput =
    | { type: 'tap'; x: number; y: number }
    | { type: 'touch'; phase: 'start' | 'move' | 'end'; x?: number; y?: number }
    | { type: 'wheel'; x: number; y: number; deltaX: number; deltaY: number }
    | { type: 'key'; key: 'Enter' | 'Backspace' | 'Tab' }
    /** One committed composer edit for the focused field: replaces its value. */
    | { type: 'commit'; text: string }
    /** A complete paste through the browser's own input path (multi-box OTP forms). */
    | { type: 'insertText'; text: string }
    | { type: 'navigate'; direction: 'back' | 'forward' };

export type DeviceMessage =
    | ({ id: string; permit: string } & InputGenerations & DeviceInput)
    | { type: 'heartbeat'; generation: number }
    /** Authority is ending: drop every held key and button. */
    | { type: 'release'; generation: number };

export function isServiceMessage(value: unknown): value is ServiceMessage {
    if (typeof value !== 'object' || value === null) return false;
    const message = value as { type?: unknown; generation?: unknown };
    return typeof message.type === 'string' && (message.type === 'status' || typeof message.generation === 'number');
}

/** A permit is usable only inside its TTL on the local monotonic clock. */
export function permitLive(issuedAt: number | undefined, now: number): boolean {
    return issuedAt !== undefined && now - issuedAt <= PERMIT_TTL_MS;
}

export interface OwnershipStrip {
    label: string;
    icon: string;
    /** Private states get the distinct lock treatment, not only a colour. */
    tone: 'agent' | 'attention' | 'private' | 'ended';
}

/** The unmissable strip for each contract state. Words and icon accompany colour. */
export function ownershipStrip(state: BrowserSessionState | 'connecting' | 'needs-pairing'): OwnershipStrip {
    switch (state) {
        case 'agent-driving': return { label: 'Agent driving', icon: 'sparkles-outline', tone: 'agent' };
        case 'waiting-for-you': return { label: 'Waiting for you', icon: 'hand-left-outline', tone: 'attention' };
        case 'taking-control': return { label: 'Taking control', icon: 'hourglass-outline', tone: 'attention' };
        case 'you-control': return { label: 'You control · Private', icon: 'lock-closed', tone: 'private' };
        case 'giving-back': return { label: 'Giving back', icon: 'hourglass-outline', tone: 'private' };
        case 'paused': return { label: 'Paused · Private', icon: 'pause-circle', tone: 'private' };
        case 'checking': return { label: 'Checking who has control', icon: 'help-circle-outline', tone: 'attention' };
        case 'ended': return { label: 'Session ended', icon: 'close-circle-outline', tone: 'ended' };
        case 'needs-pairing': return { label: 'Agent browser needs a fresh pairing', icon: 'key-outline', tone: 'ended' };
        default: return { label: 'Connecting', icon: 'ellipsis-horizontal', tone: 'agent' };
    }
}

/** The seat is this device's and live: only then is input ever unlocked. */
export function ownsSeat(status: BrowserSessionStatus | undefined): boolean {
    return status !== undefined && status.owner === 'self' && status.state === 'you-control';
}

/** Any URL inside service-supplied text collapses to its hostname before chrome shows it. */
export function redactUrls(text: string): string {
    return text.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s]+/gi, (raw) => {
        try {
            return new URL(raw).hostname;
        } catch {
            return '[link]';
        }
    });
}
