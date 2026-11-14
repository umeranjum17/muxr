/** The ssh files muxr writes for a joined computer, as text. Pure: the infrastructure writes them. */

export interface SshTarget {
    host: string;
    port: number;
    user: string;
}

/** The name Herdr Core uses to reach a computer; the `Host` entry carries the same name. */
export const sshAlias = (name: string): string => `muxr-${name}`;

export const knownHostsKey = (target: SshTarget): string => `[${target.host}]:${target.port}`;

export function hostEntry(name: string, target: SshTarget, paths: { key: string; knownHosts: string }): string {
    return [
        `Host ${sshAlias(name)}`,
        `  HostName ${target.host}`,
        `  Port ${target.port}`,
        `  User ${target.user}`,
        `  IdentityFile ${paths.key}`,
        '  IdentitiesOnly yes',
        `  UserKnownHostsFile ${paths.knownHosts}`,
        '  StrictHostKeyChecking yes',
        '  BatchMode yes',
        '  ConnectTimeout 8',
        '',
    ].join('\n');
}

/**
 * The one line a person adds to a computer's authorized_keys. `restrict` cuts forwarding and the
 * rest (Herdr Core still joins: it runs a command, never a forward); `from=` only when the
 * address muxr connects from is known, because a wrong one locks the key out.
 */
export function authorizedKeysLine(publicKey: string, from?: string): string {
    const options = from === undefined ? 'restrict' : `restrict,from="${from}"`;
    return `${options} ${publicKey.trim()}`;
}

/** `user@host`, `user@host:port` or a bare host; the user and port default to the caller's. */
export function parseTarget(text: string, defaults: { user: string }): SshTarget | undefined {
    const match = /^(?:([^@\s]+)@)?([^@\s:]+)(?::(\d{1,5}))?$/.exec(text);
    if (match === null) return undefined;
    return { user: match[1] ?? defaults.user, host: match[2]!, port: match[3] === undefined ? 22 : Number(match[3]) };
}

/** The concrete `Host` names of an ssh config: no wildcards, none muxr wrote itself. */
export function knownSshHosts(config: string): string[] {
    const names = new Set<string>();
    for (const line of config.split('\n')) {
        const match = /^\s*Host\s+(.+)$/i.exec(line);
        if (match === null) continue;
        for (const name of match[1]!.trim().split(/\s+/)) {
            if (!/[*?!]/.test(name) && !name.startsWith('muxr-')) names.add(name);
        }
    }
    return [...names];
}
