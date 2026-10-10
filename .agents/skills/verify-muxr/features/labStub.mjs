// Canned-output fixture (not a model): streams fixed numbered lines so an agent TUI
// has long, deterministic output. OpenAI chat-completions + Responses, Anthropic messages.
// Usage: node labStub.mjs  -> prints "stub listening on <port>". Env: STUB_LPS lines/sec (default 40).
import { createServer } from 'node:http';

const LPS = Number(process.env.STUB_LPS ?? 40);
const SEA = ['The tide pulls the sand back out.', 'Gulls ride the evening wind.', 'Spray lifts off a breaking crest.',
    'A buoy nods on the gray swell.', 'Salt dries white on the rocks.', 'The deep is patient as stone.'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const textOf = (body) => JSON.stringify(body?.messages ?? body?.input ?? '');
function lines(body) {
    const all = textOf(body);
    const m = [...all.matchAll(/MARK-1 to MARK-(\d+)/g)].at(-1);
    if (!m) return ['Lab output'];
    return Array.from({ length: Number(m[1]) }, (_, i) => `MARK-${i + 1} ${SEA[i % SEA.length]}`);
}
async function drip(res, items, emit) {
    for (let i = 0; i < items.length; i++) {
        if (res.destroyed) return;
        emit(items[i] + (i < items.length - 1 ? '\n' : ''));
        if (LPS > 0) await sleep(1000 / LPS);
    }
}
const sse = (res) => { res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' }); };

const server = createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    let body = {}; try { body = JSON.parse(raw || '{}'); } catch {}
    const url = req.url ?? '';
    if (req.method === 'GET' && url.includes('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'stub', object: 'model', owned_by: 'lab' }] })); return;
    }
    const items = lines(body);
    if (url.includes('/chat/completions')) {
        const id = 'chatcmpl-lab';
        if (!body.stream) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ id, object: 'chat.completion', model: 'stub', choices: [{ index: 0, message: { role: 'assistant', content: items.join('\n') }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })); return;
        }
        sse(res);
        const chunk = (delta, finish = null) => res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model: 'stub', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
        chunk({ role: 'assistant', content: '' });
        await drip(res, items, (t) => chunk({ content: t }));
        chunk({}, 'stop');
        res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model: 'stub', choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
        res.end('data: [DONE]\n\n'); return;
    }
    if (url.includes('/responses')) {
        sse(res);
        const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
        const resp = { id: 'resp_lab', object: 'response', model: 'stub', status: 'in_progress', output: [] };
        ev('response.created', { response: resp });
        const item = { id: 'msg_lab', type: 'message', role: 'assistant', status: 'in_progress', content: [] };
        ev('response.output_item.added', { output_index: 0, item });
        ev('response.content_part.added', { item_id: 'msg_lab', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
        await drip(res, items, (t) => ev('response.output_text.delta', { item_id: 'msg_lab', output_index: 0, content_index: 0, delta: t }));
        const text = items.join('\n');
        ev('response.output_text.done', { item_id: 'msg_lab', output_index: 0, content_index: 0, text });
        const done = { ...item, status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
        ev('response.output_item.done', { output_index: 0, item: done });
        ev('response.completed', { response: { ...resp, status: 'completed', output: [done], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } });
        res.end(); return;
    }
    if (url.includes('/messages')) {
        if (url.includes('count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ input_tokens: 1 })); return; }
        if (!body.stream) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ id: 'msg_lab', type: 'message', role: 'assistant', model: body.model ?? 'stub', content: [{ type: 'text', text: items.join('\n') }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } })); return;
        }
        sse(res);
        const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
        ev('message_start', { message: { id: 'msg_lab', type: 'message', role: 'assistant', model: body.model ?? 'stub', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } });
        ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
        await drip(res, items, (t) => ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: t } }));
        ev('content_block_stop', { index: 0 });
        ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } });
        ev('message_stop', {});
        res.end(); return;
    }
    res.writeHead(404); res.end('{}');
});
server.listen(Number(process.env.STUB_PORT ?? 0), '127.0.0.1', () => console.log(`stub listening on ${server.address().port}`));
