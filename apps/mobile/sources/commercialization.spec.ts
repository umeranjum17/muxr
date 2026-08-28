import { describe, expect, it, vi } from 'vitest';

const mmkvValues = vi.hoisted(() => new Map<string, string>());
vi.mock('react-native-mmkv', () => ({
    MMKV: class {
        getString(key: string) { return mmkvValues.get(key); }
        set(key: string, value: string) { mmkvValues.set(key, value); }
        delete(key: string) { mmkvValues.delete(key); }
        clearAll() { mmkvValues.clear(); }
    },
}));
import {
    directBillingUrl,
    firstRestorableMachine,
    MOBILE_ONBOARDING_CHOICES,
    setupEmptyState,
} from '@/commercialization';

describe('open-source mobile onboarding flow', () => {
    it('keeps pairing semantics, the no-machine handoff, and every commerce surface absent', () => {
        expect(MOBILE_ONBOARDING_CHOICES).toEqual(['Scan to connect']);

        expect(firstRestorableMachine([
            { id: 'new-machine', paired: false },
            { id: 'existing-grant', paired: true },
        ])).toBe('existing-grant');
        expect(firstRestorableMachine([{ id: 'new-machine', paired: false }])).toBeUndefined();

        expect(setupEmptyState('https://muxr.test/')).toEqual({
            title: 'Connect your computer',
            command: 'node scripts/cli.mjs setup',
            setupUrl: 'https://muxr.test/setup',
        });
        expect(setupEmptyState()).toEqual({
            title: 'Connect your computer',
            command: 'node scripts/cli.mjs setup',
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
        const persistence = await import('@/sync/persistence');

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
});
