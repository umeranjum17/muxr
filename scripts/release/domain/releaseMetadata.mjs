/**
 * What a release may change between the commit a journey proved and the
 * commit that ships it.
 *
 * A version bump touches exactly these files: the two package manifests, the
 * iOS project, the changelog, the CLI tarball the phone installs, and the web
 * export check's version. Every one of them is release metadata and never
 * product behavior, so a receipt that proved the code before the bump still
 * proves the code that ships. Everything else is product code: a receipt that
 * covered it does not cover the release.
 *
 * The list is the measured one, taken from the version bumps this repository
 * has merged (0.2.6 through 0.2.10), not a guess.
 */
export const RELEASE_METADATA_PATHS = new Set([
    'package.json',
    'apps/desktop/package.json',
    'apps/mobile/ios/muxr.xcodeproj/project.pbxproj',
    'apps/mobile/sources/changelog/changelog.json',
    'apps/mobile/sources/cloud/deployBoatComputer.ts',
    'scripts/diagnostics/application/checkWebExport.mjs',
]);

/** Where a release keeps the receipts that prove it, committed next to the code. */
export const RECEIPT_DIR = '.done-done-receipts';

/**
 * True when a path may differ between a proved commit and the commit that
 * ships it: release metadata, or a receipt the release carries itself.
 */
export function isReleaseMetadata(path) {
    if (path.startsWith(`${RECEIPT_DIR}/`)) return true;
    return RELEASE_METADATA_PATHS.has(path);
}
