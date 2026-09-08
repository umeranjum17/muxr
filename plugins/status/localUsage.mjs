#!/usr/bin/env node
// Read only usage records. Run in a bounded child so a large session tree or a
// locked database cannot hold the plugin RPC open. Never read prompts, paths or
// credentials into the output.
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { isAbsolute, join } from 'node:path';

const periods = JSON.parse(process.argv[2]);
const now = Number(process.argv[3]);
const windowStart = new Date(`${periods[0]}T00:00:00`).getTime();
const deadline = Date.now() + 4_000;
const home = process.env.HOME || homedir();
let profile = (process.env.OMP_PROFILE ?? process.env.PI_PROFILE)?.trim();
if (!profile || profile === 'default') profile = undefined;
const invalidProfile = profile !== undefined && (
  !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(profile) || profile.endsWith('.') || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(profile)
);
let ompRoot = join(home, process.env.PI_CONFIG_DIR || '.omp');
if (profile) ompRoot = join(ompRoot, 'profiles', profile);
if (process.env.XDG_DATA_HOME && (profile || !process.env.PI_CODING_AGENT_DIR)) {
  let candidate = join(process.env.XDG_DATA_HOME, 'omp');
  if (profile) candidate = join(candidate, 'profiles', profile);
  if (existsSync(candidate)) ompRoot = candidate;
}
// ccusage's Pi reader resolves PI_AGENT_DIR, not PI_CODING_AGENT_DIR; this
// collector replaces its Pi rows, so it has to agree on the same root.
const piAgentDir = process.env.PI_AGENT_DIR?.trim() || join(home, '.pi', 'agent');
const opencodeRoot = process.env.OPENCODE_DATA_DIR || join(process.env.XDG_DATA_HOME || join(home, '.local', 'share'), 'opencode');
const opencodeDb = process.env.OPENCODE_DB || 'opencode.db';

function localPeriod(at) {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function count(value) {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function* sessionFiles(directory, depth = 0) {
  if (depth > 4) return;
  let entries;
  try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) { yield* sessionFiles(path, depth + 1); continue; }
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    // An appended transcript touched before the window cannot hold a record
    // inside it, so skipping it keeps the scan bounded on a long history.
    try { if (statSync(path).mtimeMs >= windowStart) yield path; } catch {}
  }
}

/**
 * Pi-format transcripts, streamed. A forked session file copies its parent's
 * messages verbatim, so the same recorded response appears in several files;
 * the original entry identity is what makes it one message again.
 */
async function collectTranscripts(root) {
  const groups = new Map();
  const seen = new Set();
  let latest;
  for (const file of sessionFiles(root)) {
    const stream = createReadStream(file, { encoding: 'utf8' });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (Date.now() > deadline || seen.size > 400_000 || groups.size > 1024) throw new Error('bounded scan exceeded');
        if (line.length > 4 * 1024 * 1024 || !line.includes('"usage"')) continue;
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        const message = entry?.message;
        const usage = message?.usage;
        // Assistant usage records are not always typed; a missing type is not
        // a reason to drop recorded consumption. Only a user turn is excluded.
        if (typeof usage !== 'object' || usage === null || typeof message !== 'object' || message.role === 'user') continue;
        const stamp = typeof message.timestamp === 'string' ? message.timestamp : entry.timestamp;
        const at = Date.parse(stamp);
        if (!Number.isFinite(at) || at < windowStart || at > now) continue;
        const inputTokens = count(usage.input);
        const outputTokens = count(usage.output);
        const cacheReadTokens = count(usage.cacheRead);
        const cacheCreationTokens = count(usage.cacheWrite);
        const totalTokens = Number.isSafeInteger(usage.totalTokens) && usage.totalTokens >= 0
          ? usage.totalTokens
          : inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens;
        const identity = `${entry.id ?? ''}|${stamp ?? ''}|${totalTokens}`;
        if (seen.has(identity)) continue;
        seen.add(identity);
        if (totalTokens > 0) latest = Math.max(latest ?? 0, at);
        // A recorded zero cost is a measurement; a missing one is unknown and
        // must not read as free.
        const cost = Number.isFinite(usage.cost?.total) ? usage.cost.total : undefined;
        const modelName = String(message.model ?? 'unknown').replace(/[^\x20-\x7e]+/g, ' ').trim().slice(0, 40) || 'unknown';
        const period = localPeriod(at);
        const key = `${period}\u0000${modelName}`;
        const group = groups.get(key) ?? {
          period, modelName, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
          cacheCreationTokens: 0, totalTokens: 0, totalCost: 0,
        };
        group.inputTokens += inputTokens;
        group.outputTokens += outputTokens;
        group.cacheReadTokens += cacheReadTokens;
        group.cacheCreationTokens += cacheCreationTokens;
        group.totalTokens += totalTokens;
        group.totalCost = cost === undefined || group.totalCost === undefined ? undefined : group.totalCost + cost;
        groups.set(key, group);
      }
    } finally { lines.close(); stream.destroy(); }
  }
  return { rows: [...groups.values()].filter((row) => periods.includes(row.period)), latest };
}

