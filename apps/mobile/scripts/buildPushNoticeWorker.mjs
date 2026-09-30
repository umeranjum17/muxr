import { build } from 'esbuild';
await build({
    entryPoints: [new URL('../sources/utils/pushNoticeWorker.ts', import.meta.url).pathname],
    outfile: new URL('../public/pushNotice.bundle.js', import.meta.url).pathname,
    bundle: true,
    minify: true,
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    external: ['@/*'],
});
