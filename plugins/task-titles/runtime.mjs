import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { firstUserPrompt, titleCandidate } from './title.mjs';

const exec = promisify(execFile);
const SOURCE = 'plugin:muxr.task-titles';
const WRITERS = /(?:renam|auto.?nam|task.?title)/i;
const DEFAULT_LABELS = new Set(['', 'Shell', 'Terminal', 'Agent', 'Claude', 'Codex', 'Pi']);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function herdr(args) {
    const { stdout } = await exec(process.env.HERDR_BIN_PATH || 'herdr', args, { timeout: 5000, maxBuffer: 512 * 1024 });
    return stdout.trim();
}

function json(output) {
    const parsed = JSON.parse(output);
    if (parsed.error) throw new Error(parsed.error.message ?? 'Herdr call failed');
    return parsed.result ?? parsed;
}

async function privateDirectory(dir) {
    if (!isAbsolute(dir) || !dir.endsWith('/muxr.task-titles')) throw new Error('Task titles config directory unavailable');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const details = await lstat(dir);
    if (!details.isDirectory() || details.isSymbolicLink() || details.uid !== process.getuid()) {
        throw new Error('Task titles config directory is not owner-controlled');
    }
    await chmod(dir, 0o700);
    return dir;
}

async function load(file, fallback) {
    try { return JSON.parse(await readFile(file, 'utf8')); }
    catch (error) { if (error?.code === 'ENOENT') return fallback; throw error; }
}

async function save(file, value) {
    const temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
        await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' });
        await rename(temporary, file);
    } finally { await rm(temporary, { force: true }); }
}

function key(value) { return createHash('sha256').update(value).digest('hex').slice(0, 24); }
function displayHash(value) { return createHash('sha256').update(value ?? '').digest('hex').slice(0, 16); }

async function snapshot(call, paneId) {
    const pane = json(await call(['pane', 'get', paneId])).pane;
    const agent = json(await call(['agent', 'get', paneId])).agent;
    if (!pane || !agent || pane.pane_id !== paneId || agent.pane_id !== paneId) return undefined;
    const ref = agent.agent_session;
    if (typeof ref?.value !== 'string' || !ref.value || typeof ref.agent !== 'string') return undefined;
    if (pane.agent_session?.value !== ref.value || pane.agent_session?.agent !== ref.agent) return undefined;
    return { pane, agent, generation: key(`${paneId}\0${ref.agent}\0${ref.value}`), ref };
}

function ownerMatches(before, after) {
    return after?.generation === before.generation && after.agent.agent_status === 'working'
        && after.agent.title === before.agent.title && after.pane.title === before.pane.title
        && after.pane.label === before.pane.label && after.agent.name === before.agent.name;
}

function initialOwner(snapshotValue) {
    const { pane, agent } = snapshotValue;
    const title = agent.title?.trim() ?? '';
    const paneTitle = pane.title?.trim() ?? '';
    const label = pane.label?.trim() ?? '';
    return !title && !paneTitle && DEFAULT_LABELS.has(label);
}

async function writers(call) {
    const list = json(await call(['plugin', 'list', '--json'])).plugins;
    if (!Array.isArray(list)) throw new Error('Herdr plugin list unavailable');
    return list.filter((plugin) => plugin?.enabled === true && plugin.plugin_id !== 'muxr.task-titles'
        && plugin.plugin_id !== 'animal-namer'
        && (WRITERS.test(`${plugin.plugin_id} ${plugin.name ?? ''}`)
            || (plugin.events ?? []).some((event) => event.on === 'pane.agent_status_changed' && WRITERS.test(plugin.description ?? ''))))
        .map((plugin) => ({ id: plugin.plugin_id, name: plugin.name ?? plugin.plugin_id, source: plugin.source?.kind ?? 'local' }));
}

