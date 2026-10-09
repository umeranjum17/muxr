import { fileURLToPath } from 'node:url';

/** Product-code driver for the Files tree/preview/history probes. */
export const filesProductDriver = () => fileURLToPath(new URL('./filesProduct.mjs', import.meta.url));

/** Extra node flags the driver needs: it imports host TypeScript directly. */
export const filesProductFlags = () => ['--experimental-strip-types'];
