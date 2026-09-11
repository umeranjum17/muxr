/**
 * The self-contained mermaid build. The default entry splits every diagram
 * into its own dynamic import; the shared core then lands in Metro's
 * eager `__common` chunk (~2 MB raw) and loads before the first paint. The
 * IIFE build has no inner splits, so it stays in this lazy chunk.
 */
import 'mermaid/dist/mermaid.min.js';

const mermaid = (globalThis as { mermaid?: unknown }).mermaid;
export default mermaid;
