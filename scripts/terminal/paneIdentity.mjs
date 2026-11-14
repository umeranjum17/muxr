/**
 * The one place a muxr command learns which terminal pane it runs in.
 * Herdr puts the pane id in `HERDR_PANE_ID`; every command reads it here, so a
 * different terminal runtime changes this function and nothing else.
 */
export const PANE_ID_VARIABLE = 'HERDR_PANE_ID';

/** The trimmed pane id of the pane this process runs in, or undefined outside one. */
export function currentPaneId(env = process.env) {
    const paneId = env[PANE_ID_VARIABLE]?.trim();
    return paneId === '' ? undefined : paneId;
}
