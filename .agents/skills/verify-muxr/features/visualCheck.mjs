#!/usr/bin/env node
// One cell of the Visual check matrix (../SKILL.md "Visual check"). Prints the
// defects a machine can see; they are leads only: open the shot and judge by eye.
//   node visualCheck.mjs <serial> <dir> <name> [--end]
//     native: saves <dir>/<name>.png and .xml from a task-owned emulator. --end:
//     the screen is scrolled as far as it goes (or cannot scroll), so anything
//     still under the navigation bar is stuck there.
//   node visualCheck.mjs pwa
//     prints a function for `chrome-devtools-axi eval` that lists the same leads
//     in the PWA's DOM ("blank page" means the shot was taken before the app drew).
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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
    // react-native-web draws an Image as its parent's background (resizeMode stretch = 100% 100%) over an invisible <img>.
    for (const img of document.images) {
        const own = getComputedStyle(img).opacity !== '0', holder = own ? img : img.parentElement;
        const box = holder.getBoundingClientRect(), ratio = img.naturalWidth / img.naturalHeight;
        const fills = own ? getComputedStyle(img).objectFit === 'fill' : getComputedStyle(holder).backgroundSize === '100% 100%';
        if (img.naturalWidth && box.width && box.height && fills && Math.abs(ratio - box.width / box.height) > 0.02 * ratio) out.push(`stretched image: ${img.src.split('/').pop().slice(0, 40)} drawn ${Math.round(box.width)}x${Math.round(box.height)}, source ${img.naturalWidth}x${img.naturalHeight}`);
    }
    return out.length ? out.join('\n') : 'clean';
};
if (process.argv[2] === 'pwa') {
    console.log(pwaLeads.toString());
    process.exit(0);
}

const [serial, dir, name, ...flags] = process.argv.slice(2);
if (!name) throw new Error('usage: visualCheck.mjs <serial> <dir> <name> [--end]');
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

const nodes = [], stack = [];
for (const m of xml.matchAll(/<node ([^>]*?)(\/?)>|<\/node>/g)) {
    if (!m[1] && m[0] === '</node>') { stack.pop(); continue; }
    const at = Object.fromEntries([...m[1].matchAll(/([\w-]+)="([^"]*)"/g)].map((a) => [a[1], a[2]]));
    const [l, t, r, b] = at.bounds.match(/\d+/g).map(Number);
    const node = { at, box: { l, t, r, b }, up: [...stack], label: at.text || at['content-desc'] || at['resource-id'] || at.class };
    nodes.push(node);
    if (!m[2]) stack.push(node);
}
const app = nodes.filter((n) => n.at.package !== 'com.android.systemui' && n.box.r > n.box.l && n.box.b > n.box.t);
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
// A flat edge band that differs from the band just inside it is a blank or black strip.
const top = status?.[3] ?? 0, bottom = nav?.[1] ?? H, band = (x) => execFileSync('magick',
    [png, '-crop', `8x${bottom - top}+${x}+${top}`, '+repage', '-colorspace', 'gray', '-format', '%[fx:mean] %[fx:standard_deviation]', 'info:']).toString().split(' ').map(Number);
for (const [side, edge, inner] of [['left', 0, 24], ['right', W - 8, W - 32]]) {
    const [mean, sd] = band(edge), [innerMean] = band(inner);
    if (sd < 0.004 && Math.abs(mean - innerMean) > 0.08) found.push(`blank strip on the ${side} edge (edge ${mean.toFixed(2)} vs inside ${innerMean.toFixed(2)})`);
}
for (const line of found) console.log(`DEFECT ${name}: ${line}`);
console.log(`${found.length ? 'FAIL' : 'clean'} ${name} (${W}x${H}, status bar ${status ? `0-${status[3]}` : 'none'}, nav bar ${nav ? `${nav[1]}-${nav[3]}` : 'none'})`);
process.exitCode = found.length ? 1 : 0;
