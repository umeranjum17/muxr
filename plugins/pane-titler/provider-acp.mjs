#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

const provider = process.argv[2];
const sessions = new Set();

function send(message) {
    process.stdout.write(`${JSON.stringify(message)}\n`);
}

function commandFor(promptFile) {
    if (provider === 'claude') {
        return {
            command: process.env.CLAUDE_CODE_EXECUTABLE?.trim() || 'claude',
            args: [
                '--print', '--model', process.env.ANTHROPIC_MODEL?.trim() || 'haiku',
                '--effort', 'low', '--safe-mode', '--tools', '', '--permission-mode', 'dontAsk',
                '--no-session-persistence', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
                '--output-format', 'text',
            ],
        };
    }
    if (provider === 'codex') {
        return {
            command: process.env.CODEX_PATH?.trim() || 'codex',
            args: [
                'exec', '--model', 'gpt-5.4-mini', '--config', 'model_reasoning_effort="low"',
                '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config',
                '--ignore-rules', '--color', 'never', '--output-last-message', promptFile, '-',
            ],
        };
    }
    throw new Error(`unsupported provider: ${provider ?? '<missing>'}`);
}

function runProvider(prompt) {
    const directory = mkdtempSync(join(tmpdir(), 'muxr-title-provider-'));
    const resultPath = join(directory, 'result.txt');
    const invocation = commandFor(resultPath);
    return new Promise((resolve, reject) => {
        const child = spawn(invocation.command, invocation.args, {
            cwd: directory,
            env: process.env,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        let settled = false;
        const append = (current, chunk) => `${current}${chunk}`.slice(-64 * 1024);
        const finish = (action) => {
            if (settled) return;
            settled = true;
            rmSync(directory, { recursive: true, force: true });
            action();
        };
        child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
        child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
        child.once('error', (error) => finish(() => reject(error)));
        child.once('exit', (code, signal) => {
            if (code !== 0) {
                finish(() => reject(new Error(stderr.trim() || `${provider} exited (${signal ?? code ?? 'unknown'})`)));
                return;
            }
            try {
                const output = provider === 'codex' && existsSync(resultPath)
                    ? readFileSync(resultPath, 'utf8')
                    : stdout;
                finish(() => resolve(output));
            } catch (error) {
                finish(() => reject(error));
            }
        });
        child.stdin.end(prompt);
    });
}

async function handle(message) {
    if (message?.jsonrpc !== '2.0' || message.id === undefined || typeof message.method !== 'string') return;
    if (message.method === 'initialize') {
        send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } });
        return;
    }
    if (message.method === 'session/new') {
        const sessionId = randomUUID();
        sessions.add(sessionId);
        send({ jsonrpc: '2.0', id: message.id, result: { sessionId } });
        return;
    }
    if (message.method === 'session/prompt') {
        const sessionId = message.params?.sessionId;
        if (!sessions.has(sessionId)) throw new Error('unknown ACP session');
        const prompt = Array.isArray(message.params?.prompt)
            ? message.params.prompt.filter((block) => block?.type === 'text').map((block) => block.text).join('\n')
            : '';
        const output = await runProvider(prompt);
        send({
            jsonrpc: '2.0', method: 'session/update',
            params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: output } } },
        });
        send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
        return;
    }
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not supported' } });
}

createInterface({ input: process.stdin }).on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    void handle(message).catch((error) => {
        if (message?.id !== undefined) {
            send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: String(error?.message ?? error).slice(0, 512) } });
        }
    });
});
