import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.cwd();
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root }).toString().split('\0').filter(Boolean);
const generatedRoots = ['dist-npm', 'apps/mobile/dist'];
const generated = [];
for (const directory of generatedRoots) {
    const absolute = join(root, directory);
    if (!existsSync(absolute)) continue;
    const walk = (path) => {
        for (const name of readdirSync(path)) {
            const child = join(path, name);
            if (statSync(child).isDirectory()) walk(child);
            else generated.push(relative(root, child));
        }
    };
    walk(absolute);
}
const files = [...new Set([...tracked, ...generated])];
const patterns = [
    ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
    ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/g],
    ['OpenAI key', /\bsk-[A-Za-z0-9_-]{40,}\b/g],
    ['muxr bearer', /\b(?:p(?:ck|dc|wt)|muxr_(?:dc|tk))_[A-Za-z0-9_-]{24,}\b/g],
    ['credentialed Mongo URI', /mongodb(?:\+srv)?:\/\/[^\s:'"/]+:[^\s@'"/]+@/g],
    ['Stripe live key', /\b(?:sk|rk)_live_[A-Za-z0-9]{24,}\b/g],
];
const forbiddenWebLiterals = [process.env.EXPO_PUBLIC_MUXR_TOKEN]
    .filter((value) => typeof value === 'string' && value.length >= 12);
const findings = [];
for (const relativePath of files) {
    const path = join(root, relativePath);
    if (!existsSync(path) || statSync(path).size > 20 * 1024 * 1024) continue;
    if (/\.(?:png|jpe?g|gif|webp|wasm|lock|ico|ttf|woff2)$/.test(relativePath)) continue;
    const text = readFileSync(path, 'utf8');
    for (const [name, pattern] of patterns) {
        pattern.lastIndex = 0;
        if (pattern.test(text)) findings.push(`${relativePath}: ${name}`);
    }
    if (relativePath.startsWith('dist-npm/web/') || relativePath.startsWith('apps/mobile/dist/')) {
        for (const literal of forbiddenWebLiterals) if (text.includes(literal)) findings.push(`${relativePath}: configured web credential literal`);
    }
}
if (findings.length > 0) {
    process.stderr.write(`FAIL: secret scan found\n${findings.map((item) => `  ${item}`).join('\n')}\n`);
    process.exit(1);
}
process.stdout.write(`PASS: secret scan (${files.length} tracked/package files; no private keys or live credential shapes)\n`);
