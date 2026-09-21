/** Public API of the desktop client package. Import this, not internals. */
export * from './protocol';
export { desktopAvailable, nativeDesklink } from './native';
export { DesktopView, type DesktopViewProps } from './DesktopView';
export {
    useDesktopSession,
    CONTROL_PERMISSIONS,
    type DesktopSession,
    type DesktopSessionOptions,
} from './useDesktopSession';
