import { MMKV } from 'react-native-mmkv';

const mmkv = new MMKV();

const LAST_VIEWED_KEY = 'changelog-last-viewed-release';

export function getLastViewedRelease(): string {
    return mmkv.getString(LAST_VIEWED_KEY) ?? '';
}

export function setLastViewedRelease(release: string): void {
    mmkv.set(LAST_VIEWED_KEY, release);
}
