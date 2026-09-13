/**
 * The connect handoff, in one place. README, docs/user/install.md and the
 * website's synced copy must carry these byte-for-byte (a repository check
 * compares them); nothing else may spell an install command.
 */
export const HERDR_PLUGIN_SOURCE = 'umeranjum17/muxr/plugins/control';

/** Herdr-first: the exact source pinned to the released ref (a `v<version>` tag). */
export function herdrInstallCommand(version: string): string {
    return `herdr plugin install ${HERDR_PLUGIN_SOURCE} --ref v${version}`;
}
export const HERDR_SETUP_PANE_COMMAND = 'herdr plugin pane open --plugin muxr.control --entrypoint setup';

/** Without Herdr: the npm CLI as the advanced fallback. */
export const NPM_INSTALL_COMMAND = 'npm install -g --ignore-scripts @trymuxr/cli@latest';
export const NPM_SETUP_COMMAND = 'muxr';

export const CONNECT_AFTER_PAIR_NOTE = 'You install the app after you pair: it is served from your own computer, never from this site.';
