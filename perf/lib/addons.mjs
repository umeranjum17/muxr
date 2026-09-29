import { existsSync, mkdirSync, readdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Product-code driver for the Files tree/preview/history probes. */
export const filesProductDriver = () => fileURLToPath(new URL('./filesProduct.mjs', import.meta.url));

/** Extra node flags the driver needs: it imports host TypeScript directly. */
export const filesProductFlags = () => ['--experimental-strip-types'];

/**
 * A plugins root for the fake Herdr: every bundled plugin still in the
 * checkout. Files and prompt attachments are host product code now, so no
 * add-on checkout is linked anymore.
 */
export function bundledPlusAddons(sourceRoot) {
    return ({ root }) => {
        const dir = join(root, 'fixture-plugins');
        mkdirSync(dir, { recursive: true });
        const bundled = join(sourceRoot, 'plugins');
        if (existsSync(bundled)) for (const entry of readdirSync(bundled, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            try {
                symlinkSync(join(bundled, entry.name), join(dir, entry.name));
            } catch { /* already linked from a previous round */ }
        }
        return dir;
    };
}
