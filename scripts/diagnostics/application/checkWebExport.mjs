/**
 * Web-export release diagnostic.
 *
 * Source-level checks always run (manifest, install metadata, relay
 * MIME/cache rules, secret hygiene). When apps/mobile/dist exists — CI
 * exports first — it additionally verifies real dist properties: the gzip
 * size of the JS/CSS directly referenced by dist/index.html against the
 * initial-transfer regression budget, and that no marketing origin leaked
 * into the self-host export.
 */
import { gzipSync } from 'node:zlib';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const failures = [];
const check = (name, ok, detail = '') => {
    const mark = ok ? 'ok' : 'FAIL';
    const suffix = detail === '' ? '' : ` — ${detail}`;
    process.stdout.write(`${mark}  ${name}${suffix}\n`);
    if (!ok) failures.push(name);
};

const mobile = join(root, 'apps', 'mobile');
const read = (path) => readFileSync(path, 'utf8');

// 1. Manifest: valid, installable, icons resolve.
const manifestPath = join(mobile, 'public', 'manifest.webmanifest');
let manifest;
try {
    manifest = JSON.parse(read(manifestPath));
    check('manifest parses', true);
} catch (cause) {
    check('manifest parses', false, cause instanceof Error ? cause.message : String(cause));
}
if (manifest !== undefined) {
    check('manifest display standalone', manifest.display === 'standalone');
    check('manifest has name', typeof manifest.name === 'string' && manifest.name.length > 0);
    check('manifest start_url', manifest.start_url === '/');
    const sizes = new Set((manifest.icons ?? []).map((icon) => `${icon.sizes}:${icon.purpose ?? 'any'}`));
    check('manifest 192 + 512 any icons', sizes.has('192x192:any') && sizes.has('512x512:any'));
    check('manifest maskable icons', sizes.has('192x192:maskable') && sizes.has('512x512:maskable'));
    for (const icon of manifest.icons ?? []) {
        const file = join(mobile, 'public', String(icon.src).replace(/^\//, ''));
        check(`manifest icon ${icon.src} ships`, existsSync(file));
    }
}

// 2. Install metadata in the web shell + Expo config.
const html = read(join(mobile, 'sources', 'app', '+html.tsx'));
check('+html links manifest', html.includes('rel="manifest"') && html.includes('/manifest.webmanifest'));
check('+html theme-color', html.includes('name="theme-color"'));
check('+html iOS web-app metadata', html.includes('apple-mobile-web-app-capable') && html.includes('apple-touch-icon'));
const appConfig = read(join(mobile, 'app.config.js'));
check('app.config web display standalone', appConfig.includes('display: "standalone"') || appConfig.includes("display: 'standalone'"));
check('app.config web themeColor', appConfig.includes('themeColor'));

// 3. Relay delivery rules.
const relay = read(join(root, 'apps', 'relay', 'src', 'relay.ts'));
check('relay serves .mjs as javascript', relay.includes("'.mjs': 'text/javascript"));
check('relay serves .webmanifest', relay.includes("'.webmanifest': 'application/manifest+json'"));
check('relay sw.js revalidates', relay.includes("base === 'sw.js'"));
check('relay manifest revalidates', relay.includes("base === 'manifest.webmanifest'"));
check('relay web permissions allow self camera/mic', relay.includes("'permissions-policy': 'camera=(self), microphone=(self)"));

// 4. Secret hygiene: the exportable surface must not carry credentials.
const secretPattern = /(acctok_|EXPO_PUBLIC_MUXR_TOKEN\s*=\s*['"][^'"]+['"]|mint-secret|BEGIN (?:OPENSSH|EC|RSA) PRIVATE KEY)/;
for (const file of ['public/sw.js', 'public/manifest.webmanifest', 'sources/app/+html.tsx']) {
    const body = read(join(mobile, file));
    check(`no secrets in mobile/${file}`, !secretPattern.test(body));
}
const deploy = read(join(root, 'scripts', 'deployWebExport.sh'));
check('deploy uses the credential-free selfhost export', deploy.includes('web:export:selfhost'));
check('deploy does not bake marketing origin', deploy.includes('-u MUXR_PUBLIC_BASE_URL') || read(join(root, 'package.json')).includes('"web:export:selfhost": "npm run web:export"'));
const rsyncAt = deploy.indexOf('rsync -a');
const entriesAt = deploy.indexOf('Mutable entries last');
check('deploy syncs assets before replacing entries', rsyncAt !== -1 && entriesAt !== -1 && rsyncAt < entriesAt);
check('deploy never deletes the live root', !deploy.includes('--delete') && !deploy.includes('mv "$DOC_ROOT"'));
check('deploy prunes only aged orphans', deploy.includes('-mtime') && deploy.includes('PRUNE_DAYS'));

// 5. Unhashed entry payload: icons + manifest + worker stay small. This is
// NOT the initial bundle budget — hashed JS/CSS is measured against dist
// below. It only guards the always-fetched root files.
const BUDGET_BYTES = 512 * 1024;
let rootBytes = 0;
for (const name of readdirSync(join(mobile, 'public'))) {
    if (name.endsWith('.mjs') && name.includes('pdf')) continue; // hashed lazy worker, not entry payload
    const info = statSync(join(mobile, 'public', name));
    if (info.isFile()) rootBytes += info.size;
}
check(`public entry payload ≤ ${BUDGET_BYTES} bytes`, rootBytes <= BUDGET_BYTES, `${rootBytes} bytes`);

// 6. The 57MB Whisper model must never enter the web bundle. It lives in
// sources/assets (native-only), and Metro platform resolution shadows the
// only importer: localTranscription.web.ts wins over localTranscription.ts
// on web, so `require('@/assets/models/*.bin')` never enters the web graph.
// Assert the shadow exists for every .bin importer, and that public/ (copied
// verbatim into dist) holds no model binary.
const binImporters = [];
const walkImports = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) { walkImports(path); continue; }
        if (!/\.(ts|tsx|js)$/.test(entry.name) || entry.name.endsWith('.spec.ts') || entry.name.endsWith('.web.ts')) continue;
        const body = readFileSync(path, 'utf8');
        if (/require\(['"][^'"]*\.bin['"]\)|from ['"][^'"]*\.bin['"]/.test(body)) binImporters.push(path);
    }
};
walkImports(join(mobile, 'sources'));
for (const importer of binImporters) {
    const shadow = importer.replace(/\.tsx?$/, '.web.ts').replace(/\.js$/, '.web.js');
    const shadowed = existsSync(shadow);
    check(`web shadow keeps model out (${importer.replace(`${root}/`, '')})`, shadowed, shadowed ? '' : `missing ${shadow.replace(`${root}/`, '')}`);
}
const publicModels = readdirSync(join(mobile, 'public')).filter((name) => /\.bin$|\.pt$|\.onnx$/i.test(name));
check('no model binaries in public/', publicModels.length === 0, publicModels.slice(0, 5).join(', '));

