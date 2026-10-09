/**
 * The mechanics every private X display here shares: finding Xvfb, one
 * Xauthority cookie entry, a free display number and its socket, and the
 * cleanup a killed server leaves behind.
 *
 * The owner is Computer's virtual display for a machine with no screen
 * (`virtualDisplay.ts`).
 */
import { accessSync, constants, existsSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** A program on this host's PATH, by absolute path. */
export function onPath(name: string, env: NodeJS.ProcessEnv): string | undefined {
    for (const directory of (env.PATH ?? '').split(':')) {
        if (directory === '') continue;
        const candidate = join(directory, name);
        try {
            accessSync(candidate, constants.X_OK);
            return candidate;
        } catch {
            // Not here.
        }
    }
    return undefined;
}

/** One MIT-MAGIC-COOKIE-1 entry for any host, in the Xauthority file format. */
export function authorityEntry(number: number, cookie: Buffer): Buffer {
    const field = (value: Buffer) => {
        const length = Buffer.alloc(2);
        length.writeUInt16BE(value.length);
        return Buffer.concat([length, value]);
    };
    const family = Buffer.alloc(2);
    family.writeUInt16BE(0xffff);
    return Buffer.concat([family, field(Buffer.alloc(0)), field(Buffer.from(String(number))), field(Buffer.from('MIT-MAGIC-COOKIE-1')), field(cookie)]);
}

export function displaySocket(socketDirectory: string, number: number): string {
    return join(socketDirectory, `X${number}`);
}

/** The lock file Xvfb holds while a display number is starting or running. */
export function displayLock(number: number): string {
    return `/tmp/.X${number}-lock`;
}

/** A number another display still answers for, or one that is starting right now. */
export function displayNumberTaken(socketDirectory: string, number: number): boolean {
    return existsSync(displaySocket(socketDirectory, number)) || existsSync(displayLock(number));
}

/** The first number at or above `from` that is free and not already reserved by the caller. */
export function firstFreeDisplayNumber(
    socketDirectory: string,
    from: number,
    reserved: ReadonlySet<number> = new Set(),
): number {
    let number = from;
    while (reserved.has(number) || displayNumberTaken(socketDirectory, number)) number += 1;
    return number;
}

export function isDisplaySocket(path: string): boolean {
    try {
        return statSync(path).isSocket();
    } catch {
        return false;
    }
}

/** Wait for a started server to answer, or fail when it never does. */
export async function waitForDisplaySocket(
    socketDirectory: string,
    number: number,
    timeoutMs: number,
    alive: () => boolean,
): Promise<void> {
    const socket = displaySocket(socketDirectory, number);
    const deadline = Date.now() + timeoutMs;
    while (!isDisplaySocket(socket)) {
        if (!alive() || Date.now() > deadline) throw new Error('the virtual screen did not start');
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
}

/**
 * A server killed outright leaves its socket and lock behind, and the next
 * start must not mistake them for a live display.
 */
export function removeDisplayFiles(socketDirectory: string, number: number): void {
    rmSync(displaySocket(socketDirectory, number), { force: true });
    rmSync(displayLock(number), { force: true });
}
