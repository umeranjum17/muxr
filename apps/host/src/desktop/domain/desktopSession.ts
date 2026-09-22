import type { DesktopPermission, DesktopSurfaceGeometry } from '@muxr/contract';

/**
 * One open desktop session, as the host tracks it.
 *
 * The engine's own session id is kept here and never leaves the host: what a
 * client sees is an opaque handle for this host's process lifetime, so a
 * reconnecting client cannot address an engine session it was not granted.
 */
export interface DesktopSessionRecord {
    desktopId: string;
    engineSessionId: string;
    generation: number;
    permissions: DesktopPermission[];
    geometry: DesktopSurfaceGeometry;
    source: { kind: string; width: number; height: number; origin: { x: number; y: number } };
    openedAt: number;
}

let counter = 0;

/** A per-host handle. Not a capability: the grant is the authenticated device. */
export function nextDesktopId(): string {
    counter += 1;
    return `d${counter.toString(36)}`;
}
