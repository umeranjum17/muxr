/**
 * Join a computer to this host: trust its host key by fingerprint, give it muxr's key, let Herdr
 * Core add it, and bring an older Core up to the pin. Each refusal is a named failure with the
 * words to act on; nothing is trusted on first sight.
 */
import { CORE_PIN, ComputerJoinError, isOlderThanPin, stateWord, words } from '../domain/computerWords.js';
import { authorizedKeysLine, parseTarget, sshAlias, type SshTarget } from '../domain/sshEntries.js';
import type { CoreMachine, HcMachines } from '../infrastructure/hcMachines.js';
import { checkLogin, ensureKey, pinHostKey, pinnedFingerprint, resolveHost, scanHostKey, writeHostEntry, type SshPaths } from '../infrastructure/sshTools.js';

export interface JoinRequest {
    /** An ssh config name, `user@host` or `user@host:port`. */
    target: string;
    /** What the computer is called here; defaults to the target's host name. */
    name?: string | undefined;
    /** The fingerprint the person confirmed (or read off a join code). Without it a new host key stops the join. */
    fingerprint?: string | undefined;
}

export interface JoinResult {
    name: string;
    /** `user@address`, the line the person confirmed. */
    address: string;
    fingerprint: string;
    version: string;
    state: string;
    /** Set when the Core was older than the pin and muxr updated it. */
    updatedFrom?: string;
    /** Set when Herdr Core says agents on that computer stop at logout. */
    warning?: string;
}

export interface JoinDeps {
    paths: SshPaths;
    hc: HcMachines;
    /** The address muxr connects from, when known: the key is then limited to it. */
    keyFrom?: string | undefined;
}

export const addressOf = (target: SshTarget): string => `${target.user}@${target.host}${target.port === 22 ? '' : `:${target.port}`}`;

async function resolveTarget(deps: JoinDeps, request: JoinRequest): Promise<{ name: string; target: SshTarget }> {
    const direct = request.target.includes('@') ? parseTarget(request.target, { user: 'root' }) : undefined;
    const target = direct ?? await resolveHost(deps.paths, request.target);
    if (target === undefined) throw new ComputerJoinError('unreachable', `muxr cannot tell where ${request.target} is. Use user@address or a name from your ssh config.`);
    return { name: request.name ?? (direct === undefined ? request.target : target.host), target };
}

/** The host key's fingerprint must be one the person confirmed; returns the line to pin when it is new. */
async function confirmHostKey(deps: JoinDeps, name: string, target: SshTarget, confirmed: string | undefined): Promise<{ fingerprint: string; pin?: string }> {
    const scanned = await scanHostKey(target, name);
    const trusted = await pinnedFingerprint(deps.paths, target);
    if (trusted === scanned.fingerprint) return { fingerprint: trusted };
    if (confirmed === scanned.fingerprint) return { fingerprint: confirmed, pin: scanned.line };
    if (trusted === undefined) throw new ComputerJoinError('unknown-host-key', words.unknownHostKey(name, scanned.fingerprint));
    throw new ComputerJoinError('host-key-changed', words.hostKeyChanged(name, trusted, scanned.fingerprint));
}

/** Wait for the link to come up (and, after an update, for the new version) so the result is the end state. */
async function settle(hc: HcMachines, name: string, atLeast: string | undefined, limitMs = 30_000): Promise<CoreMachine> {
    const deadline = Date.now() + limitMs;
    for (;;) {
        const machine = (await hc.list()).find((candidate) => candidate.name === name);
        if (machine === undefined) throw new ComputerJoinError('failed', `Herdr Core lost ${name} right after joining it.`);
        const current = atLeast === undefined || !isOlderThanPin(machine.version, atLeast);
        if ((stateWord(machine.state) === 'ready' && current) || Date.now() > deadline) return machine;
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
}

export async function joinComputer(deps: JoinDeps, request: JoinRequest): Promise<JoinResult> {
    const { name, target } = await resolveTarget(deps, request);
    const publicKey = await ensureKey(deps.paths);
    const host = await confirmHostKey(deps, name, target, request.fingerprint);
    if (host.pin !== undefined) await pinHostKey(deps.paths, target, host.pin);
    writeHostEntry(deps.paths, name, target);
    await checkLogin(deps.paths, name, target, publicKey, (key) => authorizedKeysLine(key, deps.keyFrom));

    let machine = await deps.hc.add(name, sshAlias(name));
    const result: JoinResult = { name, address: addressOf(target), fingerprint: host.fingerprint, version: machine.version, state: '' };
    // Herdr Core's join keeps an older Core as it found it; bringing it to the pin is muxr's step.
    if (isOlderThanPin(machine.version, CORE_PIN.version)) {
        await deps.hc.update(name);
        result.updatedFrom = result.version;
    }
    machine = await settle(deps.hc, name, result.updatedFrom === undefined ? undefined : CORE_PIN.version);
    result.version = machine.version;
    result.state = stateWord(machine.state);
    if (machine.keepsRunningAfterLogout === false) result.warning = words.logout(name, target.user);
    return result;
}

export type { CoreMachine };
