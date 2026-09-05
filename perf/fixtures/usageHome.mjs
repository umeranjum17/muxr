import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const usagePlugins = (sourceRoot) => ({ root, env }) => {
    const dir = join(root, 'fixture-plugins');
    mkdirSync(join(dir, 'status'), { recursive: true });
    for (const name of ['code', 'terminal-keys', 'attachments']) symlinkSync(join(sourceRoot, 'plugins', name), join(dir, name));
    const original = join(sourceRoot, 'plugins/status');
    for (const file of readdirSync(original)) {
        // The real catalog opens manifests with O_NOFOLLOW. Preserve that guard.
        if (file === 'muxr-ui.json') copyFileSync(join(original, file), join(dir, 'status', file));
        else if (file !== 'usage.mjs') symlinkSync(join(original, file), join(dir, 'status', file));
    }
    // Host sanitization is retained: only this scratch fixture entry restores
    // test env. All parsing, collection and rendering use real product modules.
    writeFileSync(join(dir, 'status/usage.mjs'), `Object.assign(process.env, ${JSON.stringify(env)});\nawait import(${JSON.stringify(pathToFileURL(join(original, 'usage.mjs')).href)});\n`);
    return dir;
};

// Real provider databases, consumed by the real plugin. Only the external
// ccusage CLI is stubbed; there is deliberately no mocked plugin response.
export function usageHome(home) {
    execFileSync('python3', ['-c', `
import sqlite3,json,pathlib,sys,datetime
h=pathlib.Path(sys.argv[1])
def stamp(hour): return int(datetime.datetime(2026,9,5,hour,tzinfo=datetime.timezone.utc).timestamp()*1000)
p=h/'.omp/stats.db'; p.parent.mkdir(parents=True,exist_ok=True)
with sqlite3.connect(p) as db:
 db.execute('CREATE TABLE messages(timestamp INTEGER, model TEXT, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, total_tokens INTEGER, cost_total REAL)')
 db.execute('INSERT INTO messages VALUES(?,?,?,?,?,?,?,?)',(stamp(11),'fixture-omp',100,20,30,0,150,.01))
p=h/'.local/share/opencode/opencode.db'; p.parent.mkdir(parents=True,exist_ok=True)
with sqlite3.connect(p) as db:
 db.execute('CREATE TABLE message(time_created INTEGER,data TEXT)')
 db.execute('INSERT INTO message VALUES(?,?)',(stamp(10),json.dumps({'role':'assistant','modelID':'fixture-go','providerID':'opencode-go','time':{'created':stamp(10)},'tokens':{'input':200,'output':40,'reasoning':0,'cache':{'read':60,'write':0}},'cost':0})))
`, home], { timeout: 10_000 });
    const bin = join(home, 'fixture-bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'ccusage'), '#!/bin/sh\nprintf \'{"daily":[{"period":"2026-09-05","agents":[{"agent":"opencode","totalTokens":300,"totalCost":0}]}],"session":[]}\\n\'\n', { mode: 0o755 });
    // Exclude the user's CLIs/credentials while retaining node and sqlite tools.
    return {
        PATH: `${bin}:/usr/bin:/bin:${join(process.execPath, '..')}`,
        XDG_DATA_HOME: join(home, '.local/share'), PI_CONFIG_DIR: '.omp',
        CLAUDE_CONFIG_DIR: join(home, '.claude'), CODEX_HOME: join(home, '.codex'),
        OMP_PROFILE: '', PI_PROFILE: '', MUXR_USAGE_NOW: '2026-09-05T12:00:00Z', TZ: 'UTC',
        MUXR_CCUSAGE_BIN: join(bin, 'ccusage'),
    };
}
