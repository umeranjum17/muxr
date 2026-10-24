// A stand-in Boat cloud computer for the SSH set-up journey: a user and network namespace of its own (its own
// loopback, so its relay on 127.0.0.1:8792 can never be the captain's), named muxr-cloud, running a real sshd as an
// ordinary user and this checkout's muxr CLI with a private HOME and a Herdr lab session. Outside, a loopback TCP port
// reaches its sshd; Boat's SSH key route is `authorize(key)`. Nothing here joins a tailnet.
// Used by boatSignInLab.mjs (BOAT_LAB_SSH=<root>); `node cloudMachineLab.mjs --inside <root>` is its own inside half.
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const REPO = resolve(SELF, '../../../../..');
const SSHD_PORT = 2222;
export const MACHINE_USER = execFileSync('id', ['-un'], { encoding: 'utf8' }).trim();

/** One child per line on a unix socket: `{argv, keep?}` in, `{code, stdout, stderr}` out when it exits. */
function inside(root) {
    // MUXR_MODE is the app recipe's `run.env`, which the kit sets for every command on the machine.
    const env = { ...process.env, HOME: join(root, 'home'), MUXR_HOME: join(root, 'muxr'), MUXR_MODE: 'selfhost', MUXR_NO_SERVICE_COMMANDS: '1', XDG_RUNTIME_DIR: join(root, 'run') };
    for (const key of ['DBUS_SESSION_BUS_ADDRESS', 'MUXR_RELAY_URL', 'MUXR_RELAY_TOKEN', 'MUXR_MACHINE_ID', 'MUXR_RELAY_AUTH', 'MUXR_RELAY_PORT', 'MUXR_DATA_DIR',
        'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME']) delete env[key];
    const children = [];
    const sshd = spawn('/usr/bin/sshd', ['-D', '-e', '-f', join(root, 'sshd_config')], { stdio: ['ignore', 'ignore', 'pipe'] });
    sshd.stderr.on('data', (chunk) => appendFileSync(join(root, 'sshd.log'), chunk));
    children.push(sshd);
    createServer((socket) => socket.pipe(connect(SSHD_PORT, '127.0.0.1')).pipe(socket).on('error', () => socket.destroy())).listen(join(root, 'ssh.sock'));
    createServer((socket) => {
        let buffered = '';
        socket.on('data', (chunk) => {
            buffered += chunk;
            if (!buffered.includes('\n')) return;
            const { argv, keep } = JSON.parse(buffered);
            const child = spawn(process.execPath, [join(REPO, 'scripts/cli.mjs'), ...argv], { cwd: join(root, 'work'), env, stdio: ['ignore', 'pipe', 'pipe'] });
            children.push(child);
            let stdout = '';
            let stderr = '';
            child.stdout.on('data', (part) => { stdout += part; if (keep) appendFileSync(join(root, 'up.log'), part); });
            child.stderr.on('data', (part) => { stderr += part; if (keep) appendFileSync(join(root, 'up.log'), part); });
            if (keep) socket.end(`${JSON.stringify({ code: 0, stdout: `started ${child.pid}`, stderr: '' })}\n`);
            else child.on('exit', (code) => socket.end(`${JSON.stringify({ code: code ?? 1, stdout, stderr })}\n`));
        });
    }).listen(join(root, 'ctl.sock'), () => writeFileSync(join(root, 'ready'), `${process.pid}\n`));
    process.on('SIGTERM', () => {
        for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
        setTimeout(() => process.exit(0), 1500);
    });
}

export async function startCloudMachine(root, herdr) {
    for (const dir of ['home', 'muxr', 'work', 'run']) mkdirSync(join(root, dir), { recursive: true, mode: 0o700 });
    if (!existsSync(join(root, 'hostkey'))) execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'muxr-cloud', '-f', join(root, 'hostkey')]);
    writeFileSync(join(root, 'authorized_keys'), '', { mode: 0o600 });
    writeFileSync(join(root, 'sshd_config'), [
        `Port ${SSHD_PORT}`, 'ListenAddress 127.0.0.1', `HostKey ${join(root, 'hostkey')}`, `PidFile ${join(root, 'sshd.pid')}`,
        `AuthorizedKeysFile ${join(root, 'authorized_keys')}`, `AllowUsers ${MACHINE_USER}`, 'StrictModes no', 'UsePAM no',
        'PasswordAuthentication no', 'KbdInteractiveAuthentication no', 'AllowTcpForwarding local', 'PermitTTY no', '',
    ].join('\n'));
    // The kit starts Herdr with a narrow env, so the wrapper carries the lab session itself.
    const keep = ['FM_HERDR_LAB_STATE_DIR', 'TMPDIR'].filter((name) => process.env[name]).map((name) => `export ${name}=${JSON.stringify(process.env[name])}\n`).join('');
    const wrapper = join(root, 'herdr-lab.sh');
    writeFileSync(wrapper, `#!/bin/sh\n${keep}exec ${JSON.stringify(herdr.helper)} run ${JSON.stringify(herdr.session)} "$@"\n`);
    chmodSync(wrapper, 0o700);
    // Root in the outer namespace brings loopback up; the inner one maps back to this user, so sshd runs unprivileged.
    const uid = String(process.getuid());
    const gid = String(process.getgid());
    const child = spawn('unshare', ['-rn', '--uts', 'sh', '-c', 'ip link set lo up && hostname muxr-cloud && exec unshare --map-user="$1" --map-group="$2" "$3" "$4" --inside "$5"',
        'sh', uid, gid, process.execPath, SELF, root], {
        env: { ...process.env, HERDR_BIN: wrapper, HERDR_BIN_PATH: wrapper, HERDR_SOCKET_PATH: herdr.socket, HERDR_SESSION: herdr.session },
        stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr.on('data', (chunk) => appendFileSync(join(root, 'machine.log'), chunk));
    for (let i = 0; !existsSync(join(root, 'ready')); i += 1) {
        if (child.exitCode !== null || i > 100) throw new Error(`the stand-in cloud computer did not start: ${existsSync(join(root, 'machine.log')) ? readFileSync(join(root, 'machine.log'), 'utf8') : ''}`);
        await new Promise((done) => setTimeout(done, 100));
    }
    const bridge = createServer((socket) => socket.pipe(connect(join(root, 'ssh.sock'))).pipe(socket).on('error', () => socket.destroy()));
    await new Promise((done) => bridge.listen(0, '127.0.0.1', done));
    return {
        pid: child.pid,
        sshPort: bridge.address().port,
        hostKey: readFileSync(join(root, 'hostkey.pub'), 'utf8').trim(),
        workDir: join(root, 'work'),
        authorize: (key) => appendFileSync(join(root, 'authorized_keys'), `${key.trim()}\n`),
        /** Run this checkout's muxr CLI on the machine; `keep` leaves it running, as the machine's service does. */
        muxr: (argv, keep = false) => new Promise((done, fail) => {
            const socket = connect(join(root, 'ctl.sock'));
            let answer = '';
            socket.on('data', (part) => { answer += part; });
            socket.on('end', () => done(JSON.parse(answer)));
            socket.on('error', fail);
            socket.write(`${JSON.stringify({ argv, keep })}\n`);
        }),
        stop: async () => {
            bridge.close();
            if (child.exitCode !== null) return;
            const exited = new Promise((done) => child.once('exit', done));
            child.kill('SIGTERM');
            await exited;
        },
    };
}

if (process.argv[2] === '--inside') inside(process.argv[3]);
