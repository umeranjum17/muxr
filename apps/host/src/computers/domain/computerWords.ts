/**
 * What a computer's state and failures say, in the words a person reads. Pure: the join and the
 * list pick a kind, this file owns the sentence, so no screen or command invents its own.
 */

/** The Herdr Core release the host pins; a joined computer behind it (same generation) is updated. */
export const CORE_PIN = { version: '0.1.19', generation: 1 } as const;

export type JoinFailureKind = 'needs-key' | 'unknown-host-key' | 'host-key-changed' | 'unreachable' | 'mac-bundle' | 'refused' | 'failed';

export class ComputerJoinError extends Error {
    constructor(readonly kind: JoinFailureKind, message: string) {
        super(message);
        this.name = 'ComputerJoinError';
    }
}

/** The state a person sees for a computer, from the word Herdr Core reports. */
const STATE_WORDS: Record<string, string> = {
    connected: 'ready',
    connecting: 'joining',
    needs_login: 'needs a key',
    refused: 'refused: update muxr',
};

export function stateWord(coreState: string): string {
    return STATE_WORDS[coreState] ?? 'offline';
}

export const words = {
    needsKey: (name: string, line: string): string =>
        `${name} did not accept muxr's key. Run this once on ${name}, then add it again:\n  echo '${line}' >> ~/.ssh/authorized_keys`,
    unknownHostKey: (name: string, fingerprint: string): string =>
        `muxr has not seen ${name} before. Its host key fingerprint is ${fingerprint}. If that is the one ${name} shows, add it again with --fingerprint ${fingerprint}.`,
    hostKeyChanged: (name: string, trusted: string, shown: string): string =>
        `The host key of ${name} changed. muxr trusted ${trusted}; ${name} now shows ${shown}. If you rebuilt ${name}, add it again with --fingerprint ${shown}.`,
    unreachable: (name: string, address: string): string =>
        `${name} is not answering on ${address}. Check that it is on, that its ssh server runs and that no firewall blocks that port.`,
    macBundle: 'Update Herdr Core on the Mac',
    newerGeneration: 'refused: update muxr',
    logout: (name: string, user: string): string =>
        `Agents on ${name} stop when you log out. Run this once on ${name}: sudo loginctl enable-linger ${user}`,
};

/** Herdr Core's own refusal for a Mac that runs the Herdr app bundle; muxr answers in its words. */
export function classifyCoreError(name: string, message: string): ComputerJoinError {
    if (/bundled remote core needs a complete bundle/i.test(message)) return new ComputerJoinError('mac-bundle', words.macBundle);
    if (/generation/i.test(message)) return new ComputerJoinError('refused', words.newerGeneration);
    return new ComputerJoinError('failed', `Herdr Core could not join ${name}: ${message}`);
}

const versionParts = (version: string): number[] => version.split('.').map((part) => Number.parseInt(part, 10) || 0);

/** True when `version` is an older release than `pin` (plain dotted numbers, as Herdr Core ships them). */
export function isOlderThanPin(version: string, pin: string = CORE_PIN.version): boolean {
    const have = versionParts(version);
    const want = versionParts(pin);
    for (let index = 0; index < Math.max(have.length, want.length); index += 1) {
        const difference = (have[index] ?? 0) - (want[index] ?? 0);
        if (difference !== 0) return difference < 0;
    }
    return false;
}
