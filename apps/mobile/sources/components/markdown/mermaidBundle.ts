/**
 * Mermaid, loaded on first use from public/mermaid.min.js (copied there by
 * `setup-mermaid`, like the pdf worker and CanvasKit). The default entry
 * splits every diagram into dynamic imports whose shared core lands in
 * Metro's eager __common chunk; the self-contained IIFE cannot be bundled
 * either, because under Metro's module wrapper its `var` is not global.
 * A script tag keeps it off the startup path and off the bundle entirely.
 */
type Mermaid = { initialize: (config: Record<string, unknown>) => void; render: (id: string, text: string) => Promise<{ svg: string }> };

let loading: Promise<Mermaid> | undefined;

export function loadMermaid(): Promise<Mermaid> {
    if (loading !== undefined) return loading;
    loading = new Promise<Mermaid>((resolve, reject) => {
        const existing = (globalThis as { mermaid?: Mermaid }).mermaid;
        if (existing !== undefined) { resolve(existing); return; }
        if (typeof document === 'undefined') { reject(new Error('Mermaid diagrams need a browser.')); return; }
        const tag = document.createElement('script');
        tag.src = '/mermaid.min.js';
        tag.async = true;
        tag.onload = () => {
            const loaded = (globalThis as { mermaid?: Mermaid }).mermaid;
            if (loaded === undefined) reject(new Error('Mermaid did not register.'));
            else resolve(loaded);
        };
        tag.onerror = () => reject(new Error('Mermaid could not be loaded.'));
        document.head.appendChild(tag);
    });
    loading.catch(() => { loading = undefined; });
    return loading;
}
