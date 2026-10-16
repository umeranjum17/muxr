// Live host session source against a lab Herdr socket: prints each change of
// the tree the phone would read. Usage: node herdrStatusLab.mjs <lab socket> <scratch dir>
import { createHerdrSessionSource } from '../../../../apps/host/dist/agent/infrastructure/herdrSessionSource.js';
const [socketPath, dir] = process.argv.slice(2);
const source = await createHerdrSessionSource({ socketPath, dataDir: `${dir}/data`, artifactsDir: `${dir}/att`, hostHttpPort: 0 });
const panes = (t) => (t.workspaces ?? []).flatMap((w) => (w.tabs ?? []).flatMap((tab) => (tab.panes ?? []).map((p) => `${w.label}/${p.paneId}:${p.agentKind ?? '-'}:${p.agentStatus ?? '-'}`)));
let last = '';
const timer = setInterval(async () => {
  const t = await source.herdrTree();
  const line = `connected=${t.connected} ${panes(t).join(' ')}`;
  if (line !== last) { console.log(new Date().toISOString(), line); last = line; }
}, 200);
process.on('SIGTERM', async () => { clearInterval(timer); await source.dispose(); console.log('disposed'); process.exit(0); });
console.log('pid', process.pid, 'ready');
