import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const script = join(root, 'install.sh');
const scratch = mkdtempSync(join(tmpdir(), 'muxr-install-script-'));
const bin = join(scratch, 'bin');
const prefix = join(scratch, 'prefix with spaces');
const log = join(scratch, 'npm.log');
mkdirSync(bin, { recursive: true });

writeFileSync(join(bin, 'node'), `#!/bin/sh
case "$1" in
  -e) [ "\${FAKE_NODE_MAJOR:-22}" -ge 22 ] ;;
  --version) echo "v\${FAKE_NODE_MAJOR:-22}.0.0" ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
writeFileSync(join(bin, 'npm'), `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_NPM_LOG"
if [ "$1 $2" = "prefix --global" ]; then printf '%s\\n' "$FAKE_PREFIX"; exit 0; fi
if [ "$1" = install ]; then
  [ "\${FAKE_NPM_FAIL:-0}" = 1 ] && exit 13
  mkdir -p "$FAKE_PREFIX/bin"
  cat > "$FAKE_PREFIX/bin/muxr" <<'EOF'
#!/bin/sh
[ "$1" = version ] && printf '%s\\n' "0.1.12"
EOF
  chmod 755 "$FAKE_PREFIX/bin/muxr"
  exit 0
fi
exit 1
`, { mode: 0o755 });
writeFileSync(join(bin, 'muxr'), '#!/bin/sh\nprintf "stale 9.9.9\\n"\n', { mode: 0o755 });

const env = {
    ...process.env,
    PATH: `${bin}:/usr/bin:/bin`,
    FAKE_NPM_LOG: log,
    FAKE_PREFIX: prefix,
};
const syntax = spawnSync('sh', ['-n', script], { encoding: 'utf8' });
assert.equal(syntax.status, 0, syntax.stderr);
const installed = spawnSync('sh', [script, '1.2.3'], { env, encoding: 'utf8' });
assert.equal(installed.status, 0, installed.stderr);
assert.match(installed.stdout, /Installing @trymuxr\/cli@1\.2\.3/);
assert.match(installed.stdout, /Installed muxr 0\.1\.12/);
assert.doesNotMatch(installed.stdout, /stale 9\.9\.9/);
assert.match(installed.stdout, /Next: run `muxr`/);
assert.match(installed.stdout, /prefix with spaces\/bin to PATH/);
assert.equal(existsSync(join(prefix, 'bin', 'muxr')), true);
const calls = readFileSync(log, 'utf8');
assert.match(calls, /^install --global --ignore-scripts @trymuxr\/cli@1\.2\.3$/m);
assert.match(calls, /^prefix --global$/m);
assert.doesNotMatch(calls, /sudo|curl|postinstall/);

writeFileSync(log, '');
const oldNode = spawnSync('sh', [script], { env: { ...env, FAKE_NODE_MAJOR: '21' }, encoding: 'utf8' });
assert.notEqual(oldNode.status, 0);
assert.match(oldNode.stderr, /Node\.js 22 or newer; found v21\.0\.0/);
assert.equal(readFileSync(log, 'utf8'), '', 'old Node reached npm');

const injection = spawnSync('sh', [script, 'latest --force'], { env, encoding: 'utf8' });
assert.equal(injection.status, 2);
assert.match(injection.stderr, /invalid version/);

const unwritable = spawnSync('sh', [script], { env: { ...env, FAKE_NPM_FAIL: '1' }, encoding: 'utf8' });
assert.notEqual(unwritable.status, 0);
assert.match(unwritable.stderr, /user-owned Node installation or npm prefix/);
assert.match(unwritable.stderr, /will not use sudo/);

process.stdout.write('install script smoke passed\n');
