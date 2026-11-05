import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Dictation on the computer: the phone sends one recorded WAV, Hex
 * (github.com/anomalyco/hex, MIT, on-device) reads it here, and only the text
 * goes back. No cloud engine. `hex model transcribe` runs in its own process
 * with the model the machine's Hex already has selected; nothing here starts
 * the Hex app or downloads a model.
 */

/** About four minutes of 16 kHz mono PCM16; the phone caps a take well under this. */
export const MAX_DICTATION_WAV_BYTES = 8 * 1024 * 1024;
const TRANSCRIBE_TIMEOUT_MS = 60_000;
const OUTPUT_LIMIT = 64 * 1024;

type Environment = Readonly<Record<string, string | undefined>>;

function hexCommand(env: Environment): string {
    return env.MUXR_HEX_BIN?.trim() || 'hex';
}

function isWav(bytes: Buffer): boolean {
    return bytes.length > 44 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WAVE';
}

function run(command: string, args: string[], env: Environment): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { env: { ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => child.kill('SIGKILL'), TRANSCRIBE_TIMEOUT_MS);
        child.stdout.on('data', (chunk: Buffer) => { stdout = (stdout + chunk.toString('utf8')).slice(0, OUTPUT_LIMIT); });
        child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-OUTPUT_LIMIT); });
        child.once('error', (error: NodeJS.ErrnoException) => {
            clearTimeout(timer);
            reject(error.code === 'ENOENT'
                ? new Error('Hex is not installed on this computer. Install Hex (github.com/anomalyco/hex) and its speech model, then try again.')
                : error);
        });
        child.once('close', (code, signal) => {
            clearTimeout(timer);
            if (signal !== null) return reject(new Error(`Hex did not finish transcribing within ${TRANSCRIBE_TIMEOUT_MS / 1000} seconds.`));
            if (code !== 0) return reject(new Error(`Hex could not transcribe the recording: ${stderr.trim().split('\n').at(-1) || `exit ${code}`}`));
            resolve({ stdout, stderr });
        });
    });
}

/** Transcribe one base64 WAV with the computer's Hex and return the text. */
export async function dictateWithHex(audio: string, env: Environment = process.env): Promise<{ text: string }> {
    const wav = Buffer.from(audio, 'base64');
    if (!isWav(wav)) throw new Error('Dictation audio must be a WAV recording.');
    if (wav.length > MAX_DICTATION_WAV_BYTES) throw new Error('That recording is too long to transcribe on the computer. Dictate in shorter takes.');
    const folder = await mkdtemp(join(tmpdir(), 'muxr-dictation-'));
    const started = performance.now();
    try {
        const file = join(folder, 'take.wav');
        await writeFile(file, wav, { mode: 0o600 });
        const { stdout } = await run(hexCommand(env), ['model', 'transcribe', file], env);
        const text = stdout.trim();
        const seconds = ((performance.now() - started) / 1000).toFixed(1);
        // The words are the user's own; the host log keeps them only when asked to.
        process.stderr.write(`dictation: Hex transcribed ${wav.length} bytes in ${seconds}s, ${text.length} characters${env.MUXR_DICTATION_LOG_TEXT === '1' ? `: ${JSON.stringify(text)}` : ''}\n`);
        return { text };
    } finally {
        await rm(folder, { recursive: true, force: true });
    }
}
