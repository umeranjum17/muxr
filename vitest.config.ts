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
        // Vitest 4 dropped `**/dist/**` from its own defaults, so after a
        // `tsc --build` the compiled copy of every suite gets collected too --
        // and the architecture tests, which resolve paths from their own
        // location, then look for `.ts` sources next to the emitted `.js`.
        exclude: [...configDefaults.exclude, '**/dist/**', 'dist-npm/**', 'perf/**'],
    },
    resolve: {
        alias: [{ find: /^@\//, replacement: path.resolve('apps/mobile/sources') + '/' }],
    },
});
