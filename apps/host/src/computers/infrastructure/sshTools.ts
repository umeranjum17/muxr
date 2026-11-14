/**
 * muxr's own ssh material on the main computer: one key for computer links, the pinned host keys,
 * and the `Host` entries Herdr Core reads. All of it lives under `<muxr home>/ssh`; the one
 * line added outside it is an `Include` in the person's ssh config.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ComputerJoinError, words } from '../domain/computerWords.js';
import { hostEntry, knownHostsKey, sshAlias, type SshTarget } from '../domain/sshEntries.js';
import { run } from './run.js';

export interface SshPaths {
    dir: string;
    key: string;
    config: string;
    knownHosts: string;
    /** The ssh config the person (and Herdr Core's ssh) reads; gets one `Include` line. */
    userConfig: string;
}

export function sshPaths(muxrHome: string, userConfig: string): SshPaths {
    const dir = join(muxrHome, 'ssh');
    return { dir, key: join(dir, 'muxr_ed25519'), config: join(dir, 'config'), knownHosts: join(dir, 'known_hosts'), userConfig };
}

/** The muxr key's public line, made on first use. The private half never leaves this computer. */
export async function ensureKey(paths: SshPaths): Promise<string> {
    mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
    if (!existsSync(paths.key)) {
        const made = await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'muxr-main', '-f', paths.key]);
        if (made.code !== 0) throw new Error(`could not make the muxr key: ${made.stderr.trim()}`);
    }
    return readFileSync(`${paths.key}.pub`, 'utf8').trim();
}

/** What ssh would do for `target` under the person's own config: the host, port and user behind a name. */
export async function resolveHost(paths: SshPaths, name: string): Promise<SshTarget | undefined> {
    const args = existsSync(paths.userConfig) ? ['-F', paths.userConfig, '-G', name] : ['-G', name];
    const out = await run('ssh', args);
    if (out.code !== 0) return undefined;
    const field = (key: string): string | undefined => new RegExp(`^${key} (.+)$`, 'm').exec(out.stdout)?.[1];
    const host = field('hostname');
    const user = field('user');
    if (host === undefined || user === undefined) return undefined;
    return { host, user, port: Number(field('port') ?? 22) };
}

/** The computer's own ed25519 host key and its fingerprint, read from the address, never from memory. */
export async function scanHostKey(target: SshTarget, name: string): Promise<{ line: string; fingerprint: string }> {
    const scan = await run('ssh-keyscan', ['-T', '8', '-p', String(target.port), '-t', 'ed25519', target.host], { timeoutMs: 20_000 });
    const line = scan.stdout.split('\n').find((candidate) => candidate.includes('ssh-ed25519'));
    if (line === undefined) throw new ComputerJoinError('unreachable', words.unreachable(name, `${target.host}:${target.port}`));
    const fingerprint = await fingerprintOf(line);
    return { line, fingerprint };
}

async function fingerprintOf(knownHostsLine: string): Promise<string> {
    const out = await run('ssh-keygen', ['-lf', '-'], { input: `${knownHostsLine}\n` });
    const fingerprint = /(SHA256:\S+)/.exec(out.stdout)?.[1];
    if (fingerprint === undefined) throw new Error(`could not read a fingerprint: ${out.stderr.trim()}`);
    return fingerprint;
}

/** The fingerprint muxr pinned for this address, if any. */
export async function pinnedFingerprint(paths: SshPaths, target: SshTarget): Promise<string | undefined> {
    if (!existsSync(paths.knownHosts)) return undefined;
    const found = await run('ssh-keygen', ['-F', knownHostsKey(target), '-f', paths.knownHosts]);
    const line = found.stdout.split('\n').find((candidate) => candidate.includes('ssh-ed25519'));
    return line === undefined ? undefined : fingerprintOf(line);
}

/** Pin the host key the person confirmed, replacing an older pin for the same address. */
export async function pinHostKey(paths: SshPaths, target: SshTarget, scannedLine: string): Promise<void> {
    if (existsSync(paths.knownHosts)) await run('ssh-keygen', ['-R', knownHostsKey(target), '-f', paths.knownHosts]);
    appendFileSync(paths.knownHosts, `${scannedLine}\n`, { mode: 0o600 });
}

/** Write the computer's `Host` entry (replacing an older one) and make sure the user's config includes ours. */
export function writeHostEntry(paths: SshPaths, name: string, target: SshTarget): void {
    const marker = `Host ${sshAlias(name)}\n`;
    const current = existsSync(paths.config) ? readFileSync(paths.config, 'utf8') : '';
    const others = current.split(/\n(?=Host )/).filter((block) => block.trim() !== '' && !`${block}\n`.startsWith(marker));
    const entry = hostEntry(name, target, { key: paths.key, knownHosts: paths.knownHosts });
    writeFileSync(paths.config, [...others.map((block) => `${block.trimEnd()}\n`), entry].join('\n'), { mode: 0o600 });
    chmodSync(paths.config, 0o600);
    const include = `Include ${paths.config}`;
    const user = existsSync(paths.userConfig) ? readFileSync(paths.userConfig, 'utf8') : '';
    if (!user.split('\n').includes(include)) {
        mkdirSync(dirname(paths.userConfig), { recursive: true, mode: 0o700 });
        writeFileSync(paths.userConfig, `${include}\n${user}`, { mode: 0o600 });
    }
}

/** Does the muxr key log in without a prompt? Names the failure when it does not. */
export async function checkLogin(paths: SshPaths, name: string, target: SshTarget, publicKey: string, authorizedLine: (key: string) => string): Promise<void> {
    const attempt = await run('ssh', ['-F', paths.config, '-o', 'BatchMode=yes', sshAlias(name), 'true'], { timeoutMs: 30_000 });
    if (attempt.code === 0) return;
    if (/Permission denied/i.test(attempt.stderr)) throw new ComputerJoinError('needs-key', words.needsKey(name, authorizedLine(publicKey)));
    throw new ComputerJoinError('unreachable', words.unreachable(name, `${target.host}:${target.port}`));
}
