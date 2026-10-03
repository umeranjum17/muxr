import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Exercise the committed Android project and Expo's actual EAS injection script.
// No application build tasks execute, and no release credentials are used.
const root = fileURLToPath(new URL('../../../', import.meta.url));
const android = join(root, 'apps/mobile/android');
const credentialsFile = join(root, 'apps/mobile/credentials.json');
const require = createRequire(import.meta.url);
const easScript = require('@expo/config-plugins/build/android/EasBuildGradleScript.js').default;
const cache = join(root, '.cache/managed-validation');
mkdirSync(cache, { recursive: true });
const scratch = mkdtempSync(join(cache, 'release-signing-'));
const store = join(scratch, 'fixture.p12');
const password = 'throwaway-fixture';
const alias = 'fixture';
const groovyString = (value) => `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
const evidence = process.argv[2] ? resolve(process.argv[2]) : scratch;
mkdirSync(evidence, { recursive: true });
let credentialsOwned = false;

function run(command, args, cwd = root, env = process.env) {
    const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 180_000, maxBuffer: 16 * 1024 * 1024 });
    if (result.error) throw result.error;
    return { status: result.status, output: result.stdout + result.stderr };
}

try {
    const key = run('keytool', ['-genkeypair', '-keystore', store, '-storetype', 'PKCS12',
        '-storepass', password, '-keypass', password, '-alias', alias, '-keyalg', 'RSA',
        '-dname', 'CN=Throwaway configuration fixture', '-validity', '1', '-noprompt']);
    assert.equal(key.status, 0, key.output);
    writeFileSync(join(scratch, 'eas-build.gradle'), easScript);
    // Exclusive creation prevents replacing any developer's signing material.
    writeFileSync(credentialsFile, JSON.stringify({ android: { keystore: {
        keystorePath: store, keystorePassword: password, keyAlias: alias,
        // Standard EAS PKCS12 injection supplies keyPassword from keystorePassword.
    } } }), { flag: 'wx', mode: 0o600 });
    credentialsOwned = true;

    const manual = [`-PreleaseStoreFile=${store}`, `-PreleaseStorePassword=${password}`,
        `-PreleaseKeyAlias=${alias}`, `-PreleaseKeyPassword=${password}`];
    const signerError = 'A configured Release signer and existing signing store are required';
    const cases = [
        { name: 'manual', properties: manual },
        { name: 'eas', injection: 'eas' },
        { name: 'missing', error: signerError },
        { name: 'partial', properties: [`-PreleaseKeyAlias=${alias}`], error: 'All release signing properties are required' },
        { name: 'null', properties: manual, injection: 'null', error: signerError },
        { name: 'debug', properties: manual, injection: 'debug', error: signerError },
        { name: 'eas-missing-version', injection: 'eas', versions: [], error: 'A semantic appVersion is required' },
        { name: 'eas-missing-code', injection: 'eas', versions: ['-PappVersion=0.2.4'], error: 'A positive androidVersionCode is required' },
    ];
    const results = [];
    for (const scenario of cases) {
        const init = join(scratch, `${scenario.name}.gradle`);
        let injection = '';
        if (scenario.injection === 'eas') injection = `
        p.apply from: ${groovyString(join(scratch, 'eas-build.gradle'))}
        // EAS listens for task addition; adding a task drives its real callback.
        p.tasks.create('muxrSigningConfigurationProbe')
        `;
        if (scenario.injection === 'null') injection = 'p.android.buildTypes.release.signingConfig = null';
        if (scenario.injection === 'debug') injection = 'p.android.buildTypes.release.signingConfig = p.android.signingConfigs.debug';
        writeFileSync(init, `
gradle.beforeProject { p ->
    if (p.path == ':app') p.afterEvaluate {
        ${injection}
        gradle.taskGraph.whenReady { graph ->
            assert graph.allTasks.any { it.project == p && it.name == 'assembleRelease' }
            ${scenario.error ? "throw new GradleException('Expected signing/version rejection before build tasks')" : `
            def signer = p.android.buildTypes.release.signingConfig
            assert signer != null && signer.name == 'release'
            assert signer.storeFile.canonicalPath == ${groovyString(store)}
            assert signer.storePassword == ${groovyString(password)}
            assert signer.keyAlias == ${groovyString(alias)}
            assert signer.keyPassword == ${groovyString(password)}
            assert p.android.defaultConfig.versionName == '0.2.4'
            assert p.android.defaultConfig.versionCode == 24
            println 'MUXR_RELEASE_CONFIGURATION_OK: signer=release version=0.2.4 code=24'
            `}
        }
    }
}
`);
        // Avoid ambient project-property signing overrides, retaining SDK/JDK setup.
        const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('ORG_GRADLE_PROJECT_')));
        env.EAS_BUILD = 'true';
        const result = run('./gradlew', [':app:assembleRelease', '--dry-run', '--offline', '--no-daemon',
            '--console=plain', '--init-script', init,
            ...(scenario.versions ?? ['-PappVersion=0.2.4', '-PandroidVersionCode=24']),
            ...(scenario.properties ?? [])], android, env);
        writeFileSync(join(evidence, `${scenario.name}.log`), result.output, { mode: 0o600 });
        if (scenario.error) {
            assert.notEqual(result.status, 0, `${scenario.name} unexpectedly accepted`);
            assert.ok(result.output.includes(scenario.error), result.output);
        } else {
            assert.equal(result.status, 0, result.output);
            assert.ok(result.output.includes('MUXR_RELEASE_CONFIGURATION_OK'), result.output);
            assert.ok(result.output.includes(':app:assembleRelease SKIPPED'), result.output);
        }
        results.push({ name: scenario.name, result: 'passed', scope: 'Gradle configuration/dry-run' });
        console.log(`${scenario.name}: passed (configuration/dry-run only)`);
    }
    writeFileSync(join(evidence, 'results.json'), JSON.stringify({
        scope: 'Android signing/version build configuration only', results,
        unvalidated: ['native build/install', 'store upload', 'Mac/iPhone journeys', 'Pi reconnect journeys'],
    }, null, 2));
} finally {
    if (credentialsOwned) rmSync(credentialsFile);
    rmSync(scratch, { recursive: true, force: true });
}
