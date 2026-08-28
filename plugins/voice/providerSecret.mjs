import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

function homeRoot() {
    return process.env.MUXR_HOME?.trim() || join(homedir(), '.muxr');
}

/**
 * Owner-only provider secret on disk. The filename is the store identity;
 * display labels never authorize. Callers pass the missing/empty copy the
 * settings UI already shows for that provider.
 */
export function providerSecret(fileName, copy) {
    const root = homeRoot();
    const keyFile = join(root, fileName);

    function assertKeyRoot(info) {
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(copy.notDirectory);
    }

    async function readKey() {
        let directory;
        let info;
        try {
            directory = await lstat(root);
            info = await lstat(keyFile);
        } catch (cause) {
            if (cause?.code === 'ENOENT') throw new Error(copy.missing);
            throw cause;
        }
        assertKeyRoot(directory);
        if ((directory.mode & 0o077) !== 0 || !info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
            throw new Error(copy.ownerOnly);
        }
        const value = (await readFile(keyFile, 'utf8')).trim();
        if (!value) throw new Error(copy.missing);
        return value;
    }

    async function writeKey(value) {
        const key = String(value ?? '').trim();
        if (!key) throw new Error(copy.empty);
        await mkdir(root, { recursive: true, mode: 0o700 });
        assertKeyRoot(await lstat(root));
        await chmod(root, 0o700);
        const temporary = `${keyFile}.tmp-${process.pid}-${randomUUID()}`;
        try {
            await writeFile(temporary, `${key}\n`, { mode: 0o600, flag: 'wx' });
            await rename(temporary, keyFile);
        } finally {
            await rm(temporary, { force: true });
        }
    }

    async function clearKey() {
        try {
            assertKeyRoot(await lstat(root));
            const info = await lstat(keyFile);
            if (!info.isFile() || info.isSymbolicLink()) throw new Error(copy.notRegular);
            await rm(keyFile);
        } catch (cause) {
            if (cause?.code !== 'ENOENT') throw cause;
        }
    }

    async function statusPayload() {
        return readKey().then(
            () => ({ configured: true, statusLabel: 'Key set' }),
            () => ({ configured: false, statusLabel: 'No key set' }),
        );
    }

    return { readKey, writeKey, clearKey, statusPayload };
}
