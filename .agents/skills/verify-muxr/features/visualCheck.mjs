#!/usr/bin/env node
// One cell of the Visual check matrix (../SKILL.md "Visual check"). Prints the
// defects a machine can see; every DEFECT line fails the cell (exit 1).
//   node visualCheck.mjs <serial> <dir> <name> [--end] [--ref <main>.xml]
//     native: saves <dir>/<name>.png and .xml from a task-owned emulator. --end:
//     the screen is scrolled as far as it goes (or cannot scroll), so anything
//     still under the navigation bar is stuck there. --ref: the dump of the same
//     cell from main (or the mock run); image nodes are compared against it.
//   node visualCheck.mjs pwa-check <shot>.png <name>
//     the PWA driver: runs the DOM leads on the open page through
//     `chrome-devtools-axi eval` ("blank page" means the shot was taken before the
//     app drew) and fails <name> (exit 1) on any DEFECT: any lead other than
//     `clean`, no eval result at all, or a blank strip in the screenshot.
//   node visualCheck.mjs selftest | pwa-selftest
//     proves the checks fire on their defects and stay quiet on the clean case,
//     one flow per page: native (the pair-screen defect, a clean pair entry, a
//     split title word, a blank strip) and PWA (a fixture page, and the driver's exit codes).
//     pwa-selftest needs `chromium`. Each prints PASS/FAIL per case and exits
//     non-zero on any FAIL.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pwaLeads = () => {
    const out = [];
    const painted = (e) => e.checkVisibility({ opacityProperty: true, visibilityProperty: true }) && !e.closest('[aria-hidden="true"]');
    const shown = (e) => painted(e) && getComputedStyle(e).pointerEvents !== 'none';
    const paints = (c) => /^(IMG|SVG|CANVAS|VIDEO)$/.test(c.tagName.toUpperCase()) || getComputedStyle(c).backgroundImage !== 'none';
    const inHorizontalScroller = (e) => {
        for (let a = e.parentElement; a && a !== document.documentElement; a = a.parentElement) {
            const ps = getComputedStyle(a);
            if ((ps.overflowX === 'auto' || ps.overflowX === 'scroll') && a.scrollWidth > a.clientWidth + 1) return true;
        }
        return false;
    };
    if (!document.body.innerText.trim()) return 'blank page: nothing rendered (retake the shot)';
    const de = document.documentElement;
    if (de.scrollWidth > innerWidth) out.push(`off-screen: page ${de.scrollWidth}px wide in a ${innerWidth}px viewport`);
    for (const el of document.querySelectorAll('div[dir="auto"], span')) {
        const cs = getComputedStyle(el), r = el.getBoundingClientRect();
        if (!el.innerText?.trim() || r.width === 0 || !shown(el)) continue;
        if (cs.overflow !== 'visible' && (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1)) out.push(`clipped text: "${el.innerText.slice(0, 40)}"`);
        if ((r.right > innerWidth + 1 || r.left < -1) && !inHorizontalScroller(el)) out.push(`text off-screen: "${el.innerText.slice(0, 40)}"`);
        const box = el.closest('[role="button"], button')?.getBoundingClientRect();
        if (box && (r.left < box.left - 1 || r.right > box.right + 1)) out.push(`text spills out of its button: "${el.innerText.slice(0, 40)}"`);
        // An ancestor that clips (overflow hidden, not a scroller) cuts any text
        // sticking out of its box, even when the text element itself may overflow.
        // A scroller between the text and the clipper invalidates that axis:
        // scrolled content below the fold is reachable, not cut.
        let ancestor = el.parentElement, clipX = false, clipY = false, scrollX = false, scrollY = false;
        while (ancestor && ancestor !== document.documentElement && !(clipX && clipY)) {
            const ps = getComputedStyle(ancestor);
            if (!scrollX && (ps.overflowX === 'auto' || ps.overflowX === 'scroll') && ancestor.scrollWidth > ancestor.clientWidth + 1) scrollX = true;
            if (!scrollY && (ps.overflowY === 'auto' || ps.overflowY === 'scroll') && ancestor.scrollHeight > ancestor.clientHeight + 1) scrollY = true;
            const pr = ancestor.getBoundingClientRect();
            if (!scrollX && (ps.overflowX === 'hidden' || ps.overflowX === 'clip') && (r.left < pr.left - 1 || r.right > pr.right + 1)) clipX = true;
            if (!scrollY && (ps.overflowY === 'hidden' || ps.overflowY === 'clip') && (r.top < pr.top - 1 || r.bottom > pr.bottom + 1)) clipY = true;
            ancestor = ancestor.parentElement;
        }
        if (clipX || clipY) out.push(`text clipped by overflow-hidden ancestor: "${el.innerText.slice(0, 40)}"`);
        // Text with another text or an image painted over it: sample the box and
        // ask what is actually on top. Ancestors and descendants are the text's
        // own containers, never a cover.
        const spots = [[0.5, 0.2], [0.5, 0.5], [0.5, 0.8], [0.1, 0.5], [0.9, 0.5]];
        for (const [fx, fy] of spots) {
            const x = r.left + r.width * fx, y = r.top + r.height * fy;
            if (x < 0 || x >= innerWidth || y < 0 || y >= innerHeight) continue;
            const hit = document.elementFromPoint(x, y);
            if (!hit || hit === el || el.contains(hit) || hit.contains(el)) continue;
            if (hit.closest('[aria-hidden="true"]')) continue;
            const hitText = (hit.innerText || '').trim();
            const hitName = `${hit.tagName}${hitText ? ` "${hitText.slice(0, 30)}"` : ''}`;
            if (hitText && hit.tagName !== 'BODY' && hit.tagName !== 'HTML') { out.push(`text over text: "${el.innerText.slice(0, 40)}" under ${hitName}`); break; }
            if (paints(hit)) { out.push(`text over image: "${el.innerText.slice(0, 40)}" under ${hitName}`); break; }
        }
    }
    // Accessibility text has no line geometry. DOM ranges do: a word's painted
    // fragments on different lines expose break-word/break-all. A nested text
    // node is reached from each ancestor, so the set prints one split once.
    const splits = new Set();
    for (const el of document.querySelectorAll('div[dir="auto"], span')) {
        if (!el.innerText?.trim() || !painted(el)) continue;
        const textNodes = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        for (let node; (node = textNodes.nextNode());) {
            for (const { segment, index, isWordLike } of new Intl.Segmenter(undefined, { granularity: 'word' }).segment(node.textContent)) {
                if (!isWordLike) continue;
                const range = document.createRange();
                range.setStart(node, index);
                range.setEnd(node, index + segment.length);
                const rects = [...range.getClientRects()].filter((b) => b.width > 0 && b.height > 0);
                if (rects.some((b) => Math.abs(b.top - rects[0].top) > 1)) splits.add(`word split across lines: "${segment}" in "${node.textContent.trim().slice(0, 40)}"`);
            }
        }
    }
    out.push(...splits);
    for (const b of document.querySelectorAll('[role="button"], button, input, textarea')) {
        const r = b.getBoundingClientRect();
        if (!r.width || r.bottom < 0 || r.top > innerHeight || !shown(b)) continue;
        const y = Math.min(Math.max(r.top + r.height / 2, 0), innerHeight - 1);
        const hit = document.elementFromPoint(r.left + r.width / 2, y);
        if (hit && !b.contains(hit) && !hit.contains(b)) out.push(`covered control: "${(b.innerText || b.getAttribute('aria-label') || '').slice(0, 40)}" under ${hit.tagName}`);
    }
    for (const m of document.querySelectorAll('img, svg, canvas')) {
        const r = m.getBoundingClientRect();
        if (r.width > 1 && shown(m) && (r.left < -1 || r.right > innerWidth + 1) && !inHorizontalScroller(m)) out.push(`image off-screen: ${m.tagName} ${Math.round(r.left)}..${Math.round(r.right)} in ${innerWidth}px`);
    }
    // react-native-web draws an Image as its parent's background over an invisible <img>. A filled image (object-fit fill, or background-size with two explicit sizes) must keep its source aspect; cover and contain crops keep it by design.
    for (const img of document.images) {
        const own = getComputedStyle(img).opacity !== '0', holder = own ? img : img.parentElement;
        const box = holder.getBoundingClientRect(), ratio = img.naturalWidth / img.naturalHeight;
        const size = getComputedStyle(holder).backgroundSize.split(' ');
        const fills = own ? getComputedStyle(img).objectFit === 'fill' : size.length === 2 && !size.includes('auto');
        if (img.naturalWidth && box.width && box.height && fills && Math.abs(ratio - box.width / box.height) > 0.02 * ratio) out.push(`stretched image: ${img.src.split('/').pop().slice(0, 40)} drawn ${Math.round(box.width)}x${Math.round(box.height)}, source ${img.naturalWidth}x${img.naturalHeight}`);
    }
    return out.length ? out.join('\n') : 'clean';
};

