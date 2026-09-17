/**
 * Wait until the relay a check spawned is actually listening, and return the
 * port it bound.
 *
 * Polling a port number proves nothing about the child you started. A relay
 * left over from another worktree, another lane, or a previous run answers
 * `GET /health` exactly like yours, so a check whose own relay died on
 * EADDRINUSE went green against a stranger's process and a stranger's data
 * directory -- PASS having tested nothing it started. The relay announces its
 * real bound port on stdout, so that line is the proof: it can only come from
 * this child, and a child that exits before printing it cannot be mistaken for
 * a healthy one.
 *
 * Spawn with MUXR_RELAY_PORT=0 and let the kernel pick, so concurrent checks
 * cannot collide in the first place.
 */
const LISTENING = /^relay listening on wss?:\/\/\S+:(\d+)\s*$/m;

export function waitForRelay(child, timeoutMs = 10_000) {
    if (typeof child !== 'object' || child === null || typeof child.on !== 'function') {
        throw new TypeError('waitForRelay needs the spawned relay child process, not a port');
    }
    if (child.stdout === null || child.stdout === undefined) {
        throw new TypeError('waitForRelay needs the relay spawned with stdout piped');
    }
    return new Promise((resolve, reject) => {
        let out = '';
        let errors = '';
        const settle = (finish, value) => {
            clearTimeout(timer);
            child.stdout.off('data', onOut);
            child.stderr?.off('data', onErr);
            child.off('exit', onExit);
            child.off('error', onError);
            finish(value);
        };
        const onOut = (chunk) => {
            out += chunk;
            const match = LISTENING.exec(out);
            if (match !== null) settle(resolve, Number(match[1]));
        };
        const onErr = (chunk) => { errors += chunk; };
        const tail = () => {
            const text = `${errors}${out}`.trim().split('\n').slice(-6).join('\n  ');
            return text === '' ? '' : `\n  ${text}`;
        };
        const onExit = (code, signal) => settle(
            reject,
            new Error(`relay exited before it was listening (code ${code}, signal ${signal})${tail()}`),
        );
        const onError = (cause) => settle(reject, new Error(`relay could not be started: ${cause.message}`));
        const timer = setTimeout(
            () => settle(reject, new Error(`relay did not report a listening port within ${timeoutMs}ms${tail()}`)),
            timeoutMs,
        );

        child.stdout.on('data', onOut);
        child.stderr?.on('data', onErr);
        child.on('exit', onExit);
        child.on('error', onError);
    });
}
