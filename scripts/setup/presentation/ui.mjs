import { createInterface, emitKeypressEvents } from 'node:readline';

const interactive = () => Boolean(process.stdin.isTTY && process.stdout.isTTY);
const ansi = (code, text) => interactive() && process.env.NO_COLOR === undefined && process.env.TERM !== 'dumb' ? `\x1b[${code}m${text}\x1b[0m` : text;
const dim = (text) => ansi('2', text);
const bold = (text) => ansi('1', text);
const green = (text) => ansi('32', text);
const yellow = (text) => ansi('33', text);
const inverse = (text) => ansi('7', text);
let fullscreen = false;
let setupSession = false;
let holdFullscreen = false;
let persistentReceipt = '';

const richInteractive = () => interactive()
    && process.env.MUXR_NO_TUI !== '1'
    && !process.env.SSH_CONNECTION
    && !process.env.CI
    && process.env.TERM !== 'dumb'
    && (!setupSession || (process.stdout.columns ?? 80) >= 80 && (process.stdout.rows ?? 24) >= 40);
const fullscreenSupported = () => richInteractive()
    && (process.stdout.columns ?? 80) >= 80
    && (process.stdout.rows ?? 24) >= 40;

function leaveFullscreen() {
    if (!fullscreen) return;
    process.stdout.write('\x1b[?25h\x1b[?1049l');
    fullscreen = false;
    holdFullscreen = false;
}

async function waitForContinue() {
    process.stdout.write(`\n  ${dim('enter continue · ctrl-c exit')}\x1b[K`);
    emitKeypressEvents(process.stdin);
    const wasRaw = process.stdin.isRaw;
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    await new Promise((resolve) => {
        const onKey = (_text, key = {}) => {
            if (key.name !== 'return' && !(key.ctrl && key.name === 'c')) return;
            process.stdin.off('keypress', onKey);
            process.stdin.setRawMode?.(Boolean(wasRaw));
            process.stdin.pause();
            resolve();
        };
        process.stdin.on('keypress', onKey);
    });
}

/** OMP-style alternate-screen shell for local onboarding. SSH/non-TTY keeps
 * append-only output so logs and automation remain inspectable. */
export async function withFullscreen(task) {
    if (setupSession) return task();
    setupSession = true;
    persistentReceipt = '';
    if (!fullscreenSupported()) {
        try { return await task(); }
        finally { setupSession = false; }
    }
    fullscreen = true;
    holdFullscreen = false;
    process.stdout.write('\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H');
    const originalOutputWrite = process.stdout.write.bind(process.stdout);
    const originalErrorWrite = process.stderr.write.bind(process.stderr);
    let output = '';
    let errors = '';
    let failed = false;
    process.stdout.write = (chunk, ...args) => {
        output += String(chunk);
        return originalOutputWrite(chunk, ...args);
    };
    process.stderr.write = (chunk, ...args) => {
        errors += String(chunk);
        return originalErrorWrite(chunk, ...args);
    };
    const onExit = () => leaveFullscreen();
    process.once('exit', onExit);
    try {
        const result = await task();
        failed = typeof result === 'number' && result !== 0;
        if (holdFullscreen || failed) await waitForContinue();
        return result;
    } catch (cause) {
        failed = true;
        process.stderr.write(`\n  Setup stopped: ${cause instanceof Error ? cause.message : String(cause)}\n`);
        await waitForContinue();
        throw cause;
    } finally {
        process.stdout.write = originalOutputWrite;
        process.stderr.write = originalErrorWrite;
        process.off('exit', onExit);
        leaveFullscreen();
        setupSession = false;
        // Alternate-screen failures must remain copyable after restoration.
        if (failed) {
            const clear = '\x1b[2J\x1b[H';
            const screen = output.slice(Math.max(0, output.lastIndexOf(clear)));
            const plain = `${screen}\n${errors}`
                .replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '')
                .replaceAll('\r', '\n')
                .trim();
            if (plain) originalErrorWrite(`${plain}\n`);
        } else if (persistentReceipt) {
            originalOutputWrite(`\n◆ ${persistentReceipt}\n\n`);
        }
    }
}

