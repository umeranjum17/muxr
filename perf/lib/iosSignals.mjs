/** Simulator observations. RSS is not PSS; process CPU is not the JS thread. */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir, loadavg } from 'node:os';
import { join } from 'node:path';
import { runCommand } from './commands.mjs';

export const unavailable = {
    pssKb: 'Android proportional-set-size accounting is unavailable on iOS.',
    jsBusyPercent: 'No validated per-JS-thread CPU sampler for this retained Release binary.',
    fps: 'No Android gfxinfo/SurfaceFlinger equivalent collected in this run.',
    frameStats: 'No instrumented frame timestamps; AX command duration is not input-to-frame latency.',
};
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
export const command = async (bin, args, options = {}) => (await runCommand(bin, args, { timeout: 20_000, maxBuffer: 16 * 1024 * 1024, ...options })).stdout;
export const simctl = (...args) => command('xcrun', ['simctl', ...args]);
export function flatten(value) {
    if (Array.isArray(value)) return value.flatMap(flatten);
    if (value === null || typeof value !== 'object') return [];
    return [value, ...Object.values(value).filter((v) => typeof v === 'object').flatMap(flatten)];
}
export class IosControls {
    constructor(udid) { this.udid = udid; this.width = 402; this.height = 874; }
    async ui() { return flatten(JSON.parse(await command('axe', ['describe-ui', '--udid', this.udid]))); }
    visible(node) { const f = node.frame; return f && f.width > 0 && f.height > 0 && f.y >= 0 && f.y + f.height / 2 < this.height; }
    async tap(x, y) { await command('axe', ['tap', '-x', String(x), '-y', String(y), '--udid', this.udid]); }
    async tapMatch(pattern, { optional = false } = {}) {
        const node = (await this.ui()).find((n) => this.visible(n) && pattern.test(n.AXLabel ?? ''));
        if (!node) { if (optional) return false; throw new Error(`UI target missing: ${pattern}`); }
        await this.tap(node.frame.x + node.frame.width / 2, node.frame.y + node.frame.height / 2); return true;
    }
    async waitFor(pattern, timeout = 20_000) {
        const end = Date.now() + timeout;
        do { const nodes = await this.ui(); if (nodes.some((n) => this.visible(n) && pattern.test(n.AXLabel ?? ''))) return nodes; await sleep(500); } while (Date.now() < end);
        throw new Error(`Required screen absent: ${pattern}`);
    }
    async open(route) { await simctl('openurl', this.udid, `muxr://${route}`); await sleep(500); }
    async home() { await this.open(''); await this.waitFor(/^(LIVE|SPACES|Machine)$/); }
    async back() { await this.tapMatch(/^(Back|Go back|Close)$/); await sleep(600); }
    async swipe(x1, y1, x2, y2, seconds = 0.12) {
        await command('axe', ['swipe', '--start-x', String(x1), '--start-y', String(y1), '--end-x', String(x2), '--end-y', String(y2), '--duration', String(seconds), '--udid', this.udid]);
    }
    async scrollPair(seconds = 0.12) { await this.swipe(this.width * .5, this.height * .22, this.width * .5, this.height * .72, seconds); await this.swipe(this.width * .5, this.height * .72, this.width * .5, this.height * .22, seconds); }
    async stripPair() { await this.swipe(this.width * .85, this.height * .33, this.width * .15, this.height * .33, .3); await this.swipe(this.width * .15, this.height * .33, this.width * .85, this.height * .33, .3); }
    async screenshot(path) { await simctl('io', this.udid, 'screenshot', path); }
    async foreground() { await command('axe', ['tap', '--label', 'muxr', '--udid', this.udid]); await sleep(700); }
    async background() { await command('axe', ['button', 'home', '--udid', this.udid]); await sleep(700); }
}
export async function appPid(udid, bundle) {
    const container = (await simctl('get_app_container', udid, bundle, 'app')).trim();
    const text = await command('ps', ['-axo', 'pid=,comm=']);
    const line = text.split('\n').find((row) => row.includes(`${container}/`));
    return line ? Number(line.trim().split(/\s+/)[0]) : null;
}
function cpuSeconds(text) {
    const [minutes, seconds] = text.split(':').map(Number);
    return Number.isFinite(minutes + seconds) ? minutes * 60 + seconds : null;
}
export async function processSample(pid) {
    const at = new Date().toISOString();
    try {
        const text = (await command('ps', ['-p', String(pid), '-o', 'pid=,rss=,%cpu=,time='])).trim();
        const [actual, rss, cpu, time] = text.split(/\s+/);
        return { at, pid: Number(actual), alive: true, rssKb: Number(rss), processCpuPsPercent: Number(cpu), cpuSeconds: cpuSeconds(time) };
    } catch { return { at, pid, alive: false, rssKb: null, processCpuPsPercent: null, cpuSeconds: null }; }
}
export function reduceSamples(samples) {
    const rss = samples.map((s) => s.rssKb).filter(Number.isFinite);
    const cpu = samples.map((s) => s.processCpuIntervalPercent).filter(Number.isFinite);
    return { samples, rssFirstKb: rss[0] ?? null, rssLastKb: rss.at(-1) ?? null, rssPeakKb: rss.length ? Math.max(...rss) : null,
        rssDriftKb: rss.length > 1 ? rss.at(-1) - rss[0] : null,
        processCpuMeanPercent: cpu.length ? cpu.reduce((a,b) => a+b,0)/cpu.length : null,
        processCpuPeakPercent: cpu.length ? Math.max(...cpu) : null,
        pssKb: null, jsBusyPercent: null, fps: null, frameStats: null, unsupported: unavailable };
}
export function crashFiles(sinceMs) {
    const dir = join(homedir(), 'Library/Logs/DiagnosticReports');
    try { return readdirSync(dir).filter((name) => /^muxr.*\.(ips|crash)$/.test(name) && statSync(join(dir,name)).mtimeMs >= sinceMs).map((name) => join(dir,name)); } catch { return []; }
}
export const hostLoad = () => ({ at: new Date().toISOString(), loadAverage: loadavg() });
