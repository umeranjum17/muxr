/**
 * The one place the host reads which terminal pane an environment belongs to.
 * Herdr names it in `HERDR_PANE_ID`; a process's own environment and a
 * `/proc/<pid>/environ` snapshot are both read here, so a different terminal
 * runtime changes this module and nothing else.
 */
export const PANE_ID_VARIABLE = 'HERDR_PANE_ID';

/** The trimmed pane id carried by an environment, or undefined when it carries none or an empty one. */
export function paneIdFromEnvironment(env: Readonly<Record<string, string | undefined>>): string | undefined {
    const paneId = env[PANE_ID_VARIABLE]?.trim();
    return paneId === undefined || paneId === '' ? undefined : paneId;
}
