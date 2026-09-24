/**
 * A tab's split layout drawn to phone size: each pane's Herdr rect (terminal
 * cells) scaled into dp, same arrangement and proportions as on the desk.
 */

export interface CellRect { x: number; y: number; width: number; height: number }
export interface PaneMapLayout { area: CellRect; panes: readonly { paneId: string; rect: CellRect }[] }
export interface PaneMapTile { paneId: string; left: number; top: number; width: number; height: number }

/** A terminal cell is about twice as tall as it is wide. */
const CELL_ASPECT = 2;

/**
 * Tiles for `paneIds`, scaled to `width`. Height follows the desk's
 * proportions, stretched only so the shortest pane still gets `minTile` dp.
 * `undefined` when the layout does not cover exactly these panes (a stale
 * read, a zoomed tab): the caller then stacks them instead.
 */
export function paneMapTiles(layout: PaneMapLayout | undefined, paneIds: readonly string[], width: number, minTile: number): { tiles: PaneMapTile[]; height: number } | undefined {
    if (layout === undefined || width <= 0 || layout.area.width <= 0 || layout.area.height <= 0) return undefined;
    const byId = new Map(layout.panes.map((pane) => [pane.paneId, pane.rect]));
    if (paneIds.length === 0 || layout.panes.length !== paneIds.length || paneIds.some((id) => !byId.has(id))) return undefined;
    const { area } = layout;
    const sx = width / area.width;
    const shortest = Math.min(...paneIds.map((id) => byId.get(id)!.height));
    const sy = Math.max(sx * CELL_ASPECT, minTile / shortest);
    // Edges snap from the scaled coordinates, so neighbours share a line and nothing gaps.
    const tiles = paneIds.map((paneId) => {
        const rect = byId.get(paneId)!;
        const left = Math.round((rect.x - area.x) * sx);
        const top = Math.round((rect.y - area.y) * sy);
        return {
            paneId,
            left,
            top,
            width: Math.round((rect.x - area.x + rect.width) * sx) - left,
            height: Math.round((rect.y - area.y + rect.height) * sy) - top,
        };
    });
    return { tiles, height: Math.round(area.height * sy) };
}
