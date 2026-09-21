import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';

import type { ControlReply } from './protocol';
import { parseControlReply } from './protocol';

/**
 * The native session module.
 *
 * Everywhere but Android the module is absent, `desktopAvailable` is false, and
 * the package still exports its types plus the web surface — an application
 * renders one screen on every platform and branches on capability, not on
 * platform name.
 */
export type NativeEventName =
    | 'ready'
    | 'answer'
    | 'candidate'
    | 'ice'
    | 'channel'
    | 'track'
    | 'presented'
    | 'control'
    | 'failure'
    | 'closed';

export interface NativeSessionEvent {
    sessionId: string;
    name: NativeEventName;
    payload: Record<string, unknown>;
}

export interface NativeDesklinkModule {
    createSession(iceServersJson: string, relayOnly: boolean): string | null;
    setRemoteDescription(id: string, type: string, sdp: string): boolean;
    addRemoteCandidate(id: string, candidate: string, sdpMid: string | null, sdpMLineIndex: number | null): boolean;
    sendControl(id: string, message: string): boolean;
    showKeyboard(id: string): boolean;
    hideKeyboard(id: string): boolean;
    setSurfaceSize(id: string, width: number, height: number): boolean;
    closeSession(id: string): boolean;
    isAvailable(): boolean;
    addListener?(name: 'onSessionEvent', handler: (event: NativeSessionEvent) => void): { remove: () => void };
}

const native = Platform.OS === 'android'
    ? (requireOptionalNativeModule<NativeDesklinkModule>('Desklink') ?? null)
    : null;

export const nativeDesklink: NativeDesklinkModule | null = native;

/** True when this build can show a live desktop surface at all. */
export const desktopAvailable = native !== null;

export { parseControlReply };
export type { ControlReply };
