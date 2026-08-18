#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_LISTENERS = 64;
const MAX_ITEMS = 24;
const COMMAND_TIMEOUT_MS = 1_500;
const PROBE_TIMEOUT_MS = 900;
const PROBE_CONCURRENCY = 8;

function run(command, args) {
    try {
        return execFileSync(command, args, {
            encoding: 'utf8',
            timeout: COMMAND_TIMEOUT_MS,
            maxBuffer: 256 * 1024,
            stdio: ['ignore', 'pipe', 'ignore'],
        });
    } catch (error) {
        return typeof error?.stdout === 'string' ? error.stdout : '';
    }
}

function splitHostPort(value) {
    const mark = value.lastIndexOf(':');
    if (mark <= 0) return undefined;
    const port = Number(value.slice(mark + 1));
    return Number.isSafeInteger(port) && port >= 1 && port <= 65_535
        ? { host: value.slice(0, mark), port }
        : undefined;
}

/** `LISTEN 0 511 127.0.0.1:8080 0.0.0.0:* users:(("node",pid=4039084,fd=21))` */
export function parseSsListeners(stdout) {
    return stdout.split('\n').flatMap((line) => {
        if (!line.trimStart().startsWith('LISTEN')) return [];
        const fields = line.trim().split(/\s+/);
        const local = fields[3];
        const address = local === undefined ? undefined : splitHostPort(local);
        if (address === undefined) return [];
        const process = /users:\(\("([^"]{1,80})",pid=(\d+)/.exec(line);
        const pid = process?.[2] === undefined ? undefined : Number(process[2]);
        return [{
            port: address.port,
            command: process?.[1] ?? '',
            ...(Number.isSafeInteger(pid) && pid > 0 ? { pid } : {}),
        }];
    }).slice(0, MAX_LISTENERS);
}

/** `node 12345 user 21u IPv4 0x1 0t0 TCP 127.0.0.1:8080 (LISTEN)` */
export function parseLsofListeners(stdout) {
    return stdout.split('\n').flatMap((line) => {
        if (!line.includes('(LISTEN)')) return [];
        const fields = line.trim().split(/\s+/);
        const address = splitHostPort(fields.at(-2) ?? '');
        const pid = Number(fields[1]);
        if (address === undefined || !Number.isSafeInteger(pid) || pid <= 0) return [];
        return [{ port: address.port, command: fields[0]?.slice(0, 80) ?? '', pid }];
    }).slice(0, MAX_LISTENERS);
}

export function insideProject(projectCwd, processCwd) {
    const within = (outer, inner) => {
        const path = relative(outer, inner);
        return path === '' || (!path.startsWith('..') && !isAbsolute(path));
    };
    return within(projectCwd, processCwd) || within(processCwd, projectCwd);
}

function processCwds(listeners) {
    const result = new Map();
    if (process.platform !== 'darwin') {
        for (const { pid } of listeners) {
            if (pid === undefined) continue;
            try { result.set(pid, realpathSync(readlinkSync(`/proc/${pid}/cwd`))); } catch {}
        }
        return result;
    }
    const pids = [...new Set(listeners.flatMap(({ pid }) => pid === undefined ? [] : [pid]))].slice(0, MAX_LISTENERS);
    if (pids.length === 0) return result;
    let current;
    for (const line of run('lsof', ['-a', '-p', pids.join(','), '-d', 'cwd', '-Fn']).split('\n')) {
        if (/^p\d+$/.test(line)) current = Number(line.slice(1));
        else if (current !== undefined && line.startsWith('n')) {
            try { result.set(current, realpathSync(line.slice(1))); } catch {}
        }
    }
    return result;
}

async function speaksHttp(port) {
    try {
        await fetch(`http://127.0.0.1:${port}/`, {
            method: 'HEAD',
            redirect: 'manual',
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        return true;
    } catch {
        return false;
    }
}

async function httpListeners(listeners) {
    const accepted = [];
    let next = 0;
    const worker = async () => {
        while (next < listeners.length) {
            const listener = listeners[next++];
            if (listener !== undefined && await speaksHttp(listener.port)) accepted.push(listener);
        }
    };
    await Promise.all(Array.from({ length: Math.min(PROBE_CONCURRENCY, listeners.length) }, worker));
    return accepted;
}

function readListeners() {
    const raw = process.platform === 'darwin'
        ? parseLsofListeners(run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN']))
        : parseSsListeners(run('ss', ['-H', '-ltnp']));
    const byPort = new Map();
    for (const listener of raw) {
        const existing = byPort.get(listener.port);
        if (existing === undefined || existing.pid === undefined && listener.pid !== undefined) byPort.set(listener.port, listener);
    }
    return [...byPort.values()].slice(0, MAX_LISTENERS);
}

function safeText(value, fallback) {
    const clean = String(value ?? '').replace(/[\0-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, 80);
    return clean || fallback;
}

export async function discover(cwd) {
    if (typeof cwd !== 'string' || cwd.includes('\0') || cwd.length === 0 || cwd.length > 1_024) return [];
    let project;
    try {
        project = realpathSync(cwd);
        if (!statSync(project).isDirectory()) return [];
    } catch {
        return [];
    }
    const listeners = readListeners();
    const cwds = processCwds(listeners);
    const contained = listeners.filter(({ pid }) => {
        if (pid === process.ppid) return false;
        const processCwd = pid === undefined ? undefined : cwds.get(pid);
        return processCwd !== undefined && insideProject(project, processCwd);
    });
    const http = await httpListeners(contained);
    const projectLabel = safeText(basename(project), 'project');
    return http.sort((a, b) => a.port - b.port).slice(0, MAX_ITEMS).map(({ port, command }) => ({
        id: `port-${port}`,
        title: `localhost:${port}`,
        subtitle: `${safeText(command, 'HTTP server')} · ${projectLabel}`,
        action: { type: 'kernel.navigate', target: 'preview', port },
    }));
}

async function main() {
    if (process.argv[2] !== 'list') throw new Error('unknown run-server RPC method');
    let input = {};
    try { input = JSON.parse(readFileSync(0, 'utf8') || '{}') ?? {}; } catch {}
    process.stdout.write(JSON.stringify({ items: await discover(input.cwd) }));
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    });
}
