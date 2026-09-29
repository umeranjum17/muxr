/** Public API of the host's desktop feature. Import this, not internals. */
export { DesktopSessions, type DesktopEngineOptions } from './infrastructure/desktopSessions.js';
export { nextDesktopId, type DesktopSessionRecord } from './domain/desktopSession.js';
export { PaneScreens, type PaneScreen, type ScreenWindow } from './infrastructure/paneScreens.js';
export {
    PreviewDesktops,
    PreviewPresenceTracker,
    cleanPreviewTitle,
    previewKindForClass,
    withPreview,
    type PreviewDesktopsOptions,
    type PreviewPresenceTrackerOptions,
    type PreviewScreenWindow,
    type PreviewScreens,
} from './application/previewPresence.js';
