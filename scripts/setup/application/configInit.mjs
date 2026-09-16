import { existsSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { heading, intro, note, outro, prompt, select } from '../presentation/ui.mjs';
import { atomicWrite, error, print, stateDir } from '../infrastructure/runtime.mjs';

/**
 * `muxr config init|check`: the interactive onboarding flow and validator for
 * the agent-editable `$MUXR_HOME/config.json` host settings file. Plain JSON
 * only, no new dependencies. The host itself (`apps/host/src/config.ts`) is
 * the runtime authority for this shape; the checks below mirror it so a hand
 * edit can be validated without starting the host.
 */

export const configFilePath = () => join(stateDir(), 'config.json');

const KNOWN_KEYS = ['mode', 'relayUrl', 'machineId', 'machineName', 'dataDir', 'hostHttpPort'];
const DEFAULT_HOST_HTTP_PORT = 8793;

function configError(path, key, reason) {
    return `${path}: key "${key}": ${reason}`;
}

function validRelayUrl(value) {
    try {
        const url = new URL(value);
        return url.protocol === 'ws:' || url.protocol === 'wss:';
    } catch {
        return false;
    }
}

/** Same shape the host enforces: unknown keys and bad values fail loudly. */
export function validateMuxrConfig(path, text) {
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch (cause) {
        return { ok: false, error: `${path}: key "(file)": contains malformed JSON (${cause.message})` };
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return { ok: false, error: configError(path, '(file)', 'must be a JSON object') };
    }
    for (const key of Object.keys(parsed)) {
        if (!KNOWN_KEYS.includes(key)) return { ok: false, error: configError(path, key, 'unknown setting') };
    }
    if (parsed.mode !== undefined && !['hosted', 'selfhost', 'local'].includes(parsed.mode)) {
        return { ok: false, error: configError(path, 'mode', 'must be "hosted", "selfhost", or "local"') };
    }
    if (parsed.relayUrl !== undefined && (typeof parsed.relayUrl !== 'string' || !validRelayUrl(parsed.relayUrl.trim()))) {
        return { ok: false, error: configError(path, 'relayUrl', 'must be a ws:// or wss:// URL') };
    }
    for (const key of ['machineId', 'machineName']) {
        if (parsed[key] !== undefined && (typeof parsed[key] !== 'string' || parsed[key].trim() === '')) {
            return { ok: false, error: configError(path, key, 'must be a non-empty string') };
        }
    }
    if (parsed.dataDir !== undefined && (typeof parsed.dataDir !== 'string' || !isAbsolute(parsed.dataDir.trim()))) {
        return { ok: false, error: configError(path, 'dataDir', 'must be a non-empty absolute path') };
    }
    if (parsed.hostHttpPort !== undefined
        && (!Number.isInteger(parsed.hostHttpPort) || parsed.hostHttpPort < 1 || parsed.hostHttpPort > 65535)) {
        return { ok: false, error: configError(path, 'hostHttpPort', 'must be an integer from 1 to 65535') };
    }
    return { ok: true, config: parsed };
}

export function defaultRelayForMode(mode) {
    return mode === 'local' ? 'ws://127.0.0.1:8792' : '';
}

const interactive = () => Boolean(process.stdin.isTTY && process.stdout.isTTY);

function previewConfig() {
    return { mode: 'selfhost', relayUrl: defaultRelayForMode('local'), machineName: hostname() };
}

export async function runConfigCheck() {
    const path = configFilePath();
    if (!existsSync(path)) {
        print(`No config file at ${path}; the host runs on today's defaults.`);
        print('Run `muxr config init` for the interactive setup, or copy muxr.config.example.json.');
        return 0;
    }
    const result = validateMuxrConfig(path, readFileSync(path, 'utf8'));
    if (!result.ok) {
        error(`muxr: ${result.error}`);
        return 1;
    }
    print(`${path} is valid.`);
    for (const key of KNOWN_KEYS) {
        if (result.config[key] !== undefined) print(`  ${key}: ${JSON.stringify(result.config[key])}`);
    }
    return 0;
}

export async function runConfigInit(args = []) {
    const path = configFilePath();
    const dryRun = args.includes('--dry-run');
    const force = args.includes('--yes');
    if (!interactive() && !dryRun) {
        // Non-interactive-safe: never prompt, never hang, never write.
        print('muxr config init needs a terminal; nothing was written.');
        print(`It would write ${path} with:`);
        print(JSON.stringify(previewConfig(), null, 2));
        print('Rerun in a terminal to answer, or pass --dry-run to preview without writing.');
        return 0;
    }
    intro();
    heading('Host settings');
    note([
        'Three questions. The answers land in a plain JSON file an agent can edit by hand:',
        path,
        'Precedence per setting: explicit flag beats environment beats this file beats default.',
        'Pairing credentials stay in the owner-only auth files; this file holds no secrets.',
    ]);
    const machineName = await prompt('Machine name', hostname());
    if (machineName === undefined) {
        outro('Cancelled. Nothing changed.');
        return 0;
    }
    const mode = await select('How does this computer run muxr?', [
        { value: 'selfhost', title: 'Self-host', description: 'this computer runs its own relay; pair your phone to it' },
        { value: 'hosted', title: 'Hosted', description: 'pair through the hosted relay after setup' },
        { value: 'local', title: 'Local only', description: 'development on this machine; no phone pairing' },
    ], 0);
    // select() resolves a symbol (BACK) on escape and undefined on ctrl-c.
    if (typeof mode !== 'string') {
        outro('Cancelled. Nothing changed.');
        return 0;
    }
    const relayDefault = mode === 'local' ? defaultRelayForMode(mode) : '';
    const relayPrompt = relayDefault === '' ? 'Relay URL (empty means decide during setup)' : 'Relay URL';
    let relayUrl = '';
    let invalidRelayAttempts = 0;
    for (;;) {
        const relayAnswer = await prompt(relayPrompt, relayDefault);
        if (relayAnswer === undefined) {
            outro('Cancelled. Nothing changed.');
            return 0;
        }
        if (relayAnswer.trim() === '') break;
        if (validRelayUrl(relayAnswer.trim())) {
            relayUrl = relayAnswer.trim();
            break;
        }
        invalidRelayAttempts += 1;
        if (invalidRelayAttempts >= 3) {
            print('Leaving relayUrl unset after 3 invalid entries; set it later in the file if needed.');
            break;
        }
        print('Relay URL must be a ws:// or wss:// URL, or empty to decide during setup.');
    }
    let hostHttpPort = DEFAULT_HOST_HTTP_PORT;
    for (;;) {
        const portAnswer = await prompt('Host HTTP port', String(DEFAULT_HOST_HTTP_PORT));
        if (portAnswer === undefined) {
            outro('Cancelled. Nothing changed.');
            return 0;
        }
        const port = Number(portAnswer);
        if (portAnswer.trim() === '') break;
        if (Number.isInteger(port) && port >= 1 && port <= 65535) {
            hostHttpPort = port;
            break;
        }
        print('Enter an integer from 1 to 65535, or empty for the default.');
    }
    const config = { mode, machineName };
    if (relayUrl !== '') config.relayUrl = relayUrl;
    if (hostHttpPort !== DEFAULT_HOST_HTTP_PORT) config.hostHttpPort = hostHttpPort;
    const text = `${JSON.stringify(config, null, 2)}\n`;
    const exists = existsSync(path);
    heading(dryRun ? 'Dry run — nothing will be written' : 'Review host settings');
    note([`File: ${path}`, ...text.trim().split('\n')]);
    if (dryRun) {
        outro('Dry run complete. Nothing changed.');
        return 0;
    }
    if (!force) {
        const apply = await select(exists ? 'config.json already exists. Overwrite it?' : 'Write this file?', [
            { value: false, title: 'Cancel', description: 'leave everything unchanged' },
            { value: true, title: exists ? 'Overwrite' : 'Write file', description: exists ? 'replace the existing config.json' : `create ${path}` },
        ], 1);
        if (apply !== true) {
            outro('Cancelled. Nothing changed.');
            return 0;
        }
    }
    atomicWrite(path, text, 0o600);
    if (relayUrl === '') {
        outro(`Wrote ${path} with relayUrl unset. Edit it by hand anytime, then validate with \`muxr config check\`.`);
    } else {
        outro(`Wrote ${path}. Edit it by hand anytime, then validate with \`muxr config check\`.`);
    }
    return 0;
}

export async function runMuxrConfig(args = []) {
    const [subcommand = 'init', ...rest] = args;
    if (subcommand === 'init') return runConfigInit(rest);
    if (subcommand === 'check') return runConfigCheck();
    if (subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
        print('muxr config init [--dry-run] [--yes]\nmuxr config check');
        return 0;
    }
    error(`muxr config ${subcommand}\n\nUnknown config command. Use \`muxr config init\` or \`muxr config check\`.`);
    return 1;
}
