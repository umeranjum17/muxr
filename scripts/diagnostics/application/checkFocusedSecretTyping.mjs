import { execFile } from 'node:child_process';

// Types a long secret (e.g. an SSH public key) into the currently focused
// Android text field over adb, then reads the field back and verifies it.
//
// `adb shell input text` silently drops and reorders characters in a long
// string, so this helper sends one strictly sequential `input text` call per
// character and compares the uiautomator readback against the typed string.
//
// Preconditions (the caller owns these; this helper focuses nothing itself):
// - a text field is already focused and empty on the target device.
// - text stays within the input-safe charset below (letters, digits, space
//   and `%s`-free symbols); `%` is rejected because `input text` reserves
//   `%s` as a space.
//
// Usage:
//   node checkFocusedSecretTyping.mjs --serial <serial> --text <secret>
//     [--expect <expected>] [--adb <path>]
// `--expect` compares the readback against a different string instead, which
// is how a corrupted readback is proven to fail. Exit 0 on match, 1 otherwise.
//
// A multi-line secret (`--text` containing `\n`, e.g. an SSH public key) is
// typed one line at a time with an Enter keypress between lines, and the
// readback is compared against the accumulated text: the lines concatenated
// with the separators removed, so the Enter keypresses never count as content
// and leave no residue in the comparison. Without `\n` the helper matches the
// whole field exactly as before.

const adbPath = valueOf('--adb') || process.env.ADB || 'adb';
const serial = valueOf('--serial');
const text = valueOf('--text');
const expect = valueOf('--expect') ?? text;
if (!serial || text === undefined) {
    process.stderr.write('Usage: checkFocusedSecretTyping.mjs --serial <serial> --text <secret> [--expect <expected>] [--adb <path>]\n');
    process.exit(2);
}
if (text.includes('%') || (valueOf('--expect') ?? '').includes('%')) {
    process.stderr.write('FAIL: text contains % which `adb shell input text` reserves (%s means space)\n');
    process.exit(2);
}
if (!/^[A-Za-z0-9 \/+=\-.,_:@\n]*$/.test(text)) {
    process.stderr.write('FAIL: text has characters outside the input-safe charset [A-Za-z0-9 /+=.,_:@, space and newline]\n');
    process.exit(2);
}

// Multi-line mode: without `\n` in the typed text every line below is the
// identity, so the single-line path compares and reports exactly as before.
const multiline = text.includes('\n');
const accumulated = (value) => value.replace(/\r?\n/g, '');
const expected = multiline ? accumulated(expect) : expect;

function valueOf(flag) {
    const index = process.argv.indexOf(flag);
    return index === -1 ? undefined : process.argv[index + 1];
}

function run(args) {
    return new Promise((resolve, reject) => {
        execFile(adbPath, args, { timeout: 30000 }, (error, stdout, stderr) => {
            if (error) reject(new Error(`${args.join(' ')} failed: ${stderr.trim() || error.message}`));
            else resolve(stdout);
        });
    });
}

const shell = (...command) => run(['-s', serial, 'shell', ...command]);

function encodeChar(char) {
    if (char === ' ') return '%s';
    return char;
}

function unescapeXml(value) {
    return value.replace(/&(amp|lt|gt|quot|apos);/g, (_, name) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[name]));
}

function focusedTexts(xml) {
    return [...xml.matchAll(/<node\b[^>]*focused="true"[^>]*>/g)]
        .map(([tag]) => tag.match(/\btext="([^"]*)"/)?.[1])
        .filter((value) => value !== undefined)
        .map(unescapeXml);
}

const dumpPath = '/sdcard/muxr_type_secret.xml';

// Focus nothing: fail fast when no field holds focus instead of typing into the void.
await shell('uiautomator', 'dump', dumpPath);
if (focusedTexts(await shell('cat', dumpPath)).length === 0) {
    process.stderr.write(`FAIL: no focused text field on ${serial}; focus a field first (this helper focuses nothing itself)\n`);
    process.exit(1);
}

// Strictly sequential: one awaited adb call per character. Batching or
// parallel calls reintroduce the drop/reorder behaviour this helper exists
// to avoid. Between the lines of a multi-line secret an Enter keypress
// separates the lines; it carries no content and is stripped from both sides
// of the comparison below.
if (!multiline) {
    for (const char of text) {
        await shell('input', 'text', encodeChar(char));
    }
} else {
    const lines = text.split('\n');
    for (let index = 0; index < lines.length; index++) {
        for (const char of lines[index]) {
            await shell('input', 'text', encodeChar(char));
        }
        if (index < lines.length - 1) await shell('input', 'keyevent', '66');
    }
}

let readback;
for (let attempt = 0; attempt < 30; attempt++) {
    await shell('uiautomator', 'dump', dumpPath);
    const xml = await shell('cat', dumpPath);
    const focused = focusedTexts(xml).map((value) => (multiline ? accumulated(value) : value));
    if (focused.includes(expected)) {
        readback = expected;
        break;
    }
    if (focused.length > 0) readback = focused[0];
    await new Promise((resolve) => setTimeout(resolve, 500));
}
if (readback === undefined) {
    process.stderr.write(`FAIL: no focused text field readable on ${serial} (uiautomator dump has no focused node)\n`);
    process.exit(1);
}
if (readback !== expected) {
    const first = [...expected].findIndex((char, index) => char !== readback[index]);
    const at = first === -1 ? Math.min(expected.length, readback.length) : first;
    const show = (value) => (at < value.length ? `'${value[at]}' (U+${value.codePointAt(at).toString(16).toUpperCase()})` : '<end of string>');
    process.stderr.write(
        `FAIL: readback differs at index ${at}: expected ${show(expected)} got ${show(readback)} ` +
        `(expected ${expected.length} chars, read ${readback.length})\n`,
    );
    process.exit(1);
}
process.stdout.write(`PASS: typed and verified ${expected.length} chars on ${serial}\n`);
