// Fails if withPrivateXvfb.sh leaves its Xvfb running after the command exits.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const wrapper = fileURLToPath(new URL('./withPrivateXvfb.sh', import.meta.url));
// The command proves its own Xvfb is up before it prints, then the check looks after exit.
const run = spawnSync('bash', [wrapper, 'sh', '-c', 'pid=$(tr -d " " < "/tmp/.X${DISPLAY#:}-lock") && kill -0 "$pid" && printf "%s %s" "$pid" "$DISPLAY"'], { encoding: 'utf8', timeout: 20_000, killSignal: 'SIGKILL' });
if (run.error || run.status !== 0) throw new Error(`wrapper failed: ${run.error?.message ?? run.stderr}`);

const [pid, display] = run.stdout.split(' ');
const number = display.slice(1);
const alive = () => { try { process.kill(Number(pid), 0); return true; } catch { return false; } };
if (existsSync(`/tmp/.X${number}-lock`) || existsSync(`/tmp/.X11-unix/X${number}`)) throw new Error(`display ${display} files left behind`);
if (alive()) throw new Error(`Xvfb ${pid} (${display}) is still running after the command exited`);
console.log(`ok: ${display} stopped with its command`);
