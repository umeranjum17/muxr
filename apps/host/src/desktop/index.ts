/** Public API of the host's desktop feature. Import this, not internals. */
export { DesktopSessions, type DesktopEngineOptions } from './infrastructure/desktopSessions.js';
export { nextDesktopId, type DesktopSessionRecord } from './domain/desktopSession.js';
export {
    PreviewLeaseTracker,
    filePreviewLeaseSink,
    PREVIEW_LEASE_FILENAME,
    PREVIEW_LEASE_IDLE_MS,
    type PreviewLeaseController,
    type PreviewLeaseSnapshot,
    type PreviewLeaseTrackerOptions,
} from './application/previewLease.js';
export { withPreview } from './application/previewPresence.js';
export {
    AndroidEmulatorWatcher,
    AndroidMirrors,
    DevicePreviewTargets,
    DevicePresenceTracker,
    DesklinkEncodedEngine,
    deviceCapabilities,
    avdTitle,
    deviceOnline,
    findAdb,
    resolveScrcpyServer,
    scanAndroidEmulators,
    resolveVendoredResource,
    type AdbRunner,
    type AdbResult,
    type AndroidMirrorOptions,
    type DeviceMirrors,
    type DevicePreviewKind,
    type DeviceTargetsOptions,
    type AndroidWatcherOptions,
    type DiscoveredEmulator,
    type EncodedEngine,
    type EncodedEngineEvent,
    type EncodedEngineOptions,
    type EncodedEngineSession,
    type EncodedInput,
} from './application/androidEmulators.js';
export {
    IosMirrors,
    IosSimulatorWatcher,
    readSimulatorClaims,
    type IosMirrorOptions,
    type IosWatcherOptions,
} from './application/iosSimulators.js';
export {
    ANDROID_ACTION_DOWN,
    ANDROID_ACTION_UP,
    ANDROID_KEYCODE_APP_SWITCH,
    ANDROID_KEYCODE_HOME,
    RESET_VIDEO_MESSAGE,
    ROTATE_DEVICE_MESSAGE,
    ScrcpyVideoParser,
    encodeBackOrScreenOn,
    encodeInjectKeycode,
    encodeScroll,
    encodeText,
    encodeTouch,
    toAccessUnit,
} from './application/scrcpy.js';
