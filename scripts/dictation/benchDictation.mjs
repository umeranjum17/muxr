#!/usr/bin/env node
/**
 * Word error rate and time-to-text of on-device dictation settings, measured
 * on the fixtures with whisper.rn's own vendored whisper.cpp (see
 * whisperBench.cpp). See README.md.
 *
 *   node scripts/dictation/benchDictation.mjs candidates.json [--fixtures manifest.json] [--repeats 3] [--speed 3] [--only id,id] [--model path] [--json out.json]
 */
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../..');
const WHISPER_RN = join(ROOT, 'node_modules/whisper.rn');
const BYTES_PER_SECOND = 16_000 * 2;
// react-native-live-audio-stream hands over the microphone in these buffers.
const CHUNK_BYTES = 2560;

// The source list of whisper.rn's android/src/main/CMakeLists.txt, less the JSI bridge.
const SOURCES = [
    'ggml.c', 'ggml.cpp', 'ggml-alloc.c', 'ggml-backend.cpp', 'ggml-backend-meta.cpp', 'ggml-backend-reg.cpp',
    'ggml-backend-dl.cpp', 'ggml-cpu/amx/amx.cpp', 'ggml-cpu/amx/mmq.cpp', 'ggml-cpu/ggml-cpu.c', 'ggml-cpu/ggml-cpu.cpp',
    'ggml-cpu/quants.c', 'ggml-cpu/traits.cpp', 'ggml-cpu/repack.cpp', 'ggml-cpu/unary-ops.cpp', 'ggml-cpu/binary-ops.cpp',
    'ggml-cpu/vec.cpp', 'ggml-cpu/ops.cpp', 'ggml-opt.cpp', 'ggml-threading.cpp', 'ggml-quants.c', 'gguf.cpp', 'whisper.cpp',
];

function buildBench() {
    const version = JSON.parse(readFileSync(join(WHISPER_RN, 'package.json'), 'utf8')).version;
    const source = join(HERE, 'whisperBench.cpp');
    const sourceHash = createHash('sha256').update(readFileSync(source)).digest('hex');
    const out = join(ROOT, 'node_modules/.cache/dictation-bench', `${version}-${sourceHash}`);
    const binary = join(out, 'whisperBench');
    if (existsSync(binary)) return binary;
    mkdirSync(out, { recursive: true });
    const cpp = join(WHISPER_RN, 'cpp');
    const arch = process.arch === 'arm64' ? 'arm' : 'x86';
    const flags = ['-O3', '-DNDEBUG', '-march=native', '-D_GNU_SOURCE', '-DWSP_GGML_USE_CPU', '-DWSP_GGML_USE_CPU_REPACK', '-pthread', `-I${cpp}`, `-I${cpp}/ggml-cpu`];
    const files = [...SOURCES, `ggml-cpu/arch/${arch}/quants.c`, `ggml-cpu/arch/${arch}/repack.cpp`].map((file) => join(cpp, file));
    files.push(source);
    console.error(`building whisperBench from whisper.rn ${version}…`);
    const objects = files.map((file, index) => {
        const object = join(out, `${index}-${basename(file)}.o`);
        const [compiler, std] = file.endsWith('.c') ? ['cc', '-std=c11'] : ['c++', '-std=c++17'];
        execFileSync(compiler, [std, ...flags, '-c', file, '-o', object], { stdio: ['ignore', 'ignore', 'inherit'] });
        return object;
    });
    execFileSync('c++', ['-pthread', ...objects, '-o', binary], { stdio: 'inherit' });
    return binary;
}

/** One whisper.cpp context; `read` is one transcribeData call. */
async function openWhisper(binary, model) {
    const child = spawn(binary, [model], { stdio: ['pipe', 'pipe', 'inherit'] });
    let buffered = '';
    const waiting = [];
    let failure;
    const fail = (error) => {
        failure ??= error;
        while (waiting.length) waiting.shift().reject(failure);
    };
    child.on('error', (error) => fail(error));
    child.on('exit', (code, signal) => {
        fail(new Error(`whisperBench exited (${signal ?? code})${model ? ` while loading ${model}` : ''}`));
    });
    child.stdout.on('data', (data) => {
        buffered += data;
        let newline;
        while ((newline = buffered.indexOf('\n')) >= 0) {
            const line = buffered.slice(0, newline);
            buffered = buffered.slice(newline + 1);
            try {
                const reply = JSON.parse(line);
                if (reply.code !== undefined && reply.code !== 0) throw new Error(`whisper_full_parallel failed with code ${reply.code}`);
                const pending = waiting.shift();
                if (pending) pending.resolve(reply);
            } catch (error) {
                fail(error);
                child.kill();
            }
        }
    });
    const next = () => failure
        ? Promise.reject(failure)
        : new Promise((resolve, reject) => waiting.push({ resolve, reject }));
    await next();
    return {
        async read(pcm, options) {
            const settings = Object.entries(options)
                .filter(([, value]) => value !== undefined && value !== null && typeof value !== 'object')
                .map(([key, value]) => `${key}=${encodeURIComponent(typeof value === 'boolean' ? Number(value) : value)}`);
            const reply = next();
            child.stdin.write(`${settings.join(' ')} bytes=${pcm.length}\n`);
            child.stdin.write(pcm);
            const { ms, segments } = await reply;
            return { ms, segments, result: segments.map((segment) => segment.text).join('').trim() };
        },
        close: () => child.stdin.end(),
    };
}

