/**
 * Bounds for a plugin-rendered code surface. Kept in this light module so the
 * session file/diff routes can read them at module load without importing the
 * heavy surfaces (which live behind `codeSurfaces.tsx`).
 */
export const PLUGIN_CODE_MAX_LINES = 600;
export const PLUGIN_CODE_MAX_CHARS = 64 * 1024;
export const HOST_CODE_MAX_LINES = 2000;
export const HOST_CODE_MAX_CHARS = 256 * 1024;
