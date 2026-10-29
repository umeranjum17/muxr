// A real Herdr lab with a real `pi` answering from the machine's local Ollama
// endpoint, for a phone to pair with and read as chat. No agent sign-in is used:
// the lab-only models.json names the local OpenAI-compatible endpoint and no key.
// The host reads Pi's log root from PI_AGENT_DIR, so the lab sets it beside Pi's own PI_CODING_AGENT_DIR.
// Usage: HERDR_LAB_HELPER=<helper> node chatRealAgentLab.mjs <lab root> <link file>
// Prints "READY <port>" once the native pair link is in <link file>; stops on SIGTERM.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { linkHerdrLab } from '../../../../scripts/diagnostics/application/linkHerdrLab.mjs';

const [root, linkFile] = process.argv.slice(2);
const helper = process.env.HERDR_LAB_HELPER;
const ollama = process.env.CHAT_LAB_OLLAMA ?? 'http://127.0.0.1:11434/v1';
const model = process.env.CHAT_LAB_MODEL_ID ?? 'qwen3.8:27b-q4_K_M';
mkdirSync(join(root, 'lab'), { recursive: true });
const session = execFileSync(helper, ['name', process.env.CHAT_LAB_NAME ?? 'mx-chat-slice1-build1'], { encoding: 'utf8' }).trim();
process.env.HERDR_LAB_SESSION = session;
process.env.HERDR_LAB_PREPROVISIONED = '1';
let lab;
// The lab was provisioned here, so its teardown is ours too.
const stop = async () => { await lab?.stop?.(); execFileSync(helper, ['teardown', session]); process.exit(0); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);
try {
    execFileSync(helper, ['provision', session]);
    const xdgRoot = readFileSync(join(process.env.JG_HERDR_LAB_STATE_DIR ?? `${process.env.TMPDIR ?? '/tmp'}/jg-herdr-lab-${process.getuid()}`, `${session}.xdg-root`), 'utf8').trim();
    const piDir = join(xdgRoot, 'home', '.pi', 'agent');
    mkdirSync(piDir, { recursive: true });
    writeFileSync(join(piDir, 'models.json'), `${JSON.stringify({ providers: { ollama: { baseUrl: ollama, api: 'openai-completions', apiKey: 'none', models: [{ id: model }] } } })}\n`);
    writeFileSync(join(piDir, 'settings.json'), `${JSON.stringify({ defaultProvider: 'ollama', defaultModel: model })}\n`);
    execFileSync(helper, ['run', session, 'integration', 'install', 'pi'], { stdio: 'inherit' });
    const cwd = join(root, 'repo');
    mkdirSync(cwd, { recursive: true });
    // The agent is up before the phone pairs, so Home already lists it.
    const begin = (herdr) => {
        const made = JSON.parse(herdr(['workspace', 'create', '--cwd', cwd, '--label', 'chat-lab']));
        const pane = made.result?.root_pane?.pane_id ?? made.root_pane?.pane_id;
        console.log(JSON.stringify(made).slice(0, 300));
        herdr(['pane', 'run', pane, 'pi']);
    };
    lab = await linkHerdrLab(join(root, 'lab'), 'mx', undefined, begin, { PI_CODING_AGENT_DIR: piDir, PI_AGENT_DIR: piDir }, (offer) => { writeFileSync(linkFile, offer); console.log(`OFFER ${linkFile}`); });
    console.log(`READY ${lab.port}`);
    setInterval(() => {}, 60_000); // held open until SIGTERM
} catch (error) { console.error(error); await stop(); }
