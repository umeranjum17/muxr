import { build } from 'esbuild';
import { cpSync } from 'node:fs';
import { join } from 'node:path';

/** Keep public voice entries beside the host and resolve the spawned stream's workspace imports. */
export async function bundleVoiceRuntime({ root, out, external }) {
    cpSync(join(root, 'apps', 'host', 'dist', 'voice'), join(out, 'voice'), {
        recursive: true,
        filter: (path) => !path.endsWith('.spec.mjs'),
    });
    return build({
        absWorkingDir: root,
        entryPoints: ['apps/host/dist/voice/stream.mjs'],
        outfile: join(out, 'voice', 'stream.mjs'),
        preserveSymlinks: true,
        bundle: true,
        platform: 'node',
        format: 'esm',
        target: 'node22',
        external,
        metafile: true,
        minifyWhitespace: true,
        legalComments: 'none',
        logLevel: 'warning',
    });
}