const parseDump = (xml) => {
    const nodes = [], stack = [];
    for (const m of xml.matchAll(/<node ([^>]*?)(\/?)>|<\/node>/g)) {
        if (!m[1] && m[0] === '</node>') { stack.pop(); continue; }
        const at = Object.fromEntries([...m[1].matchAll(/([\w-]+)="([^"]*)"/g)].map((a) => [a[1], a[2]]));
        const [l, t, r, b] = at.bounds.match(/\d+/g).map(Number);
        const node = { at, box: { l, t, r, b }, up: [...stack], label: at.text || at['content-desc'] || at['resource-id'] || at.class };
        nodes.push(node);
        if (!m[2]) stack.push(node);
    }
    return nodes.filter((n) => n.at.package !== 'com.android.systemui' && n.box.r > n.box.l && n.box.b > n.box.t);
};

// Native dumps retain the whole label, not its painted line breaks. Match
// adjacent OCR fragments back to that label before calling a split a lead.
// OCR can miss or misread glyphs: this is a lead, never a replacement for eyes.
const ocrWords = (png) => execFileSync('tesseract', [png, 'stdout', '--psm', '11', 'tsv'], { encoding: 'utf8' })
    .split('\n').slice(1).map((line) => line.split('\t')).filter((c) => c[0] === '5' && c[11]?.trim())
    .map((c) => ({ text: c[11], l: Number(c[6]), t: Number(c[7]), r: Number(c[6]) + Number(c[8]), b: Number(c[7]) + Number(c[9]) }));

const wordSplitLeads = (nodes, words) => {
    const normalize = (s) => s.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    const out = [];
    for (const n of nodes.filter((n) => n.at.text)) {
        const inside = words.filter((w) => normalize(w.text) && w.l >= n.box.l - 4 && w.r <= n.box.r + 4 && w.t >= n.box.t - 4 && w.b <= n.box.b + 4);
        const expected = [...new Intl.Segmenter(undefined, { granularity: 'word' }).segment(n.at.text)].filter((s) => s.isWordLike);
        for (const { segment } of expected) {
            const word = normalize(segment);
            for (let i = 0; i < inside.length; i++) {
                let joined = '';
                for (let j = i; j < inside.length; j++) {
                    joined += normalize(inside[j].text);
                    if (!word.startsWith(joined)) break;
                    const nextLine = inside[j].t >= inside[i].b;
                    if (joined === word && j > i && nextLine) out.push(`word split across lines: "${segment}" in "${n.label}" ${n.at.bounds}`);
                    if (joined === word) break;
                }
            }
        }
    }
    return [...new Set(out)];
};

const aspect = ({ l, t, r, b }) => (r - l) / (b - t);

// An image is matched to its reference by resource-id and content-desc, the nth occurrence of each pair; with neither, by order.
// A squashed or stretched image changes its aspect against the same image in the reference, which covers an avatar that must stay round.
// An image with no reference twin cannot be compared, so it is a defect until someone looks at it.
const imageDefects = (cand, ref) => {
    const keyed = (nodes) => {
        const seen = new Map();
        return new Map(nodes.filter((n) => /ImageView$/.test(n.at.class)).map((n) => {
            const base = `${n.at['resource-id']}|${n.at['content-desc']}`, k = seen.get(base) ?? 0;
            seen.set(base, k + 1);
            return [`${base}|${k}`, n];
        }));
    };
    const refs = keyed(ref);
    return [...keyed(cand)].flatMap(([key, n]) => {
        const r = refs.get(key);
        if (!r) return [`image not compared, no reference twin: "${n.label}" ${n.at.bounds}`];
        return Math.abs(aspect(n.box) - aspect(r.box)) / aspect(r.box) > 0.02 ? [`stretched image: "${n.label}" ${n.at.bounds} (reference ${r.at.bounds})`] : [];
    });
};

const isImageNode = (n) => /Image/.test(n.at.class);

const inHorizontalScroller = (n) => n.up.some((a) => a.at.scrollable === 'true' && /Horizontal/.test(a.at.class));

// Images with no text, content-desc or clickable flag are invisible to the
// content filter, so they get their own off-screen and overlap checks. A
// horizontal spill is reachable only inside a horizontal scroller; a vertical
// one is normal below-the-fold content on a screen that scrolls.
const imageOffScreenLeads = (imagery, W, H, scrollable) => imagery.flatMap((n) => {
    if (n.box.l < -1 || n.box.r > W + 1) return inHorizontalScroller(n) ? [] : [`image off-screen: "${n.label}" ${n.at.bounds}`];
    return !scrollable && (n.box.t < -1 || n.box.b > H + 1) ? [`image off-screen: "${n.label}" ${n.at.bounds}`] : [];
});

// An image painted over a control or text covers it. Dump order is draw
// order, so only an image later than the node it overlaps is on top; an
// image behind text (a background) is the design, not a defect.
const imageCoversLeads = (ordered, imagery) => {
    const index = new Map(ordered.map((n, i) => [n, i]));
    const cut = (a, b) => Math.max(0, Math.min(a.r, b.r) - Math.max(a.l, b.l)) * Math.max(0, Math.min(a.b, b.b) - Math.max(a.t, b.t));
    return imagery.flatMap((img) => ordered.flatMap((m) => {
        if (m === img || img.up.includes(m) || m.up.includes(img)) return [];
        if ((index.get(img) ?? -1) < (index.get(m) ?? -1)) return [];
        if (cut(img.box, m.box) < 16 * 16) return [];
        return [`image covers "${m.label}" ${m.at.bounds} (image "${img.label}" ${img.at.bounds})`];
    }));
};

// Content under the navigation/gesture bar. Scrolled to the end (--end) any
// of it is stuck there. At rest, a text or button box whose bottom edge sits
// more than 4px into the bar is the pair-screen miss, whether or not a scroller
// holds it. Content fully below the screen is not under the bar.
const navLeads = (watched, nav, H, end) => {
    if (!nav) return [];
    return watched.flatMap((n) => {
        if (n.box.b <= nav[1]) return [];
        if (end) return [`under the navigation bar: "${n.label}" ${n.at.bounds} (bar starts at y=${nav[1]})`];
        if (Math.min(n.box.b, H) - Math.max(n.box.t, nav[1]) <= 4) return [];
        return [`under the navigation bar on the unscrolled screen: "${n.label}" ${n.at.bounds} (bar starts at y=${nav[1]})`];
    });
};

// Content below the viewport on a screen with nowhere to scroll is cut off,
// with or without a navigation bar. A scrolling screen is checked by --end.
const belowLeads = (content, H, scrollable, end) => {
    if (scrollable || end) return [];
    return content.filter((n) => n.box.b > H + 1)
        .map((n) => `off-screen below the viewport with nowhere to scroll: "${n.label}" ${n.at.bounds}`);
};

// Text touching the screen edge is likely cut. A button box past the edge is
// cut even when its text fits; containers may legitimately fill the width,
// so a box without text only fails strictly past the edge, and a node inside a
// horizontal scroller is reached by swipe rather than cut.
const edgeLeads = (watched, W) => watched.flatMap((n) => {
    if (n.at.text && !inHorizontalScroller(n) && (n.box.l <= 0 || n.box.r >= W)) return [`text touches the screen edge, likely cut: "${n.label}" ${n.at.bounds}`];
    if (!n.at.text && n.at.clickable === 'true' && (n.box.l < 0 || n.box.r > W) && !inHorizontalScroller(n)) return [`button runs past the screen edge: "${n.label}" ${n.at.bounds}`];
    return [];
});

const clipLeads = (nodes) => nodes.filter((n) => n.at.text).flatMap((n) => {
    const parent = n.up.at(-1), out = [];
    if (/(…|\.\.\.)$/.test(n.at.text)) out.push(`ellipsis cuts the text: "${n.label}" ${n.at.bounds}`);
    if (parent && (n.box.l < parent.box.l - 1 || n.box.r > parent.box.r + 1 || n.box.t < parent.box.t - 1 || n.box.b > parent.box.b + 1)) out.push(`text runs past its parent: "${n.label}" ${n.at.bounds} (parent ${parent.at.bounds})`);
    return out;
});

// A flat edge band that differs from the band just inside it is a blank or black strip.
const stripLeads = (png, top, bottom, W) => {
    const band = (x) => execFileSync('magick',
        [png, '-crop', `8x${bottom - top}+${x}+${top}`, '+repage', '-colorspace', 'gray', '-format', '%[fx:mean] %[fx:standard_deviation]', 'info:']).toString().split(' ').map(Number);
    const found = [];
    for (const [side, edge, inner] of [['left', 0, 24], ['right', W - 8, W - 32]]) {
        const [mean, sd] = band(edge), [innerMean] = band(inner);
        if (sd < 0.004 && Math.abs(mean - innerMean) > 0.03) found.push(`blank strip on the ${side} edge (edge ${mean.toFixed(2)} vs inside ${innerMean.toFixed(2)})`);
    }
    return found;
};

// The PWA driver: every lead other than `clean` is a DEFECT (a blank page lead
// means the shot was taken before the app drew: retake it), a page that gives
// no eval result is a DEFECT too, plus a blank-strip read of the screenshot.
const pwaEvalDefects = (text) => {
    // chrome-devtools-axi prints the eval result JSON-encoded on a `result:`
    // line, followed by `help` chatter — and it encodes twice, so the payload
    // parses to a string that is itself a JSON string literal (`"clean"`,
    // never bare `clean`). Parse that second layer when present; anything
    // else fails closed.
    const line = text.split('\n').find((l) => l.startsWith('result:'));
    if (line === undefined) return ['no DOM eval result: the leads did not run'];
    let body = JSON.parse(line.slice('result:'.length).trim());
    if (typeof body !== 'string') return ['no DOM eval result: the leads did not run'];
    try {
        const inner = JSON.parse(body);
        if (typeof inner === 'string') body = inner;
    } catch { /* single-encoded payload: keep it as is */ }
    const leads = body.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!leads.length) return ['no DOM eval result: the leads did not run'];
    return leads.filter((l) => l !== 'clean');
};

