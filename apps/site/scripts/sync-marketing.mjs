#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { generateSiteIcons, SITE_ICON_OUTPUTS } from './generate-site-icons.mjs';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const LOCK = join(ROOT, 'marketing.lock.json');
const args = process.argv.slice(2);
const value = (flag, fallback) => {
    const at = args.indexOf(flag);
    return at === -1 ? fallback : args[at + 1];
};
const sourceRepo = resolve(value('--source', join(ROOT, '..', '..')));
const sourceRef = value('--ref', 'HEAD');
const check = args.includes('--check');

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const read = (file) => readFileSync(join(ROOT, file));
const write = (file, data) => {
    const target = join(ROOT, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
};
const run = (cmd, commandArgs, options = {}) => execFileSync(cmd, commandArgs, {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'inherit'],
    maxBuffer: 64 * 1024 * 1024,
    ...options,
});

if (check) {
    const lock = JSON.parse(readFileSync(LOCK, 'utf8'));
    const derived = [...(lock.film?.outputs ?? []), ...(lock.herd?.outputs ?? []), ...(lock.screens?.outputs ?? [])];
    for (const output of [...lock.outputs, ...derived]) {
        const target = join(ROOT, output.file);
        if (!existsSync(target)) throw new Error(`missing synced marketing file: ${output.file}`);
        const actual = sha256(readFileSync(target));
        if (actual !== output.sha256) throw new Error(`marketing drift: ${output.file}`);
    }
    process.stdout.write(`marketing locked to ${lock.source.commit.slice(0, 12)}; ${lock.outputs.length + derived.length} files verified\n`);
    process.exit(0);
}

const commit = run('git', ['-C', sourceRepo, 'rev-parse', `${sourceRef}^{commit}`], { encoding: 'utf8' }).trim();
const canonical = [
    ['apps/mobile/sources/assets/images/icon.png', 'docs/icons/muxr-app-icon.png'],
    ['apps/mobile/sources/assets/images/wordmark@3x.png', 'docs/marketing/wordmark.png'],
    ['apps/mobile/sources/assets/images/favicon.png', 'docs/marketing/favicon.png'],
    ['docs/demo/muxr-demo.mp4', 'docs/media/demo.mp4'],
    ['docs/art/rpg-cover.png', 'docs/marketing/rpg-cover.png'],
    ['docs/play/store-assets/02-terminal.png', 'docs/marketing/product-terminal.png'],
    ['docs/play/store-assets/04-files.png', 'docs/marketing/product-files.png'],
    ...['herd', 'inbox', 'terminal', 'changes', 'voice', 'connection']
        .map((name) => [`docs/store-preview/class/${name}.png`, `docs/marketing/campaign-${name}.png`]),
    ...['herd', 'inbox', 'terminal', 'changes', 'voice', 'gestures', 'computer']
        .flatMap((name) => ['webp', 'jpg'].map((ext) => [`docs/assets/readme/${name}.${ext}`, `docs/marketing/readme-${name}.${ext}`])),
];

/** The app's own agent marks: monochrome masks the site tints with its ink, as the app does. */
const AGENT_MARKS = ['amp', 'antigravity', 'claude', 'cline', 'codex', 'copilot', 'cursor', 'devin', 'droid', 'gemini', 'grok',
    'hermes', 'kilocode', 'kimi', 'kiro', 'maki', 'mastracode', 'omp', 'opencode', 'pi', 'qoder'];

rmSync(join(ROOT, 'docs/marketing'), { recursive: true, force: true });
for (const [from, to] of canonical) {
    write(to, run('git', ['-C', sourceRepo, 'show', `${commit}:${from}`]));
}
for (const name of AGENT_MARKS) {
    const file = `docs/marketing/agent-${name}.png`;
    write(file, run('git', ['-C', sourceRepo, 'show', `${commit}:apps/mobile/sources/assets/agents/${name}.png`]));
    // Shown at 20 px; 64 px keeps them sharp at 3x and small on the wire.
    run('magick', [join(ROOT, file), '-resize', '64x64', '-strip', join(ROOT, file)]);
}

