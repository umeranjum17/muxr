#!/usr/bin/env node
// Snapshots one herdr pane's scrollback into lib/desk.json.
//
// The film's central claim is that the phone and the desk are two windows onto
// one pane, so the film has to show the desk. Rather than screenshot the user's
// actual display, it takes the pane's real text and draws it in the film's own
// chrome — the same deal the captures make: real content, drawn frame.
//
// Committed so the film renders without a live host.
//
// Usage: node capture/desk.mjs <paneLabel>            (default: ui-polish)
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

/** Anything that is routing state rather than something a person named. */
const FORBIDDEN = [
    /\b[a-zA-Z]{2,4}[0-9A-Z]{1,3}:[a-z][0-9A-Za-z]{1,4}\b/, // pane/tab ids
    /\bterm_[0-9a-f]+\b/,
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/,
    /\b(Bearer|token|secret|api[_-]?key)\b/i,
];

const label = process.argv[2] ?? 'ui-polish';

async function main() {
    const { stdout: listOut } = await exec('herdr', ['pane', 'list'], { maxBuffer: 1 << 24 });
    const pane = JSON.parse(listOut).result.panes.find((p) => p.label === label);
    if (pane === undefined) throw new Error(`no pane labelled ${label}`);

    const id = pane.paneId ?? pane.pane_id;
    // recent-unwrapped gives prose at its real width; the pane is narrow and
    // `visible` returns it hard-wrapped mid-sentence. Fall back if the agent is
    // busy, because that source refuses while it is not idle.
    let stdout = '';
    for (const source of ['recent-unwrapped', 'visible']) {
        try {
            ({ stdout } = await exec('herdr', ['pane', 'read', id, '--source', source, '--lines', '40'], { maxBuffer: 1 << 24 }));
            if (stdout.trim() !== '' && !stdout.includes('agent_not_idle')) break;
        } catch {
            // try the next source
        }
    }

    const lines = stdout
        .split('\n')
        .map((line) => line.replace(/\s+$/, ''))
        // The pane is drawn for a terminal; the horizontal rules and the status
        // line are chrome we redraw ourselves.
        .filter((line) => !/^[\s─│┌┐└┘├┤┬┴┼]+$/.test(line))
        .filter((line) => line.trim() !== '')
        // The agent's own status footer is pane chrome, and it carries spend and
        // context ratios that mean nothing outside the terminal.
        .filter((line) => !/^~?[/~]|^\s*[↑↓]|^\s*○|ponytail:/.test(line))
        // Markdown survives the pane's narrow wrap as pipe soup, half-open
        // code spans and orphaned headings. The prose is what reads at film
        // size, so keep the prose and nothing else.
        .filter((line) => !/\|/.test(line) && !/^\s*-{2,}/.test(line))
        .filter((line) => !/^\s*(#|`|\.\.\. \()/.test(line));

    // The pane draws a one-column gutter. Keeping it would set the scrollback
    // one character in from the plate's own padding.
    const flush = lines.every((line) => line.startsWith(' ')) ? lines.map((line) => line.slice(1)) : lines;

    const offenders = flush.filter((line) => FORBIDDEN.some((re) => re.test(line)));
    if (offenders.length > 0) {
        throw new Error(`refusing to snapshot: routing state or a secret is on screen\n  ${offenders.join('\n  ')}`);
    }

    const snapshot = {
        label: pane.label,
        agent: pane.agent ?? 'shell',
        branch: (pane.cwd ?? '').split('/').pop() ?? '',
        lines: flush.slice(-20),
    };
    await writeFile(path.join(root, 'lib', 'desk.json'), `${JSON.stringify(snapshot, null, 4)}\n`);
    console.log(`--> lib/desk.json  ${snapshot.lines.length} lines from ${snapshot.label}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
