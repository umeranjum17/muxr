/**
 * Memory the service costs on the machine, read from `/proc`.
 *
 * The phone's numbers say whether the app survives; these say whether the host
 * fits in the RAM a user is willing to give it. Both are needed to answer "how
 * big a herd can this run": the app can be fine while the host is not.
 *
 * RSS is the honest number for a capacity budget - it is what the kernel has
 * actually given the process - summed over the process tree, because a herd's
 * terminals are child processes.
 */
import { readFileSync, readdirSync } from 'node:fs';

function rssKb(pid) {
    try {
        // statm field 2 is resident pages.
        const pages = Number(readFileSync(`/proc/${pid}/statm`, 'utf8').split(' ')[1]);
        return Number.isFinite(pages) ? pages * 4 : 0;
    } catch {
        return 0;
    }
}

function children(pid) {
    const found = [];
    let tasks;
    try {
        tasks = readdirSync(`/proc/${pid}/task`);
    } catch {
        return found;
    }
    for (const task of tasks) {
        try {
            const raw = readFileSync(`/proc/${pid}/task/${task}/children`, 'utf8').trim();
            for (const child of raw.split(/\s+/)) {
                if (child !== '') found.push(Number(child));
            }
        } catch {
            /* the task exited while being read */
        }
    }
    return found;
}

/** RSS of a process and everything it spawned, in kB. */
export function treeRssKb(pid) {
    const seen = new Set();
    const queue = [Number(pid)];
    let total = 0;
    while (queue.length > 0) {
        const current = queue.shift();
        if (!Number.isFinite(current) || seen.has(current)) continue;
        seen.add(current);
        total += rssKb(current);
        queue.push(...children(current));
    }
    return total;
}

/**
 * Sample the service's memory for a while and report the peak, which is what a
 * RAM budget has to cover.
 */
export async function sampleServiceMemory({ pids, seconds, intervalMs = 2000 }) {
    const names = Object.keys(pids);
    const deadline = Date.now() + seconds * 1000;
    const samples = [];
    while (Date.now() < deadline) {
        samples.push(Object.fromEntries(names.map((name) => [name, treeRssKb(pids[name])])));
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    const totals = samples.map((sample) => names.reduce((sum, name) => sum + (sample[name] ?? 0), 0));
    return {
        samples: samples.length,
        peakByName: Object.fromEntries(names.map((name) => [
            name,
            samples.reduce((peak, sample) => Math.max(peak, sample[name] ?? 0), 0),
        ])),
        firstTotalKb: totals[0] ?? 0,
        lastTotalKb: totals.at(-1) ?? 0,
        peakTotalKb: totals.length === 0 ? 0 : Math.max(...totals),
    };
}