// Node 22.0 predates node:sqlite. Python's standard-library SQLite is a
// read-only fallback on older hosts; neither path launches an agent CLI.
let DatabaseSync;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch {}
const pythonQuery = `import json,sqlite3,sys
request=json.load(sys.stdin)
db=sqlite3.connect(request['uri'],uri=True,timeout=0.5)
db.row_factory=sqlite3.Row
try:
 print(json.dumps([dict(row) for row in db.execute(request['sql'],request['params'])]))
finally:
 db.close()
`;
function query(db, path, sql, params = []) {
  if (db) return db.prepare(sql).all(...params);
  const result = spawnSync('python3', ['-c', pythonQuery], {
    input: JSON.stringify({ uri: `${pathToFileURL(path).href}?mode=ro`, sql, params }),
    encoding: 'utf8', timeout: 2_000, maxBuffer: 2 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error('SQLite reader unavailable');
  return JSON.parse(result.stdout);
}

const result = {};
for (const [agent, root] of [['omp', join(ompRoot, 'agent', 'sessions')], ['pi', join(piAgentDir, 'sessions')]]) {
  if (agent === 'omp' && invalidProfile) { result.omp = { unavailable: true, reason: 'Invalid OMP profile configuration' }; continue; }
  if (!existsSync(root)) continue;
  try { result[agent] = await collectTranscripts(root); }
  catch { result[agent] = { unavailable: true, reason: 'Local activity could not be measured · reopen Usage in a minute' }; }
}

// OpenCode contributes recency only: ccusage already reads the same store for
// its tokens, so a second count would be the same activity twice.
const opencodePath = isAbsolute(opencodeDb) ? opencodeDb : join(opencodeRoot, opencodeDb);
if (existsSync(opencodePath)) {
  let db;
  try {
    if (DatabaseSync) {
      db = new DatabaseSync(opencodePath, { readOnly: true });
      db.exec('PRAGMA busy_timeout = 500');
    }
    const rows = query(db, opencodePath, `SELECT max(at) AS at FROM (
      SELECT coalesce(json_extract(data, '$.time.completed'), json_extract(data, '$.time.created'), time_created) AS at,
        json_extract(data, '$.tokens.input') + json_extract(data, '$.tokens.output')
        + coalesce(json_extract(data, '$.tokens.cache.read'), 0) + coalesce(json_extract(data, '$.tokens.cache.write'), 0) AS total
      FROM message WHERE json_extract(data, '$.role') = 'assistant' AND json_type(data, '$.tokens') = 'object')
      WHERE total > 0 AND at <= ?`, [now]);
    result.opencode = { latest: rows[0].at };
  } catch {
    result.opencode = { unavailable: true, reason: DatabaseSync ? 'Local usage database unavailable' : 'Local usage unavailable · requires Node 22.13+ or Python 3' };
  } finally { db?.close(); }
}
process.stdout.write(JSON.stringify(result));
