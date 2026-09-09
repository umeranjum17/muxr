/**
 * Mermaid draws a node label either as SVG `<text>` or as HTML inside a
 * `<foreignObject>`, and which of the two it picks turns on a config key that has
 * moved between versions. The diagram sanitizer forbids `<foreignObject>`, so the
 * HTML form is dropped and the node paints as an empty box -- which is what a
 * packaged Android build shipped, whatever the committed config asked for.
 *
 * Rewriting those labels to `<text>` before sanitizing makes the label survive
 * whichever form Mermaid chose. The characters are carried across still escaped,
 * so markup inside a label stays inert text; `<foreignObject>` remains forbidden
 * and the sanitizer runs over the result unchanged.
 */
const labels = /<foreignObject\b([^>]*)>([\s\S]*?)<\/foreignObject>/gi;
const number = (attributes: string, name: string) => Number(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(attributes)?.[1]) || 0;

export function svgTextLabels(svg: string): string {
    return svg.replace(labels, (_label, attributes: string, html: string) => {
        const lines = html.replace(/<br\s*\/?>|<\/p>|<\/div>/gi, '\n').replace(/<[^>]*>/g, '')
            .split('\n').map((line) => line.trim()).filter(Boolean);
        if (!lines.length) return '';
        const x = number(attributes, 'x') + number(attributes, 'width') / 2;
        const y = number(attributes, 'y') + number(attributes, 'height') / 2;
        const rows = lines.map((line, index) => `<tspan x="${x}" dy="${index ? 1.1 : -0.55 * (lines.length - 1)}em">${line}</tspan>`).join('');
        return `<text x="${x}" y="${y}" text-anchor="middle" dominant-baseline="central">${rows}</text>`;
    });
}
