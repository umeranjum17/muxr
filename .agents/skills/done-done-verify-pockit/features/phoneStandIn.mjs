// The ChatGPT stand-in behind the "Just this phone" lab: @byokit/accounts' own mockOpenAI for sign-in, models and
// answers, with a front for the answers endpoint that does the two things the mock does not: it calls the app's
// set_theme tool with the argument it takes, and it answers slowly when asked to "Take your time" so a journey can
// kill the app mid-turn. Real ChatGPT needs a person's account, which a lab never copies.
//   node phoneStandIn.mjs --auth-port N --api-port M [--auto-approve]   (a hand-run stand-in)
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const mobile = resolve(import.meta.dirname, '../../../../apps/mobile');
const testing = createRequire(`${mobile}/package.json`).resolve('@byokit/accounts/testing');
const { mockOpenAI } = await import(pathToFileURL(testing).href);

const ANSWERS = [
    { match: 'what can you do', text: 'I run on this phone. I can change how muxr looks: light, dark, or following your phone. Anything that needs a computer, I will tell you.' },
    { match: 'take your time', text: 'Here is a short one: why did the phone go to school? To get smarter.' },
];
const SLOW_MS = 90_000;
const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`;

function said(body) {
    const words = [];
    let toolDone = false;
    for (const item of Array.isArray(body.input) ? body.input : []) {
        if (item?.type === 'function_call_output') { toolDone = true; continue; }
        // Only the latest user message counts; earlier turns stay in the history.
        if (item?.role === 'user') { words.length = 0; toolDone = false; }
        const content = typeof item?.content === 'string' ? [{ type: 'input_text', text: item.content }] : Array.isArray(item?.content) ? item.content : [];
        for (const part of content) if (part?.type === 'input_text' && typeof part.text === 'string') words.push(part.text);
    }
    return { words: words.join(' ').toLowerCase(), toolDone };
}

export async function startPhoneStandIn({ authPort = 0, apiPort = 0, log = () => undefined } = {}) {
    const mock = await mockOpenAI({ port: authPort, answers: ANSWERS, log });
    const front = createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const raw = Buffer.concat(chunks);
        const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': req.headers['access-control-request-headers'] ?? '*', 'access-control-allow-methods': 'POST, GET, OPTIONS' };
        if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
        let body = {};
        try { body = JSON.parse(raw.toString('utf8') || '{}'); } catch { /* not JSON: forward as is */ }
        const ask = req.url?.startsWith('/codex/responses') ? said(body) : undefined;
        if (ask) log(`ask: ${ask.words.slice(0, 60)} tool=${ask.toolDone}`);
        const tools = Array.isArray(body.tools) ? body.tools.filter((t) => t?.type === 'function') : [];
        if (ask && !ask.toolDone && (ask.words.includes('dark') || ask.words.includes('follow')) && tools.some((t) => t.name === 'set_theme')) {
            const item = { type: 'function_call', call_id: 'call_theme', name: 'set_theme', arguments: JSON.stringify({ theme: ask.words.includes('follow') ? 'system' : 'dark' }) };
            res.writeHead(200, { ...cors, 'content-type': 'text/event-stream' });
            res.write(sse('response.output_item.added', { output_index: 0, item: { ...item, arguments: '' } }));
            res.write(sse('response.function_call_arguments.delta', { output_index: 0, item_id: item.call_id, delta: item.arguments }));
            res.write(sse('response.output_item.done', { output_index: 0, item }));
            return res.end(`${sse('response.completed', { response: { status: 'completed', output: [item] } })}data: [DONE]\n\n`);
        }
        if (ask && !ask.toolDone && ask.words.includes('take your time')) await new Promise((done) => setTimeout(done, SLOW_MS));
        if (ask?.toolDone) {
            const text = ask.words.includes('follow') ? 'Done. muxr follows your phone now.' : 'Done. muxr is dark now. Ask me to change it back any time.';
            res.writeHead(200, { ...cors, 'content-type': 'text/event-stream' });
            for (const delta of text.match(/[\s\S]{1,4}/g)) { res.write(sse('response.output_text.delta', { delta })); await new Promise((done) => setTimeout(done, 15)); }
            return res.end(`${sse('response.completed', { response: { status: 'completed' } })}data: [DONE]\n\n`);
        }
        const headers = Object.fromEntries(Object.entries(req.headers).filter(([name]) => !['host', 'connection', 'content-length'].includes(name)));
        const upstream = await fetch(`${mock.base}${req.url}`, { method: req.method, headers, body: req.method === 'GET' ? undefined : raw });
        res.writeHead(upstream.status, { ...Object.fromEntries(upstream.headers), ...cors });
        for await (const chunk of upstream.body) res.write(chunk);
        res.end();
    });
    await new Promise((done) => front.listen(apiPort, '127.0.0.1', done));
    return {
        authBase: mock.base,
        apiBase: `http://127.0.0.1:${front.address().port}`,
        approve: (code) => mock.approve(code),
        lastCode: () => mock.lastCode(),
        requests: () => mock.state.requests,
        close: async () => { front.closeAllConnections(); await new Promise((done) => front.close(done)); await mock.close(); },
    };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? undefined : Number(process.argv[i + 1]); };
    const standIn = await startPhoneStandIn({ authPort: arg('auth-port') ?? 0, apiPort: arg('api-port') ?? 0, log: (line) => console.log(line) });
    console.log(`stand-in auth ${standIn.authBase} api ${standIn.apiBase}`);
    if (process.argv.includes('--auto-approve')) {
        let seen;
        setInterval(() => { const code = standIn.lastCode(); if (code && code !== seen) { seen = code; setTimeout(() => standIn.approve(code), 4000); } }, 500);
    }
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void standIn.close().then(() => process.exit(0)); });
}
