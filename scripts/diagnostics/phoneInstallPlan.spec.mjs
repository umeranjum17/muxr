import { expect, it } from 'vitest';
import { phoneInstallPlan } from './application/phoneInstallPlan.mjs';

it('wipes a disposable device, keeps a named production device, and says which ran', () => {
    expect(phoneInstallPlan({ serial: 'emulator-5554', apk: '/r.apk' })).toEqual({ install: 'fresh', calls: [['uninstall', 'com.trymuxr.app'], ['install', '/r.apk']] });
    const kept = phoneInstallPlan({ serial: 'a4b93ea2', apk: '/r.apk', preserveDevice: 'a4b93ea2' });
    expect(kept).toEqual({ install: 'preserving', calls: [['install', '-r', '/r.apk']] });
    expect(kept.calls.flat()).not.toContain('uninstall');
    expect(() => phoneInstallPlan({ serial: 'emulator-5554', apk: '/r.apk', preserveDevice: 'a4b93ea2' })).toThrow('not the device being driven');
    expect(phoneInstallPlan({ serial: 'a4b93ea2', useInstalled: true })).toEqual({ install: 'installed-app', calls: [] });
});
