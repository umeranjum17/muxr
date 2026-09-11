import { configDefaults, defineConfig } from 'vitest/config';
import path from 'node:path';

// Keep `yarn vitest run apps/mobile/sources` deterministic from the repo root.
// Metro's @/ alias points at the mobile source tree; without this, the two
// suites that import toolDisplay/turnChanges fail before their tests load.
export default defineConfig({
    test: {
        // `perf/**` is driven by `node --test` through `yarn perf`, and its
        // *.test.mjs files carry no vitest suite: swept in from the root they
        // fail as "no test suite found" and take `yarn check` down with them.
        exclude: [...configDefaults.exclude, 'dist-npm/**', 'perf/**'],
    },
    resolve: {
        alias: [{ find: /^@\//, replacement: path.resolve('apps/mobile/sources') + '/' }],
    },
});