generateSiteIcons();

const webpSources = canonical.filter(([, file]) => file.startsWith('docs/marketing/') && file.endsWith('.png') && !file.endsWith('wordmark.png') && !file.endsWith('favicon.png'));
for (const [, file] of webpSources) {
    run('magick', [join(ROOT, file), '-strip', '-quality', '88', '-define', 'webp:method=6', join(ROOT, file.replace(/\.png$/, '.webp'))]);
}

// The app's own faces as woff2, so the site never reaches a third-party font host.
const FONTS = [
    ['BricolageGrotesque-Bold', 'bricolage-grotesque-bold'],
    ['IBMPlexSans-Regular', 'ibm-plex-sans-regular'],
    ['IBMPlexSans-SemiBold', 'ibm-plex-sans-semibold'],
    ['IBMPlexMono-Regular', 'ibm-plex-mono-regular'],
];
for (const [font, name] of FONTS) {
    const ttf = `docs/marketing/${name}.ttf`;
    write(ttf, run('git', ['-C', sourceRepo, 'show', `${commit}:apps/mobile/sources/assets/fonts/${font}.ttf`]));
    run('woff2_compress', [join(ROOT, ttf)]);
    rmSync(join(ROOT, ttf));
}

const film = join(ROOT, 'docs/media/demo.mp4');
const probe = (entries) => run('ffprobe', ['-v', 'error', ...entries, '-of', 'json', film], { encoding: 'utf8' });
const metadata = JSON.parse(probe(['-show_entries', 'format=duration', '-show_entries', 'stream=width,height']));
const duration = Number(metadata.format.duration);
const width = metadata.streams[0].width;
const height = metadata.streams[0].height;
const posterAt = Number(Math.min(duration - 1, duration * 0.7).toFixed(2));
run('ffmpeg', ['-y', '-v', 'error', '-ss', String(posterAt), '-i', film, '-frames:v', '1', join(ROOT, 'docs/marketing/demo-poster.png')]);
run('magick', [join(ROOT, 'docs/marketing/demo-poster.png'), '-strip', '-quality', '88', '-define', 'webp:method=6', join(ROOT, 'docs/marketing/demo-poster.webp')]);
write('docs/media/demo.json', `${JSON.stringify({ duration, width, height, poster: { at: posterAt, width, height }, sourceCommit: commit }, null, 4)}\n`);

const outputs = [
    ...canonical.map(([, file]) => file),
    ...webpSources.map(([, file]) => file.replace(/\.png$/, '.webp')),
    ...SITE_ICON_OUTPUTS,
    'docs/marketing/demo-poster.png',
    'docs/marketing/demo-poster.webp',
    'docs/media/demo.json',
    ...FONTS.map(([, name]) => `docs/marketing/${name}.woff2`),
    ...AGENT_MARKS.map((name) => `docs/marketing/agent-${name}.png`),
].sort().map((file) => ({ file, sha256: sha256(read(file)) }));

// The film cuts, herd drawings and feature screens come from scripts/encode-film.mjs,
// scripts/draw-herd.mjs and scripts/crop-screens.mjs, not this commit; keep their records.
const { film: filmLock, herd: herdLock, screens: screensLock } = JSON.parse(readFileSync(LOCK, 'utf8'));
writeFileSync(LOCK, `${JSON.stringify({
    version: 1,
    source: { repository: 'https://github.com/umeranjum17/muxr', commit },
    outputs,
    ...(filmLock ? { film: filmLock } : {}),
    ...(herdLock ? { herd: herdLock } : {}),
    ...(screensLock ? { screens: screensLock } : {}),
}, null, 4)}\n`);
process.stdout.write(`synced ${outputs.length} files from muxr ${commit.slice(0, 12)}\n`);
