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
//   node typeFocusedSecret.mjs --serial <serial> --text <secret>
//     [--expect <expected>] [--adb <path>]
// `--expect` compares the readback against a different string instead, which
// is how a corrupted readback is proven to fail. Exit 0 on match, 1 otherwise.

const adbPath = valueOf('--adb') || process.env.ADB || 'adb';
const serial = valueOf('--serial');
const text = valueOf('--text');
const expect = valueOf('--expect') ?? text;
if (!serial || text === undefined) {
    process.stderr.write('Usage: typeFocusedSecret.mjs --serial <serial> --text <secret> [--expect <expected>] [--adb <path>]\n');
    process.exit(2);
}
if (text.includes('%') || (valueOf('--expect') ?? '').includes('%')) {
    process.stderr.write('FAIL: text contains % which `adb shell input text` reserves (%s means space)\n');
    process.exit(2);
}
if (!/^[A-Za-z0-9 \/+=\-.,_:@]*$/.test(text)) {
    process.stderr.write('FAIL: text has characters outside the input-safe charset [A-Za-z0-9 /+=.,_:@ and space]\n');
    process.exit(2);
}

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
// to avoid.
for (const char of text) {
    await shell('input', 'text', encodeChar(char));
}

let readback;
for (let attempt = 0; attempt < 30; attempt++) {
    await shell('uiautomator', 'dump', dumpPath);
    const xml = await shell('cat', dumpPath);
    const focused = focusedTexts(xml);
    if (focused.includes(expect)) {
        readback = expect;
        break;
    }
    if (focused.length > 0) readback = focused[0];
    await new Promise((resolve) => setTimeout(resolve, 500));
}
if (readback === undefined) {
    process.stderr.write(`FAIL: no focused text field readable on ${serial} (uiautomator dump has no focused node)\n`);
    process.exit(1);
}
if (readback !== expect) {
    const first = [...expect].findIndex((char, index) => char !== readback[index]);
    const at = first === -1 ? Math.min(expect.length, readback.length) : first;
    const show = (value) => (at < value.length ? `'${value[at]}' (U+${value.codePointAt(at).toString(16).toUpperCase()})` : '<end of string>');
    process.stderr.write(
        `FAIL: readback differs at index ${at}: expected ${show(expect)} got ${show(readback)} ` +
        `(expected ${expect.length} chars, read ${readback.length})\n`,
    );
    process.exit(1);
}
process.stdout.write(`PASS: typed and verified ${expect.length} chars on ${serial}\n`);
