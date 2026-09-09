import type { RichPreviewKind } from './richAttachmentPreview';

/**
 * The preview page is app chrome, not the file's own styling, so it takes the
 * active theme's surfaces rather than painting a white sheet behind a dark app.
 * Plain colours, not the theme object: this module stays free of react-native.
 */
export function richPreviewHtml(runtime: string, payload: { kind: RichPreviewKind; base64: string }, c: {
    dark: boolean; surface: string; surfaceHigh: string; surfaceHighest: string; text: string; textSecondary: string; divider: string;
}): string {
    // File bytes are base64 data, never interpolated markup or executable code.
    const nonce = `muxr-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
    const script = `${runtime}\nvoid window.renderMuxrAttachment(${JSON.stringify({ ...payload, dark: c.dark })});`.replace(/<\/script/gi, '<\\/script');
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}' blob:; worker-src blob:; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"><style>
:root{color-scheme:${c.dark ? 'dark' : 'light'}}*{box-sizing:border-box}body{margin:0;background:${c.surface};color:${c.text};font:16px/1.65 system-ui,sans-serif}#tools{position:sticky;top:0;display:flex;gap:8px;flex-wrap:wrap;padding:8px;background:${c.surfaceHigh};border-bottom:1px solid ${c.divider};z-index:1}#tools:empty{display:none}button,select{min-height:44px;border:1px solid ${c.divider};border-radius:8px;background:${c.surfaceHigh};color:${c.text};padding:6px 12px;font:inherit}#content{padding:20px;overflow:auto}#status{font:12px/1.5 system-ui;color:${c.textSecondary};padding:12px 20px;border-top:1px solid ${c.divider}}pre,code{font-family:ui-monospace,monospace}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:${c.surfaceHighest};padding:12px;border-radius:8px}table{border-collapse:collapse;font-size:14px}td,th{border:1px solid ${c.divider};padding:8px 12px;max-width:360px;overflow-wrap:anywhere;text-align:left}th{background:${c.surfaceHighest}}img,svg{max-width:100%;height:auto}canvas{display:block;margin:auto}h1,h2,h3{line-height:1.25}blockquote{margin-left:0;padding-left:16px;border-left:3px solid ${c.divider}}</style></head><body><div id="tools"></div><main id="content"></main><div id="status" role="status">Opening preview…</div><script nonce="${nonce}">${script}</script></body></html>`;
}
