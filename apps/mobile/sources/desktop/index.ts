/** Public API of the live-desktop feature. Import this, not internals. */
export { DesktopSurface, type DesktopSurfaceProps } from './presentation/DesktopSurface';
export { createDesktopSignaling, type OpenDesktopOptions } from './application/desktopSignaling';
export { desktopCopy, desktopUnavailableMessage } from './model/desktopCopy';
