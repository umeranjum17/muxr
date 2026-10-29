/**
 * The adb calls that put the release APK on the phone, and the label the
 * receipt records for them.
 *
 * Disposable test devices (an emulator, the test phone) get a fresh app:
 * uninstall, then install, so no pairing to another computer survives. A
 * named production device (`PHONE_PRESERVE_DEVICE=<its serial>`, which must be
 * the serial being driven) is never uninstalled: `install -r` replaces the app
 * and keeps its data. Its pairing then survives too, so the journey's pair
 * step runs against whatever the app already holds.
 */
export function phoneInstallPlan({ serial, apk, preserveDevice, useInstalled = false }) {
    if (apk === undefined) {
        if (!useInstalled) throw new Error('PHONE_APK must point at the release build to install (or PHONE_USE_INSTALLED=1 to drive the installed app)');
        return { install: 'installed-app', calls: [] };
    }
    if (preserveDevice === undefined || preserveDevice === '') return { install: 'fresh', calls: [['uninstall', 'com.trymuxr.app'], ['install', apk]] };
    if (preserveDevice !== serial) throw new Error(`PHONE_PRESERVE_DEVICE ${preserveDevice} is not the device being driven (${serial}); a preserving install names exactly that device`);
    return { install: 'preserving', calls: [['install', '-r', apk]] };
}
