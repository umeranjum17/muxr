import { defineConfig } from 'vitest/config';
import path from 'node:path';

// Keep `yarn vitest run apps/mobile/sources` deterministic from the repo root.
// Metro's @/ alias points at the mobile source tree; without this, the two
// suites that import toolDisplay/turnChanges fail before their tests load.
export default defineConfig({
    resolve: {
        alias: [{ find: /^@\//, replacement: path.resolve('apps/mobile/sources') + '/' }],
    },
});
