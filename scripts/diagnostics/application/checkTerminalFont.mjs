/**
 * The Android terminal draws every glyph at col * cellWidth, with cellWidth
 * the advance of "M" in the face it draws with. That only holds if the face
 * is genuinely monospaced, which the system's Typeface.MONOSPACE is not
 * guaranteed to be (a ROM font customization resolved it to a proportional
 * sans on a OnePlus and letter-spaced the whole terminal). So the renderer
 * sets text in a face the app bundles. This check fails when that contract
 * breaks: the asset names the renderer loads must exist in the app's Android
 * assets, and every printable ASCII glyph in each must share one advance.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const renderer = join(root, 'node_modules/expo-libghostty/android/src/main/java/expo/modules/libghostty/GhosttyTerminalView.kt');
const assetsDir = join(root, 'apps/mobile/android/app/src/main/assets');

function fail(message) {
    process.stderr.write(`terminal font: ${message}\n`);
    process.exit(1);
}

/** Advance width per printable ASCII code point, read from cmap (format 4) + hmtx. */
function asciiAdvances(buffer) {
    const u16 = (at) => buffer.readUInt16BE(at);
    const u32 = (at) => buffer.readUInt32BE(at);
    const tableCount = u16(4);
    const tables = new Map();
    for (let index = 0; index < tableCount; index++) {
        const at = 12 + index * 16;
        tables.set(buffer.toString('latin1', at, at + 4), { offset: u32(at + 8), length: u32(at + 12) });
    }
    const hhea = tables.get('hhea'); const hmtx = tables.get('hmtx'); const cmap = tables.get('cmap');
    if (!hhea || !hmtx || !cmap) throw new Error('not a TrueType font (missing hhea/hmtx/cmap)');
    const metricCount = u16(hhea.offset + 34);
    const advance = (glyph) => u16(hmtx.offset + Math.min(glyph, metricCount - 1) * 4);
    // A format-4 Unicode subtable maps BMP code points.
    const subtables = u16(cmap.offset + 2);
    let format4;
    for (let index = 0; index < subtables; index++) {
        const record = cmap.offset + 4 + index * 8;
        const platform = u16(record); const encoding = u16(record + 2); const offset = u32(record + 4);
        const at = cmap.offset + offset;
        if (u16(at) === 4 && (platform === 3 && (encoding === 1 || encoding === 10) || platform === 0)) { format4 = at; break; }
    }
    if (format4 === undefined) throw new Error('no format-4 cmap subtable');
    const segCount = u16(format4 + 6) / 2;
    const ends = format4 + 14, starts = ends + segCount * 2 + 2, deltas = starts + segCount * 2, rangeOffsets = deltas + segCount * 2;
    const glyphFor = (code) => {
        for (let seg = 0; seg < segCount; seg++) {
            const end = u16(ends + seg * 2);
            if (code > end) continue;
            const start = u16(starts + seg * 2);
            if (code < start) return 0;
            const delta = u16(deltas + seg * 2);
            const rangeOffset = u16(rangeOffsets + seg * 2);
            if (rangeOffset === 0) return (code + delta) & 0xffff;
            const glyphAt = rangeOffsets + seg * 2 + rangeOffset + (code - start) * 2;
            const glyph = u16(glyphAt);
            return glyph === 0 ? 0 : (glyph + delta) & 0xffff;
        }
        return 0;
    };
    const advances = new Map();
    for (let code = 0x20; code <= 0x7e; code++) {
        const glyph = glyphFor(code);
        if (glyph === 0) throw new Error(`no glyph for U+${code.toString(16).padStart(4, '0')}`);
        advances.set(String.fromCharCode(code), advance(glyph));
    }
    return advances;
}

const source = readFileSync(renderer, 'utf8');
const assets = [...source.matchAll(/const val TEXT_FONT(?:_[A-Z]+)?_ASSET = "([^"]+)"/g)].map((match) => match[1]);
if (assets.length === 0) fail(`renderer names no bundled text face (${renderer})`);
for (const name of assets) {
    const path = join(assetsDir, name);
    if (!existsSync(path)) fail(`renderer loads ${name} but apps/mobile/android/app/src/main/assets has no such file`);
    let advances;
    try { advances = asciiAdvances(readFileSync(path)); } catch (error) { fail(`${name}: ${error instanceof Error ? error.message : String(error)}`); }
    const widths = new Set(advances.values());
    if (widths.size !== 1) {
        const byWidth = [...advances].sort((left, right) => left[1] - right[1]);
        fail(`${name} is not monospaced: '${byWidth[0][0]}' advances ${byWidth[0][1]} but 'M' advances ${advances.get('M')} (${widths.size} distinct widths)`);
    }
    process.stdout.write(`terminal font: ${name} bundled, ${advances.size} printable ASCII glyphs at one advance (${advances.get('M')})\n`);
}
