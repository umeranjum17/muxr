import { chmodSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { Transform } from 'node:stream';

const MAX_LINE_BYTES = 8 * 1024 * 1024;
const MAX_PENDING_LISTS = 128;
const MAX_CONNECTIONS = 64;

function bundledRoots(root) {
    const roots = new Map();
    const directory = join(root, 'plugins');
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const pluginRoot = realpathSync(join(directory, entry.name));
        try {
            if (!statSync(join(pluginRoot, 'herdr-plugin.toml')).isFile()) continue;
            const manifest = JSON.parse(readFileSync(join(pluginRoot, 'muxr-ui.json'), 'utf8'));
            if (typeof manifest.pluginId !== 'string' || manifest.pluginId.length === 0) throw new Error(`Missing pluginId in ${pluginRoot}`);
            if (roots.has(manifest.pluginId)) throw new Error(`Duplicate bundled pluginId: ${manifest.pluginId}`);
            roots.set(manifest.pluginId, pluginRoot);
        } catch (error) {
            if (error.code === 'ENOENT') continue;
            throw error;
        }
    }
    if (roots.size === 0) throw new Error('No bundled plugin manifests found');
    return roots;
}

function record(line) {
    try {
        const value = JSON.parse(line.toString('utf8'));
        return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
    } catch { return undefined; }
}

// Keep bytes intact until a complete line exists, including split UTF-8 codepoints.
// Transform/pipe own backpressure; one frame and stream high-water marks bound buffering.
function lines(rewrite) {
    let buffer = Buffer.alloc(0);
    let length = 0;
    const emit = (line, stream) => {
        const output = rewrite(line);
        if (output.length > MAX_LINE_BYTES) throw new Error('Dev plugin adapter response exceeds line limit');
        stream.push(output);
    };
    return new Transform({
        transform(chunk, _encoding, callback) {
            try {
                let offset = 0;
                while (offset < chunk.length) {
                    const newline = chunk.indexOf(10, offset);
                    const end = newline === -1 ? chunk.length : newline + 1;
                    const part = chunk.subarray(offset, end);
                    const size = length + part.length;
                    if (size > MAX_LINE_BYTES) throw new Error('Dev plugin adapter frame exceeds line limit');
                    if (newline !== -1) {
                        const line = length === 0 ? part : Buffer.concat([buffer.subarray(0, length), part], size);
                        length = 0;
                        emit(line, this);
                    } else {
                        if (buffer.length < size) {
                            const next = Buffer.allocUnsafe(Math.min(MAX_LINE_BYTES, Math.max(size, 4096, buffer.length * 2)));
                            buffer.copy(next, 0, 0, length);
                            buffer = next;
                        }
                        part.copy(buffer, length);
                        length = size;
                    }
                    offset = end;
                }
                callback();
            } catch (error) { callback(error); }
        },
        flush(callback) {
            try {
                if (length > 0) emit(buffer.subarray(0, length), this);
                callback();
            } catch (error) { callback(error); }
        },
    });
}

/** Dev-only projection of existing registrations; never registers or enables plugins. */
export async function sourcePlugins({ root, upstreamPath, onError }) {
    const roots = bundledRoots(root);
    // Deliberately not TMPDIR or the checkout: either can exceed Unix socket limits.
    const directory = mkdtempSync('/tmp/muxr-dev-');
    const socketPath = join(directory, 'herdr.sock');
    const connections = new Set();
    const listening = Promise.withResolvers();
    let started = false;
    let closing;
    let probe;
    const server = createServer({ allowHalfOpen: true }, (client) => {
        if (closing !== undefined || connections.size >= MAX_CONNECTIONS) { client.destroy(); return; }
        const upstream = connect({ path: upstreamPath, allowHalfOpen: true });
        const pending = new Set();
        const requests = lines((line) => {
            const message = record(line);
            if (message !== undefined && typeof message.method === 'string'
                && (typeof message.id === 'string' || typeof message.id === 'number')) {
                // A reused id for another method must never inherit a list projection.
                pending.delete(message.id);
                if (message.method === 'plugin.list') {
                    if (pending.size >= MAX_PENDING_LISTS) throw new Error('Too many pending dev plugin list requests');
                    pending.add(message.id);
                }
            }
            return line;
        });
        const responses = lines((line) => {
            const message = record(line);
            if (message === undefined || !pending.has(message.id) || Object.hasOwn(message, 'event') || Object.hasOwn(message, 'method')
                || (!Object.hasOwn(message, 'result') && !Object.hasOwn(message, 'error'))) return line;
            pending.delete(message.id);
            if (message.error != null || !Array.isArray(message.result?.plugins)) return line;
            let changed = false;
            const plugins = message.result.plugins.map((plugin) => {
                const pluginRoot = roots.get(plugin?.plugin_id);
                if (pluginRoot === undefined) return plugin;
                changed = true;
                return { ...plugin, plugin_root: pluginRoot, source: { kind: 'local' } };
            });
            if (!changed) return line;
            return Buffer.from(JSON.stringify({ ...message, result: { ...message.result, plugins } }) + (line.at(-1) === 10 ? '\n' : ''));
        });
        const stop = () => {
            connections.delete(stop);
            pending.clear();
            client.destroy();
            upstream.destroy();
            requests.destroy();
            responses.destroy();
        };
        connections.add(stop);
        for (const stream of [client, upstream, requests, responses]) stream.on('error', stop);
        client.once('close', stop);
        // A normal upstream FIN must drain the response pipe before closing the client.
        upstream.once('close', () => { if (!upstream.readableEnded) stop(); });
        client.once('finish', stop);
        client.pipe(requests).pipe(upstream);
        upstream.pipe(responses).pipe(client);
    });
    const close = () => closing ??= (async () => {
        probe?.destroy();
        for (const stop of connections) stop();
        const stopped = Promise.withResolvers();
        server.close(() => stopped.resolve());
        await stopped.promise;
        rmSync(directory, { recursive: true, force: true });
    })();
    server.on('error', (error) => {
        if (!started) listening.reject(error);
        else if (closing === undefined) onError(error);
    });
    try {
        if (resolve(upstreamPath) === socketPath) throw new Error('Dev plugin adapter cannot proxy itself');
        chmodSync(directory, 0o700);
        // Herdr's terminal client resolves this sibling from HERDR_SOCKET_PATH.
        // Its binary transport goes directly upstream, never through JSON framing.
        symlinkSync(join(dirname(resolve(upstreamPath)), 'herdr-client.sock'), join(directory, 'herdr-client.sock'));
        server.listen(socketPath, () => listening.resolve());
        await listening.promise;
        chmodSync(socketPath, 0o600);
        started = true;
        const connected = Promise.withResolvers();
        probe = connect(upstreamPath);
        probe.setTimeout(3000, () => probe.destroy(new Error('Herdr upstream connection timed out')));
        probe.once('connect', () => connected.resolve());
        probe.once('error', connected.reject);
        probe.once('close', () => connected.reject(new Error('Herdr upstream closed before readiness')));
        await connected.promise;
        probe.destroy();
        probe = undefined;
        return { socketPath, pluginIds: [...roots.keys()].sort(), close };
    } catch (error) {
        await close();
        throw error;
    }
}
