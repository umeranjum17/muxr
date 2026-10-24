/**
 * The released arm64 APK's static checks, for a release journey that ran its
 * x86_64 twin on an emulator.
 *
 * React Native cannot load the stable APK's arm64-only libraries under an
 * x86_64 emulator's ARM translation, so the journey runs an x86_64 APK built
 * from the release's own commit (journey-apk.yml). This records what binds
 * the two: both APK digests, the commit and source digest the journey APK was
 * built from, and the checks the released APK passed against the bytes its
 * release sealed (apkCheckFault in ../domain/releaseJourney.mjs reads them).
 * It reads the release directory as `gh release download` leaves it.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { APK_CHECKS, releaseBuild } from '../domain/releaseJourney.mjs';
import { artifactPath, readReleaseManifest } from '../infrastructure/artifacts.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** apksigner and apkanalyzer from the Android SDK at `sdk`. */
function androidTools(sdk) {
    const buildTools = join(sdk, 'build-tools');
    const newest = existsSync(buildTools) ? readdirSync(buildTools).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).pop() : undefined;
    const tools = { apksigner: newest && join(buildTools, newest, 'apksigner'), apkanalyzer: join(sdk, 'cmdline-tools', 'latest', 'bin', 'apkanalyzer') };
    for (const [name, path] of Object.entries(tools)) if (!path || !existsSync(path)) throw new Error(`no ${name} in the Android SDK at ${sdk}`);
    return tools;
}

const run = (bin, args) => execFileSync(bin, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 300_000 });

// A library tuned per CPU (whisper.rn's librnwhisper_v8fp16_va_2.so, _x86_64.so) counts once under its base name.
const ABI_TUNED = /_(?:v8\w*|x86(?:_64)?)\.so$/;

/** The native libraries an APK carries, as { abi: [names] }, CPU-tuned variants folded. */
function nativeLibs(apk) {
    const libs = {};
    for (const entry of run('unzip', ['-Z1', apk]).split('\n')) {
        const match = /^lib\/([^/]+)\/([^/]+\.so)$/.exec(entry);
        if (match) (libs[match[1]] ??= new Set()).add(match[2].replace(ABI_TUNED, '.so'));
    }
    return Object.fromEntries(Object.entries(libs).map(([abi, names]) => [abi, [...names].sort()]));
}

/**
 * Check the released APK in `directory` (its release-manifest.json, APK,
 * signer.txt, compiled-manifest.xml and native-provenance.json) against the x86_64 `journeyApk` and
 * its build record `journeyBuild` (perf/buildPrApk.mjs's `<apk>.json`).
 * Returns the record to commit at apkCheckPath(version); a failed check is
 * recorded as such with the reason, never thrown.
 */
