import { createInterface, emitKeypressEvents } from 'node:readline';

const interactive = () => Boolean(process.stdin.isTTY && process.stdout.isTTY);
const ansi = (code, text) => interactive() && process.env.NO_COLOR === undefined ? `\x1b[${code}m${text}\x1b[0m` : text;
const dim = (text) => ansi('2', text);
const bold = (text) => ansi('1', text);
const green = (text) => ansi('32', text);
const yellow = (text) => ansi('33', text);
const inverse = (text) => ansi('7', text);

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
    const icon = kind === 'ok' ? green('●') : kind === 'warn' ? yellow('●') : dim('○');
    process.stdout.write(`  ${icon} ${label}${detail ? ` ${dim(detail)}` : ''}\n`);
}

export function note(lines) {
    const values = Array.isArray(lines) ? lines : [lines];
    process.stdout.write(`  ${dim('│')}\n`);
    for (const line of values) process.stdout.write(`  ${dim('│')} ${line}\n`);
    process.stdout.write(`  ${dim('└')}\n`);
}

export function outro(text) {
    process.stdout.write(`\n${green('◆')} ${bold(text)}\n\n`);
}

// Returned by select() on escape/left so callers can go up one level;
// ctrl-c still resolves undefined and means quit.
export const BACK = Symbol('muxr.back');

export async function select(message, choices, initial = 0) {
    if (!interactive()) return choices[initial]?.value;
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
            + choices.reduce((total, choice, index) => total + wrapped(4 + choice.title.length + (index === selected ? 2 : 0)
                + (choice.description ? choice.description.length + 1 : 0)), 0)
            + 1;
    };
    const draw = (first = false) => {
        if (!first) process.stdout.write(`\x1b[${lastRows}A`);
        process.stdout.write(`${bold(`◆ ${message}`)}\x1b[K\n`);
        choices.forEach((choice, index) => {
            const active = index === selected;
            const marker = choice.disabled ? dim('○') : active ? green('●') : dim('○');
            const label = choice.disabled ? dim(choice.title) : active ? inverse(` ${choice.title} `) : choice.title;
            process.stdout.write(`  ${marker} ${label}${choice.description ? ` ${dim(choice.description)}` : ''}\x1b[K\n`);
        });
        process.stdout.write(`  ${dim('esc back · ctrl-c quit')}\x1b[K\n`);
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
                resolve(undefined);
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
    const reader = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise((resolve) => {
        let settled = false;
        const finish = (value) => {
            if (settled) return;
            settled = true;
            resolve(value);
        };
        reader.once('SIGINT', () => finish(undefined));
        reader.question(`${bold(`◆ ${message}`)}${suffix}\n  › `, finish);
    });
    reader.close();
    return typeof answer === 'string' ? answer.trim() || initial : undefined;
}

export async function withSpinner(label, task) {
    if (!interactive()) {
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