async function findTranscript(ref) {
    const kind = ref.agent;
    if (kind === 'pi') return ref.value;
    if (!['claude', 'codex'].includes(kind) || !/^[a-zA-Z0-9-]{8,80}$/.test(ref.value)) return undefined;
    const root = kind === 'claude'
        ? (process.env.CLAUDE_CONFIG_DIR || join(process.env.HOME ?? '', '.claude', 'projects'))
        : (process.env.CODEX_HOME || join(process.env.HOME ?? '', '.codex', 'sessions'));
    const start = kind === 'claude' && !root.endsWith('/projects') ? join(root, 'projects') : root;
    const queue = [start];
    let visited = 0;
    while (queue.length && visited++ < 500) {
        const dir = queue.shift();
        let entries;
        try { entries = await readdir(dir, { withFileTypes: true }); } catch { continue; }
        for (const entry of entries) {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) queue.push(path);
            else if (entry.isFile() && entry.name.endsWith(`${ref.value}.jsonl`)) return path;
        }
    }
    return undefined;
}

async function promptFor(ref) {
    const path = await findTranscript(ref);
    if (!path) return undefined;
    const details = await stat(path).catch(() => undefined);
    if (!details?.isFile() || details.size > 2 * 1024 * 1024) return undefined;
    return firstUserPrompt(ref.agent, await readFile(path, 'utf8'));
}

async function outcome(dir, result) {
    await save(join(dir, 'outcome.json'), { ...result, at: new Date().toISOString() });
    return result;
}

async function withConfigLock(dir, action) {
    const lock = join(dir, 'configuration.lock');
    try { await mkdir(lock); } catch { throw new Error('Task titles configuration is busy'); }
    try { return await action(); }
    finally { await rm(lock, { recursive: true, force: true }); }
}

/** Herdr event hook: one serialized, fail-closed title attempt per bound agent generation. */
export async function handleStatus({ event, configDir, call = herdr, readPrompt = promptFor }) {
    if (event?.data?.agent_status !== 'working' || typeof event.data.pane_id !== 'string') return { status: 'ignored' };
    const dir = await privateDirectory(configDir);
    const config = await load(join(dir, 'settings.json'), { enabled: true });
    if (config.enabled !== true) return { status: 'disabled' };
    const paneId = event.data.pane_id;
    const lock = join(dir, `pane-${key(paneId)}.lock`);
    try { await mkdir(lock); } catch { return { status: 'busy' }; }
    try {
        const active = await writers(call);
        if (active.length) return await outcome(dir, { status: 'conflict', writers: active });
        let before;
        for (let attempt = 0; attempt < 6; attempt++) {
            before = await snapshot(call, paneId).catch(() => undefined);
            if (before) break;
            await wait(250);
        }
        if (!before) return await outcome(dir, { status: 'unavailable', reason: 'Agent session is not bound.' });
        const marker = join(dir, `generation-${before.generation}.json`);
        if (await load(marker, undefined)) return { status: 'already handled' };
        if (!initialOwner(before)) return await outcome(dir, { status: 'owned elsewhere', reason: 'An existing title or pane label is already in use.' });
        const attemptFile = join(dir, `attempts-${before.generation}.json`);
        const attempts = await load(attemptFile, { count: 0 });
        if (!Number.isInteger(attempts.count) || attempts.count < 0 || attempts.count >= 2) {
            return { status: 'needs title', reason: 'Automatic title attempts are complete for this task.' };
        }
        await save(attemptFile, { count: attempts.count + 1 });
        let prompt;
        for (let attempt = 0; attempt < 12; attempt++) {
            prompt = await readPrompt(before.ref).catch(() => undefined);
            if (prompt) break;
            await wait(250);
        }
        if (!prompt) return await outcome(dir, { status: 'needs title', reason: 'No first task prompt was available.' });
        const candidate = titleCandidate(prompt);
        if (!candidate.title) return await outcome(dir, { status: 'needs title', reason: candidate.reason });
        // The plugin registry, agent generation, title, and pane label are all
        // checked again under our lock immediately before the non-atomic write.
        if ((await writers(call)).length) return await outcome(dir, { status: 'conflict', reason: 'Another title writer became active.' });
        const current = await snapshot(call, paneId);
        if (!ownerMatches(before, current)) return await outcome(dir, { status: 'owned elsewhere', reason: 'Agent or title changed before publication.' });
        if ((await load(join(dir, 'settings.json'), { enabled: true })).enabled !== true) return { status: 'disabled' };
        // A durable claim precedes the non-atomic Herdr write. If the process
        // dies after Herdr accepts it, reconnect cannot publish a second time.
        await save(marker, { status: 'publishing', at: new Date().toISOString() });
        await call(['pane', 'report-metadata', paneId, '--source', SOURCE, '--title', candidate.title,
            '--token', `muxr_task_title_hash=${displayHash(candidate.title)}`,
            '--token', `muxr_task_label_hash=${displayHash(before.pane.label ?? '')}`,
            '--ttl-ms', '86400000']);
        await save(marker, { status: 'published', title: candidate.title, source: SOURCE, confidence: candidate.confidence, at: new Date().toISOString() });
        return await outcome(dir, { status: 'titled', title: candidate.title, confidence: candidate.confidence, source: candidate.source });
    } catch (error) {
        return await outcome(dir, { status: 'unavailable', reason: error instanceof Error ? error.message.slice(0, 120) : 'Herdr unavailable.' });
    } finally { await rm(lock, { recursive: true, force: true }); }
}

