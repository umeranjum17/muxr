/**
 * The release journey's result for one exact build, and what it must say
 * before that build may become stable.
 *
 * The journey (`phone-attach`, scripts/diagnostics/application/checkPhoneAttach.mjs)
 * drives an APK on an emulator against a host started from the release's own
 * npm tarball, and writes `release-build.json`: the version, the sha256 of the
 * APK and of the tarball it ran, the steps it passed, how many hosts were
 * alive at the end, and how long the attach and the fast scroll took. The
 * receipt cites that file by digest, and the release commits it at
 * `buildResultPath(version)` next to the receipt.
 *
 * The stable APK carries only arm64 libraries and React Native cannot load
 * them under an x86_64 emulator's ARM translation, so the journey may instead
 * run an x86_64 APK built from the release's own commit (journey-apk.yml).
 * The release then also commits `apkCheckPath(version)`: both APK digests,
 * the commit the journey APK was built from, and the static checks the
 * released arm64 APK passed. The owner's own phone test stays the last gate.
 */
import { RECEIPT_DIR } from './releaseMetadata.mjs';

export const RELEASE_JOURNEY = 'phone-attach';

/**
 * Every step the journey must pass, in the order a user meets them. 0.2.9
 * failed `attach` (panes never attached); 0.2.8 failed `one-host` (the Usage
 * ledger child booted a second host).
 */
export const RELEASE_STEPS = ['pair', 'attach', 'send', 'scroll', 'usage', 'one-host'];

/**
 * Time budgets, in milliseconds, set at about twice the slowest baseline the
 * journey measured on the 0.2.10 stable build (the exact APK, sha256
 * fbdd5ae7…, on the arm64 test phone, host from the 0.2.10 tarball, 22 Oct),
 * so device jitter passes and a wedge does not:
 * - `attachMs`: tapping the agent on Home until the terminal shows and the
 *   host logged a new terminal stream (baseline 9.7 s and 11.5 s).
 * - `scrollMs`: the slower of a fast fling back into history until the phone
 *   offers Latest, and a fast fling forward until it is back at the newest
 *   output (baseline 2.3 s back, 3.7 s forward).
 */
export const RELEASE_BUDGETS = Object.freeze({ attachMs: 23_000, scrollMs: 7_500 });

/** Where a release commits the journey result for one version. */
export const buildResultPath = (version) => `${RECEIPT_DIR}/builds/${version}.json`;

/** Where a release commits the released APK's checks when the journey ran a same-commit x86_64 build. */
export const apkCheckPath = (version) => `${RECEIPT_DIR}/builds/${version}.release-apk.json`;

/**
 * What the released arm64 APK must pass when the journey ran its x86_64 twin:
 * - `signature`: apksigner verifies it and prints exactly the sealed signer.txt;
 * - `manifest`: it is com.trymuxr.app and its compiled manifest is exactly the sealed compiled-manifest.xml;
 * - `nativeLibs`: it carries arm64-v8a libraries only, the same set the journey APK carries for x86_64;
 * - `version`: its versionName is the release's app version and its versionCode the one in its name;
 * - `code`: its JS bundle and dex files are byte for byte the journey APK's;
 * - `source`: the journey APK was built clean from the commit, source digest and native patches the sealed native-provenance.json names.
 */
export const APK_CHECKS = ['signature', 'manifest', 'nativeLibs', 'version', 'code', 'source'];

const DIGEST = /^[0-9a-f]{64}$/;

/**
 * Why a journey result does not let `build` ({ version, apk, package }, each
 * digest a sha256) go stable, or null. A digest left out of `build` is not
 * compared; at least one must be given.
 */
export function buildResultFault(result, build, budgets = RELEASE_BUDGETS) {
    if (!result || typeof result !== 'object') return 'it is not a journey result';
    if (result.schema !== 1) return `its schema is ${result.schema}, not 1`;
    if (result.journey !== RELEASE_JOURNEY) return `it is a ${result.journey} result, not ${RELEASE_JOURNEY}`;
    if (result.version !== build.version) return `it ran ${result.version}, not ${build.version}`;
    if (build.apk === undefined && build.package === undefined) return 'the release names no build digest to compare';
    for (const kind of ['apk', 'package']) {
        if (build[kind] === undefined) continue;
        if (!DIGEST.test(build[kind])) return `the release's ${kind} digest ${build[kind]} is not a sha256`;
        if (result.build?.[kind] !== build[kind]) {
            return `it ran ${kind} ${String(result.build?.[kind]).slice(0, 12)}, not this release's ${build[kind].slice(0, 12)}`;
        }
    }
    if (result.result !== 'pass') return `its result is ${result.result}, not pass`;
    const missed = RELEASE_STEPS.filter((step) => result.steps?.[step] !== 'pass');
    if (missed.length) return `it did not pass ${missed.join(', ')}`;
    if (result.hosts !== 1) return `${result.hosts} hosts were alive at the end, not exactly one`;
    for (const [name, budget] of Object.entries(budgets)) {
        const took = result.timings?.[name];
        if (!Number.isFinite(took) || took < 0) return `it recorded no ${name}`;
        if (took > budget) return `its ${name} of ${took} is over the ${budget} budget`;
    }
    return null;
}

/**
 * Why a released-APK check record does not let a journey on another APK stand
 * for `build` ({ version, apk, commit }), or null: it must name the release's
 * own APK with every check passed, and a journey APK built from the release's
 * own commit.
 */
export function apkCheckFault(check, build) {
    if (!check || typeof check !== 'object') return 'it is not a release APK check';
    if (check.schema !== 1) return `its schema is ${check.schema}, not 1`;
    if (check.version !== build.version) return `it checked ${check.version}, not ${build.version}`;
    if (!DIGEST.test(build.apk ?? '')) return 'the release names no APK digest to check';
    if (check.releaseApk?.sha256 !== build.apk) return `it checked apk ${String(check.releaseApk?.sha256).slice(0, 12)}, not this release's ${build.apk.slice(0, 12)}`;
    const failed = APK_CHECKS.filter((name) => check.releaseApk?.checks?.[name] !== 'pass');
    if (failed.length) return `the released apk did not pass ${failed.join(', ')}`;
    if (!DIGEST.test(check.journeyApk?.sha256 ?? '')) return 'it names no journey apk digest';
    if (typeof build.commit !== 'string' || check.journeyApk?.commit !== build.commit) {
        return `its journey apk was built from ${String(check.journeyApk?.commit).slice(0, 12)}, not the release commit ${String(build.commit).slice(0, 12)}`;
    }
    return null;
}

/**
 * The build a sealed release manifest names: its version, the commit it was
 * sealed from, and the sha256 of the APK and npm tarball it carries (an
 * npm-only manifest has no APK).
 */
export function releaseBuild(manifest) {
    const version = manifest?.release?.version;
    if (typeof version !== 'string') throw new Error('the release manifest names no version');
    const artifacts = Array.isArray(manifest.artifacts) ? manifest.artifacts : [];
    const digest = (suffix) => artifacts.find((item) => typeof item?.name === 'string' && item.name.endsWith(suffix))?.sha256;
    return { version, commit: manifest.source?.commit, apk: digest('.apk'), package: digest('.tgz') };
}
