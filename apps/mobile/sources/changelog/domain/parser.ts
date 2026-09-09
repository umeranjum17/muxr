import { ChangelogData, ChangelogRelease, LegacyChangelogEntry } from './types';

const statuses = ['passed', 'partial', 'failed', 'not-run'];
const plain = (value: unknown, max: number) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[<>]/.test(value);

let changelogData: ChangelogData | null = null;

export function getChangelogData(): ChangelogData {
    if (!changelogData) {
        try {
            const data = require('../changelog.json') as Partial<ChangelogData>;
            changelogData = { releases: data.releases ?? [], legacyEntries: data.legacyEntries ?? [] };
        } catch {
            console.warn('Changelog data not found, returning empty changelog');
            changelogData = { releases: [], legacyEntries: [] };
        }
    }
    return changelogData;
}

/** Throws on a malformed entry; a valid release is never guessed from another version. */
export function validateRelease(release: ChangelogRelease): ChangelogRelease {
    if (!/^\d+\.\d+\.\d+$/.test(release.appVersion)) throw new Error('Changelog release needs an app version');
    if (!plain(release.title, 120) || !plain(release.summary, 400)) throw new Error(`Changelog ${release.appVersion} needs a plain title and summary`);
    for (const list of [release.features, release.fixes, release.verification]) {
        if (!Array.isArray(list) || list.length > 24) throw new Error(`Changelog ${release.appVersion} has a malformed change list`);
        for (const change of list) {
            if (!plain(change.title, 120) || !plain(change.detail, 600)) throw new Error(`Changelog ${release.appVersion} has a malformed change`);
        }
    }
    for (const item of release.verification) {
        if (!statuses.includes(item.status)) throw new Error(`Changelog ${release.appVersion} has an unknown verification status`);
    }
    if (!Array.isArray(release.knownLimits) || release.knownLimits.length > 24 || release.knownLimits.some((limit) => !plain(limit, 400))) {
        throw new Error(`Changelog ${release.appVersion} has malformed known limits`);
    }
    if (release.features.length + release.fixes.length === 0) throw new Error(`Changelog ${release.appVersion} records no changes`);
    return release;
}

/** Exactly one entry must match the requested version; there is no fallback. */
export function selectRelease(appVersion: string): ChangelogRelease | undefined {
    const matches = getChangelogData().releases.filter((release) => release.appVersion === appVersion);
    if (matches.length > 1) throw new Error(`Changelog has ${matches.length} entries for ${appVersion}`);
    return matches.length === 1 ? validateRelease(matches[0]) : undefined;
}

const order = (version: string) => version.split('.').reduce((rank, part) => rank * 10_000 + Number(part), 0);

/**
 * Releases published before the installed one, newest first. A release newer
 * than the installed app describes software this phone is not running, so it is
 * never rendered -- neither as history nor in place of the current entry.
 */
export function olderReleases(appVersion: string): ChangelogRelease[] {
    if (!/^\d+\.\d+\.\d+$/.test(appVersion)) return [];
    const installed = order(appVersion);
    return getChangelogData().releases
        .filter((release) => /^\d+\.\d+\.\d+$/.test(release.appVersion) && order(release.appVersion) < installed)
        .sort((left, right) => order(right.appVersion) - order(left.appVersion))
        .map((release) => validateRelease(release));
}

export function getLegacyEntries(): LegacyChangelogEntry[] {
    return getChangelogData().legacyEntries;
}