export function setupStep(current, total, title) {
    if (!fullscreen) {
        heading(title);
        return;
    }
    const columns = process.stdout.columns ?? 80;
    const rows = process.stdout.rows ?? 24;
    const center = (text) => `${' '.repeat(Math.max(0, Math.floor((columns - [...text].length) / 2)))}${text}`;
    const width = Math.max(10, Math.min(42, columns - 16));
    const filled = Math.round(width * current / total);
    process.stdout.write('\x1b[2J\x1b[H');
    if (rows >= 34) {
        const logo = [
            '███╗   ███╗██╗   ██╗██╗  ██╗██████╗',
            '████╗ ████║██║   ██║╚██╗██╔╝██╔══██╗',
            '██╔████╔██║██║   ██║ ╚███╔╝ ██████╔╝',
            '██║╚██╔╝██║██║   ██║ ██╔██╗ ██╔══██╗',
            '██║ ╚═╝ ██║╚██████╔╝██╔╝ ██╗██║  ██║',
            '╚═╝     ╚═╝ ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝',
        ];
        process.stdout.write(`\n${logo.map((line) => bold(center(line))).join('\n')}\n`);
        process.stdout.write(`${dim(center('Your agents. One pocket.'))}\n\n`);
    } else {
        process.stdout.write(`\n  ${bold('MUXR')}  ${dim('Your agents. One pocket.')}\n\n`);
    }
    process.stdout.write(`  ${dim(`Setup step ${current} of ${total}`)}\n`);
    process.stdout.write(`  ${green('━'.repeat(filled))}${dim('━'.repeat(width - filled))}\n`);
    process.stdout.write(`\n  ${bold(title)}\n\n`);
}

export function completeFullscreen() {
    holdFullscreen = fullscreen;
}

export function intro() {
    process.stdout.write(`\n${bold('  ███╗   ███╗██╗   ██╗██╗  ██╗██████╗')}\n`);
    process.stdout.write(`${bold('  ████╗ ████║██║   ██║╚██╗██╔╝██╔══██╗')}\n`);
    process.stdout.write(`${bold('  ██╔████╔██║██║   ██║ ╚███╔╝ ██████╔╝')}\n`);
    process.stdout.write(`${bold('  ██║╚██╔╝██║██║   ██║ ██╔██╗ ██╔══██╗')}\n`);
    process.stdout.write(`${bold('  ██║ ╚═╝ ██║╚██████╔╝██╔╝ ██╗██║  ██║')}\n`);
    process.stdout.write(`${bold('  ╚═╝     ╚═╝ ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝')}\n`);
    process.stdout.write(`\n  ${dim('Your agents. One pocket.')}\n\n`);
}

export function heading(text) {
    process.stdout.write(`${bold(`◆ ${text}`)}\n`);
}

export function status(label, detail, kind = 'ok') {
    let icon = dim('○');
    if (kind === 'ok') icon = green('●');
    else if (kind === 'warn') icon = yellow('●');
    process.stdout.write(`  ${icon} ${label}${detail ? ` ${dim(detail)}` : ''}\n`);
}

export function note(lines) {
    const values = Array.isArray(lines) ? lines : [lines];
    process.stdout.write(`  ${dim('│')}\n`);
    for (const line of values) process.stdout.write(`  ${dim('│')} ${line}\n`);
    process.stdout.write(`  ${dim('└')}\n`);
}

export function outro(text, kind = 'ok') {
    if (setupSession) persistentReceipt = text;
    process.stdout.write(`\n${kind === 'ok' ? green('◆') : yellow('◆')} ${bold(text)}\n\n`);
}

// Returned by select() on escape/left so callers can go up one level;
// ctrl-c still resolves undefined and means quit.
export const BACK = Symbol('muxr.back');

