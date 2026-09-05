#!/usr/bin/env node
// Read only usage columns. Run in a bounded child so a locked/large database
// cannot hold the plugin RPC open. Never select prompts, paths or credentials.
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { isAbsolute, join } from 'node:path';

const periods = JSON.parse(process.argv[2]);
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
const opencodeRoot = process.env.OPENCODE_DATA_DIR || join(process.env.XDG_DATA_HOME || join(home, '.local', 'share'), 'opencode');
const opencodeDb = process.env.OPENCODE_DB || 'opencode.db';
const sources = {
  omp: {
    path: join(ompRoot, 'stats.db'),
    query: `SELECT timestamp AS at, model AS modelName, input_tokens AS inputTokens,
      output_tokens AS outputTokens, cache_read_tokens AS cacheReadTokens,
      cache_write_tokens AS cacheCreationTokens, total_tokens AS totalTokens, cost_total AS totalCost FROM messages`,
  },
  opencode: {
    path: isAbsolute(opencodeDb) ? opencodeDb : join(opencodeRoot, opencodeDb),
    query: `SELECT coalesce(json_extract(data, '$.time.completed'), json_extract(data, '$.time.created'), time_created) AS at, json_extract(data, '$.modelID') AS modelName,
      json_extract(data, '$.tokens.input') AS inputTokens,
      json_extract(data, '$.tokens.output') AS outputTokens,
      coalesce(json_extract(data, '$.tokens.cache.read'), 0) AS cacheReadTokens,
      coalesce(json_extract(data, '$.tokens.cache.write'), 0) AS cacheCreationTokens,
      json_extract(data, '$.cost') AS totalCost FROM message
      WHERE json_extract(data, '$.role') = 'assistant' AND json_type(data, '$.tokens') = 'object'`,
  },
};
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
for (const [agent, source] of Object.entries(sources)) {
  if (agent === 'omp' && invalidProfile) { result.omp = { unavailable: true, reason: 'Invalid OMP profile configuration' }; continue; }
  if (!existsSync(source.path)) continue;
  let db;
  try {
    if (DatabaseSync) {
      db = new DatabaseSync(source.path, { readOnly: true });
      db.exec('PRAGMA busy_timeout = 500');
    }
    const total = agent === 'omp' ? 'totalTokens' : 'inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens';
    const latest = query(db, source.path, `SELECT max(at) AS at FROM (${source.query}) WHERE (${total}) > 0 AND at <= ?`, [Number(process.argv[3])])[0].at;
    if (agent === 'opencode') { result[agent] = { latest }; continue; }
    const rows = query(db, source.path, `SELECT date(at / 1000, 'unixepoch', 'localtime') AS period, modelName,
      sum(inputTokens) AS inputTokens, sum(outputTokens) AS outputTokens,
      sum(cacheReadTokens) AS cacheReadTokens, sum(cacheCreationTokens) AS cacheCreationTokens,
      sum(${total}) AS totalTokens,
      CASE WHEN count(totalCost) = count(*) THEN sum(totalCost) END AS totalCost
      FROM (${source.query}) WHERE at >= ? AND at <= ?
      GROUP BY period, modelName LIMIT 1025`, [
        new Date(`${periods[0]}T00:00:00`).getTime(),
        Number(process.argv[3]),
      ]);
    if (rows.length > 1024) throw new Error('aggregate too large');
    result[agent] = { rows: rows.filter((row) => periods.includes(row.period)), latest };
  } catch {
    result[agent] = { unavailable: true, reason: DatabaseSync ? 'Local usage database unavailable' : 'Local usage unavailable · requires Node 22.13+ or Python 3' };
  } finally { db?.close(); }
}
process.stdout.write(JSON.stringify(result));
