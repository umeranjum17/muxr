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
    // The OS launch splash takes one colour; it is the light splash so the
    // installed PWA never flashes black on a light phone (see finalizeWebExport).
    check('manifest background matches the light splash', manifest.background_color === '#F2F2F7', String(manifest.background_color));
    for (const icon of manifest.icons ?? []) {
        const file = join(mobile, 'public', String(icon.src).replace(/^\//, ''));
        check(`manifest icon ${icon.src} ships`, existsSync(file));
    }
}

// 2. Install metadata in the web shell + Expo config.
// The shell metadata is written into the built index.html by
// finalizeWebExport (expo's "single" output ignores any +html.tsx), so it
// is asserted on the artifact below, never on source. Manifest installability
// is asserted above; the finalized shell is asserted in section 8.

// 3. Relay delivery rules are proven behaviorally by checkWebServing (live
// relay + static server over HTTP), not by asserting source strings here.
// The setup-canvaskit/pdfjs/mermaid chain is proven by checkExportIsolation,
// which runs the real chain with canaries and scans the complete dist.

// 4. Secret hygiene: the exportable surface must not carry credentials.
const secretPattern = /(acctok_|EXPO_PUBLIC_MUXR_TOKEN\s*=\s*['"][^'"]+['"]|mint-secret|BEGIN (?:OPENSSH|EC|RSA) PRIVATE KEY)/;
for (const file of ['public/sw.js', 'public/manifest.webmanifest']) {
    const body = read(join(mobile, file));
    check(`no secrets in mobile/${file}`, !secretPattern.test(body));
}

// 5. Deploy behavior (ordering, atomic swap, prune) is not driven here:
// scripts/deployWebExport.sh always runs a full export and targets the real
// document root, so it cannot run against a throwaway fixture in isolation.

// 6. Unhashed entry payload: icons + manifest + worker stay small. This is
// NOT the initial bundle budget — hashed JS/CSS is measured against dist
// below. The known lazy payload (canvaskit.wasm, pdf.worker, mermaid) is
// excluded: it loads on demand, never as startup transfer.
const BUDGET_BYTES = 512 * 1024;
let rootBytes = 0;
for (const name of readdirSync(join(mobile, 'public'))) {
    if (name.endsWith('.wasm') || name === 'pdf.worker.min.mjs' || name === 'mermaid.min.js') continue;
    const info = statSync(join(mobile, 'public', name));
    if (info.isFile()) rootBytes += info.size;
}
check(`public entry payload ≤ ${BUDGET_BYTES} bytes`, rootBytes <= BUDGET_BYTES, `${rootBytes} bytes`);

// 7. The 57MB Whisper model must never enter the web bundle. Proven on the
// built export in section 8 (dist file walk + payload scan when dist exists)
// and on public/ here (copied verbatim into dist).
const publicModels = readdirSync(join(mobile, 'public')).filter((name) => /\.bin$|\.pt$|\.onnx$/i.test(name));
check('no model binaries in public/', publicModels.length === 0, publicModels.slice(0, 5).join(', '));

// 8. Dist properties (only when an export exists — CI exports first).
// Usable load is the gzip of JS/CSS dist/index.html references directly:
// CanvasKit is lazy (never root-awaited, loaded on first Canvas use), so it
// is excluded by construction, and lazy chunks (mermaid languages, pdf
// worker) load on demand. The 2.0 MiB compressed usable-screen target is
// not met yet: the ratchet below is pinned above it until the shell splits.
const distIndex = join(mobile, 'dist', 'index.html');
if (!existsSync(distIndex)) {
    process.stdout.write('..  dist export absent — skipping dist budget/origin checks (CI exports first)\n');
} else {
    const distHtml = read(distIndex);
    const distWorkerPath = join(mobile, 'dist', 'sw.js');
    const distWorker = existsSync(distWorkerPath) ? read(distWorkerPath) : '';
    check('dist service worker carries a build shell version', /const SHELL_VERSION = '[0-9a-f]{16}'/.test(distWorker));
    check('dist service worker omits the unfinalized version token', !distWorker.includes('__MUXR_SHELL_VERSION__'));
    check('dist index links the manifest', distHtml.includes('<link rel="manifest" href="/manifest.webmanifest">'));
    check('dist index theme-color', distHtml.includes('name="theme-color"'));
    check('dist index iOS web-app metadata', distHtml.includes('apple-mobile-web-app-capable') && distHtml.includes('rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png"'));
    check('dist index viewport resizes content for the keyboard', /<meta name="viewport" content="[^"]*interactive-widget=resizes-content[^"]*"/.test(distHtml));
    check('dist index has exactly one viewport meta', (distHtml.match(/<meta name="viewport"/g) ?? []).length === 1);
    check('dist index carries no inline scripts (CSP script-src self)', !/<script(?![^>]*\bsrc=)[^>]*>[^<]/.test(distHtml));
    // The themed web splash: from the first paint, follows the system theme,
    // reuses the native mark, and hides itself structurally the moment React
    // mounts so it can never cover the app's own error or offline screen.
    check('dist index carries the themed web splash', distHtml.includes('id="muxr-splash"') && distHtml.includes('id="muxr-splash-style"'));
    check('dist splash follows prefers-color-scheme', /@media \(prefers-color-scheme:dark\)/.test(distHtml) && distHtml.includes('#F2F2F7') && distHtml.includes('#000000'));
    check('dist splash carries the muxr mark', distHtml.includes('aria-label="muxr"') && distHtml.includes('fill="currentColor"'));
    check('dist splash hides when #root mounts', distHtml.includes('#root:not(:empty)+#muxr-splash{display:none}'));
    const refs = [...new Set(
        [...distHtml.matchAll(/(?:src|href)="(\/[^"]+\.(?:js|css))"/g)].map((match) => match[1]),
    )];
    check('dist index references initial JS/CSS', refs.length > 0);
    check('dist initial refs exclude wasm (CanvasKit is lazy)', refs.every((ref) => !ref.endsWith('.wasm')));
    let initialGzip = 0;
    for (const ref of refs) {
        const file = join(mobile, 'dist', ref.replace(/^\//, ''));
        if (!existsSync(file)) {
            check(`dist asset ships (${ref})`, false);
            continue;
        }
        initialGzip += gzipSync(readFileSync(file)).length;
    }
    // Ratchet, not target. The 2.0 MiB (2,097,152 B) compressed usable-screen
    // target is owned by follow-up pock-pwa-coldstart2 and is not met yet.
    // This head's export, measured on CI, is 2,360,572 B of initial transfer;
    // the pin is that figure x1.005 (2,372,375 B). The terminal, the editor/diff
    // surfaces and
    // the syntax highlighter load as lazy chunks, so none of them run on the
    // landing or pair routes. The highlighter's grammar set is a single static
    // slim list reached only through the diff viewer's lazy import, so no
    // grammar is shared into the eager __common chunk (guarded below by the
    // source.cpp marker).
    const USABLE_GZIP_CEILING = 2372375;
    check(`dist usable gzip ratchet (target 2,097,152 B, pinned at head)`, initialGzip <= USABLE_GZIP_CEILING, `${initialGzip} bytes`);
    // The eager common chunk carries what Metro shares between two lazy
    // chunks; anything here loads before the first paint. After the terminal,
    // diff and highlighter moved behind their own lazy boundaries it holds the
    // shared application shell, not those payloads.
    const commonRef = refs.find((ref) => ref.includes('__common'));
    const commonGzip = commonRef === undefined ? 0 : gzipSync(readFileSync(join(mobile, 'dist', commonRef.replace(/^\//, '')))).length;
    // Ratchet, not target: this head's export measured on CI is 652,730 B,
    // pinned at that figure x1.005 (655,994 B).
    check('dist __common chunk ratchet', commonGzip <= 655994, `${commonGzip} bytes`);
    const refTexts = refs.map((ref) => {
        const file = join(mobile, 'dist', ref.replace(/^\//, ''));
        return existsSync(file) ? readFileSync(file, 'utf8') : '';
    });
    const distText = [distHtml, ...refTexts].join('\n');
    // Origin check via URL parsing (not a substring match): any URL in the
    // payload whose host is the marketing origin is a leak.
    const normalizedText = distText.replace(/\\\//g, '/');
    const candidateUrls = normalizedText.match(/https?:\/\/[^\s"'<>()]+/g) ?? [];
    const hasMarketingOrigin = candidateUrls.some((candidate) => {
        try {
            const host = new URL(candidate).hostname.replace(/\.+$/, '');
            return host === 'trymuxr.com' || host.endsWith('.trymuxr.com');
        } catch {
            return false;
        }
    });
    check('dist initial payload has no marketing origin', !hasMarketingOrigin);
    check('dist initial payload carries no mermaid engine', !distText.includes('__esbuild_esm_mermaid_nm'));
    // The live terminal and its xterm addons must stay in the lazy TerminalRoute
    // chunk. The entry keeps only the small web wrapper, which has no body.
    const initialAssets = refTexts.join('\n');
    check('dist initial JS/CSS carries no xterm payload',
        !initialAssets.includes('xterm-scrollable-element') && !initialAssets.includes('@xterm/addon-webgl'));
    check('dist initial JS carries no syntax grammar payload', !initialAssets.includes('source.cpp'));
    const lazyDir = join(mobile, 'dist', '_expo', 'static', 'js');
    const lazyText = existsSync(lazyDir)
        ? readdirSync(lazyDir, { recursive: true }).filter((name) => String(name).endsWith('.js'))
            .map((name) => readFileSync(join(lazyDir, String(name)), 'utf8')).join('\n')
        : '';
    check('dist lazy chunks carry the xterm payload',
        lazyText.includes('xterm-scrollable-element') && lazyText.includes('@xterm/addon-webgl'));
    check('dist lazy chunks carry the grammar payload', lazyText.includes('source.cpp'));
    // Languages outside the slim set load as on-demand JSON assets, never from
    // the eager payload. The landing HTML must not reference them.
    check('dist ships on-demand grammar assets',
        existsSync(join(mobile, 'dist', 'shiki-langs', 'index.json')) && existsSync(join(mobile, 'dist', 'shiki-langs', 'vue.json')));
    check('dist initial payload never references a grammar asset', !distHtml.includes('/shiki-langs/'));
    // Expo hashes asset names, so inspect emitted model-sized binaries instead
    // of grepping JS metadata for a legitimate filename.
    const MIN_WHISPER_MODEL_BYTES = 50 * 1024 * 1024;
    const distModels = [];
    const walkDistModels = (dir) => {
        if (!existsSync(dir)) return;
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) walkDistModels(path);
            else if (/\.(bin|pt|onnx)$/i.test(entry.name)) {
                const size = statSync(path).size;
                if (size >= MIN_WHISPER_MODEL_BYTES) distModels.push(`${path} (${size} bytes)`);
            }
        }
    };
    walkDistModels(join(mobile, 'dist'));
    check('dist ships no whisper model binary', distModels.length === 0, distModels.slice(0, 5).map((path) => path.replace(`${mobile}/`, '')).join(', '));
    check('dist ships mermaid.min.js for on-demand diagrams', existsSync(join(mobile, 'dist', 'mermaid.min.js')));
    // CanvasKit is fetched lazily by Skia at runtime; without it the app
    // dies in Error initializing. Observed ~8.0 MB; anything under 1 MB is
    // a stub or a truncation, not the engine.
    const canvaskitDist = join(mobile, 'dist', 'canvaskit.wasm');
    const canvaskitBytes = existsSync(canvaskitDist) ? statSync(canvaskitDist).size : 0;
    check('dist ships a full canvaskit.wasm', canvaskitBytes > 1024 * 1024, `${canvaskitBytes} bytes`);
    // The browser QR scanner's decoder WASM ships as a hashed same-origin
    // export asset and loads only when scanning starts (never a CDN, never
    // the entry payload).
    const zxingAssets = [];
    const walkAssets = (dir) => {
        if (!existsSync(dir)) return;
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) walkAssets(path);
            else if (/^zxing_reader\.[0-9a-f]{32}\.wasm$/.test(entry.name)) zxingAssets.push(path);
        }
    };
    walkAssets(join(mobile, 'dist', 'assets'));
    // The pairing/QR slice has not landed, so no scanner WASM ships yet:
    // validate shape only when present, and that slice restores the presence
    // requirement (exactly one full hashed reader) with the scanner source.
    if (zxingAssets.length === 0) {
        process.stdout.write('..  no zxing reader asset — pairing/QR slice not landed, skipping presence (shape still enforced when present)\n');
    } else {
        check('dist zxing reader WASM is one full hashed asset', zxingAssets.length === 1 && statSync(zxingAssets[0]).size > 512 * 1024, zxingAssets.map((path) => path.replace(`${mobile}/`, '')).join(', '));
    }
    check('dist initial payload never names the decoder CDN', !distText.includes('jsdelivr'));
}

if (failures.length > 0) {
    process.stderr.write(`checkWebExport: ${failures.length} failing check(s)\n`);
    process.exit(1);
}
process.stdout.write('checkWebExport: all web-export checks passed\n');
