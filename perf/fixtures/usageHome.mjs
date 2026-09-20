import { execFileSync } from 'node:child_process';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { attachmentsAddonDir, codeAddonDir } from '../lib/addons.mjs';

/** Usage and machine health are host product code, so the fake stack needs no
 *  status plugin fixture: the host's typed usage.report answers from this
 *  module's environment fixture alone. The remaining fixture plugins are the
 *  add-on checkouts the journeys walk (Files/Changes). */
export const usagePlugins = () => ({ root }) => {
    const dir = join(root, 'fixture-plugins');
    mkdirSync(dir, { recursive: true });
    // Attachments left the bundle for its own repo: MUXR_ADDONS_ROOT or the Herdr install.
    symlinkSync(attachmentsAddonDir(), join(dir, 'attachments'));
    symlinkSync(codeAddonDir(), join(dir, 'code'));
    return dir;
};

// Real provider databases, consumed by the real host collector. Only the external
// ccusage CLI is stubbed; there is deliberately no mocked usage response.
export function usageHome(home) {
    execFileSync('python3', ['-c', `
import sqlite3,json,pathlib,sys,datetime
h=pathlib.Path(sys.argv[1])
def stamp(hour): return int(datetime.datetime(2026,9,5,hour,tzinfo=datetime.timezone.utc).timestamp()*1000)
p=h/'.omp/stats.db'; p.parent.mkdir(parents=True,exist_ok=True)
with sqlite3.connect(p) as db:
 db.execute('CREATE TABLE messages(timestamp INTEGER, model TEXT, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, total_tokens INTEGER, cost_total REAL)')
 db.execute('INSERT INTO messages VALUES(?,?,?,?,?,?,?,?)',(stamp(11),'fixture-omp',100,20,30,0,150,.01))
p=h/'.omp/agent/sessions/proj/session.jsonl'; p.parent.mkdir(parents=True,exist_ok=True)
at=datetime.datetime(2026,9,5,11,tzinfo=datetime.timezone.utc).isoformat().replace('+00:00','Z')
p.write_text(json.dumps({'id':'fixture-1','type':'message','timestamp':at,'message':{'role':'assistant','model':'fixture-omp','timestamp':at,'usage':{'input':100,'output':20,'cacheRead':30,'cacheWrite':0,'totalTokens':150,'cost':{'total':.01}}}})+chr(10))
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
