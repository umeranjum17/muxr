import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { TokenLedger, ledgerRoots } from './tokenLedger.js';

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
const line = (value: unknown) => `${JSON.stringify(value)}\n`;

/** Every harness's store as the real ones are shaped, with the copies each
 *  one really makes: a Pi fork, Claude's per-block lines and resumed history,
 *  Codex's repeated counts. */
function machine(): NodeJS.ProcessEnv {
    const home = mkdtempSync(join(tmpdir(), 'muxr-ledger-'));
    const env = { HOME: home, XDG_DATA_HOME: join(home, 'share') };

    const pi = join(home, '.pi', 'agent', 'sessions', '--repo--');
    mkdirSync(pi, { recursive: true });
    const turnAt = at(30);
    const piTurn = (id: string, provider: string, model: string, input: number, cost?: number) => line({
        type: 'message', id, timestamp: turnAt,
        message: { role: 'assistant', provider, model, usage: { input, output: 5, cacheRead: 100, cacheWrite: 0, totalTokens: input + 105, ...(cost === undefined ? {} : { cost: { total: cost } }) } },
    });
    const prompt = line({ type: 'message', id: 'u', timestamp: at(31), message: { role: 'user', content: [{ type: 'text', text: 'a prompt the ledger must never read' }] } });
    writeFileSync(join(pi, 'parent.jsonl'), prompt + piTurn('p1', 'openai-codex', 'gpt-sol', 895, 0.5) + piTurn('p2', 'zai', 'glm-flash', 1895) + piTurn('pg', 'google', 'gemini-2.5-pro', 500));
    // A fork copies its parent's turns verbatim before its own.
    writeFileSync(join(pi, 'fork.jsonl'), piTurn('p1', 'openai-codex', 'gpt-sol', 895, 0.5) + piTurn('f1', 'openai-codex', 'gpt-sol', 95, 0.1));

    const omp = join(home, '.omp', 'agent', 'sessions', '--repo--');
    mkdirSync(omp, { recursive: true });
    writeFileSync(join(omp, 's.jsonl'), piTurn('o1', 'anthropic', 'claude-sonnet-4', 395));

    const claude = join(home, '.claude', 'projects', '-repo');
    mkdirSync(claude, { recursive: true });
    const claudeAt = at(20);
    const claudeLine = (block: string) => line({
        type: 'assistant', timestamp: claudeAt, requestId: 'req_1', message: {
            id: 'msg_1', role: 'assistant', model: 'claude-sonnet-4', content: [{ type: block }],
            usage: { input_tokens: 10, output_tokens: 90, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 },
        },
    });
    // One response written once per content block, then copied into a resume.
    writeFileSync(join(claude, 'first.jsonl'), claudeLine('thinking') + claudeLine('text'));
    writeFileSync(join(claude, 'resumed.jsonl'), claudeLine('text'));

    const codex = join(home, '.codex', 'sessions', '2026', '09', '28');
    mkdirSync(codex, { recursive: true });
    const countAt = at(10);
    const count = (total: number, last: { input_tokens: number; cached_input_tokens: number; output_tokens: number }) => line({
        timestamp: countAt, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: total }, last_token_usage: { ...last, total_tokens: last.input_tokens + last.output_tokens } } },
    });
    writeFileSync(join(codex, 'rollout.jsonl'),
        line({ timestamp: at(12), type: 'session_meta', payload: { model_provider: 'openai' } })
        + line({ timestamp: at(12), type: 'turn_context', payload: { model: 'gpt-5.5-codex' } })
        + count(1000, { input_tokens: 900, cached_input_tokens: 800, output_tokens: 100 })
        + count(1000, { input_tokens: 900, cached_input_tokens: 800, output_tokens: 100 }));

    const opencode = join(home, 'share', 'opencode');
    mkdirSync(opencode, { recursive: true });
    const db = new DatabaseSync(join(opencode, 'opencode.db'));
    db.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)');
    const now = Date.now();
    db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)').run('m1', 's1', now - 60_000, now, JSON.stringify({
        role: 'assistant', providerID: 'opencode-go', modelID: 'glm-go', cost: 0.25, time: { created: now - 60_000, completed: now - 50_000 },
        tokens: { input: 400, output: 50, reasoning: 50, cache: { read: 500, write: 0 } },
    }));
    db.close();
    return env;
}