function readWav(path) {
    const file = readFileSync(path);
    let offset = 12;
    while (offset < file.length) {
        const id = file.toString('ascii', offset, offset + 4);
        const size = file.readUInt32LE(offset + 4);
        if (id === 'data') return file.subarray(offset + 8, offset + 8 + size);
        offset += 8 + size + (size % 2);
    }
    throw new Error(`${path}: no data chunk`);
}

/** RMS approximation used by the former app-owned live-reading loop. */
function level(pcm) {
    const samples = Math.floor(pcm.length / 2);
    const step = Math.max(1, Math.floor(samples / 64));
    let sum = 0;
    let count = 0;
    for (let i = 0; i < samples; i += step) {
        const s = pcm.readInt16LE(i * 2) / 32768;
        sum += s * s;
        count += 1;
    }
    return Math.min(1, Math.sqrt(sum / count) * 4);
}

/** Legacy Whisper options for one reading of `bytes` of audio. */
function whisperOptions(candidate, bytes, prompt) {
    const { audioCtx, audioCtxMargin = 256, live, prompt: vocabulary, ...rest } = candidate.whisper;
    const fitted = audioCtx === 'fit' ? Math.min(1500, Math.ceil((bytes / BYTES_PER_SECOND) * 50) + audioCtxMargin) : audioCtx;
    return { ...rest, audioCtx: fitted, prompt: [vocabulary, prompt].filter(Boolean).join(' ') || undefined };
}

/** Tap, speak, tap: the whole recording read once after stop. */
async function dictateWhole(whisper, candidate, pcm, speed) {
    const reading = await whisper.read(pcm, whisperOptions(candidate, pcm.length));
    return { text: reading.result, waitMs: reading.ms * speed, readings: 1 };
}

/**
 * The former app-owned startLiveTranscription loop replayed on a clock: audio
 * arrives in real time, a reading takes its measured time times `speed`,
 * finished segments are kept once a reading is long enough, and stop waits
 * for the reading in flight plus a last one if anything was said since.
 */
async function dictateLive(whisper, candidate, pcm, speed) {
    const { readEverySeconds = 1, keepAfterSeconds = 6, silentLevel = 0.06, keptPromptChars = 200 } = candidate.live;
    const levels = [];
    let total = 0;
    let keptBytes = 0;
    let kept = '';
    let readTo = 0;
    let heard = '';
    let inFlight = null;
    let readings = 0;
    const spokenAfter = (at) => levels.some(({ value, end }) => end > at && value >= silentLevel);

    const start = async (at) => {
        const from = keptBytes;
        const to = total;
        const prompt = kept.slice(-keptPromptChars) || undefined;
        const reading = await whisper.read(pcm.subarray(from, to), whisperOptions(candidate, to - from, prompt));
        readings += 1;
        inFlight = { from, to, reading, doneAt: at + (reading.ms * speed) / 1000 };
    };
    const land = (recording) => {
        const { from, to, reading } = inFlight;
        const last = reading.segments.at(-1);
        if (recording && to - from > keepAfterSeconds * BYTES_PER_SECOND && reading.segments.length > 1 && last) {
            keptBytes = from + Math.floor((last.t0 * BYTES_PER_SECOND) / 100 / 2) * 2;
            kept = [kept, ...reading.segments.slice(0, -1).map((segment) => segment.text.trim())].filter(Boolean).join(' ');
            heard = last.text.trim();
        } else {
            heard = reading.result;
        }
        readTo = to;
        inFlight = null;
    };
    const follow = async (at) => {
        if (inFlight || total - readTo < readEverySeconds * BYTES_PER_SECOND || !spokenAfter(readTo)) return;
        await start(at);
    };

    for (let offset = 0; offset < pcm.length; offset += CHUNK_BYTES) {
        const chunk = pcm.subarray(offset, Math.min(pcm.length, offset + CHUNK_BYTES));
        const at = (offset + chunk.length) / BYTES_PER_SECOND;
        while (inFlight && inFlight.doneAt <= at) {
            const landedAt = inFlight.doneAt;
            land(true);
            await follow(landedAt);
        }
        total += chunk.length;
        levels.push({ value: level(chunk), end: total });
        await follow(at);
    }

    const stoppedAt = pcm.length / BYTES_PER_SECOND;
    let waitMs = 0;
    if (inFlight) {
        waitMs = Math.max(0, inFlight.doneAt - stoppedAt) * 1000;
        land(false);
    }
    // A candidate with `final` settings always reads the rest once more with them.
    const current = readTo > keptBytes && !spokenAfter(readTo) && !candidate.final;
    if (!current && total > keptBytes) {
        const prompt = kept.slice(-keptPromptChars) || undefined;
        const settings = candidate.final ? { whisper: { ...candidate.whisper, ...candidate.final } } : candidate;
        const reading = await whisper.read(pcm.subarray(keptBytes, total), whisperOptions(settings, total - keptBytes, prompt));
        readings += 1;
        waitMs += reading.ms * speed;
        heard = reading.result;
    }
    return { text: [kept, heard].filter(Boolean).join(' '), waitMs, readings };
}

