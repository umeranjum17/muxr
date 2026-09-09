import { build, context } from 'esbuild';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const options = { bundle: true, minify: true, platform: 'browser', target: 'chrome120', format: 'iife', write: false, logLevel: 'warning' };
const worker = await build({ ...options, format: 'esm', entryPoints: [new URL('../../../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs', import.meta.url).pathname] });
const rendererOptions = {
    ...options,
    entryPoints: [`${root}sources/components/attachment/previewRuntime.mjs`],
    write: true,
    outfile: `${root}sources/components/attachment/preview.bundle.bin`,
    banner: { js: `window.MUXR_PDF_WORKER=${JSON.stringify(worker.outputFiles[0].text)};` },
};
if (process.argv.includes('--watch')) {
    const renderer = await context(rendererOptions);
    await renderer.watch();
    for (const signal of ['SIGINT', 'SIGTERM']) {
        process.once(signal, async () => {
            await renderer.dispose();
            process.exit(0);
        });
    }
    console.log('Watching offline attachment renderer');
} else {
    await build(rendererOptions);
    console.log('Offline attachment renderer and PDF worker bundled');
}