export async function select(message, choices, initial = 0) {
    if (!interactive()) return choices[initial]?.value;
    if (!richInteractive()) {
        process.stdout.write(`${bold(`◆ ${message}`)}\n`);
        choices.forEach((choice, index) => {
            process.stdout.write(`  ${index + 1}. ${choice.disabled ? dim(choice.title) : choice.title}${choice.disabled ? ` ${dim('(unavailable)')}` : ''}\n`);
            if (choice.description) process.stdout.write(`     ${dim(choice.description)}\n`);
        });
        for (;;) {
            const reader = createInterface({ input: process.stdin, output: process.stdout });
            const hint = initial >= 0 ? ` (${initial + 1})` : '';
            const back = setupSession ? 'cancel setup' : 'go back';
            const answer = await new Promise((resolve) => {
                reader.once('SIGINT', () => setupSession ? process.exit(130) : resolve(undefined));
                reader.question(`  Choose 1-${choices.length}${hint}, or b to ${back}: `, resolve);
            });
            reader.close();
            if (answer === undefined) return undefined;
            const value = String(answer).trim().toLowerCase();
            if (value === 'b' || value === 'back') return BACK;
            const index = value === '' ? initial : Number(value) - 1;
            if (Number.isInteger(index) && choices[index] !== undefined && !choices[index].disabled) return choices[index].value;
            process.stdout.write('  Enter the number of an available option.\n');
        }
    }
    emitKeypressEvents(process.stdin);
    const wasRaw = process.stdin.isRaw;
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    const selectable = choices.map((choice) => !choice.disabled);
    if (!selectable.some(Boolean)) selectable.fill(true);
    let selected = Math.max(0, Math.min(initial, choices.length - 1));
    while (!selectable[selected]) selected = (selected + 1) % choices.length;
    // Long descriptions (e.g. detection reasons with remedies) wrap; count the
    // wrapped rows or the cursor-up redraw smears the frame.
    const frameRows = () => {
        const width = process.stdout.columns || 80;
        const wrapped = (length) => Math.max(1, Math.ceil(length / width));
        return wrapped(2 + message.length)
            + choices.reduce((total, choice, index) => {
                const unavailable = choice.disabled ? 14 : 0;
                const cursor = index === selected ? 2 : 0;
                return total
                + wrapped(4 + choice.title.length + unavailable + cursor)
                + (choice.description ? wrapped(6 + choice.description.length) : 0);
            }, 0)
            + 1;
    };
    const draw = (first = false) => {
        if (!first) process.stdout.write(`\x1b[${lastRows}A`);
        process.stdout.write(`${bold(`◆ ${message}`)}\x1b[K\n`);
        choices.forEach((choice, index) => {
            const active = index === selected;
            let marker = dim('○');
            if (choice.disabled) marker = dim('○');
            else if (active) marker = green('●');
            let label = choice.title;
            if (choice.disabled) label = dim(`${choice.title} · unavailable`);
            else if (active) label = inverse(` ${choice.title} `);
            process.stdout.write(`  ${marker} ${label}\x1b[K\n`);
            if (choice.description) process.stdout.write(`      ${dim(choice.description)}\x1b[K\n`);
        });
        process.stdout.write(`  ${dim(setupSession ? 'esc cancel setup · ctrl-c quit' : 'esc back · ctrl-c quit')}\x1b[K\n`);
        lastRows = frameRows();
    };
    let lastRows = 0;
    draw(true);
    return new Promise((resolve) => {
        const cleanup = () => {
            process.stdin.off('keypress', onKey);
            process.stdin.setRawMode?.(Boolean(wasRaw));
            process.stdin.pause();
        };
        const onKey = (_text, key = {}) => {
            if (key.ctrl && key.name === 'c') {
                cleanup();
                process.stdout.write('\n');
                if (setupSession) process.exit(130);
                else resolve(undefined);
                return;
            }
            if (key.name === 'escape' || key.name === 'left') {
                cleanup();
                process.stdout.write('\n');
                resolve(BACK);
                return;
            }
            if (key.name === 'up' || key.name === 'k') {
                do selected = (selected - 1 + choices.length) % choices.length;
                while (!selectable[selected]);
            } else if (key.name === 'down' || key.name === 'j') {
                do selected = (selected + 1) % choices.length;
                while (!selectable[selected]);
            } else if (key.name === 'return') {
                cleanup();
                resolve(choices[selected].value);
                return;
            } else return;
            draw();
        };
        process.stdin.on('keypress', onKey);
    });
}

export async function prompt(message, initial = '') {
    if (!interactive()) return initial;
    const suffix = initial ? ` ${dim(`(${initial})`)}` : '';
    if (fullscreen) process.stdout.write('\x1b[?25h');
    const reader = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise((resolve) => {
        let settled = false;
        const finish = (value) => {
            if (settled) return;
            settled = true;
            resolve(value);
        };
        reader.once('SIGINT', () => setupSession ? process.exit(130) : finish(undefined));
        reader.question(`${bold(`◆ ${message}`)}${suffix}\n  › `, finish);
    });
    reader.close();
    if (fullscreen) process.stdout.write('\x1b[?25l');
    return typeof answer === 'string' ? answer.trim() || initial : undefined;
}

export async function withSpinner(label, task) {
    if (!richInteractive()) {
        process.stdout.write(`  … ${label}\n`);
        return task();
    }
    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    let index = 0;
    process.stdout.write(`  ${frames[index]} ${label}`);
    const timer = setInterval(() => {
        index = (index + 1) % frames.length;
        process.stdout.write(`\r  ${frames[index]} ${label}`);
    }, 80);
    try {
        const result = await task();
        clearInterval(timer);
        process.stdout.write(`\r  ${green('✓')} ${label}\x1b[K\n`);
        return result;
    } catch (error) {
        clearInterval(timer);
        process.stdout.write(`\r  ${yellow('!')} ${label}\x1b[K\n`);
        throw error;
    }
}
