/**
 * Mermaid draws a node label either as SVG `<text>` or as HTML inside a
 * `<foreignObject>`, and which of the two it picks turns on a config key that has
 * moved between versions. The diagram sanitizer forbids `<foreignObject>`, so the
 * HTML form is dropped and the node paints as an empty box -- which is what a
 * packaged Android build shipped, whatever the committed config asked for.
 *
 * Rewriting those labels to `<text>` before sanitizing makes the label survive
 * whichever form Mermaid chose. `<foreignObject>` remains forbidden and the
 * sanitizer runs over the result unchanged.
 */
const labels = /<foreignObject\b([^>]*)>([\s\S]*?)<\/foreignObject>/gi;
const number = (attributes: string, name: string) => Number(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(attributes)?.[1]) || 0;

const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
const decode = (text: string) => text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/gi, (reference: string, body: string) => {
    if (body[0] !== '#') return named[body.toLowerCase()] ?? reference;
    const code = Number(body[1] === 'x' || body[1] === 'X' ? `0${body.slice(1)}` : body.slice(1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : reference;
});
const escapes: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
const escape = (text: string) => text.replace(/[&<>]/g, (character) => escapes[character]);

/**
 * Keeps only the characters that sit outside a tag. Stripping tags with a regex
 * is unsound -- removing `<b>` from `<scr<b>ipt>` hands back a live `<script>` --
 * so the walk reads the markup once, never re-scans what it has collected, and
 * every character it keeps is escaped on the way into the `<tspan>`. Text is all
 * that survives; `<br>` and the end of a `<p>`/`<div>` become line breaks.
 */
function labelLines(html: string): string[] {
    let text = '';
    for (let cursor = 0; cursor < html.length;) {
        const open = html.indexOf('<', cursor);
        if (open < 0) { text += html.slice(cursor); break; }
        text += html.slice(cursor, open);
        const close = html.indexOf('>', open);
        if (close < 0) break; // An unterminated tag runs to the end of the markup.
        if (/^(br\b|\/p\b|\/div\b)/.test(html.slice(open + 1, close).trim().toLowerCase())) text += '\n';
        cursor = close + 1;
    }
    return decode(text).split('\n').map((line) => line.trim()).filter(Boolean);
}

export function svgTextLabels(svg: string): string {
    return svg.replace(labels, (_label, attributes: string, html: string) => {
        const lines = labelLines(html);
        if (!lines.length) return '';
        const x = number(attributes, 'x') + number(attributes, 'width') / 2;
        const y = number(attributes, 'y') + number(attributes, 'height') / 2;
        const rows = lines.map((line, index) => `<tspan x="${x}" dy="${index ? 1.1 : -0.55 * (lines.length - 1)}em">${escape(line)}</tspan>`).join('');
        return `<text x="${x}" y="${y}" text-anchor="middle" dominant-baseline="central">${rows}</text>`;
    });
}
