import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { devHerdrSocket } from '../../development/application/devHerdrSocket.mjs';

const home = mkdtempSync(join(tmpdir(), 'muxr-dev-guard-'));
try {
    const env = { HOME: home };
    const defaultPath = join(home, '.config', 'herdr', 'herdr.sock');
    const labPath = join(home, '.config', 'herdr', 'sessions', 'lab', 'herdr.sock');
    const refusal = /Set HERDR_SOCKET_PATH to a lab session socket/;
    assert.throws(() => devHerdrSocket(env), refusal);
    assert.throws(() => devHerdrSocket({ ...env, HERDR_SOCKET_PATH: '  ' }), refusal);
    assert.throws(() => devHerdrSocket({ ...env, HERDR_SOCKET_PATH: defaultPath }), refusal);
    assert.throws(() => devHerdrSocket({ ...env, HERDR_SOCKET_PATH: relative(process.cwd(), defaultPath) }), refusal);
    mkdirSync(join(home, '.config', 'herdr'), { recursive: true });
    writeFileSync(defaultPath, 'synthetic socket target');
    const alias = join(home, 'alias');
    symlinkSync(join(home, '.config'), alias);
    assert.throws(() => devHerdrSocket({ ...env, HERDR_SOCKET_PATH: join(alias, 'herdr', 'herdr.sock') }), refusal);
    assert.equal(devHerdrSocket({ ...env, HERDR_SOCKET_PATH: labPath }), labPath);
    assert.equal(devHerdrSocket({ ...env, MUXR_DEV_ALLOW_DEFAULT_HERDR: '1' }), defaultPath);
    assert.equal(devHerdrSocket({ ...env, HERDR_SOCKET_PATH: defaultPath, MUXR_DEV_ALLOW_DEFAULT_HERDR: '1' }), defaultPath);
    assert.throws(() => devHerdrSocket({ ...env, MUXR_DEV_ALLOW_DEFAULT_HERDR: 'true' }), refusal);
    console.log('PASS: development socket selection refuses implicit/default Herdr and admits a lab or explicit opt-in (no Herdr connections).');
} finally {
    rmSync(home, { recursive: true, force: true });
}
