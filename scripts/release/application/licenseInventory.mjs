import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { packageInfoFromPath, packagePathFromInput } from '../infrastructure/audit.mjs';

/**
 * Shared third-party license inventory builder. The npm CLI packer and the
 * desktop AppImage builder both audit through here, so both distributions
 * enforce the same license allow-list and emit the same inventory shape.
 * Nothing here knows about either distribution's bundler: callers pass
 * esbuild metafiles plus the dependency pins they ship.
 */

/** Resolve every node_modules package inlined by the given esbuild bundles and audit it. */
export function bundledDependenciesFromMetafiles(bundles, { allowDeclaredOnly = false } = {}) {
    const bundledPackagePaths = new Set(
        bundles
            .flatMap(({ root, metafile }) => Object.keys(metafile.inputs).map((input) => packagePathFromInput(root, input)))
            .filter((path) => path !== undefined && !/node_modules\/@(?:try)?muxr\//.test(path)),
    );
    return [...bundledPackagePaths]
        .sort()
        .map((path) => ({ ...packageInfoFromPath(path, true, { allowDeclaredOnly }), declaredRange: null }));
}

/** Audit installed (not inlined) dependencies by their declared ranges. */
export function installedDependencies({ root, declared, bundledNames }) {
    return Object.keys(declared)
        .filter((name) => !bundledNames.has(name))
        .sort()
        .map((name) => ({
            ...packageInfoFromPath(join(root, 'node_modules', ...name.split('/'), 'package.json'), false),
            declaredRange: declared[name],
        }));
}

function resolveInstalled(fromDir, name) {
    for (let dir = fromDir; ; dir = dirname(dir)) {
        const manifest = join(dir, 'node_modules', ...name.split('/'), 'package.json');
        if (existsSync(manifest)) return manifest;
        if (dirname(dir) === dir) return undefined;
    }
}

/**
 * The production closure electron-builder copies into node_modules: each
 * declared package, then every `dependencies` and installed
 * `optionalDependencies` entry reached from it, resolved the way Node resolves
 * them so nested copies (a second ws under @desklink/host) are audited too.
 * Packages already audited at the same version are skipped.
 */
export function installedClosure({ root, declared, audited }) {
    const found = new Map();
    const queue = Object.keys(declared).sort().map((name) => ({ fromDir: root, name, declaredRange: declared[name], transitiveOf: undefined, optional: false }));
    for (const next of queue) {
        const manifest = resolveInstalled(next.fromDir, next.name);
        if (manifest === undefined) {
            if (next.optional) continue;
            throw new Error(`license audit: ${next.name} is not installed beside ${next.fromDir}`);
        }
        if (found.has(manifest)) continue;
        const info = packageInfoFromPath(manifest, false, { allowDeclaredOnly: true });
        found.set(manifest, { ...info, declaredRange: next.declaredRange, transitiveOf: next.transitiveOf });
        const { dependencies = {}, optionalDependencies = {} } = JSON.parse(readFileSync(manifest, 'utf8'));
        for (const [edges, optional] of [[dependencies, false], [optionalDependencies, true]]) {
            for (const name of Object.keys(edges).sort()) {
                queue.push({ fromDir: dirname(manifest), name, declaredRange: null, transitiveOf: info.name, optional });
            }
        }
    }
    return [...found.values()].filter((entry) => !audited.some(({ name, auditedVersion }) => name === entry.name && auditedVersion === entry.auditedVersion));
}

/**
 * The ccusage native backends install as platform packages beside the
 * wrapper. They are not inlined, but the inventory names each one so the
 * audit pins their versions and license exactly.
 */
export function ccusagePlatformDependencies({ root, rootPackage }) {
    const ccusageManifestPath = join(root, 'node_modules', 'ccusage', 'package.json');
    const ccusageManifest = JSON.parse(readFileSync(ccusageManifestPath, 'utf8'));
    const ccusagePackage = packageInfoFromPath(ccusageManifestPath, false);
    const ccusagePlatformRoot = join(root, 'node_modules', '@ccusage');
    return ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'].map((target) => {
        const name = `@ccusage/ccusage-${target}`;
        const version = ccusageManifest.optionalDependencies?.[name];
        if (version !== rootPackage.dependencies.ccusage) throw new Error(`license audit: ccusage does not pin ${name} to ${rootPackage.dependencies.ccusage}`);
        const installedManifest = join(ccusagePlatformRoot, `ccusage-${target}`, 'package.json');
        if (existsSync(installedManifest)) {
            const pkg = JSON.parse(readFileSync(installedManifest, 'utf8'));
            if (pkg.name !== name || pkg.license !== ccusagePackage.license || pkg.version !== version) {
                throw new Error(`license audit: ccusage platform metadata mismatch for ${pkg.name}@${pkg.version}`);
            }
        }
        return {
            name,
            auditedVersion: version,
            license: ccusagePackage.license,
            bundled: false,
            licensePath: ccusagePackage.licensePath,
            declaredRange: null,
            transitiveOf: 'ccusage',
        };
    });
}

/**
 * Its native executable is desklink's own Apache-2.0 build; the licences of
 * what it links travel inside that package as THIRD_PARTY_LICENSES.txt.
 */
export function desklinkPlatformDependencies({ root }) {
    const desklinkHost = JSON.parse(readFileSync(join(root, 'node_modules', '@desklink', 'host', 'package.json'), 'utf8'));
    return Object.entries(desklinkHost.optionalDependencies)
        .map(([name, version]) => ({
            name,
            auditedVersion: version,
            license: desklinkHost.license,
            bundled: false,
            licensePath: join(root, 'node_modules', '@desklink', 'host', 'LICENSE'),
            declaredRange: null,
            transitiveOf: '@desklink/host',
        }));
}

/**
 * Audit one distribution's full dependency set: inlined, platform and installed.
 * `closure` audits the whole installed production closure instead of only the
 * declared names, and a package that ships no license text is recorded from
 * its package.json license and author instead of failing. Both the npm CLI
 * packer and the desktop AppImage builder audit in closure mode, since npm
 * and electron-builder both ship the transitive production packages.
 */
export function licenseInventory({ bundles, root, rootPackage, declared, closure = false }) {
    const bundled = bundledDependenciesFromMetafiles(bundles, { allowDeclaredOnly: closure });
    const bundledNames = new Set(bundled.map(({ name }) => name));
    const platform = [...ccusagePlatformDependencies({ root, rootPackage }), ...desklinkPlatformDependencies({ root })];
    const installed = closure
        ? installedClosure({ root, declared, audited: [...bundled, ...platform] })
        : installedDependencies({ root, declared, bundledNames });
    return [...bundled, ...platform, ...installed];
}

/** Copy each dependency's license text and write the inventory beside them. */
export function writeThirdPartyInventory({ inventoryPath, licenseDir, artifact, dependencies, policy = 'Packaging fails on copyleft or unknown/non-approved dependency licenses.' }) {
    rmSync(licenseDir, { recursive: true, force: true });
    mkdirSync(licenseDir, { recursive: true });
    for (const dependency of dependencies) {
        if (dependency.licensePath === undefined) continue;
        const licenseFile = `${dependency.name.replaceAll('/', '__')}@${dependency.auditedVersion}.txt`;
        copyFileSync(dependency.licensePath, join(licenseDir, licenseFile));
    }
    writeFileSync(
        inventoryPath,
        `${JSON.stringify({
            artifact,
            policy,
            dependencies: dependencies.map(({ licensePath: _licensePath, ...dependency }) => dependency),
        }, null, 2)}\n`,
    );
}