const pwaCheck = (png, name) => {
    const evalOut = execFileSync('chrome-devtools-axi', ['eval', pwaLeads.toString()], { encoding: 'utf8' });
    const shot = readFileSync(png);
    const found = [...pwaEvalDefects(evalOut), ...stripLeads(png, 0, shot.readUInt32BE(20), shot.readUInt32BE(16))];
    for (const line of found) console.log(`DEFECT ${name}: ${line}`);
    console.log(`${found.length ? 'FAIL' : 'clean'} ${name}`);
    process.exitCode = found.length ? 1 : 0;
};

let failed = 0;
const expect = (label, ok, detail = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ` (${detail})`}`);
    if (!ok) failed++;
};

// The native page's checks over one parsed dump. status and nav are the
// system bars as [l, t, r, b] (or null); ref is the reference dump, if any.
const layoutLeads = (app, { W, H, status, nav, end, ref }) => {
    const content = app.filter((n) => n.at.text || n.at['content-desc'] || n.at.clickable === 'true' || /EditText/.test(n.at.class));
    // Unlabelled images join the bar and overlap watches; labelled ones are
    // already in content through their description.
    const imagery = app.filter((n) => isImageNode(n) && !content.includes(n));
    const watched = app.filter((n) => content.includes(n) || imagery.includes(n));
    const judged = content.filter((n) => n.at.text || (n.at.clickable === 'true' && (n.box.b - n.box.t <= H * 0.25 || !content.some((m) => m.up.includes(n)))));
    const scrollable = app.some((n) => n.at.scrollable === 'true' && !/Horizontal/.test(n.at.class));
    const cut = (a, b) => Math.max(0, Math.min(a.r, b.r) - Math.max(a.l, b.l)) * Math.max(0, Math.min(a.b, b.b) - Math.max(a.t, b.t));
    const found = [];
    for (const n of judged) {
        if (status && n.box.t < status[3]) found.push(`under the status bar: "${n.label}" ${n.at.bounds} (bar ends at y=${status[3]})`);
    }
    found.push(...edgeLeads(watched, W));
    found.push(...navLeads(judged, nav, H, end));
    found.push(...belowLeads(judged, H, scrollable, end));
    found.push(...imageOffScreenLeads(imagery, W, H, scrollable));
    found.push(...imageCoversLeads(watched, imagery));
    for (const [i, a] of content.entries()) for (const b of content.slice(i + 1)) {
        if (a.up.includes(b) || b.up.includes(a) || cut(a.box, b.box) < 16 * 16) continue;
        found.push(`overlap: "${a.label}" ${a.at.bounds} and "${b.label}" ${b.at.bounds}${b.at.clickable === 'true' || a.at.clickable === 'true' ? ' (a control is covered)' : ''}`);
    }
    found.push(...clipLeads(content));
    if (ref) found.push(...imageDefects(app, ref));
    return found;
};

const selfTest = () => {
    const dir = mkdtempSync(join(tmpdir(), 'visual-check-'));
    const nodesOf = (...parts) => parseDump(`<?xml version='1.0'?><hierarchy rotation="0">${parts.join('')}</hierarchy>`);
    const el = (cls, bounds, attrs = {}, inner = '') => {
        const a = { text: '', desc: '', clickable: false, scrollable: false, ...attrs };
        return `<node index="0" text="${a.text}" resource-id="" class="${cls}" package="com.muxr" content-desc="${a.desc}" clickable="${a.clickable}" scrollable="${a.scrollable}" bounds="${bounds}"${inner ? `>${inner}</node>` : ' />'}`;
    };
    const NAV = [0, 2334, 1080, 2376];
    const layout = (app, extra = {}) => layoutLeads(app, { W: 1080, H: 2376, status: null, nav: NAV, end: false, ...extra });
    const pair = nodesOf(
        el('android.widget.TextView', '[100,2300][980,2360]', { text: 'Paste the new code', clickable: true }),
        el('android.widget.TextView', '[100,2400][980,2470]', { text: 'Back', clickable: true }),
        el('com.facebook.react.views.image.ReactImageView', '[100,600][400,700]', { desc: 'avatar' }));
    const refPair = nodesOf(el('com.facebook.react.views.image.ReactImageView', '[100,600][400,900]', { desc: 'avatar' }));
    const defects = layout(pair, { ref: refPair });
    expect('pair screen: Paste under the gesture bar, Back below the screen and a squashed avatar are flagged',
        defects.some((l) => l.includes('"Paste the new code"') && l.includes('navigation bar'))
        && defects.some((l) => l.startsWith('off-screen below') && l.includes('"Back"'))
        && defects.some((l) => l.startsWith('stretched image')), defects.join(' | '));
    expect('the same pair screen under --end still flags the Paste text under the bar',
        layout(pair, { end: true }).some((l) => l.startsWith('under the navigation bar:')), layout(pair, { end: true }).join(' | '));
    const clean = nodesOf(
        el('android.widget.TextView', '[100,1800][980,1860]', { text: 'Paste the new code', clickable: true }),
        el('com.facebook.react.views.scroll.ReactHorizontalScrollView', '[0,1900][1080,2000]', { scrollable: true },
            el('com.facebook.react.views.image.ReactImageView', '[1060,1910][1120,1990]')));
    expect('clean pair entry raises no leads (horizontal carousel past the edge is reachable by swipe)', layout(clean).length === 0, layout(clean).join(' | '));
    const title = el('android.widget.TextView', '[100,500][600,560]', { text: 'Title' });
    const wallpaper = el('com.facebook.react.views.image.ReactImageView', '[0,400][1080,1000]');
    expect('image dumped before its label, behind it, is not flagged', !layout(nodesOf(wallpaper, title)).some((l) => l.startsWith('image covers')), layout(nodesOf(wallpaper, title)).join(' | '));
    expect('image dumped after its label, painted over it, is flagged', layout(nodesOf(title, wallpaper)).some((l) => l.startsWith('image covers "Title"')), layout(nodesOf(title, wallpaper)).join(' | '));
    const bleed = el('com.facebook.react.views.image.ReactImageView', '[0,0][1080,2376]');
    const headline = el('android.widget.TextView', '[100,50][600,100]', { text: 'Headline' });
    const status = [0, 0, 1080, 145];
    expect('full-bleed image under the status bar is not flagged', layout(nodesOf(bleed), { status }).length === 0, layout(nodesOf(bleed), { status }).join(' | '));
    expect('text under the status bar is flagged', layout(nodesOf(headline), { status }).some((l) => l.startsWith('under the status bar: "Headline"')), layout(nodesOf(headline), { status }).join(' | '));
    expect('full-bleed wallpaper under the nav bar scrolled to the end is not flagged', layout(nodesOf(bleed), { end: true }).length === 0, layout(nodesOf(bleed), { end: true }).join(' | '));
    const leaf = el('android.view.ViewGroup', '[100,2300][980,2360]', { clickable: true });
    expect('clickable leaf box under the gesture bar at rest is flagged', layout(nodesOf(leaf)).some((l) => l.startsWith('under the navigation bar on the unscrolled screen')), layout(nodesOf(leaf)).join(' | '));
    const card = el('android.view.ViewGroup', '[0,0][1080,2376]', { clickable: true }, el('android.widget.TextView', '[100,100][400,160]', { text: 'Fits' }));
    expect('full-screen clickable container with fitting children is not flagged', layout(nodesOf(card)).length === 0, layout(nodesOf(card)).join(' | '));
    const ctrl = el('android.view.ViewGroup', '[100,2250][980,2370]', { clickable: true }, el('android.widget.TextView', '[400,2280][680,2330]', { text: 'Continue' }));
    expect('button-sized clickable box under the gesture bar is flagged by its own box', layout(nodesOf(ctrl)).some((l) => l.startsWith('under the navigation bar') && l.includes('android.view.ViewGroup')), layout(nodesOf(ctrl)).join(' | '));
    const tall = el('android.widget.TextView', '[100,1500][980,2400]', { text: 'Read the full terms', clickable: true });
    expect('tall clickable text under the gesture bar at rest is flagged', layout(nodesOf(tall)).some((l) => l.startsWith('under the navigation bar on the unscrolled screen') && l.includes('"Read the full terms"')), layout(nodesOf(tall)).join(' | '));
    const tallAbove = el('android.widget.TextView', '[100,1500][980,2300]', { text: 'Read the full terms', clickable: true });
    expect('tall clickable text that ends above the gesture bar is not flagged', layout(nodesOf(tallAbove)).length === 0, layout(nodesOf(tallAbove)).join(' | '));
    const labelled = el('android.view.ViewGroup', '[0,200][1080,2376]', { desc: 'list', scrollable: true });
    expect('labelled non-clickable container past the bar at the end of the scroll is not flagged', layout(nodesOf(labelled), { end: true }).length === 0, layout(nodesOf(labelled), { end: true }).join(' | '));
    const pngOf = (name, args) => {
        const png = join(dir, `${name}.png`);
        execFileSync('magick', ['-size', '1080x2376', 'xc:#0c0c0b', ...args, png]);
        return png;
    };
    const stripped = stripLeads(pngOf('black-strip', ['-fill', 'black', '-draw', 'rectangle 0,0 7,2375']), 0, 2376, 1080);
    const uniform = stripLeads(pngOf('uniform', []), 0, 2376, 1080);
    const font = fileURLToPath(new URL('../../../../apps/mobile/sources/assets/fonts/IBMPlexSans-Regular.ttf', import.meta.url));
    const splitShot = pngOf('word-split', ['-font', font, '-pointsize', '60', '-fill', 'white',
        '-draw', "text 100,580 'Sec' text 100,660 'urel' text 100,740 'y' text 100,860 'pair' text 100,940 'this' text 100,1020 'device' text 650,580 'Tails' text 650,660 'cale' text 650,860 'Con' text 650,940 'nect'"]);
    const intactShot = pngOf('word-intact', ['-font', font, '-pointsize', '60', '-fill', 'white',
        '-draw', "text 100,580 'Securely' text 100,660 'pair' text 100,740 'this' text 100,820 'device' text 650,580 'Tailscale' text 650,860 'Connect'"]);
    const pairTitle = nodesOf(el('android.widget.TextView', '[80,480][600,1100]', { text: 'Securely pair this device' }),
        el('android.widget.TextView', '[630,480][1060,720]', { text: 'Get Tailscale' }),
        el('android.widget.TextView', '[630,780][1060,1000]', { text: 'Connect' }));
    const splits = wordSplitLeads(pairTitle, ocrWords(splitShot));
    expect('native screenshots flag split Securely, Tailscale and Connect against full labels; whole-word wrapping is clean',
        ['Securely', 'Tailscale', 'Connect'].every((word) => splits.some((l) => l.startsWith(`word split across lines: "${word}"`)))
        && wordSplitLeads(pairTitle, ocrWords(intactShot)).length === 0, splits.join(' | '));
    expect('black strip on the screen edge is flagged, a uniform background is not', stripped.length === 1 && uniform.length === 0, `strip=${stripped.length} uniform=${uniform.length}`);
    process.exitCode = failed ? 1 : 0;
};

const pwaSelfTest = () => {
    const dir = mkdtempSync(join(tmpdir(), 'pwa-visual-check-'));
    writeFileSync(join(dir, 'wide.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="100"><rect width="400" height="100" fill="#d33"/></svg>');
    const hidden = '<img src="wide.svg" style="position:absolute;opacity:0;width:100%;height:100%">';
    writeFileSync(join(dir, 'page.html'), `<!doctype html><body style="margin:0;background:#0c0c0b;color:#eee"><p>fixture</p>
