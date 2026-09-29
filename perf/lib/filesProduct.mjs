#!/usr/bin/env node
/** Drive the host's product files/history modules the way probes used to drive the add-on scripts. */
import { readFileSync } from 'node:fs';

const { filesList, filesRead, filesRepos } = await import('../../apps/host/src/files/files.ts');
const { historyLog, historyShow } = await import('../../apps/host/src/files/history.ts');

const input = JSON.parse(readFileSync(0, 'utf8') || 'null') ?? {};
const sessionId = String(input.sessionId ?? 'perf');
const cwd = String(input.cwd ?? '');
const method = process.argv[2];
const openRoots = () => filesRepos(cwd === '' ? [] : [cwd]).repos.map((repo) => repo.root);
if (method === 'repos') {
    const cwds = Array.isArray(input.cwds) ? input.cwds.map(String) : cwd === '' ? [] : [cwd];
    process.stdout.write(JSON.stringify(filesRepos(cwds)));
} else if (method === 'list') {
    process.stdout.write(JSON.stringify(filesList({
        sessionId,
        cwd,
        ...(input.root === undefined ? {} : { root: String(input.root) }),
        ...(input.path === undefined ? {} : { path: String(input.path) }),
        allowedRoots: openRoots(),
    })));
} else if (method === 'read') {
    process.stdout.write(JSON.stringify(filesRead({
        sessionId,
        cwd,
        ...(input.root === undefined ? {} : { root: String(input.root) }),
        ...(input.path === undefined ? {} : { path: String(input.path) }),
        allowedRoots: openRoots(),
    })));
} else if (method === 'log') {
    process.stdout.write(JSON.stringify(historyLog({ sessionId, cwd })));
} else if (method === 'show') {
    process.stdout.write(JSON.stringify(historyShow({
        sessionId,
        cwd,
        ...(input.sha === undefined ? {} : { sha: String(input.sha) }),
    })));
} else {
    throw new Error(`unknown files product method: ${method}`);
}