it('counts every harness store once, by route and model, and reads only what was appended', async () => {
    const env = machine();
    const ledger = new TokenLedger(ledgerRoots(env));
    await ledger.refresh();
    const tokens = () => {
        const byKey: Record<string, number> = {};
        for (const row of ledger.snapshot().rows) {
            const key = `${row.harness}/${row.route}/${row.model}`;
            byKey[key] = (byKey[key] ?? 0) + row.input + row.output + row.cacheRead + row.cacheWrite;
        }
        return byKey;
    };
    expect(tokens()).toEqual({
        // The forked copy of p1 is not counted twice.
        'pi/openai-codex/gpt-sol': 1000 + 200,
        'pi/zai/glm-flash': 2000,
        'pi/google/gemini-2.5-pro': 500 + 105,
        'omp/anthropic/claude-sonnet-4': 500,
        // One response, not three lines' worth.
        'claude/anthropic/claude-sonnet-4': 1000,
        // The repeated count is one turn; cached input is its own figure.
        'codex/openai/gpt-5.5-codex': 1000,
        'opencode/opencode-go/glm-go': 1000,
    });
    const rows = ledger.snapshot().rows;
    const cost = (harness: string) => rows.filter((row) => row.harness === harness).reduce((sum, row) => sum + row.cost, 0);
    expect(cost('pi')).toBeCloseTo(0.6);
    expect(cost('opencode')).toBeCloseTo(0.25);
    // Claude and Codex record no cost: theirs is estimated at list prices.
    expect(rows.find((row) => row.harness === 'claude')?.estimated).toBe(true);
    expect(cost('claude')).toBeGreaterThan(0);
    expect(rows.find((row) => row.model === 'gemini-2.5-pro')).toMatchObject({ cost: 0, unpriced: true });

    // A turn appended to a live transcript lands; the rest is not reread.
    const home = env.HOME!;
    appendFileSync(join(home, '.pi', 'agent', 'sessions', '--repo--', 'parent.jsonl'), line({
        type: 'message', id: 'p3', timestamp: at(1),
        message: { role: 'assistant', provider: 'zai', model: 'glm-flash', usage: { input: 3000, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 3000 } },
    }) + '{"type":"message","id":"p4","message":{"role":"assist');
    await ledger.refresh();
    expect(tokens()['pi/zai/glm-flash']).toBe(5000);
}, 20_000);

it('recounts the whole machine within the pass that spots a rewritten transcript', async () => {
    const env = machine();
    const ledger = new TokenLedger(ledgerRoots(env));
    await ledger.refresh();
    // A crash or rotation can truncate a transcript and start it over; the
    // recount must reach every harness, not only the ones read after it.
    writeFileSync(join(env.HOME!, '.claude', 'projects', '-repo', 'first.jsonl'), line({
        type: 'assistant', timestamp: at(5), requestId: 'req_2', message: {
            id: 'msg_2', role: 'assistant', model: 'claude-sonnet-4', content: [{ type: 'text' }],
            usage: { input_tokens: 20, output_tokens: 30, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
    }));
    await ledger.refresh();
    const rows = ledger.snapshot().rows;
    expect(rows.find((row) => row.harness === 'pi')).toBeDefined();
    // Rows are hourly buckets, so the rewritten record lands beside whatever
    // else shares its hour: the record is counted, not a row named after it.
    expect(rows.filter((row) => row.harness === 'claude').reduce((sum, row) => sum + row.input, 0)).toBe(30);
});
