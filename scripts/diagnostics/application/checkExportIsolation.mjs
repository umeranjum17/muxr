#!/usr/bin/env node
/**
 * Export-isolation verifier: proves the web export chain sanitizes secrets.
 *
 * Runs the real setup-canvaskit + setup-pdfjs + expo export chain into a
 * throwaway directory with canary credentials set in the environment, then
 * scans the COMPLETE dist (initial chunks, lazy chunks, workers, maps) for
 * the canaries. Any hit means the chain bakes environment secrets into
 * shipped bytes. Cleans up afterwards; exits non-zero on the first hit.
 *
 * This is the behavioral counterpart to checkWebExport's shipped-dist scan:
 * that proves the artifact is clean, this proves the chain cannot dirty it.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const mobile = join(root, 'apps', 'mobile');

const CANARIES = {
    EXPO_PUBLIC_MUXR_TOKEN: 'muxr-canary-token-9f3k',
    EXPO_PUBLIC_MUXR_MACHINE_ID: 'muxr-canary-machine-9f3k',
    EXPO_PUBLIC_MUXR_MODE: 'muxr-canary-mode-9f3k',
    MUXR_MINT_SECRET: 'muxr-canary-mint-9f3k',
};
// NOTE: MUXR_PUBLIC_BASE_URL is intentionally absent: app.config bakes a set
// origin by design (store builds need it). The shipped web:export unsets it,
// and checkWebExport's dist scan asserts no marketing origin leaked.

const failures = [];
const fail = (message) => {
    process.stderr.write(`FAIL  ${message}\n`);
    failures.push(message);
};

const outDir = mkdtempSync(join(tmpdir(), 'muxr-export-canary-'));
try {
    const exported = spawnSync('sh', ['-c', 'npm run setup-canvaskit >/dev/null 2>&1 && npm run setup-pdfjs >/dev/null 2>&1 && npm run setup-mermaid >/dev/null 2>&1 && npx expo export --platform web --output-dir "$0" && node ../../scripts/release/application/finalizeWebExport.mjs "$0/index.html"', outDir], {
        cwd: mobile,
        env: { ...process.env, APP_ENV: 'production', ...CANARIES },
        encoding: 'utf8',
        timeout: 420_000,
    });
    if (exported.status !== 0) {
        fail(`canary export chain failed (exit ${exported.status}): ${(exported.stderr || exported.stdout || '').split('\n').slice(-5).join('\n')}`);
    } else {
        const needles = Object.values(CANARIES);
        const walk = (dir) => {
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
                const path = join(dir, entry.name);
                if (entry.isDirectory()) {
                    walk(path);
                    continue;
                }
                let bytes;
                try {
                    bytes = readFileSync(path);
                } catch {
                    continue;
                }
                if (bytes.length === 0 || bytes.length > 64 * 1024 * 1024) continue;
                const text = bytes.toString('utf8');
                for (const needle of needles) {
                    if (text.includes(needle)) {
                        fail(`canary ${JSON.stringify(needle)} baked into ${path.replace(`${outDir}/`, 'dist-canary/')}`);
                        break;
                    }
                }
            }
        };
        if (!existsSync(join(outDir, 'index.html'))) {
            fail('canary export produced no index.html');
        } else {
            walk(outDir);
        }
        if (failures.length === 0) process.stdout.write(`ok  export chain bakes no environment secrets (scanned complete canary dist)\n`);
    }
} finally {
    rmSync(outDir, { recursive: true, force: true });
}

if (failures.length > 0) {
    process.stderr.write(`checkExportIsolation: ${failures.length} failing check(s)\n`);
    process.exit(1);
}
process.stdout.write('checkExportIsolation: export chain is secret-clean\n');