// 7. Dist properties (only when an export exists — CI exports first). The
// initial transfer is the JS/CSS dist/index.html references directly; lazy
// chunks (mermaid languages, canvaskit) load on demand and are not budgeted
// here. Tight target: 3.12 MB gzip (2026-09-10); the enforced regression
// budget carries headroom for content churn.
const distIndex = join(mobile, 'dist', 'index.html');
if (!existsSync(distIndex)) {
    process.stdout.write('..  dist export absent — skipping dist budget/origin checks (CI exports first)\n');
} else {
    const distHtml = read(distIndex);
    const refs = [...new Set(
        [...distHtml.matchAll(/(?:src|href)="(\/[^"]+\.(?:js|css))"/g)].map((match) => match[1]),
    )];
    check('dist index references initial JS/CSS', refs.length > 0);
    let initialGzip = 0;
    for (const ref of refs) {
        const file = join(mobile, 'dist', ref.replace(/^\//, ''));
        if (!existsSync(file)) {
            check(`dist asset ships (${ref})`, false);
            continue;
        }
        initialGzip += gzipSync(readFileSync(file)).length;
    }
    const INITIAL_GZIP_BUDGET = Math.round(3.5 * 1024 * 1024);
    check(`dist initial gzip ≤ 3.5 MB (target 3.12)`, initialGzip <= INITIAL_GZIP_BUDGET, `${(initialGzip / 1024 / 1024).toFixed(2)} MB`);
    const distText = [distHtml, ...refs.map((ref) => {
        const file = join(mobile, 'dist', ref.replace(/^\//, ''));
        return existsSync(file) ? readFileSync(file, 'utf8') : '';
    })].join('\n');
    check('dist initial payload has no marketing origin', !distText.includes('https://trymuxr.com'));
}

if (failures.length > 0) {
    process.stderr.write(`checkWebExport: ${failures.length} failing check(s)\n`);
    process.exit(1);
}
process.stdout.write('checkWebExport: all web-export checks passed\n');
