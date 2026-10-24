import { execFile } from 'node:child_process';

const fields = new Set(['tab', 'workspace', 'pane', 'provider', 'model']);
const USAGE = 'usage: muxr name [--tab LABEL] [--pane TITLE] [--provider PROVIDER] [--model MODEL]';
const MAX_NAME_LENGTH = 512;
const MAX_ERROR_LENGTH = 512;
const HERDR_TIMEOUT_MS = 10_000;
const HERDR_TARGET = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

function valueFor(args, index, flag) {
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
    return value;
}

/** A bounded display value. It is never trimmed or otherwise mutated. */
function isName(value) {
    return value.length > 0 && value.length <= MAX_NAME_LENGTH && !/[\0-\x1F\x7F]/.test(value);
}

function boundedError(value) {
    const text = String(value ?? '').replace(/[\0-\x1F\x7F]/g, ' ').trim();
    return text.slice(0, MAX_ERROR_LENGTH) || 'Herdr rejected the operation';
}

function parseHerdr(stdout, stderr, error) {
    const text = String(stdout ?? '').trim();
    if (text === '') {
        return error === null ? { ok: true, data: undefined } : { ok: false, error: boundedError(stderr || error.message) };
    }
    let payload;
    try {
        payload = JSON.parse(text);
    } catch {
        return { ok: false, error: error === null ? 'Herdr returned an invalid response' : boundedError(stderr || error.message) };
    }
    if (payload?.error !== undefined && payload.error !== null) {
        const detail = payload.error;
        return {
            ok: false,
            error: boundedError(typeof detail === 'string' ? detail : `${detail.code ?? 'herdr_error'}: ${detail.message ?? 'Herdr rejected the operation'}`),
        };
    }
    if (error !== null) return { ok: false, error: boundedError(stderr || error.message) };
    return { ok: true, data: payload?.result };
}

/**
 * One Herdr CLI call. Inside a pane Herdr exports the socket of the session
 * the agent runs in, so the CLI reaches that session without a flag.
 */
function herdr(...command) {
    const bin = process.env.HERDR_BIN_PATH?.trim() || process.env.HERDR_BIN?.trim() || 'herdr';
    return new Promise((resolve) => {
        execFile(bin, command, { timeout: HERDR_TIMEOUT_MS, maxBuffer: 1_048_576 },
            (error, stdout, stderr) => resolve(parseHerdr(stdout, stderr, error)));
    });
}

/**
 * The agent names its own tab and pane. It knows what it is working on;
 * nothing should guess that from the command line. This calls the Herdr CLI
 * directly, so it works whenever Herdr does, with or without a muxr host.
 *
 * It never renames a workspace: a workspace holds whoever else its owner puts
 * there later, so a lane that found it empty and named it after its own task
 * left the lead's whole workspace named after one worker (`boat-live-cli`).
 * `--workspace` is kept as the old spelling of `--tab`.
 */
export async function nameAgent(args) {
    const body = {};
    for (let index = 0; index < args.length; index += 1) {
        const flag = args[index];
        if (!flag.startsWith('--') || !fields.has(flag.slice(2))) throw new Error(USAGE);
        const field = flag.slice(2) === 'workspace' ? 'tab' : flag.slice(2);
        if (body[field] !== undefined) throw new Error(USAGE);
        body[field] = valueFor(args, index, flag);
        index += 1;
    }
    const paneId = process.env.HERDR_PANE_ID?.trim();
    if (paneId === undefined || paneId === '') throw new Error('muxr name must run inside a Herdr pane (HERDR_PANE_ID is missing)');
    if (!HERDR_TARGET.test(paneId)) throw new Error('HERDR_PANE_ID is not a supported Herdr pane target');
    if (Object.keys(body).length === 0) throw new Error('muxr name needs at least one name or metadata value');
    for (const [field, value] of Object.entries(body)) {
        if (!isName(value)) throw new Error(`${field} must be at most ${MAX_NAME_LENGTH} characters without control characters`);
    }
    // ponytail: Herdr's positional rename parser has no safe `--` escape;
    // reject only leading-dash labels rather than letting a name become a flag.
    if (body.pane?.startsWith('-') || body.tab?.startsWith('-')) throw new Error('pane and tab names must not start with "-"');

    // Resolve membership from Herdr before the first mutation. The pane id is
    // not allowed to imply a tab by string convention.
    const current = await herdr('pane', 'get', paneId);
    if (!current.ok) throw new Error(`this pane is not available in Herdr: ${current.error}`);
    const tabId = current.data?.pane?.tab_id;
    if (typeof tabId !== 'string' || !HERDR_TARGET.test(tabId)) throw new Error('this pane is not available in Herdr');

    const results = {};
    const errors = {};
    const apply = async (key, ...command) => {
        const result = await herdr(...command);
        results[key] = result.ok;
        if (!result.ok) errors[key] = result.error;
    };
    if (body.pane !== undefined) await apply('pane', 'pane', 'rename', paneId, body.pane);
    if (body.tab !== undefined) {
        // A tab that holds other panes is shared, so it keeps its name.
        const tab = await herdr('tab', 'get', tabId);
        if (!tab.ok) {
            results.tab = false;
            errors.tab = tab.error;
        } else if ((tab.data?.tab?.pane_count ?? 1) > 1) {
            results.tab = 'kept: shared with other panes';
        } else {
            await apply('tab', 'tab', 'rename', tabId, body.tab);
        }
    }
    if (body.provider !== undefined || body.model !== undefined) {
        const tokenArgs = [];
        if (body.provider !== undefined) tokenArgs.push('--token', `provider=${body.provider}`);
        if (body.model !== undefined) tokenArgs.push('--token', `model=${body.model}`);
        await apply('metadata', 'pane', 'report-metadata', paneId, '--source', 'muxr.naming', ...tokenArgs);
    }

    const failed = Object.keys(results).filter((key) => results[key] === false);
    const status = failed.length === 0 ? 'ok' : failed.length === Object.keys(results).length ? 'failed' : 'partial';
    if (status !== 'ok') {
        throw new Error(`${status} — ${failed.map((key) => `${key}: ${errors[key]}`).join('; ')}`);
    }
    process.stdout.write(`${JSON.stringify({ ok: true, status, results })}\n`);
    return 0;
}