<img src="wide.svg" style="position:absolute;left:0;top:40px;width:100px;height:100px;object-fit:fill">
<img src="wide.svg" style="position:absolute;left:120px;top:40px;width:80px;height:80px;object-fit:cover">
<div style="position:absolute;left:220px;top:40px;width:120px;height:120px;background-image:url(wide.svg);background-size:100% 100%">${hidden}</div>
<div style="position:absolute;left:360px;top:40px;width:90px;height:90px;background-image:url(wide.svg);background-size:cover">${hidden}</div>
<span style="position:absolute;left:10px;top:200px">buried caption</span><span style="position:absolute;left:10px;top:200px">covering caption</span>
<span style="position:absolute;left:10px;top:260px">caption under art</span><img src="wide.svg" style="position:absolute;left:10px;top:260px;width:100px;height:30px;object-fit:none">
<div style="position:absolute;left:10px;top:320px;width:200px;height:20px;overflow:hidden"><div dir="auto">two lines of text that wrap well beyond twenty pixels of height</div></div>
<div style="position:absolute;left:600px;top:500px;width:150px;height:40px;overflow-x:auto;overflow-y:hidden"><div style="position:relative;width:400px;height:40px"><span style="position:absolute;left:300px;top:0">chip inside a scroller</span><img src="wide.svg" style="position:absolute;left:300px;top:20px;width:60px;height:60px;object-fit:cover"></div></div>
<span style="position:absolute;left:820px;top:560px">chip past the edge</span>
<div dir="auto" style="position:absolute;left:10px;top:380px;width:55px;font:26px Arial;overflow-wrap:break-word">Securely pair this device</div>
<div dir="auto" style="position:absolute;left:220px;top:380px;width:110px;font:26px Arial;overflow-wrap:normal">Securely pair this device</div>
<div dir="auto" style="position:absolute;left:450px;top:380px;width:40px;font:17px Arial;overflow-wrap:break-word">Tailscale</div>
<button disabled style="position:absolute;left:550px;top:380px;pointer-events:none"><div dir="auto" style="width:40px;font:17px Arial;overflow-wrap:break-word">Connect</div></button>
<div dir="auto" style="position:absolute;left:650px;top:380px;width:110px;font:17px Arial;overflow-wrap:normal">Tailscale Connect</div>
<pre id="leads"></pre>
<script>window.onload = () => { document.getElementById('leads').textContent = (${pwaLeads})(); };</script>`);
    const html = execFileSync('chromium', ['--headless=new', '--no-sandbox', '--allow-file-access-from-files', '--virtual-time-budget=5000', '--dump-dom', pathToFileURL(join(dir, 'page.html')).href]).toString();
    const leads = (html.match(/<pre id="leads">([\s\S]*?)<\/pre>/)?.[1] ?? '').split('\n');
    expect('PWA ranges flag split Securely, Tailscale and Connect; whole-word wrapping is clean',
        ['Securely', 'Tailscale', 'Connect'].every((word) => leads.filter((l) => l.startsWith(`word split across lines: "${word}"`)).length === 1), leads.join(' | '));
    const stretched = leads.filter((l) => l.startsWith('stretched image'));
    expect('squashed img and background are flagged, cover crops are not', stretched.length === 2 && !leads.some((l) => /drawn (80x80|90x90)/.test(l)), leads.join(' | '));
    expect('text painted over by other text or by an image is flagged',
        leads.some((l) => l.startsWith('text over text: "buried caption"')) && leads.some((l) => l.startsWith('text over image: "caption under art"')), leads.join(' | '));
    expect('text sticking out of an overflow-hidden ancestor is flagged', leads.some((l) => l.startsWith('text clipped by overflow-hidden ancestor: "two lines of text')), leads.join(' | '));
    expect('text past the edge outside a scroller is flagged; text and images inside a horizontal scroller are not',
        leads.some((l) => l.startsWith('text off-screen: "chip past the edge"')) && !leads.some((l) => l.includes('"chip inside a scroller"') || l.startsWith('image off-screen')), leads.join(' | '));
    // The driver runs the eval itself: a stub chrome-devtools-axi on PATH prints the case's eval output.
    const self = fileURLToPath(import.meta.url);
    const runDriver = (evalOut, pngArgs) => {
        const bin = mkdtempSync(join(dir, 'bin-'));
        writeFileSync(join(bin, 'eval.txt'), evalOut);
        writeFileSync(join(bin, 'chrome-devtools-axi'), `#!/bin/sh\ncat "${join(bin, 'eval.txt')}"\n`, { mode: 0o755 });
        const png = join(bin, 'shot.png');
        execFileSync('magick', ['-size', '270x594', 'xc:#0c0c0b', ...pngArgs, png]);
        try {
            execFileSync(process.execPath, [self, 'pwa-check', png, 'driver'], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
            return { code: 0, out: '' };
        } catch (e) { return { code: e.status, out: (e.stdout ?? '').toString() }; }
    };
    // The real wire format: JSON-encoded payload on a `result:` line plus help chatter.
    const result = (body) => `result: ${JSON.stringify(body)}\nhelp[1]:\n  Run \`chrome-devtools-axi snapshot\` to see current page state\n`;
    const failing = runDriver(result('clean\ntext off-screen: "too wide"'), []);
    expect('driver exits non-zero on a DEFECT lead', failing.code === 1 && /DEFECT driver: text off-screen/.test(failing.out), `code=${failing.code} out=${failing.out}`);
    const wired = runDriver(result('clean'), []);
    expect('driver passes a clean page on a uniform shot', wired.code === 0, `code=${wired.code} out=${wired.out}`);
    // The live tool double-encodes the payload; a single parse leaves a
    // quoted `"clean"` that must not become a DEFECT.
    const twice = (body) => result(JSON.stringify(body));
    const wired2 = runDriver(twice('clean'), []);
    expect('driver passes a double-encoded clean page', wired2.code === 0, `code=${wired2.code} out=${wired2.out}`);
    const failing2 = runDriver(twice('text off-screen: "too wide"'), []);
    expect('driver exits non-zero on a double-encoded DEFECT and prints it unescaped', failing2.code === 1 && /DEFECT driver: text off-screen: "too wide"/.test(failing2.out), `code=${failing2.code} out=${failing2.out}`);
    const silent = runDriver('clean\n', []);
    expect('driver fails a page that gives no eval result', silent.code === 1 && /no DOM eval result/.test(silent.out), `code=${silent.code} out=${silent.out}`);
    const striped = runDriver(result('clean'), ['-fill', 'black', '-draw', 'rectangle 0,0 7,593']);
    expect('driver flags a blank strip on the PWA shot', striped.code === 1 && /blank strip/.test(striped.out), `code=${striped.code} out=${striped.out}`);
    process.exitCode = failed ? 1 : 0;
};

