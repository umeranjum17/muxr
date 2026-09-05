import MarkdownIt from 'markdown-it';
import DOMPurify from 'dompurify';
import mermaid from 'mermaid';
import Papa from 'papaparse';
import ExcelJS from 'exceljs/dist/exceljs.min.js';
import { Unzip, UnzipInflate } from 'fflate';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

const main = () => document.getElementById('content');
const status = (text) => { document.getElementById('status').textContent = text; };
const clean = (text, svg = false) => DOMPurify.sanitize(text, {
    USE_PROFILES: svg ? { svg: true, svgFilters: true } : { html: true, svg: true, svgFilters: true },
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'foreignObject'],
    FORBID_ATTR: ['href', 'xlink:href', 'srcset', 'action', 'formaction', 'nonce'],
    ALLOWED_URI_REGEXP: /^data:image\/(?:png|jpeg|webp|gif);base64,/i,
});
function appendText(text, tag = 'pre') { const node = document.createElement(tag); node.textContent = text; main().append(node); return node; }
function table(rows) {
    const node = document.createElement('table');
    for (const cells of rows.slice(0, 201)) {
        const tr = document.createElement('tr');
        for (const value of cells.slice(0, 50)) {
            const cell = document.createElement(node.rows.length === 0 ? 'th' : 'td');
            cell.textContent = String(value ?? '').slice(0, 2000); tr.append(cell);
        }
        node.append(tr);
    }
    main().replaceChildren(node);
    status('Preview: up to 200 data rows and 50 columns. Download the original for the complete workbook.');
}
function boundedZip(bytes) {
    let total = 0, entries = 0;
    const unzip = new Unzip((file) => {
        if (++entries > 1000) throw new Error('Workbook contains too many entries');
        file.ondata = (error, data) => {
            if (error) throw error;
            total += data.length;
            if (total > 16 * 1024 * 1024) { file.terminate(); throw new Error('Expanded workbook is too large'); }
        };
        file.start();
    });
    unzip.register(UnzipInflate); unzip.push(bytes, true);
}
async function workbook(bytes) {
    boundedZip(bytes);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(bytes);
    const sheets = book.worksheets.slice(0, 20);
    if (!sheets.length) throw new Error('No worksheets');
    const select = document.createElement('select'); select.setAttribute('aria-label', 'Worksheet');
    for (const [index, sheet] of sheets.entries()) { const option = document.createElement('option'); option.value = String(index); option.textContent = sheet.name; select.append(option); }
    const render = () => {
        const sheet = sheets[Number(select.value)], rows = [];
        for (let r = 1; r <= Math.min(sheet.rowCount, 201); r++) {
            const cells = []; for (let c = 1; c <= Math.min(sheet.columnCount, 50); c++) cells.push(sheet.getCell(r, c).text);
            rows.push(cells);
        }
        table(rows);
    };
    select.onchange = render; document.getElementById('tools').append(select); render();
}
async function pdf(bytes) {
    const workerUrl = URL.createObjectURL(new Blob([window.MUXR_PDF_WORKER], { type: 'text/javascript' }));
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
    const loading = pdfjs.getDocument({ data: bytes, isEvalSupported: false, enableXfa: false, disableFontFace: true, useSystemFonts: true, disableAutoFetch: true });
    let doc, renderTask, generation = 0, pageNumber = 1, scale = 1;
    const deadline = setTimeout(() => { void loading.destroy(); status('PDF took too long to open. Download the original to view it externally.'); }, 20000);
    try { doc = await loading.promise; } finally { clearTimeout(deadline); URL.revokeObjectURL(workerUrl); }
    const canvas = document.createElement('canvas'); main().append(canvas);
    const render = async () => {
        const mine = ++generation;
        const previous = renderTask;
        previous?.cancel();
        await previous?.promise.catch(() => undefined);
        const page = await doc.getPage(pageNumber);
        if (mine !== generation) return;
        const natural = page.getViewport({ scale: 1 });
        const fit = Math.min((innerWidth - 40) / natural.width, 2) * scale;
        const capped = Math.min(fit, Math.sqrt(4_000_000 / (natural.width * natural.height)));
        const viewport = page.getViewport({ scale: capped });
        canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
        renderTask = page.render({ canvasContext: canvas.getContext('2d'), viewport });
        status(`Page ${pageNumber} of ${doc.numPages}`);
        const current = renderTask;
        const renderDeadline = setTimeout(() => { current.cancel(); if (mine === generation) status('This PDF page took too long to render.'); }, 15000);
        try { await current.promise; } catch (error) { if (error.name !== 'RenderingCancelledException') throw error; }
        finally { clearTimeout(renderDeadline); }
    };
    for (const [label, act] of [['Previous page', () => { pageNumber = Math.max(1, pageNumber - 1); }], ['Next page', () => { pageNumber = Math.min(doc.numPages, pageNumber + 1); }], ['Zoom out', () => { scale = Math.max(.5, scale / 1.25); }], ['Zoom in', () => { scale = Math.min(3, scale * 1.25); }]]) {
        const button = document.createElement('button'); button.textContent = label;
        button.onclick = () => { act(); void render().catch(() => status('This PDF page cannot be rendered.')); }; document.getElementById('tools').append(button);
    }
    await render(); window.addEventListener('pagehide', () => { void doc.destroy(); }, { once: true });
}
window.renderMuxrAttachment = async ({ kind, base64 }) => {
    try {
        const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
        if (kind === 'pdf') return await pdf(bytes);
        if (kind === 'xlsx') return await workbook(bytes);
        const text = new TextDecoder().decode(bytes);
        if (kind === 'csv') return table(Papa.parse(text, { preview: 201, skipEmptyLines: true }).data);
        if (kind === 'html' || kind === 'svg') {
            main().innerHTML = clean(text, kind === 'svg');
            if (main().querySelectorAll('*').length > 20000) throw new Error('Document is too complex');
            status('Read-only preview. Scripts, remote content and links are disabled.'); return;
        }
        if (kind !== 'markdown') { appendText(text); status('Text preview'); return; }
        const diagrams = [];
        const md = new MarkdownIt({ html: false, linkify: false, typographer: false });
        const fence = md.renderer.rules.fence;
        md.renderer.rules.fence = (tokens, index, ...rest) => {
            if (tokens[index].info.trim() !== 'mermaid') return fence(tokens, index, ...rest);
            if (diagrams.length >= 10 || tokens[index].content.length > 50000) return '<p>Diagram exceeds preview limit.</p>';
            const id = `diagram-${diagrams.length}`; diagrams.push({ id, code: tokens[index].content }); return `<div id="${id}"></div>`;
        };
        main().innerHTML = clean(md.render(text));
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', maxTextSize: 50000, flowchart: { htmlLabels: false } });
        for (const { id, code } of diagrams) {
            const element = document.getElementById(id); if (!element) continue;
            try { const { svg } = await mermaid.render(`svg-${id}`, code); element.innerHTML = clean(svg, true); }
            catch { element.textContent = 'This Mermaid diagram cannot be rendered.'; }
        }
        status('Markdown preview · tables, code and Mermaid diagrams');
    } catch { main().replaceChildren(); appendText('This file cannot be previewed within the supported limits.', 'p'); status('Download the original to open it in another app.'); }
};
