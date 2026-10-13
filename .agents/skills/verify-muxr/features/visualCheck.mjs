#!/usr/bin/env node
// One cell of the Visual check matrix (../SKILL.md "Visual check"). Prints the
// defects a machine can see; every DEFECT line fails the cell (exit 1).
//   node visualCheck.mjs <serial> <dir> <name> [--end] [--ref <main>.xml]
//     native: saves <dir>/<name>.png and .xml from a task-owned emulator. --end:
//     the screen is scrolled as far as it goes (or cannot scroll), so anything
//     still under the navigation bar is stuck there. --ref: the dump of the same
//     cell from main (or the mock run); image nodes are compared against it.
//   node visualCheck.mjs pwa
//     prints a function for `chrome-devtools-axi eval` that lists the same leads
//     in the PWA's DOM ("blank page" means the shot was taken before the app drew).
//   node visualCheck.mjs pwa-check <shot>.png <leads>.txt <name>
//     the PWA driver: fails <name> (exit 1) on any DEFECT, where a DEFECT is any
//     eval line other than `clean` plus a blank-strip read of the screenshot.
//   node visualCheck.mjs selftest | pwa-selftest
//     proves every check fires on its defect and stays quiet on the matching
//     clean case (native: avatar geometry, clipped text, edge strip, unlabelled
//     images, button boxes, unscrolled nav bar; PWA: stretched images, blank
//     strips, text-over-text/image, overflow-hidden clipping, driver exit
//     codes). pwa-selftest needs `chromium`. Each prints PASS/FAIL per case and
//     exits non-zero on any FAIL.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pwaLeads = () => {
    const out = [];
    const shown = (e) => e.checkVisibility({ opacityProperty: true, visibilityProperty: true }) && !e.closest('[aria-hidden="true"]') && getComputedStyle(e).pointerEvents !== 'none';
    if (!document.body.innerText.trim()) return 'blank page: nothing rendered (retake the shot)';
    const de = document.documentElement;
    if (de.scrollWidth > innerWidth) out.push(`off-screen: page ${de.scrollWidth}px wide in a ${innerWidth}px viewport`);
    for (const el of document.querySelectorAll('div[dir="auto"], span')) {
        const cs = getComputedStyle(el), r = el.getBoundingClientRect();
        if (!el.innerText?.trim() || r.width === 0 || !shown(el)) continue;
        if (cs.overflow !== 'visible' && (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1)) out.push(`clipped text: "${el.innerText.slice(0, 40)}"`);
        if (r.right > innerWidth + 1 || r.left < -1) out.push(`text off-screen: "${el.innerText.slice(0, 40)}"`);
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
            if (typeof hit.closest === 'function' && hit.closest('[aria-hidden="true"]')) continue;
            const hitText = (hit.innerText || '').trim();
            const hitName = `${hit.tagName}${hitText ? ` "${hitText.slice(0, 30)}"` : ''}`;
            if (hitText && hit.tagName !== 'BODY' && hit.tagName !== 'HTML') { out.push(`text over text: "${el.innerText.slice(0, 40)}" under ${hitName}`); break; }
            const hitBg = getComputedStyle(hit).backgroundImage;
            if (/^(IMG|SVG|CANVAS|VIDEO)$/.test(hit.tagName) || (hitBg && hitBg !== 'none')) { out.push(`text over image: "${el.innerText.slice(0, 40)}" under ${hitName}`); break; }
        }
    }
    for (const b of document.querySelectorAll('[role="button"], button, input, textarea')) {
        const r = b.getBoundingClientRect();
        if (!r.width || r.bottom < 0 || r.top > innerHeight || !shown(b)) continue;
        const y = Math.min(Math.max(r.top + r.height / 2, 0), innerHeight - 1);
        const hit = document.elementFromPoint(r.left + r.width / 2, y);
        if (hit && !b.contains(hit) && !hit.contains(b)) out.push(`covered control: "${(b.innerText || b.getAttribute('aria-label') || '').slice(0, 40)}" under ${hit.tagName}`);
    }
    for (const m of document.querySelectorAll('img, svg, canvas')) {
        const r = m.getBoundingClientRect();
        if (r.width > 1 && shown(m) && (r.left < -1 || r.right > innerWidth + 1)) out.push(`image off-screen: ${m.tagName} ${Math.round(r.left)}..${Math.round(r.right)} in ${innerWidth}px`);
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

// Images with no text, content-desc or clickable flag are invisible to the
// content filter, so they get their own off-screen and overlap checks. A
// horizontal spill never scrolls into view; a vertical one is normal
// below-the-fold content on a screen that scrolls.
const imageOffScreenLeads = (imagery, W, H, scrollable) => imagery.flatMap((n) => {
    const out = [];
    if (n.box.l < -1 || n.box.r > W + 1) out.push(`image off-screen: "${n.label}" ${n.at.bounds}`);
    else if (!scrollable && (n.box.t < -1 || n.box.b > H + 1)) out.push(`image off-screen: "${n.label}" ${n.at.bounds}`);
    return out;
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
// of it is stuck there. On an unscrolled screen a node fully inside the bar
// band is the pair-screen miss (a button whose text sits under the gesture
// bar even though scrolling could reveal it); a node spanning the band is
// content passing under the translucent bar, which is fine, as is content
// fully below the screen on a screen that scrolls.
const navLeads = (watched, nav, H, end, scrollable) => {
    if (!nav) {
        if (scrollable || end) return [];
        return watched.filter((n) => n.box.b > H + 1)
            .map((n) => `off-screen below the viewport with nowhere to scroll: "${n.label}" ${n.at.bounds}`);
    }
    return watched.flatMap((n) => {
        if (n.box.b <= nav[1]) return [];
        if (end) return [`under the navigation bar: "${n.label}" ${n.at.bounds} (bar starts at y=${nav[1]})`];
        if (n.box.t >= nav[1] - 1 && n.box.b <= H + 1) return [`under the navigation bar on the unscrolled screen: "${n.label}" ${n.at.bounds} (bar starts at y=${nav[1]}; confirm with --end whether scroll reveals it)`];
        if (!scrollable) return [`under the navigation bar with nowhere to scroll: "${n.label}" ${n.at.bounds} (bar starts at y=${nav[1]})`];
        return [];
    });
};

// Text touching the screen edge is likely cut. A button box past the edge is
// cut even when its text fits; containers may legitimately fill the width,
// so a box without text only fails strictly past the edge.
const edgeLeads = (watched, W) => watched.flatMap((n) => {
    if (n.at.text && (n.box.l <= 0 || n.box.r >= W)) return [`text touches the screen edge, likely cut: "${n.label}" ${n.at.bounds}`];
    if (!n.at.text && n.at.clickable === 'true' && (n.box.l < 0 || n.box.r > W)) return [`button runs past the screen edge: "${n.label}" ${n.at.bounds}`];
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

// The PWA driver: every eval line other than `clean` is a DEFECT (a blank
// page line means the shot was taken before the app drew: retake it), plus a
// blank-strip read of the screenshot itself.
const pwaEvalDefects = (text) => {
    // chrome-devtools-axi prints the returned string JSON-encoded on a
    // `result:` line, followed by `help` chatter; a hand-saved file may hold
    // the bare leads instead. Either way, only the payload lines survive.
    const lines = text.split('\n');
    const at = lines.findIndex((l) => l.startsWith('result:'));
    let body;
    if (at >= 0) {
        const raw = lines[at].slice('result:'.length).trim();
        try { body = JSON.parse(raw); }
        catch { body = raw; }
        if (typeof body !== 'string') body = String(body);
        body = body.replace(/^"|"$/g, '');
    } else {
        body = lines.filter((l) => l.trim() && !/^help(\[\d+\])?:/.test(l) && !/^ {2}Run /.test(l)).join('\n');
    }
    return body.split('\n').map((l) => l.trim()).filter((l) => l && l !== 'clean');
};

const pwaCheck = (png, leadsPath, name) => {
    const found = [...pwaEvalDefects(readFileSync(leadsPath, 'utf8'))];
    const shot = readFileSync(png);
    found.push(...stripLeads(png, 0, shot.readUInt32BE(20), shot.readUInt32BE(16)));
    for (const line of found) console.log(`DEFECT ${name}: ${line}`);
    console.log(`${found.length ? 'FAIL' : 'clean'} ${name}`);
    process.exitCode = found.length ? 1 : 0;
};

let failed = 0;
const expect = (label, ok, detail = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ` (${detail})`}`);
    if (!ok) failed++;
};

const selfTest = () => {
    const dir = mkdtempSync(join(tmpdir(), 'visual-check-'));
    const dump = (...boxes) => `<?xml version='1.0'?><hierarchy rotation="0">${boxes.map((bounds) =>
        `<node index="0" text="" resource-id="" class="com.facebook.react.views.image.ReactImageView" package="com.muxr" content-desc="avatar" bounds="${bounds}" clickable="false" /> `).join('')}</hierarchy>`;
    const squashed = imageDefects(parseDump(dump('[0,0][100,60]')), parseDump(dump('[0,0][100,100]')));
    expect('squashed avatar is flagged against its reference', squashed.length === 1, `got ${squashed.length}`);
    const cover = imageDefects(parseDump(dump('[0,0][100,100]')), parseDump(dump('[0,0][100,100]')));
    expect('unchanged avatar (cover crop keeps its box) is not flagged', cover.length === 0, `got ${cover.length}`);
    const unmatched = imageDefects(parseDump(dump('[0,0][100,100]')), parseDump(dump()));
    expect('avatar with no reference twin is reported, not passed', unmatched.length === 1, `got ${unmatched.length}`);
    const frame = (bounds, inner) => `<node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.muxr" content-desc="" clickable="false" bounds="${bounds}">${inner}</node>`;
    const label = (text, bounds) => `<node index="0" text="${text}" resource-id="" class="android.widget.TextView" package="com.muxr" content-desc="" clickable="false" bounds="${bounds}" />`;
    const clipped = (body) => clipLeads(parseDump(`<?xml version='1.0'?><hierarchy rotation="0">${body}</hierarchy>`));
    expect('text that fits its parent is not flagged', clipped(frame('[0,0][200,100]', label('Save', '[10,10][100,40]'))).length === 0);
    expect('text ending in an ellipsis is flagged', clipped(frame('[0,0][200,100]', label('Saving the changes…', '[10,10][100,40]'))).length === 1);
    expect('text running past its parent is flagged', clipped(frame('[0,0][200,100]', label('Long label', '[10,10][300,40]'))).length === 1);
    const pngOf = (name, args) => {
        const png = join(dir, `${name}.png`);
        execFileSync('magick', ['-size', '1080x2376', 'xc:#0c0c0b', ...args, png]);
        return png;
    };
    const strip = stripLeads(pngOf('black-strip', ['-fill', 'black', '-draw', 'rectangle 0,0 7,2375']), 0, 2376, 1080);
    expect('#000 strip on the #0c0c0b dark background is flagged', strip.length === 1, `got ${strip.length}`);
    const uniform = stripLeads(pngOf('uniform', []), 0, 2376, 1080);
    expect('uniform dark background is not flagged', uniform.length === 0, `got ${uniform.length}`);
    // Unlabelled images: no text, no content-desc, not clickable.
    const shot = (cls, bounds, clickable = false) =>
        `<node index="0" text="" resource-id="" class="${cls}" package="com.muxr" content-desc="" clickable="${clickable}" bounds="${bounds}" /> `;
    const nodesOf = (...parts) => parseDump(`<?xml version='1.0'?><hierarchy rotation="0">${parts.join('')}</hierarchy>`);
    const W = 1080, H = 2376, NAV = [0, 2334, 1080, 2376];
    const graphic = (bounds) => shot('com.facebook.react.views.image.ReactImageView', bounds);
    const offUnlabelled = imageOffScreenLeads(nodesOf(graphic('[1060,100][1120,200]')), W, H, true);
    expect('unlabelled image past the screen edge is flagged', offUnlabelled.length === 1, `got ${offUnlabelled.length}`);
    expect('unlabelled image fully on-screen is not flagged', imageOffScreenLeads(nodesOf(graphic('[100,100][200,200]')), W, H, true).length === 0);
    expect('unlabelled image below the fold of a scrolling screen is not flagged', imageOffScreenLeads(nodesOf(graphic('[100,2400][200,2500]')), W, H, true).length === 0);
    expect('unlabelled image below a screen that cannot scroll is flagged', imageOffScreenLeads(nodesOf(graphic('[100,2400][200,2500]')), W, H, false).length === 1);
    const button = (bounds) => shot('android.view.ViewGroup', bounds, true);
    const clickLabel = (text, bounds) => `<node index="0" text="${text}" resource-id="" class="android.widget.TextView" package="com.muxr" content-desc="" clickable="true" bounds="${bounds}" />`;
    const over = nodesOf(clickLabel('Paste the new code', '[100,2200][980,2300]'), graphic('[150,2250][900,2350]'));
    const covers = imageCoversLeads(over, over.filter((n) => isImageNode(n) && !n.at.text && !n.at['content-desc']));
    expect('unlabelled image painted over a button is flagged', covers.length === 1, `got ${covers.length}`);
    const under = nodesOf(graphic('[150,2250][900,2350]'), clickLabel('Paste the new code', '[100,2200][980,2300]'));
    expect('image behind the button (earlier in draw order) is not flagged', imageCoversLeads(under, under.filter((n) => isImageNode(n) && !n.at.text && !n.at['content-desc'])).length === 0);
    expect('button box past the screen edge is flagged', edgeLeads(nodesOf(button('[100,100][1200,200]')), W).length === 1);
    expect('full-width button box exactly on the edge is not flagged', edgeLeads(nodesOf(button('[0,100][1080,200]')), W).length === 0);
    // The pair-screen miss at 270dp: button text fully inside the gesture-bar
    // band on a screen that has not been scrolled to the end.
    const pairCutoff = nodesOf(clickLabel('Paste the new code', '[100,2340][980,2370]'));
    const cutoffLead = navLeads(pairCutoff, NAV, H, false, true);
    expect('button text under the gesture bar on the unscrolled screen is flagged', cutoffLead.length === 1 && /unscrolled/.test(cutoffLead[0]), cutoffLead.join(' | '));
    expect('content spanning the bar band mid-scroll is not flagged', navLeads(nodesOf(label('On your computer, open muxr', '[100,2000][980,2500]')), NAV, H, false, true).length === 0);
    expect('content fully below the fold on a scrolling screen is not flagged', navLeads(nodesOf(label('Back', '[100,2400][980,2470]')), NAV, H, false, true).length === 0);
    expect('content under the bar scrolled to the end is still flagged', navLeads(pairCutoff, NAV, H, true, true).length === 1);
    expect('content under the bar with nowhere to scroll is flagged', navLeads(nodesOf(label('Back', '[100,2400][980,2470]')), NAV, H, false, false).length === 1);
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
<span style="position:absolute;left:240px;top:260px">caption beside art</span>
<div style="position:absolute;left:10px;top:320px;width:200px;height:20px;overflow:hidden"><div dir="auto">two lines of text that wrap well beyond twenty pixels of height</div></div>
<div style="position:absolute;left:240px;top:320px;width:200px;height:100px;overflow:hidden"><div dir="auto">fits</div></div>
<div style="position:absolute;left:10px;top:380px;width:120px;height:60px;overflow:hidden"><div style="height:60px;overflow-y:auto"><div style="height:200px"></div><div dir="auto">below the fold but reachable by scroll</div></div></div>
<pre id="leads"></pre>
<script>window.onload = () => { document.getElementById('leads').textContent = (${pwaLeads})(); };</script>`);
    const html = execFileSync('chromium', ['--headless=new', '--no-sandbox', '--allow-file-access-from-files', '--virtual-time-budget=5000', '--dump-dom', pathToFileURL(join(dir, 'page.html')).href]).toString();
    const leads = (html.match(/<pre id="leads">([\s\S]*?)<\/pre>/)?.[1] ?? '').split('\n');
    const stretched = leads.filter((l) => l.startsWith('stretched image'));
    expect('squashed img and squashed background are flagged', stretched.length === 2 && stretched.some((l) => l.includes('drawn 100x100')) && stretched.some((l) => l.includes('drawn 120x120')), leads.join(' | '));
    expect('cover img and cover background are not flagged', !leads.some((l) => /drawn (80x80|90x90)/.test(l)), leads.join(' | '));
    expect('text painted over by another text is flagged', leads.some((l) => l.startsWith('text over text: "buried caption"')), leads.join(' | '));
    expect('text painted over by an image is flagged', leads.some((l) => l.startsWith('text over image: "caption under art"')), leads.join(' | '));
    expect('text beside an image is not flagged', !leads.some((l) => l.includes('"caption beside art"')), leads.join(' | '));
    expect('text sticking out of an overflow-hidden ancestor is flagged', leads.some((l) => l.startsWith('text clipped by overflow-hidden ancestor: "two lines of text')), leads.join(' | '));
    expect('text fitting its overflow-hidden ancestor is not flagged', !leads.some((l) => l.includes('"fits"')), leads.join(' | '));
    expect('text below the fold inside a real scroller is not flagged', !leads.some((l) => l.includes('"below the fold but reachable by scroll"')), leads.join(' | '));
    // The driver: eval output plus screenshot through one exit code.
    const self = fileURLToPath(import.meta.url);
    const runDriver = (leadText, pngArgs) => {
        const png = join(dir, `driver-${Math.random().toString(36).slice(2)}.png`);
        execFileSync('magick', ['-size', '270x594', 'xc:#0c0c0b', ...pngArgs, png]);
        const leadsPath = `${png}.txt`;
        writeFileSync(leadsPath, leadText);
        try {
            execFileSync(process.execPath, [self, 'pwa-check', png, leadsPath, 'driver'], { encoding: 'utf8' });
            return { code: 0, out: '' };
        } catch (e) { return { code: e.status, out: (e.stdout ?? '').toString() }; }
    };
    const failing = runDriver('clean\ntext off-screen: "too wide"\n', []);
    expect('driver exits non-zero on a DEFECT eval line', failing.code === 1 && /DEFECT driver: text off-screen/.test(failing.out), `code=${failing.code} out=${failing.out}`);
    // The real wire format: JSON-encoded payload on a `result:` line plus help chatter.
    const wired = runDriver('result: "clean"\nhelp[1]:\n  Run `chrome-devtools-axi snapshot` to see current page state\n', []);
    expect('driver reads clean through the result wire format', wired.code === 0, `code=${wired.code} out=${wired.out}`);
    const wiredDefect = runDriver('result: "text over text: \\"a\\" under SPAN \\"b\\"\\nblank page: nothing rendered (retake the shot)"\nhelp[1]:\n  Run `x` to see y\n', []);
    expect('driver splits escaped newlines in the result payload', wiredDefect.code === 1 && /DEFECT driver: text over text/.test(wiredDefect.out) && /blank page/.test(wiredDefect.out) && !/Run `x`/.test(wiredDefect.out), `code=${wiredDefect.code} out=${wiredDefect.out}`);
    expect('driver passes clean eval output on a uniform shot', runDriver('clean\n', []).code === 0);
    const striped = runDriver('clean\n', ['-fill', 'black', '-draw', 'rectangle 0,0 7,593']);
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

    const app = parseDump(xml);
    const content = app.filter((n) => n.at.text || n.at['content-desc'] || n.at.clickable === 'true' || /EditText/.test(n.at.class));
    // Unlabelled images join the bar and overlap watches; labelled ones are
    // already in content through their description.
    const imagery = app.filter((n) => isImageNode(n) && !content.includes(n));
    const watched = [...content, ...imagery];
    const scrollable = app.some((n) => n.at.scrollable === 'true');
    const cut = (a, b) => Math.max(0, Math.min(a.r, b.r) - Math.max(a.l, b.l)) * Math.max(0, Math.min(a.b, b.b) - Math.max(a.t, b.t));
    const found = [];
    for (const n of watched) {
        if (status && n.box.t < status[3]) found.push(`under the status bar: "${n.label}" ${n.at.bounds} (bar ends at y=${status[3]})`);
    }
    found.push(...edgeLeads(watched, W));
    found.push(...navLeads(watched, nav, H, flags.includes('--end'), scrollable));
    found.push(...imageOffScreenLeads(imagery, W, H, scrollable));
    found.push(...imageCoversLeads(watched, imagery));
    for (const [i, a] of content.entries()) for (const b of content.slice(i + 1)) {
        if (a.up.includes(b) || b.up.includes(a) || cut(a.box, b.box) < 16 * 16) continue;
        found.push(`overlap: "${a.label}" ${a.at.bounds} and "${b.label}" ${b.at.bounds}${b.at.clickable === 'true' || a.at.clickable === 'true' ? ' (a control is covered)' : ''}`);
    }
    found.push(...clipLeads(content));
    const refAt = flags.indexOf('--ref'), refPath = refAt < 0 ? undefined : flags[refAt + 1];
    if (refPath && existsSync(refPath)) found.push(...imageDefects(app, parseDump(readFileSync(refPath).toString())));
    else console.log(`image geometry not compared for ${name}: no reference dump`);
    found.push(...stripLeads(png, status?.[3] ?? 0, nav?.[1] ?? H, W));
    for (const line of found) console.log(`DEFECT ${name}: ${line}`);
    console.log(`${found.length ? 'FAIL' : 'clean'} ${name} (${W}x${H}, status bar ${status ? `0-${status[3]}` : 'none'}, nav bar ${nav ? `${nav[1]}-${nav[3]}` : 'none'})`);
    process.exitCode = found.length ? 1 : 0;
};

const [serial, dir, name, ...flags] = process.argv.slice(2);
if (serial === 'pwa') console.log(pwaLeads.toString());
else if (serial === 'pwa-check') {
    if (!name || !flags[0]) throw new Error('usage: visualCheck.mjs pwa-check <shot>.png <leads>.txt <name>');
    pwaCheck(dir, name, flags[0]);
} else if (serial === 'selftest') selfTest();
else if (serial === 'pwa-selftest') pwaSelfTest();
else {
    if (!name) throw new Error('usage: visualCheck.mjs <serial> <dir> <name> [--end] [--ref <main>.xml]');
    native(serial, dir, name, flags);
}
