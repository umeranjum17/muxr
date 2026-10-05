import { execFile } from 'node:child_process';

// Types a long secret (e.g. an SSH public key) into the currently focused
// Android text field over adb, then reads the field back and verifies it.
//
// `adb shell input text` silently drops and reorders characters in a long
// string, so this helper sends one strictly sequential `input text` call per
// character and compares the uiautomator readback against the typed string.
//
// The target field is either named with `--field` (its accessibility
// identity: the testID Android reports as resource-id, or the content-desc)
// or, without `--field`, the field that already holds focus. A named field is
// found in a fresh uiautomator dump: the keyboard is hidden first because it
// covers the lower fields while the form re-scrolls, and the form is scrolled
// until the node appears. The tap goes to the bounds that same dump reports,
// never a remembered coordinate; a field that cannot be found fails with why.
//
// Before typing, the field is cleared like a person would (select-all, then
// delete) and read back: residue left by an earlier attempt fails with the
// residue quoted instead of being typed over.
//
// Preconditions:
// - text stays within the input-safe charset below (letters, digits, space
//   and `%s`-free symbols); `%` is rejected because `input text` reserves
//   `%s` as a space.
//
// Usage:
//   node checkFocusedSecretTyping.mjs --serial <serial> --text <secret>
//     [--field <testID or content-desc>] [--expect <expected>] [--adb <path>]
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
const field = valueOf('--field');
// Multi-line mode compares against the accumulated text (separators removed);
// without `\n` in the typed text the expectation is the raw value as before.
const multiline = text?.includes('\n') ?? false;
const accumulated = (value) => value.replace(/\r?\n/g, '');
const expect = multiline ? accumulated(valueOf('--expect') ?? text) : valueOf('--expect') ?? text;
if (!serial || text === undefined) {
    process.stderr.write('Usage: checkFocusedSecretTyping.mjs --serial <serial> --text <secret> [--field <identity>] [--expect <expected>] [--adb <path>]\n');
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

// uiautomator writes a newline in a field as `&#10;`, so numeric references
// are decoded too; left raw, each line break reads back as five extra chars.
function unescapeXml(value) {
    return value.replace(/&(?:(amp|lt|gt|quot|apos)|#(\d+)|#x([0-9a-fA-F]+));/g, (_, name, dec, hex) => (
        name ? { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[name] : String.fromCodePoint(dec ? Number(dec) : parseInt(hex, 16))
    ));
}

function focusedTexts(xml) {
    return [...xml.matchAll(/<node\b[^>]*focused="true"[^>]*>/g)]
        .map(([tag]) => tag.match(/\btext="([^"]*)"/)?.[1])
        .filter((value) => value !== undefined)
        .map(unescapeXml);
}

const dumpPath = '/sdcard/muxr_type_secret.xml';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fail = (message) => {
    process.stderr.write(`FAIL: ${message}\n`);
    process.exit(1);
};

async function dump() {
    await shell('uiautomator', 'dump', dumpPath);
    return shell('cat', dumpPath);
}

const nodeTags = (xml) => [...xml.matchAll(/<node\b[^>]*>/g)].map(([tag]) => tag);

function attr(tag, name) {
    const value = tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
    return value === undefined ? undefined : unescapeXml(value);
}

// RN reports a testID as the bare resource-id; a native view reports `pkg:id/name`.
const hasIdentity = (tag) => {
    const id = attr(tag, 'resource-id') ?? '';
    return id === field || id.endsWith(`:id/${field}`) || attr(tag, 'content-desc') === field;
};

const bounds = (tag) => (attr(tag, 'bounds')?.match(/\d+/g) ?? []).map(Number);

function centre(tag) {
    const [x1, y1, x2, y2] = bounds(tag);
    return [Math.round((x1 + x2) / 2), Math.round((y1 + y2) / 2)];
}

async function keyboardShown() {
    return /\bmInputShown=true\b/.test(await shell('dumpsys', 'input_method'));
}

// Hide the keyboard (an IME consumes BACK while shown, so this never navigates),
// then scroll the form down to its end and back up until the field appears.
async function findField() {
    if (await keyboardShown()) {
        await shell('input', 'keyevent', 'KEYCODE_BACK');
        await sleep(700);
    }
    let direction = 1;
    let previous;
    for (let swipes = 0; swipes <= 24; swipes++) {
        const tags = nodeTags(await dump());
        const tag = tags.find(hasIdentity);
        if (tag) return tag;
        // The form has stopped moving once every node sits where it sat
        // before the last swipe: that end is reached, so turn around.
        const layout = tags.map((candidate) => attr(candidate, 'bounds')).join();
        if (layout === previous) {
            if (direction === -1) break;
            direction = -1;
        }
        previous = layout;
        // The form is the tallest scrollable node, not a tab strip beside it.
        const height = (candidate) => bounds(candidate)[3] - bounds(candidate)[1];
        const scroller = tags
            .filter((candidate) => attr(candidate, 'scrollable') === 'true')
            .sort((a, b) => height(b) - height(a))[0];
        if (!scroller) {
            fail(`field '${field}' not found on ${serial}: no node has that resource-id or content-desc and the screen has no scrollable form to search`);
        }
        const [x, y] = centre(scroller);
        const reach = Math.round(height(scroller) / 4);
        await shell('input', 'swipe', `${x}`, `${y + direction * reach}`, `${x}`, `${y - direction * reach}`, '400');
        await sleep(500);
    }
    fail(`field '${field}' not found on ${serial}: no node has that resource-id or content-desc anywhere in the scrolled form; nothing was tapped`);
}

if (field !== undefined) {
    const [x, y] = centre(await findField());
    await shell('input', 'tap', `${x}`, `${y}`);
    let focusedOnField = false;
    for (let attempt = 0; attempt < 10 && !focusedOnField; attempt++) {
        await sleep(300);
        focusedOnField = nodeTags(await dump()).some((tag) => hasIdentity(tag) && attr(tag, 'focused') === 'true');
    }
    if (!focusedOnField) fail(`field '${field}' on ${serial} did not take focus after a tap at its reported bounds (${x},${y})`);
} else if (focusedTexts(await dump()).length === 0) {
    fail(`no focused text field on ${serial}; name one with --field or focus a field first`);
}

// Clear the field the way a person would, then prove it is empty before a
// single character goes in. An empty field reports its placeholder as text, so
// the hint counts as empty.
await shell('input', 'keycombination', 'KEYCODE_CTRL_LEFT', 'KEYCODE_A');
await shell('input', 'keyevent', 'KEYCODE_DEL');
let residue;
let clearedTag;
for (let attempt = 0; attempt < 10 && clearedTag === undefined; attempt++) {
    await sleep(300);
    const tag = nodeTags(await dump()).find((candidate) => (
        attr(candidate, 'focused') === 'true' && attr(candidate, 'text') !== undefined && (field === undefined || hasIdentity(candidate))
    ));
    if (tag === undefined) continue;
    const value = attr(tag, 'text');
    residue = value === '' || value === attr(tag, 'hint') ? undefined : value;
    if (residue === undefined) clearedTag = tag;
}
if (clearedTag === undefined && residue === undefined) fail(`no focused text field left on ${serial} after clearing; nothing was typed`);
if (clearedTag === undefined) fail(`field still holds residue after select-all and delete on ${serial}: ${JSON.stringify(residue)}; nothing was typed`);

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