const words = (text) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean);

/** Word error rate: word-level edit distance over the reference length. */
function wordErrorRate(reference, hypothesis) {
    const ref = words(reference);
    const hyp = words(hypothesis);
    let previous = Array.from({ length: hyp.length + 1 }, (_, index) => index);
    for (let i = 1; i <= ref.length; i += 1) {
        const row = [i];
        for (let j = 1; j <= hyp.length; j += 1) {
            row[j] = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1));
        }
        previous = row;
    }
    return previous[hyp.length] / ref.length;
}

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

function option(name, fallback) {
    const index = process.argv.indexOf(`--${name}`);
    return index > 0 ? process.argv[index + 1] : fallback;
}

async function main() {
    const candidatesPath = process.argv[2];
    if (!candidatesPath || candidatesPath.startsWith('--')) {
        console.error('usage: benchDictation.mjs <candidates.json> [--fixtures manifest.json] [--repeats N] [--speed factor] [--only id,id] [--model path] [--json out.json]');
        process.exit(2);
    }
    const repeats = Number(option('repeats', '3'));
    const speed = Number(option('speed', '1'));
    const only = option('only', '')?.split(',').filter(Boolean);
    const manifest = option('fixtures', join(HERE, 'fixtures/fixtures.json'));
    const fixturesDir = dirname(manifest);
    const fixtures = JSON.parse(readFileSync(manifest, 'utf8')).fixtures
        .filter((fixture) => !only.length || only.includes(fixture.id))
        .map((fixture) => ({ ...fixture, pcm: readWav(join(fixturesDir, `${fixture.id}.wav`)) }));
    const candidates = Object.entries(JSON.parse(readFileSync(candidatesPath, 'utf8')).candidates)
        .map(([name, candidate]) => ({ name, ...candidate }));

    const binary = buildBench();
    const models = new Map();
    const whisperFor = async (candidate) => {
        const model = option('model', undefined) ?? resolve(ROOT, 'apps/mobile/sources/assets/models', candidate.model ?? 'ggml-base.en-q5_1.bin');
        if (!models.has(model)) models.set(model, await openWhisper(binary, model));
        return models.get(model);
    };

    console.error(`${fixtures.length} fixtures × ${candidates.length} candidates × ${repeats} repeats, ${cpus().length} host cpus, speed ×${speed}`);
    const runs = new Map();
    // Candidates interleave within each repeat so host load drifts evenly across them.
    for (let repeat = 0; repeat < repeats; repeat += 1) {
        for (const fixture of fixtures) {
            for (const candidate of candidates) {
                const whisper = await whisperFor(candidate);
                const dictate = candidate.live ? dictateLive : dictateWhole;
                const run = await dictate(whisper, candidate, fixture.pcm, speed);
                const key = `${candidate.name}\u0000${fixture.id}`;
                if (!runs.has(key)) runs.set(key, []);
                runs.get(key).push({ ...run, wer: wordErrorRate(fixture.text, run.text) });
            }
        }
    }
    for (const whisper of models.values()) whisper.close();

    const results = candidates.map((candidate) => {
        const perFixture = fixtures.map((fixture) => {
            const list = runs.get(`${candidate.name}\u0000${fixture.id}`);
            return {
                id: fixture.id,
                wer: median(list.map((run) => run.wer)),
                waitMs: median(list.map((run) => run.waitMs)),
                readings: median(list.map((run) => run.readings)),
                text: list.at(-1).text,
            };
        });
        const refWords = fixtures.map((fixture) => words(fixture.text).length);
        const errors = perFixture.reduce((sum, fixture, index) => sum + fixture.wer * refWords[index], 0);
        return { name: candidate.name, wer: errors / refWords.reduce((a, b) => a + b, 0), perFixture };
    });

    const percent = (value) => `${(value * 100).toFixed(1)}%`;
    console.log(`| candidate | WER (all) | ${fixtures.map((fixture) => fixture.id).join(' | ')} | median wait after stop |`);
    console.log(`|---|---|${fixtures.map(() => '---').join('|')}|---|`);
    for (const result of results) {
        const cells = result.perFixture.map((fixture) => `${percent(fixture.wer)} · ${Math.round(fixture.waitMs)} ms`);
        console.log(`| ${result.name} | ${percent(result.wer)} | ${cells.join(' | ')} | ${Math.round(median(result.perFixture.map((fixture) => fixture.waitMs)))} ms |`);
    }
    const jsonOut = option('json', undefined);
    if (jsonOut) {
        const { writeFileSync } = await import('node:fs');
        writeFileSync(jsonOut, `${JSON.stringify({ repeats, speed, results }, null, 2)}\n`);
    }
}

await main();
