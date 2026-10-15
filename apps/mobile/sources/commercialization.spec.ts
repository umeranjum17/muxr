import { describe, expect, it, vi } from 'vitest';

const mmkvState = vi.hoisted(() => ({ values: new Map<string, string>(), failSaves: false }));
const mmkvValues = mmkvState.values;
vi.mock('react-native-mmkv', () => ({
    createMMKV: () => new class {
        getString(key: string) { return mmkvState.values.get(key); }
        set(key: string, value: string) {
            // v4 native store throws when a value cannot be saved.
            if (mmkvState.failSaves) throw new Error('MMKV: cannot save value');
            mmkvState.values.set(key, value);
        }
        remove(key: string) { mmkvValues.delete(key); }
        clearAll() { mmkvValues.clear(); }
    }(),
}));
import {
    directBillingUrl,
    firstRestorableMachine,
    setupEmptyState,
} from '@/commercialization';

describe('open-source mobile onboarding flow', () => {
    it('keeps pairing semantics, the no-machine handoff, and every commerce surface absent', () => {
        expect(firstRestorableMachine([
            { id: 'new-machine', paired: false },
            { id: 'existing-grant', paired: true },
        ])).toBe('existing-grant');
        expect(firstRestorableMachine([{ id: 'new-machine', paired: false }])).toBeUndefined();

        expect(setupEmptyState('https://muxr.test/')).toEqual({
            title: 'Connect your computer',
            command: 'muxr',
            setupUrl: 'https://muxr.test/setup',
            desktopUrl: 'https://muxr.test/desktop',
        });
        expect(setupEmptyState()).toEqual({
            title: 'Connect your computer',
            command: 'muxr',
        });

        expect(directBillingUrl({ directDistribution: false, publicBaseUrl: 'https://muxr.test' })).toBeNull();
        expect(directBillingUrl({ publicBaseUrl: 'https://muxr.test' })).toBeNull();
        expect(directBillingUrl({ directDistribution: true, publicBaseUrl: 'https://muxr.test/' })).toBeNull();
    });

    it('loads current settings without retaining unknown secret fields', async () => {
        mmkvValues.set('settings', JSON.stringify({
            version: 1,
            settings: { realtimeApiKey: 'sk-stale-mobile', preferredLanguage: 'en' },
        }));
        mmkvValues.set('pending-settings', JSON.stringify({ realtimeApiKey: 'sk-stale-pending', avatarStyle: 'brutalist' }));
        const persistence = await import('@/catalog/application/persistence');

        const loaded = persistence.loadSettings();
        expect(loaded.settings.preferredLanguage).toBe('en');
        expect(mmkvValues.get('settings')).not.toContain('realtimeApiKey');
        expect(mmkvValues.get('settings')).not.toContain('sk-stale-mobile');
        expect(persistence.loadPendingSettings()).toEqual({ avatarStyle: 'brutalist' });
        expect(mmkvValues.get('pending-settings')).not.toContain('realtimeApiKey');

        mmkvValues.set('settings', '{corrupt settings');
        persistence.loadSettings();
        expect(mmkvValues.has('settings')).toBe(false);
    });

    it('logs a failed save without throwing into the caller, and sign-out clears the store', async () => {
        const persistence = await import('@/catalog/application/persistence');
        const profile = persistence.loadProfile();
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

        mmkvState.failSaves = true;
        expect(() => persistence.saveProfile(profile)).not.toThrow();
        expect(consoleError).toHaveBeenCalledWith(expect.stringMatching(/^Failed to save profile/), expect.any(Error));
        expect(mmkvValues.has('profile')).toBe(false);
        consoleError.mockRestore();

        mmkvState.failSaves = false;
        persistence.saveProfile(profile);
        expect(mmkvValues.has('profile')).toBe(true);
        expect(() => persistence.clearPersistence()).not.toThrow();
        expect(mmkvValues.size).toBe(0);
    });
});