/** Authenticated host RPC methods. Preview cannot call Herdr or mutate disk. */
export async function rpc(method, input, configDir, call = herdr) {
    if (method === 'preview') {
        const sample = input?.sample;
        if (typeof sample !== 'string' || sample.length > 4096) throw new Error('sample must be at most 4096 characters');
        const candidate = titleCandidate(sample);
        return { before: 'Existing title', after: candidate.title ?? 'Existing title', ...candidate };
    }
    const dir = await privateDirectory(configDir);
    if (method === 'status') {
        const [settings, latest] = await Promise.all([
            load(join(dir, 'settings.json'), { enabled: true }), load(join(dir, 'outcome.json'), null),
        ]);
        let active;
        try { active = await writers(call); } catch { return { enabled: settings.enabled, status: 'offline', latest }; }
        const previous = await load(join(dir, 'switch.json'), null);
        return { enabled: settings.enabled, status: active.length ? 'conflict' : 'ready', writers: active, latest,
            canRevert: previous?.writerId ?? null,
            titleSource: 'First task prompt', update: 'Once per task', manualRename: 'Manual titles are never replaced.' };
    }
    if (method === 'configure') {
        if (typeof input?.enabled !== 'boolean' || Object.keys(input).some((key) => key !== 'enabled')) throw new Error('expected enabled boolean');
        return withConfigLock(dir, async () => {
            await save(join(dir, 'settings.json'), { enabled: input.enabled });
            return { enabled: input.enabled };
        });
    }
    if (method === 'switch') {
        if (input?.confirm !== true || typeof input.writerId !== 'string'
            || Object.keys(input).some((key) => !['confirm', 'writerId'].includes(key))) {
            throw new Error('explicit writer confirmation is required');
        }
        return withConfigLock(dir, async () => {
            const active = await writers(call);
            if (active.length !== 1 || active[0].id !== input.writerId) throw new Error('active title writer changed');
            if (await load(join(dir, 'switch.json'), null)) throw new Error('a previous writer switch is already recorded');
            const settings = await load(join(dir, 'settings.json'), { enabled: true });
            const previous = { writerId: active[0].id, name: active[0].name, source: active[0].source,
                writerEnabled: true, taskTitlesEnabled: settings.enabled === true };
            // Record recovery before changing the external writer's enabled bit.
            await save(join(dir, 'switch.json'), previous);
            await call(['plugin', 'disable', previous.writerId]);
            if ((await writers(call)).some((writer) => writer.id === previous.writerId)) throw new Error('former title writer remains enabled');
            await save(join(dir, 'settings.json'), { enabled: true });
            return { status: 'ready', formerWriter: previous.name, canRevert: true };
        });
    }
    if (method === 'revert') {
        if (input?.confirm !== true || Object.keys(input).some((key) => key !== 'confirm')) throw new Error('explicit revert confirmation is required');
        return withConfigLock(dir, async () => {
            const previous = await load(join(dir, 'switch.json'), null);
            if (!previous || typeof previous.writerId !== 'string') throw new Error('no former writer to restore');
            await save(join(dir, 'settings.json'), { enabled: false });
            await call(['plugin', 'enable', previous.writerId]);
            if (!(await writers(call)).some((writer) => writer.id === previous.writerId)) throw new Error('former title writer did not enable');
            await save(join(dir, 'settings.json'), { enabled: previous.taskTitlesEnabled });
            await rm(join(dir, 'switch.json'));
            return { status: 'conflict', restoredWriter: previous.name, enabled: previous.taskTitlesEnabled };
        });
    }
    throw new Error('unknown Task titles RPC');
}