export function checkReleaseApk({ version, directory, journeyApk, journeyBuild, sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT }) {
    if (!sdk) throw new Error('set ANDROID_HOME to an Android SDK with build-tools and cmdline-tools');
    const tools = androidTools(sdk);
    const manifest = readReleaseManifest(directory);
    const build = releaseBuild(manifest);
    if (build.version !== version) throw new Error(`the release in ${directory} is ${build.version}, not ${version}`);
    // Every file read here is the release's own: its digest is the sealed one.
    const sealed = (suffix) => {
        const artifact = manifest.artifacts.find((item) => item.name.endsWith(suffix));
        if (!artifact) throw new Error(`the ${version} release seals no ${suffix}`);
        const bytes = readFileSync(artifactPath(directory, artifact.name));
        if (sha256(bytes) !== artifact.sha256) throw new Error(`${artifact.name} in ${directory} is not the file the ${version} release sealed`);
        return { name: artifact.name, path: join(directory, artifact.name), bytes };
    };
    const apk = sealed('.apk');
    const signer = sealed('signer.txt');
    const compiled = sealed('compiled-manifest.xml');
    const provenance = JSON.parse(sealed('native-provenance.json').bytes.toString('utf8'));

    const journeyBytes = readFileSync(journeyApk);
    const journey = JSON.parse(readFileSync(journeyBuild, 'utf8'));
    if (journey.apkSha256 !== sha256(journeyBytes)) throw new Error(`${journeyBuild} describes another APK than ${journeyApk}`);

    const checks = {};
    const detail = {};
    const check = (name, test) => {
        let fault;
        try { fault = test(); } catch (error) { fault = error instanceof Error ? error.message.split('\n')[0] : String(error); }
        checks[name] = fault ? 'fail' : 'pass';
        if (fault) detail[name] = fault;
    };
    check('signature', () => (run(tools.apksigner, ['verify', '--print-certs', apk.path]) === signer.bytes.toString('utf8')
        ? null : 'apksigner prints another signer than the sealed signer.txt'));
    check('manifest', () => {
        const id = run(tools.apkanalyzer, ['manifest', 'application-id', apk.path]).trim();
        if (id !== 'com.trymuxr.app') return `its application id is ${id}, not com.trymuxr.app`;
        return run(tools.apkanalyzer, ['manifest', 'print', apk.path]) === compiled.bytes.toString('utf8')
            ? null : 'its compiled manifest is not the sealed compiled-manifest.xml';
    });
    check('nativeLibs', () => {
        const released = nativeLibs(apk.path);
        const twin = nativeLibs(journeyApk);
        if (Object.keys(released).join() !== 'arm64-v8a') return `it carries ${Object.keys(released).join(', ') || 'no'} libraries, not arm64-v8a only`;
        if (Object.keys(twin).join() !== 'x86_64') return `the journey APK carries ${Object.keys(twin).join(', ') || 'no'} libraries, not x86_64 only`;
        if (!released['arm64-v8a'].includes('libreactnative.so')) return 'it carries no libreactnative.so';
        const [ours, theirs] = [released['arm64-v8a'].join(), twin.x86_64.join()];
        return ours === theirs ? null : 'its arm64-v8a libraries are not the set the journey APK carries for x86_64';
    });
    check('version', () => {
        const name = run(tools.apkanalyzer, ['manifest', 'version-name', apk.path]).trim();
        const code = run(tools.apkanalyzer, ['manifest', 'version-code', apk.path]).trim();
        const named = /-(\d+)\.apk$/.exec(apk.name)?.[1];
        if (name !== manifest.release.appVersion) return `its versionName is ${name}, not ${manifest.release.appVersion}`;
        return code === named ? null : `its versionCode is ${code}, not ${named} from ${apk.name}`;
    });
    check('code', () => {
        // The JS bundle and the dex are ABI-free: the twin must carry the release's own bytes.
        const code = (path) => run('unzip', ['-Z1', path]).split('\n').filter((entry) => /^(classes\d*\.dex|assets\/index\.android\.bundle)$/.test(entry)).sort();
        const entries = code(apk.path);
        if (!entries.includes('assets/index.android.bundle')) return 'it carries no JS bundle';
        if (entries.join() !== code(journeyApk).join()) return 'the journey APK carries other dex or bundle entries';
        const digest = (path, entry) => sha256(execFileSync('unzip', ['-p', path, entry], { maxBuffer: 256 * 1024 * 1024 }));
        const differs = entries.filter((entry) => digest(apk.path, entry) !== digest(journeyApk, entry));
        return differs.length ? `the journey APK's ${differs.join(', ')} differ from the release's` : null;
    });
    check('source', () => {
        if (journey.dirty !== false) return 'the journey APK was built from a dirty checkout';
        if (journey.revision !== provenance.revision || journey.revision !== build.commit) return `the journey APK was built from ${journey.revision}, not ${build.commit}`;
        if (journey.sourceSha256 !== provenance.sourceSha256) return 'the journey APK was built from other source than the sealed native-provenance.json names';
        return JSON.stringify(journey.nativeDependencies) === JSON.stringify(provenance.nativeDependencies)
            ? null : 'the journey APK was built with other native patches than the release';
    });
    return {
        schema: 1,
        version,
        releaseApk: { name: apk.name, sha256: build.apk, checks, ...(Object.keys(detail).length ? { detail } : {}) },
        journeyApk: { name: basename(journeyApk), sha256: journey.apkSha256, abi: 'x86_64', commit: journey.revision,
            sourceSha256: journey.sourceSha256, builtBy: journey.builtBy ?? 'unknown' },
        passed: APK_CHECKS.every((name) => checks[name] === 'pass'),
    };
}
