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
//   node visualCheck.mjs selftest | pwa-selftest
//     proves the checks fire: a squashed image and a black strip are flagged; a
//     cover crop and a uniform background are not. pwa-selftest needs `chromium`.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

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
<pre id="leads"></pre>
<script>window.onload = () => { document.getElementById('leads').textContent = (${pwaLeads})(); };</script>`);
    const html = execFileSync('chromium', ['--headless=new', '--no-sandbox', '--allow-file-access-from-files', '--virtual-time-budget=5000', '--dump-dom', pathToFileURL(join(dir, 'page.html')).href]).toString();
    const leads = (html.match(/<pre id="leads">([\s\S]*?)<\/pre>/)?.[1] ?? '').split('\n');
    const stretched = leads.filter((l) => l.startsWith('stretched image'));
    expect('squashed img and squashed background are flagged', stretched.length === 2 && stretched.some((l) => l.includes('drawn 100x100')) && stretched.some((l) => l.includes('drawn 120x120')), leads.join(' | '));
    expect('cover img and cover background are not flagged', !leads.some((l) => /drawn (80x80|90x90)/.test(l)), leads.join(' | '));
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
    const cut = (a, b) => Math.max(0, Math.min(a.r, b.r) - Math.max(a.l, b.l)) * Math.max(0, Math.min(a.b, b.b) - Math.max(a.t, b.t));
    const found = [];
    for (const n of content) {
        if (status && n.box.t < status[3]) found.push(`under the status bar: "${n.label}" ${n.at.bounds} (bar ends at y=${status[3]})`);
        if (nav && flags.includes('--end') && n.box.b > nav[1]) found.push(`under the navigation bar: "${n.label}" ${n.at.bounds} (bar starts at y=${nav[1]})`);
        if (n.at.text && (n.box.l <= 0 || n.box.r >= W)) found.push(`text touches the screen edge, likely cut: "${n.label}" ${n.at.bounds}`);
    }
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
else if (serial === 'selftest') selfTest();
else if (serial === 'pwa-selftest') pwaSelfTest();
else {
    if (!name) throw new Error('usage: visualCheck.mjs <serial> <dir> <name> [--end] [--ref <main>.xml]');
    native(serial, dir, name, flags);
}
