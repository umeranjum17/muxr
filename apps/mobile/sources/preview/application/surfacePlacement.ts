/**
 * Stable pane identity for the Agent/Surface workspace.
 *
 * Pure and dependency-free. The workspace renders one terminal container and
 * at most one surface container with constant keys; width changes and focus
 * toggles only flip visibility and geometry, never identity. A hidden
 * compact pane keeps nonzero layout (absolute, full-bounds, transparent),
 * is non-interactive and is hidden from accessibility -- never
 * `display:none`, which collapses native surfaces.
 *
 * What this model proves (and does not): the decision sequence across
 * resizes keeps one attach intent and constant mount keys. Whether the
 * native view actually survives is hardware behavior and stays ungated
 * until a device run says so.
 */

export type SurfacePaneFocus = 'agent' | 'surface';

export interface SurfacePaneDescriptor {
    /** Stable React key. Constant across resizes and focus toggles. */
    key: string;
    /** Mounted at all. */
    mounted: boolean;
    /** Mounted but invisible, non-interactive and a11y-hidden. */
    hidden: boolean;
}

export interface SurfacePanePlan {
    terminal: SurfacePaneDescriptor;
    surface: SurfacePaneDescriptor | null;
}

export function planSurfacePanes(input: {
    wide: boolean;
    focus: SurfacePaneFocus;
    /** Stable logical surface id (offer name, blank, or transient). */
    surfaceId: string | null;
}): SurfacePanePlan {
    const terminal: SurfacePaneDescriptor = {
        key: 'agent-terminal',
        mounted: true,
        hidden: !input.wide && input.focus === 'surface' && input.surfaceId !== null,
    };
    if (input.surfaceId === null) return { terminal, surface: null };
    // A selected surface stays mounted on both layouts: focus toggles only
    // flip visibility, so URL, history, scroll and the tunnel survive. Only
    // app background parks the tunnel; hiding a pane never does.
    const hidden = !input.wide && input.focus !== 'surface';
    return {
        terminal,
        surface: {
            key: `surface:${input.surfaceId}`,
            mounted: true,
            hidden,
        },
    };
}
