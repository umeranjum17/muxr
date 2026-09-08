import { MMKV } from 'react-native-mmkv';

const mmkv = new MMKV();

const LAST_VIEWED_KEY = 'changelog-last-viewed-release';
/** What unread state was keyed on before releases were keyed by app version. */
const LEGACY_TITLE_KEY = 'changelog-last-viewed-title';
/** The last app version whose notes an install could have read under that key. */
const LEGACY_LAST_RELEASE = '0.1.26';

export function getLastViewedRelease(): string {
    const stored = mmkv.getString(LAST_VIEWED_KEY);
    if (stored !== undefined) return stored;
    // An install carrying the title key has already opened the changelog, so it
    // is not a first install: it has seen everything up to the last title-keyed
    // release, and only what came after that is unread.
    if (mmkv.getString(LEGACY_TITLE_KEY) === undefined) return '';
    mmkv.set(LAST_VIEWED_KEY, LEGACY_LAST_RELEASE);
    return LEGACY_LAST_RELEASE;
}

export function setLastViewedRelease(release: string): void {
    mmkv.set(LAST_VIEWED_KEY, release);
}
