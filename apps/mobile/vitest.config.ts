import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * Node-side unit tests for the pure helpers. `@/` must resolve the same way
 * Metro resolves it, so a test exercises the
 * inherited module the app never loads.
 */
export default defineConfig({
    test: { globalSetup: [fileURLToPath(new URL('../host/src/testScratchCleanup.ts', import.meta.url))] },
    // Metro defines this global; a spec that reaches an Expo module would
    // otherwise fail at import time on an environment detail, not on behaviour.
    define: { __DEV__: 'false' },
    resolve: {
        alias: [
            { find: /^@\//, replacement: path.join(__dirname, 'sources/') },
            // whisper.rn exports only subpaths; Metro falls back to its main field.
            { find: /^whisper\.rn$/, replacement: 'whisper.rn/index' },
        ],
    },
});
