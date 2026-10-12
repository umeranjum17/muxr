import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { packageInfoFromPath, packagePathFromInput } from '../infrastructure/audit.mjs';

/**
 * Shared third-party license inventory builder. The npm CLI packer and the
 * desktop AppImage builder both audit through here, so both distributions
 * enforce the same license allow-list and emit the same inventory shape.
 * Nothing here knows about either distribution's bundler: callers pass
 * esbuild metafiles plus the dependency pins they ship.
 */

/** Resolve every node_modules package inlined by the given esbuild bundles and audit it. */
export function bundledDependenciesFromMetafiles(bundles) {
    const bundledPackagePaths = new Set(
        bundles
            .flatMap(({ root, metafile }) => Object.keys(metafile.inputs).map((input) => packagePathFromInput(root, input)))
            .filter((path) => path !== undefined && !/node_modules\/@(?:try)?muxr\//.test(path)),
    );
    return [...bundledPackagePaths]
        .sort()
        .map((path) => ({ ...packageInfoFromPath(path, true), declaredRange: null }));
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

/** Audit one distribution's full dependency set: inlined, platform and installed. */
export function licenseInventory({ bundles, root, rootPackage, declared }) {
    const bundled = bundledDependenciesFromMetafiles(bundles);
    const bundledNames = new Set(bundled.map(({ name }) => name));
    return [
        ...bundled,
        ...ccusagePlatformDependencies({ root, rootPackage }),
        ...desklinkPlatformDependencies({ root }),
        ...installedDependencies({ root, declared, bundledNames }),
    ];
}

/** Copy each dependency's license text and write the inventory beside them. */
export function writeThirdPartyInventory({ inventoryPath, licenseDir, artifact, dependencies, policy = 'Packaging fails on copyleft or unknown/non-approved dependency licenses.' }) {
    mkdirSync(licenseDir, { recursive: true });
    for (const dependency of dependencies) {
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
