/**
 * Window decision and ratio clamps for the Agent/Surface workspace.
 *
 * Pure and dependency-free so the layout contract is testable without a
 * renderer. Side-by-side eligibility is horizontal geometry only: a
 * landscape, foldable or expanded window splits whenever both panes can
 * stay >=360dp. There is deliberately no height gate -- a 914x411dp phone
 * landscape is wide.
 */

export const MIN_SURFACE_PANE_DP = 360;
/** Touch target for the divider drag. The visible line stays 2dp. */
export const SURFACE_DIVIDER_ZONE_DP = 44;
/**
 * Minimum eligible total width: exactly 360 + divider + 360, so both
 * computed panes stay >=360dp at the boundary. No larger UX floor: it
 * would exclude standard phone landscape.
 */
export const WIDE_MIN_WIDTH_DP = MIN_SURFACE_PANE_DP + SURFACE_DIVIDER_ZONE_DP + MIN_SURFACE_PANE_DP;

export function surfaceLayoutForWindow(width: number): 'compact' | 'wide' {
    if (width >= WIDE_MIN_WIDTH_DP) return 'wide';
    return 'compact';
}

/** Companion start: 50/50 below 840dp, 40/60 at/above. */
export function defaultSurfaceRatio(width: number): number {
    if (width >= 840) return 0.4;
    return 0.5;
}

/**
 * Clamp a persisted or dragged ratio against the available pane width
 * (container minus divider), so both computed panes stay >=360dp. The
 * ratio always applies to the available width, never the full container:
 * clamping against the full width lets the divider push Surface under 360.
 */
export function clampSurfaceRatio(value: number, containerWidth: number, dividerZone = SURFACE_DIVIDER_ZONE_DP): number {
    const available = containerWidth - dividerZone;
    const low = MIN_SURFACE_PANE_DP / available;
    const high = 1 - MIN_SURFACE_PANE_DP / available;
    if (!(low < high)) return 0.5;
    if (value < low) return low;
    if (value > high) return high;
    return value;
}

/** Concrete pane widths for a ratio. Both stay >=360dp when clamped. */
export function surfacePaneWidths(ratio: number, containerWidth: number, dividerZone = SURFACE_DIVIDER_ZONE_DP): {
    agent: number;
    surface: number;
} {
    const available = containerWidth - dividerZone;
    const agent = ratio * available;
    return { agent, surface: available - agent };
}
