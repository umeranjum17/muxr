/** Public API of the desktop client package. Import this, not internals. */
export * from './protocol';
/**
 * The platform module is deliberately not re-exported here.
 *
 * It is the bulk of this package — a session, a renderer and an input bridge —
 * and most users of an application never open a desktop. Exporting it from the
 * barrel would put it in the application's first paint; the session loads it
 * when a desktop is actually opened.
 */
export type { NativeDesklinkModule, NativeSessionEvent } from './native';
export { desktopAvailable } from './availability';
export { DesktopView, type DesktopViewProps } from './DesktopView';
export {
    useDesktopSession,
    CONTROL_PERMISSIONS,
    type DesktopSession,
    type DesktopSessionOptions,
} from './useDesktopSession';
