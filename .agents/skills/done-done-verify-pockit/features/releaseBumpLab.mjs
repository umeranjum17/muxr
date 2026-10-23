// A version bump on the built web export: the changelog entry validates for
// the version in package.json, the export passes checkWebExport, and the
// served export's Settings screen reads that version at 390 px.
//
// usage: node releaseBumpLab.mjs <evidence dir>   (apps/mobile/dist is a fresh `yarn web:export`)
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';

const repo = process.cwd();
const evidence = resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('usage: releaseBumpLab.mjs <evidence dir>');
mkdirSync(evidence, { recursive: true });
const version = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version;
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const steps = [];
const lines = [];
const say = (line) => { lines.push(line); process.stdout.write(`${line}\n`); };
const step = (name, ok, detail = '') => { steps.push({ name, ok, detail }); say(`${ok ? 'ok' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`); };
const finish = (code) => {
    writeFileSync(join(evidence, 'steps.json'), JSON.stringify({ target: `web export ${version}`, start: head, steps, result: code === 0 ? 'pass' : 'fail' }, null, 2));
    writeFileSync(join(evidence, 'release-bump.log'), `${lines.join('\n')}\n`);
    process.exit(code);
};

const validate = spawnSync('node', ['scripts/release/presentation/changelog.mjs', 'validate', '--version', version, '--channel', 'stable', '--commit', head], { encoding: 'utf8' });
step(`changelog validate ${version}`, validate.status === 0, (validate.stdout + validate.stderr).trim().split('\n')[0]);
const exportCheck = spawnSync('node', ['scripts/diagnostics/application/checkWebExport.mjs'], { encoding: 'utf8' });
step('checkWebExport', exportCheck.status === 0, exportCheck.stdout.trim().split('\n').slice(-1)[0]);

const port = await new Promise((done) => { const s = createServer().listen(0, '127.0.0.1', () => { const { port: p } = s.address(); s.close(() => done(p)); }); });
const server = spawn('node', ['scripts/diagnostics/application/serveWebExport.mjs'], {
    env: { ...process.env, MUXR_WEB_EXPORT_DIR: join(repo, 'apps/mobile/dist'), MUXR_WEB_PORT: String(port) }, stdio: 'ignore',
});
const session = `release-bump-${process.pid}`;
const env = { ...process.env, CHROME_DEVTOOLS_AXI_SESSION: session };
const axi = (...args) => spawnSync('chrome-devtools-axi', args, { encoding: 'utf8', env });
try {
    await new Promise((r) => setTimeout(r, 1500));
    axi('open', `http://127.0.0.1:${port}/settings/connection`);
    axi('resize', '390', '844');
    let text = '';
    for (let i = 0; i < 30 && !text.includes(`Version ${version}`); i += 1) {
        await new Promise((r) => setTimeout(r, 1000));
        text = axi('eval', 'document.body.innerText').stdout;
    }
    axi('screenshot', join(evidence, 'settings-version-390.png'));
    step(`Settings reads Version ${version} at 390 px`, text.includes(`Version ${version}`));
} finally {
    axi('stop');
    server.kill();
}
finish(steps.every((s) => s.ok) ? 0 : 1);
