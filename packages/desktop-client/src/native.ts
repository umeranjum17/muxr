import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';



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
    | 'keyboard'
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
    /** Send one control message; the platform stamps it with the session's next sequence. */
    sendControl(id: string, message: string): boolean;
    showKeyboard(id: string): boolean;
    hideKeyboard(id: string): boolean;
    /**
     * While captured, what the phone's keyboard types is not sent: it arrives as
     * a `keyboard` event, `{ text }` or `{ key }`, for the session to chord.
     */
    captureKeyboard(id: string, captured: boolean): boolean;
    setSurfaceSize(id: string, width: number, height: number): boolean;
    /** Show the whole desktop again after the user zoomed in. */
    fitToView(id: string): boolean;
    /** Hold the screen in landscape while the desktop is shown, or follow the phone again. */
    setOrientation(mode: 'landscape' | 'auto'): boolean;
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

