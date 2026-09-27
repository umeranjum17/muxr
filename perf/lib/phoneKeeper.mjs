import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { processStartIdentity } from './surfaceProbe.mjs';

export async function acquirePhoneKeeper(serial) {
    if (!/^[-\w]+$/.test(serial)) throw new Error('a pinned Android serial is required');
    const path = join(process.cwd(), 'perf', `.fm-phone-${serial}.lock`);
    const child = spawn('flock', ['-n', '-F', path, process.execPath, '-e', "process.stdout.write('READY\\n'); setInterval(() => {}, 60000)"], { stdio: ['ignore', 'pipe', 'pipe'] });
    const closed = new Promise((resolve) => child.once('close', resolve));
    try {
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('phone keeper did not become ready')), 5000);
            const done = (error) => { clearTimeout(timer); error ? reject(error) : resolve(); };
            child.once('error', done);
            child.once('exit', () => done(new Error('phone keeper lock is already held or flock failed')));
            child.stdout.once('data', (data) => data.toString().includes('READY\n') ? done() : done(new Error('phone keeper did not become ready')));
        });
    } catch (error) {
        child.kill('SIGTERM');
        await closed;
        throw error;
    }
    const startIdentity = processStartIdentity(child.pid);
    if (!startIdentity) { child.kill('SIGTERM'); await closed; throw new Error('phone keeper process identity is unavailable'); }
    const owner = { kind: 'flock', pid: child.pid, startIdentity, device: serial };
    return { path, owner, release: async () => { child.kill('SIGTERM'); await closed; } };
}
