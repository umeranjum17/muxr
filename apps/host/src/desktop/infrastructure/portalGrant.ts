import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Host-local credential, never part of a device response or diagnostics. */
export class PortalGrant {
    private readonly directory: string;
    private readonly path: string;

    constructor(stateRoot: string) {
        this.directory = join(stateRoot, 'desktop');
        this.path = join(this.directory, 'portal-restore-token');
    }

    private prepare(): void {
        mkdirSync(this.directory, { recursive: true, mode: 0o700 });
        const directory = lstatSync(this.directory);
        if (!directory.isDirectory() || directory.uid !== process.getuid?.()) {
            throw new Error('Desktop grant directory is not privately owned.');
        }
        chmodSync(this.directory, 0o700);
    }

    /** Claim before sending: a failed/crashed open must never replay a used token. */
    take(): string | undefined {
        this.prepare();
        const claimed = `${this.path}.${randomUUID()}.used`;
        try {
            renameSync(this.path, claimed);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
            throw error;
        }
        try {
            const fd = openSync(claimed, constants.O_RDONLY | constants.O_NOFOLLOW);
            try {
                const file = fstatSync(fd);
                if (!file.isFile() || file.uid !== process.getuid?.() || (file.mode & 0o077) !== 0) {
                    throw new Error('Desktop grant is not a private regular file.');
                }
                return readFileSync(fd, 'utf8') || undefined;
            } finally {
                closeSync(fd);
            }
        } finally {
            unlinkSync(claimed);
        }
    }

    /** Replace the previous credential atomically; temporary files are private too. */
    replace(token: string): void {
        this.prepare();
        const temporary = `${this.path}.${randomUUID()}.tmp`;
        const fd = openSync(temporary, 'wx', 0o600);
        try {
            writeFileSync(fd, token);
            renameSync(temporary, this.path);
        } finally {
            closeSync(fd);
            try { unlinkSync(temporary); } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            }
        }
    }
}
