/**
 * Loads the mermaid engine in the browser from the export's own
 * `/mermaid.min.js` (copied into `public/` by `setup-mermaid`).
 *
 * Mermaid must never enter the JS bundle: its diagram modules load each other
 * dynamically, so Metro hoists their shared core, cytoscape and the rest of the
 * dependency tree into the eager `__common` chunk, which `index.html` loads
 * before the first paint. Fetching the standalone build as a script keeps every
 * byte of it out of the initial transfer, and it is only requested when a
 * mermaid block actually renders.
 *
 * The script is same-origin, so the export's `script-src 'self'` CSP allows it.
 */
type MermaidGlobal = {
    initialize: (config: { startOnLoad: boolean; theme: string }) => void;
    render: (id: string, text: string) => Promise<{ svg: string }>;
};

let pending: Promise<MermaidGlobal> | undefined;

export function loadMermaidWeb(): Promise<MermaidGlobal> {
    pending ??= new Promise<MermaidGlobal>((resolve, reject) => {
        const global = window as unknown as { mermaid?: MermaidGlobal };
        if (global.mermaid !== undefined) {
            resolve(global.mermaid);
            return;
        }
        const script = document.createElement('script');
        script.src = '/mermaid.min.js';
        script.onload = () => {
            if (global.mermaid !== undefined) resolve(global.mermaid);
            else reject(new Error('mermaid did not expose its engine'));
        };
        script.onerror = () => reject(new Error('mermaid could not be loaded'));
        document.head.appendChild(script);
    }).catch((error: unknown) => {
        pending = undefined;
        throw error;
    });
    return pending;
}
