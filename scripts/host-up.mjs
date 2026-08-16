/** Run the distributed host bridge in the foreground. The relay is hosted separately. */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const packagedHost = fileURLToPath(new URL('./host.js', import.meta.url));
const hostEntry = existsSync(packagedHost)
    ? packagedHost
    : fileURLToPath(new URL('../apps/host/dist/main.js', import.meta.url));
const child = spawn(process.execPath, [hostEntry, ...process.argv.slice(3)], { stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => child.kill(signal));
}
child.on('exit', (code) => process.exit(code ?? 1));
