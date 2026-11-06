# Runs `node --import <hook> cli.mjs` on a pty, reads until it exits or sits at
# the menu for 6 s, prints what a person sees. argv: cli, stand-in, home, outcome.
import os, pty, select, sys, time, signal, tempfile
cli, standin, home, outcome = sys.argv[1:5]
hook = os.path.join(tempfile.mkdtemp(), 'hook.mjs')
real = 'file://' + os.path.join(os.path.dirname(cli), 'setup/presentation/setupWizard.mjs')
open(hook, 'w').write(f"""import {{ register }} from 'node:module';
register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(s, c, next) {{
  if (s === 'lab:real-wizard') return {{ url: '{real}', shortCircuit: true }};
  const r = await next(s, c);
  if (r.url.endsWith('/setup/presentation/setupWizard.mjs')) return {{ ...r, url: 'file://{standin}' }};
  return r;
}}`));
""")
pid, fd = pty.fork()
if pid == 0:
    os.environ['MUXR_LAB_SETUP'] = 'finish' if outcome == 'finish' else 'cancel'
    os.execvp('node', ['node', '--no-deprecation', '--import', hook, cli])
out, deadline, status = b'', time.time() + 40, None
while time.time() < deadline:
    if select.select([fd], [], [], 0.5)[0]:
        try: chunk = os.read(fd, 65536)
        except OSError: chunk = b''
        if not chunk: break
        out += chunk
    done, st = os.waitpid(pid, os.WNOHANG)
    if done: status = os.waitstatus_to_exitcode(st); break
    if b'What would you like to do?' in out and time.time() > deadline - 34: break
for _ in range(50):
    if status is not None: break
    done, st = os.waitpid(pid, os.WNOHANG)
    if done: status = os.waitstatus_to_exitcode(st)
    else: time.sleep(0.1)
if status is None:
    os.kill(pid, signal.SIGKILL); os.waitpid(pid, 0)
    status = 0 if b'What would you like to do?' in out else 124
sys.stdout.write(out.decode('utf8', 'replace') + f'\nmuxr exit {status}\n')
sys.exit(0)
