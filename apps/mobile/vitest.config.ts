import { defineConfig } from 'vitest/config';
import path from 'node:path';

/*
 * Node-side unit tests for the pure helpers. `@/` must resolve the same way
 * Metro resolves it, so a test exercises the
 * inherited module the app never loads.
 */
export default defineConfig({
    resolve: {
        alias: [{ find: /^@\//, replacement: path.join(__dirname, 'sources/') }],
    },
});