const native = (serial, dir, name, flags) => {
    const adb = (...args) => execFileSync('adb', ['-s', serial, ...args], { maxBuffer: 64 << 20 });
    const png = join(dir, `${name}.png`);
    writeFileSync(png, adb('exec-out', 'screencap', '-p'));
    adb('shell', 'uiautomator', 'dump', '/sdcard/visual-check.xml');
    const xml = adb('exec-out', 'cat', '/sdcard/visual-check.xml').toString();
    writeFileSync(join(dir, `${name}.xml`), xml);
    const shot = readFileSync(png);
    const W = shot.readUInt32BE(16), H = shot.readUInt32BE(20);

    // System bars as the window manager reports them: "InsetsSource … type=statusBars frame=[0,0][1080,145] visible=true".
    const windows = adb('shell', 'dumpsys', 'window').toString();
    const bar = (type) => [...windows.matchAll(new RegExp(`type=${type} frame=\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\] visible=true`, 'g'))]
        .map((m) => m.slice(1).map(Number)).find(([l, t, r, b]) => r > l && b > t);
    const status = bar('statusBars'), nav = bar('navigationBars');

    const refAt = flags.indexOf('--ref'), refPath = refAt < 0 ? undefined : flags[refAt + 1];
    const ref = refPath && existsSync(refPath) ? parseDump(readFileSync(refPath).toString()) : undefined;
    if (!ref) console.log(`image geometry not compared for ${name}: no reference dump`);
    const found = layoutLeads(parseDump(xml), { W, H, status, nav, end: flags.includes('--end'), ref });
    let words;
    try { words = ocrWords(png); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (words) found.push(...wordSplitLeads(parseDump(xml), words));
    else console.log('word-split check skipped: tesseract not found');
    found.push(...stripLeads(png, status?.[3] ?? 0, nav?.[1] ?? H, W));
    for (const line of found) console.log(`DEFECT ${name}: ${line}`);
    console.log(`${found.length ? 'FAIL' : 'clean'} ${name} (${W}x${H}, status bar ${status ? `0-${status[3]}` : 'none'}, nav bar ${nav ? `${nav[1]}-${nav[3]}` : 'none'})`);
    process.exitCode = found.length ? 1 : 0;
};

const [serial, dir, name, ...flags] = process.argv.slice(2);
if (serial === 'pwa-check') {
    if (!dir || !name) throw new Error('usage: visualCheck.mjs pwa-check <shot>.png <name>');
    pwaCheck(dir, name);
} else if (serial === 'selftest') selfTest();
else if (serial === 'pwa-selftest') pwaSelfTest();
else {
    if (!name) throw new Error('usage: visualCheck.mjs <serial> <dir> <name> [--end] [--ref <main>.xml]');
    native(serial, dir, name, flags);
}
