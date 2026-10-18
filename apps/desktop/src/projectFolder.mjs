/**
 * The one-time project-folder question in desktop setup.
 *
 * A fresh install starts the newcomer's first agent in ~ unless setup learns
 * their project folder. This module finds the most recently used git repo to
 * preselect, and reads/writes the choice in the host's own config.json, which
 * the host then reports to phones through machines.list. Pure filesystem
 * calls, no Electron imports, so plain node can drive it.
 */
import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { atomicWrite } from '../../../scripts/setup/infrastructure/runtime.mjs';

const SEARCH_ROOTS = ['', 'projects', 'src', 'code', 'dev', 'work', 'repos'];

function mtimeOf(path) {
    try {
        return statSync(path).mtimeMs;
    } catch {
        return 0;
    }
}

function isGitRepo(path) {
    try {
        return statSync(path).isDirectory() && existsSync(join(path, '.git'));
    } catch {
        return false;
    }
}

function childDirs(root) {
    try {
        return readdirSync(root, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
            .map((entry) => entry.name)
            .sort()
            .slice(0, 64)
            .map((name) => join(root, name));
    } catch {
        return [];
    }
}

/**
 * The most recently modified git repo under the usual roots, or null when
 * none exists. One level deep everywhere: repos live directly under these
 * roots, and a deeper walk could crawl a whole home directory.
 */
export function suggestProjectFolder(homeDir) {
    const candidates = [];
    for (const root of SEARCH_ROOTS) {
        const base = root === '' ? homeDir : join(homeDir, root);
        for (const dir of childDirs(base)) {
            if (isGitRepo(dir)) candidates.push({ path: dir, mtime: mtimeOf(dir) });
        }
    }
    candidates.sort((left, right) => right.mtime - left.mtime);
    return candidates[0]?.path ?? null;
}

/** The saved choice, or undefined when setup never asked. A broken file reads as never asked; the host itself refuses to start on it. */
export function readSavedFolder(muxrHome) {
    try {
        const parsed = JSON.parse(readFileSync(join(muxrHome, 'config.json'), 'utf8'));
        const folder = parsed?.defaultStartFolder;
        return typeof folder === 'string' && folder.trim() !== '' ? folder.trim() : undefined;
    } catch {
        return undefined;
    }
}

/** Persist the setup choice beside the host's other settings. Throws naming the problem; the caller says it in plain words. */
export function saveFolder(muxrHome, folder) {
    const trimmed = String(folder ?? '').trim();
    if (trimmed === '') throw new Error('Enter a folder, or ~ for your home folder.');
    if (trimmed !== '~' && !isAbsolute(trimmed)) throw new Error('Enter an absolute folder path, or ~ for your home folder.');
    if (trimmed !== '~') {
        let stats;
        try {
            stats = statSync(trimmed);
        } catch {
            throw new Error(`Cannot reach this folder: ${trimmed}`);
        }
        if (!stats.isDirectory()) throw new Error(`This is not a folder: ${trimmed}`);
    }
    const path = join(muxrHome, 'config.json');
    let parsed = {};
    if (existsSync(path)) {
        try {
            parsed = JSON.parse(readFileSync(path, 'utf8'));
        } catch {
            throw new Error('The settings file is broken; fix or remove it first.');
        }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            throw new Error('The settings file is broken; fix or remove it first.');
        }
    }
    atomicWrite(path, `${JSON.stringify({ ...parsed, defaultStartFolder: trimmed }, null, 2)}\n`);
    return trimmed;
}
