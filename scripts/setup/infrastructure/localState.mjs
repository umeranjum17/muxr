import { accessSync, chmodSync, constants, existsSync, lstatSync, readFileSync, rmSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { ensurePrivateDir, processGone, stateDir } from './runtime.mjs';
import { selfhostPath } from './selfhost.mjs';

function permitted(path, mode) {
    try { accessSync(path, mode); return true; } catch { return false; }
}

function ownerPid(path, parse) {
    try { return parse(readFileSync(path, 'utf8')); } catch { return undefined; }
}

export function stateFolderCheck(add) {
    const folder = stateDir();
    if (!existsSync(folder)) {
        add('warn', 'state folder', `${folder} is missing — run \`muxr triage --fix\` to create it`,
            { safe: true, label: `created ${folder}`, run: () => ensurePrivateDir(folder) });
        return;
    }
    const info = statSync(folder);
    if (!info.isDirectory()) {
        add('fail', 'state folder', `${folder} is a file, not a folder — move it aside, then run \`muxr setup\``);
    } else if (permitted(folder, constants.W_OK | constants.X_OK)) {
        add('ok', 'state folder', `${folder} is writable`);
    } else if (info.uid === process.getuid?.()) {
        add('fail', 'state folder', `${folder} is not writable — run \`chmod u+rwx ${folder}\``);
    } else {
        add('fail', 'state folder', `${folder} belongs to another user — run \`sudo chown -R "$USER" ${folder}\``);
    }
}

/** A live, unreadable or ownerless lock is never cleared here: only a definitely exited owner is stale. */
export function staleFileChecks(add) {
    const files = [
        [join(stateDir(), 'selfhost-rotation.lock'), (text) => JSON.parse(text)?.pid],
        [join(stateDir(), 'relay', 'relay.pid'), (text) => Number(text.trim())],
    ].filter(([path]) => existsSync(path));
    let stale = 0;
    for (const [path, parse] of files) {
        const pid = ownerPid(path, parse);
        if (!Number.isSafeInteger(pid) || pid <= 1) {
            stale += 1;
            add('warn', 'stale files', `${basename(path)} names no process — remove ${path} only after confirming no muxr setup is running`);
        } else if (processGone(pid)) {
            stale += 1;
            add('warn', 'stale files', `${basename(path)} was left by process ${pid}, which has exited — run \`muxr triage --fix\` to clear it`, {
                safe: true,
                label: `cleared ${basename(path)}`,
                run: () => { if (processGone(pid)) rmSync(path, { force: true }); },
            });
        }
    }
    if (stale === 0) add('ok', 'stale files', 'no lock or pid file outlived its process');
}

/** The host refuses a state file that is not regular and owner-only. Returns true when it cannot be read at all. */
export function selfhostFileCheck(add) {
    const path = selfhostPath();
    let info;
    try { info = lstatSync(path); } catch { return false; }
    if (!info.isFile()) {
        add('fail', 'self-host state', `${path} is not a regular file, so the host refuses it — put the real file back in its place`);
        return false;
    }
    const readable = permitted(path, constants.R_OK);
    if (readable && (info.mode & 0o077) === 0) return false;
    add('fail', 'self-host state', `${path} ${readable ? 'is open to other users, so the host refuses it' : 'cannot be read'} — run \`muxr triage --fix\``,
        { safe: true, label: `set ${basename(path)} to owner-only`, run: () => chmodSync(path, 0o600) });
    return !readable;
}
