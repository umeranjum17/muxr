// Live layoutApply through the built host: a split whose first pane records kind pi.
// The host starts that agent via kit.startAgent; the probe waits for pi in the new tab.
// Usage: node herdrLayoutLab.mjs <lab socket> <scratch dir> <cwd>
import { createHerdrSessionSource } from '../../../../apps/host/dist/agent/infrastructure/herdrSessionSource.js';
const [socketPath, dir, cwd] = process.argv.slice(2);
const source = await createHerdrSessionSource({ socketPath, dataDir: `${dir}/data`, artifactsDir: `${dir}/att`, hostHttpPort: 0 });
const t0 = Date.now();
const log = (...a) => console.log(`+${Date.now() - t0}ms`, ...a);
try {
  const shell = await source.start({ cwd, kind: 'shell', label: 'layout-lab' });
  if (!('info' in shell)) throw new Error('shell start rejected');
  log('shell session', shell.info.id ? 'ok' : 'missing');
  const applied = await source.layoutApply({ sessionId: shell.info.id, snapshot: {
    type: 'split', direction: 'right', ratio: 0.5, first: { type: 'pane', kind: 'pi' }, second: { type: 'pane' } } });
  log('layoutApply', JSON.stringify(applied));
  const deadline = Date.now() + 60_000;
  let found;
  while (Date.now() < deadline && !found) {
    const tree = await source.herdrTree();
    const tab = tree.workspaces.flatMap((w) => w.tabs ?? []).find((t) => t.tabId === applied.tabId);
    found = tab?.panes?.find((p) => p.agentKind === 'pi' && p.agentStatus !== undefined && p.agentStatus !== 'unknown');
    if (tab) log('tab panes', tab.panes.map((p) => `${p.agentKind ?? '-'}:${p.agentStatus ?? '-'}`).join(' '));
    if (!found) await new Promise((r) => setTimeout(r, 1000));
  }
  if (!found) throw new Error('pi never came up in the applied layout');
  log(`PASS layoutApply started pi via the kit: status=${found.agentStatus}`);
} catch (e) { log('FAIL', e instanceof Error ? e.message : String(e)); process.exitCode = 1; }
await source.dispose();
