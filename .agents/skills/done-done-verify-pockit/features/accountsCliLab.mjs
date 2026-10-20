// `muxr accounts` on a real (lab) Herdr and host with two stand-in Claude accounts: list them with
// quota, start an agent on one by name, see which account each agent uses, move it to the other,
// and see the host refuse "auto". No phone; the commands are the proof. See accounts-cli.md. Run
// from the repo root with HERDR_LAB_HELPER set:
//   node .agents/skills/done-done-verify-pockit/features/accountsCliLab.mjs <evidenceDir> <labRoot>
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const [evidence, root] = process.argv.slice(2);
const repo = process.cwd();
const { linkHerdrLab } = await import(join(repo, 'scripts/diagnostics/application/linkHerdrLab.mjs'));
const { requestLab } = await import(join(repo, 'scripts/diagnostics/application/linkLabClient.mjs'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(evidence, { recursive: true });
const log = (m) => { const line = `${new Date().toISOString()} ${m}`; console.log(line); appendFileSync(join(evidence, 'journey.log'), `${line}\n`); };

// Stand-in `claude`, as in planMoveLab.mjs: signs in as the next lab account, says which account a
// conversation runs on, replays the conversation it resumes and reports it to Herdr. Never a real account.
const work = join(root, 'w');
const bin = join(work, 'bin');
for (const stale of ['signed', 'conversations']) rmSync(join(work, stale), { recursive: true, force: true });
mkdirSync(bin, { recursive: true });
writeFileSync(join(bin, 'claude'), `#!/bin/sh
lab=${JSON.stringify(work)}
dir="$CLAUDE_CONFIG_DIR"
if [ "$1" = auth ] && [ "$2" = status ]; then
  [ -n "$dir" ] && [ -f "$dir/lab-account.json" ] && { cat "$dir/lab-account.json"; exit 0; }
  echo '{"loggedIn":false,"authMethod":"none"}'; exit 1
fi
if [ "$1" = auth ] && [ "$2" = login ]; then
  mkdir -p "$lab/signed" "$dir"
  if [ -e "$lab/signed/a" ]; then who=b; else who=a; fi
  touch "$lab/signed/$who"
  printf '{"loggedIn":true,"authMethod":"claude.ai","email":"umer.%s@example.com","subscriptionType":"max"}\\n' "$who" > "$dir/lab-account.json"
  echo "Signed in as umer.$who@example.com"; exit 0
fi
id=""; [ "$1" = --resume ] && id="$2"
[ -n "$id" ] || id="lab-$(date +%s%N)"
email=$(sed -n 's/.*"email":"\\([^"]*\\)".*/\\1/p' "$dir/lab-account.json" 2>/dev/null)
mkdir -p "$lab/conversations"; convo="$lab/conversations/$id.log"
seq() { date +%s%N; }
report() { herdr pane report-agent --source herdr:claude --agent claude --state "$1" --seq "$(seq)" "$HERDR_PANE_ID" >/dev/null 2>&1; }
printf '\\033[2J\\033[H'
echo "Claude Code (lab stand-in) on \${email:-no account}"
[ -f "$convo" ] && { echo "Resumed this conversation:"; cat "$convo"; }
( sleep 2; herdr pane report-agent-session --source herdr:claude --agent claude --seq "$(seq)" --agent-session-id "$id" "$HERDR_PANE_ID" >/dev/null 2>&1; report idle ) &
printf '> '
while IFS= read -r line; do
  report working
  printf '> %s\\n  (%s) Heard: %s\\n' "$line" "$email" "$line" >> "$convo"
  printf '  (%s) Heard: %s\\n> ' "$email" "$line"
  report idle
done
`, { mode: 0o755 });
process.env.PATH = [bin, dirname(process.execPath), '/usr/bin', '/bin'].join(':');

let session;
let lab;
let failed = false;
const herdr = (...args) => lab.herdr(args, 30_000);
const ask = (type, params) => requestLab(lab.link, type, params);
const folderOf = (name) => JSON.parse(readFileSync(join(root, 'lab', 'muxr', 'plans', 'accounts-v1.json'), 'utf8')).accounts.find((a) => a.name === name).folder;
const addAccount = async (name) => {
    const { planAccounts } = await import(join(repo, 'apps/host/dist/plans/planAccounts.js'));
    const added = await planAccounts(lab.env).add('claude');
    execFileSync('/bin/sh', ['-c', added.signIn.shell], { stdio: 'ignore', env: lab.env, timeout: 30_000 });
    await ask('plans.rename', { accountId: added.account.id, name });
    log(`added ${name}`);
};
// Claude's own statusline writes the quota snapshot the host reads; seed a fresh one per account.
const seedQuota = (name, fiveUsed, weekUsed) => {
    const at = Math.floor(Date.now() / 1000);
    writeFileSync(join(folderOf(name), 'last-statusline-input.json'), JSON.stringify({ rate_limits: {
        five_hour: { used_percentage: fiveUsed, resets_at: at + 2 * 3600 + 600 },
        seven_day: { used_percentage: weekUsed, resets_at: at + 3 * 86400 + 5 * 3600 },
    } }));
};
const cli = (...args) => {
    const run = spawnSync(process.execPath, [join(repo, 'scripts/cli.mjs'), 'accounts', ...args], {
        encoding: 'utf8', timeout: 120_000, env: { ...process.env, MUXR_DATA_DIR: join(root, 'lab', 'host'), MUXR_HOME: join(root, 'lab', 'muxr') },
    });
    const text = `$ muxr accounts ${args.join(' ')}\n${run.stdout}${run.stderr}[exit ${run.status}]\n`;
    appendFileSync(join(evidence, 'cli.txt'), `${text}\n`);
    log(text.trimEnd());
    return run;
};
const expect = (cond, what) => { if (!cond) throw new Error(what); };
try {
    rmSync(join(evidence, 'cli.txt'), { force: true });
    rmSync(join(root, 'lab'), { recursive: true, force: true }); // each run starts with no accounts
    mkdirSync(join(root, 'lab'), { recursive: true });
    lab = await linkHerdrLab(join(root, 'lab'), 'ac', undefined, (run, labSession) => {
        session = labSession;
        run(['workspace', 'create', '--cwd', work, '--label', 'accounts-cli', '--no-focus']);
    });
    log(`lab host up on relay port ${lab.port}, herdr ${session}`);
    await addAccount('Work');
    await addAccount('Home');
    seedQuota('Work', 37, 80);
    seedQuota('Home', 5, 22);

    const listed = cli();
    expect(listed.status === 0 && /Work <umer\.a@example\.com>/.test(listed.stdout) && /Home <umer\.b@example\.com>/.test(listed.stdout), 'list should show both accounts with their emails');
    expect(/5-hour +63% left/.test(listed.stdout) && /7-day +20% left/.test(listed.stdout) && /resets/.test(listed.stdout), 'list should show both windows with reset times');
    cli('--json');

    expect(cli('start', 'auto').status !== 0, 'start auto should be refused');
    const started = cli('start', 'work', '--cwd', work, '--label', 'cli-demo');
    expect(started.status === 0, 'start on Work should work');
    let row;
    for (const deadline = Date.now() + 60_000; Date.now() < deadline; await sleep(2000)) {
        const panes = JSON.parse(cli('panes', '--json').stdout);
        row = panes.agents.find((agent) => agent.account !== null);
        if (row !== undefined) break;
    }
    expect(row?.account.email === 'umer.a@example.com', 'the new agent should run on Work (umer.a@example.com)');
    const agent = row.agent;
    // A conversation to carry: wait for the stand-in to report its session, then talk to it.
    const sessions = await ask('session.list', {});
    const mine = sessions.find((s) => (s.agentName ?? s.paneId) === agent);
    for (let settledFor = 0; settledFor < 6; settledFor += 1) await sleep(3000);
    herdr('pane', 'send-text', mine.paneId, 'Plan the release notes\n');
    await sleep(6000);

    const moved = cli('move', agent, 'home');
    expect(moved.status === 0, 'move to Home should work');
    await sleep(3000);
    // The move opens a new pane for the same conversation; the lab agents have no names, so find it by its task.
    const after = JSON.parse(cli('panes', '--json').stdout).agents.find((a) => a.task === row.task);
    expect(after?.account?.email === 'umer.b@example.com', 'the agent should now run on Home (umer.b@example.com)');
    const pane = after.pane;
    const screen = herdr('pane', 'read', pane, '--source', 'recent-unwrapped', '--lines', '30');
    writeFileSync(join(evidence, 'pane-after-move.txt'), screen);
    expect(screen.includes('umer.b@example.com') && screen.includes('Plan the release notes'), 'the conversation should carry over to Home');
    cli('panes');
    log('PASS: list, start, panes, move and refusal of auto all behave');
} catch (error) {
    failed = true;
    log(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
    if (lab !== undefined) writeFileSync(join(evidence, 'host-output.txt'), lab.hostOutput().split('\n').slice(-80).join('\n'));
} finally {
    await lab?.stop();
    log(`done${failed ? ' with failure' : ''}`);
    process.exitCode = failed ? 1 : 0;
}
