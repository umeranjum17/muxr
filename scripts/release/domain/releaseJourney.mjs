/**
 * The release journey's result for one exact build, and what it must say
 * before that build may become stable.
 *
 * The journey (`phone-attach`, scripts/diagnostics/application/checkPhoneAttach.mjs)
 * drives the release APK on an emulator against a host started from the
 * release's own npm tarball, and writes `release-build.json`: the version, the
 * sha256 of the APK and of the tarball it ran, the steps it passed, how many
 * hosts were alive at the end, and how long the attach and the fast scroll
 * took. The receipt cites that file by digest, and the release commits it at
 * `buildResultPath(version)` next to the receipt.
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
 * Time budgets, in milliseconds, set at about twice what a person should wait,
 * so device jitter passes and a wedge does not:
 * - `attachMs`: from the tap on the agent on Home until the host logged the
 *   pane's new terminal stream, sent once Herdr painted its first frame. The
 *   goal is 2 s; 0.2.12 measured 0.4-1.0 s on the x86_64 emulator at the
 *   reference phone's 270 x 594 dp. The 9.7-11.5 s 0.2.10 baseline counted
 *   the journey's own ui dumps and one-second polls, not the attach.
 * - `scrollMs`: the slower of a fast fling back into history until the phone
 *   offers Latest, and a fast fling forward until it is back at the newest
 *   output (0.2.10 on the arm64 test phone: 2.3 s back, 3.7 s forward).
 */
export const RELEASE_BUDGETS = Object.freeze({ attachMs: 4_000, scrollMs: 7_500 });

/** Where a release commits the journey result for one version. */
export const buildResultPath = (version) => `${RECEIPT_DIR}/builds/${version}.json`;

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
 * The build a sealed release manifest names: its version and the sha256 of
 * the APK and npm tarball it carries (an npm-only manifest has no APK).
 */
export function releaseBuild(manifest) {
    const version = manifest?.release?.version;
    if (typeof version !== 'string') throw new Error('the release manifest names no version');
    const artifacts = Array.isArray(manifest.artifacts) ? manifest.artifacts : [];
    const digest = (suffix) => artifacts.find((item) => typeof item?.name === 'string' && item.name.endsWith(suffix))?.sha256;
    return { version, apk: digest('.apk'), package: digest('.tgz') };
}
