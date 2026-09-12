/**
 * `muxr surface|browser|code` commands (Slice 2A).
 *
 * Semantic, provider-neutral entries over the host-local Surface broker:
 *
 * - `muxr surface capabilities --json`
 * - `muxr browser open <https-url|http://localhost:PORT/path> [--beside|--focus] [--name NAME] [--provider ID]`
 * - `muxr browser update [URL]`, `muxr browser reload`, `muxr browser close`
 * - `muxr browser session {open,navigate,snapshot,click,fill,scroll,help,close}`
 * - `muxr code open <path[:line[:column]]>`, `muxr code diff [path]`
 * - `muxr surface list`
 *
 * The agent's own browser is a broker-owned session with an enforceable human
 * handover: `session open` starts it (the provider creates the context before
 * any browsing), and `session help` only asks the owner to sign in. It never
 * conveys a credential and never prints a port, provider, session handle or
 * secret.
 *
 * Replies distinguish accepted, visible and failed. Human-readable by
 * default, JSON with `--json`. Logical names and titles only: offer, session,
 * pane, lease and device ids never print, and neither do secrets.
 */
import { callSurfaceBroker, redactForDisplay } from './brokerClient.mjs';

function usageError(message) {
    const error = new Error(message);
    error.code = 'usage';
    throw error;
}

/**
 * Flags and `--opt value` options may appear anywhere; positionals are
 * whatever is left. A bare `--` separates: everything after it is
 * positional, so shims can pass `-- "$target"` safely.
 */
function splitArgs(args, { flags = [], options = [] } = {}) {
    const found = new Set();
    const values = {};
    const positionals = [];
    let positionalOnly = false;
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (!positionalOnly && arg === '--') {
            positionalOnly = true;
            continue;
        }
        if (!positionalOnly && flags.includes(arg)) {
            found.add(arg);
            continue;
        }
        if (!positionalOnly && options.includes(arg)) {
            const value = args[index + 1];
            if (value === undefined || value.startsWith('--')) usageError(`${arg} needs a value`);
            values[arg] = value;
            index += 1;
            continue;
        }
        if (!positionalOnly) {
            const inline = options.find((name) => arg.startsWith(`${name}=`));
            if (inline !== undefined) {
                values[inline] = arg.slice(inline.length + 1);
                continue;
            }
        }
        positionals.push(arg);
    }
    return { flags: found, options: values, positionals };
}

function describeSurface(surface) {
    if (typeof surface !== 'object' || surface === null) return 'surface';
    const name = typeof surface.name === 'string' ? surface.name : 'surface';
    const revision = typeof surface.revision === 'number' ? ` (revision ${surface.revision})` : '';
    const placement = typeof surface.placement === 'string' && surface.placement !== 'replace' ? `, ${surface.placement}` : '';
    if (surface.kind === 'browser-direct' && typeof surface.url === 'string') {
        return `browser ${JSON.stringify(name)}${revision}${placement} -> ${surface.url}`;
    }
    if (surface.kind === 'browser-local') {
        return `browser ${JSON.stringify(name)}${revision}${placement} -> local app${typeof surface.path === 'string' ? ` ${surface.path}` : ''}`;
    }
    if (surface.kind === 'browser-session') {
        const where = typeof surface.site === 'string' && surface.site !== '' ? ` -> ${surface.site}` : ' (blank)';
        return `agent browser ${JSON.stringify(name)}${revision}${placement}${where}`;
    }
    if (surface.kind === 'code-review' && typeof surface.path === 'string') {
        const anchor = typeof surface.line === 'number' ? `:${surface.line}${typeof surface.column === 'number' ? `:${surface.column}` : ''}` : '';
        const verb = surface.destination === 'diff' ? 'diff' : 'open';
        return `code ${JSON.stringify(name)}${revision} -> ${surface.path}${anchor} (${verb}, review)`;
    }
    return `${JSON.stringify(name)}${revision}${placement}`;
}

function printResult(data, json) {
    const clean = redactForDisplay(data);
    if (json) {
        process.stdout.write(`${JSON.stringify({ ok: true, ...(typeof clean === 'object' && clean !== null ? clean : { data: clean }) }, null, 2)}\n`);
        return;
    }
    if (typeof clean !== 'object' || clean === null) {
        process.stdout.write('Done.\n');
        return;
    }
    if (Array.isArray(clean.capabilities)) {
        const lines = clean.capabilities.map((entry) => {
            const name = typeof entry?.capability === 'string' ? entry.capability : 'surface';
            const state = entry?.available !== true ? 'unavailable' : entry?.ambiguous === true ? 'ambiguous — pass --provider' : 'available';
            return `${name} (${state})`;
        });
        process.stdout.write(`Surface capabilities:\n${lines.map((line) => `- ${line}`).join('\n')}\n`);
        return;
    }
    if (Array.isArray(clean.surfaces)) {
        if (clean.surfaces.length === 0) {
            process.stdout.write('No open surfaces.\n');
            return;
        }
        for (const surface of clean.surfaces) process.stdout.write(`- ${describeSurface(surface)}\n`);
        return;
    }
    const outcome = clean.outcome;
    if (outcome === 'accepted') {
        process.stdout.write(`Accepted ${describeSurface(clean.surface)}.\n`);
        if (clean.help === 'waiting-for-you') process.stdout.write('Asked the owner to sign in; automation is paused until they hand back.\n');
        return;
    }
    if (outcome === 'visible') {
        if (clean.surface !== undefined) process.stdout.write(`Visible ${describeSurface(clean.surface)}.\n`);
        else process.stdout.write('Visible.\n');
        if (typeof clean.text === 'string' && clean.text !== '') process.stdout.write(`${clean.text}\n`);
        return;
    }
    if (outcome === 'closed') {
        process.stdout.write(`Closed ${JSON.stringify(clean.name ?? 'surface')}.\n`);
        return;
    }
    process.stdout.write('Done.\n');
}

export async function runSurfaceCli(argv) {
    const [command, ...input] = argv;
    const global = splitArgs(input, { flags: ['--json'] });
    const json = global.flags.has('--json');
    const args = [...global.positionals];
    for (const [name, value] of Object.entries(global.options)) args.push(name, value);
    try {
        if (command === 'surface') {
            const [sub, ...rest] = args;
            if (sub === 'capabilities' && rest.length === 0) {
                printResult(await callSurfaceBroker({ method: 'capabilities' }), json);
                return 0;
            }
            if ((sub === 'list' || sub === undefined) && (rest.length === 0 || sub === undefined)) {
                if (sub === undefined && rest.length > 0) usageError('usage: muxr surface list');
                printResult(await callSurfaceBroker({ method: 'surface.list' }), json);
                return 0;
            }
            if (sub === 'close' && rest.length <= 1) {
                const parsed = splitArgs(rest, { options: ['--name'] });
                const name = parsed.options['--name'] ?? parsed.positionals[0];
                if (parsed.positionals.length > 1) usageError('usage: muxr surface close [NAME] [--json]');
                printResult(await callSurfaceBroker({ method: 'browser.close', ...(name === undefined ? {} : { name }) }), json);
                return 0;
            }
            usageError('usage: muxr surface capabilities [--json] | muxr surface list [--json] | muxr surface close [NAME] [--json]');
        }
        if (command === 'browser') {
            const [sub, ...rest] = args;
            if (sub === 'session') {
                return await runBrowserSession(rest, json);
            }
            if (sub === 'home') {
                const parsed = splitArgs(rest, { flags: ['--beside', '--focus'], options: ['--name'] });
                if (parsed.positionals.length > 0) usageError('usage: muxr browser home [--beside|--focus] [--name NAME]');
                printResult(await callSurfaceBroker({
                    method: 'browser.open',
                    target: 'about:blank',
                    ...(parsed.options['--name'] === undefined ? {} : { name: parsed.options['--name'] }),
                    ...placementOf(parsed),
                }), json);
                return 0;
            }
            if (sub === 'open') {
                const parsed = splitArgs(rest, { flags: ['--beside', '--focus'], options: ['--name', '--provider'] });
                if (parsed.positionals.length !== 1) usageError('usage: muxr browser open <https-url|http://localhost:PORT/path> [--beside|--focus] [--name NAME] [--provider ID]');
                printResult(await callSurfaceBroker({
                    method: 'browser.open',
                    target: parsed.positionals[0],
                    ...(parsed.options['--name'] === undefined ? {} : { name: parsed.options['--name'] }),
                    ...placementOf(parsed),
                    ...(parsed.options['--provider'] === undefined ? {} : { provider: parsed.options['--provider'] }),
                }), json);
                return 0;
            }
            if (sub === 'update') {
                const parsed = splitArgs(rest, { flags: ['--beside', '--focus'], options: ['--name', '--provider'] });
                if (parsed.positionals.length > 1) usageError('usage: muxr browser update [URL] [--beside|--focus] [--name NAME] [--provider ID]');
                printResult(await callSurfaceBroker({
                    method: 'browser.update',
                    ...(parsed.positionals[0] === undefined ? {} : { target: parsed.positionals[0] }),
                    ...(parsed.options['--name'] === undefined ? {} : { name: parsed.options['--name'] }),
                    ...placementOf(parsed),
                    ...(parsed.options['--provider'] === undefined ? {} : { provider: parsed.options['--provider'] }),
                }), json);
                return 0;
            }
            if (sub === 'reload' || sub === 'close') {
                const parsed = splitArgs(rest, { options: ['--name'] });
                if (parsed.positionals.length > 1) usageError(`usage: muxr browser ${sub} [--name NAME]`);
                const name = parsed.options['--name'] ?? parsed.positionals[0];
                printResult(await callSurfaceBroker({
                    method: sub === 'reload' ? 'browser.reload' : 'browser.close',
                    ...(name === undefined ? {} : { name }),
                }), json);
                return 0;
            }
            usageError('usage: muxr browser open|home|update|reload|close|session ...');
        }
        if (command === 'code') {
            const [sub, ...rest] = args;
            if (sub === 'open' || sub === 'diff') {
                const parsed = splitArgs(rest, { flags: ['--beside', '--focus'], options: ['--name', '--provider'] });
                if (sub === 'open' && parsed.positionals.length !== 1) usageError('usage: muxr code open <path[:line[:column]]> [--beside|--focus] [--name NAME] [--provider ID]');
                if (sub === 'diff' && parsed.positionals.length > 1) usageError('usage: muxr code diff [path] [--beside|--focus] [--name NAME] [--provider ID]');
                printResult(await callSurfaceBroker({
                    method: sub === 'open' ? 'code.open' : 'code.diff',
                    ...(parsed.positionals[0] === undefined ? {} : { target: parsed.positionals[0] }),
                    ...(parsed.options['--name'] === undefined ? {} : { name: parsed.options['--name'] }),
                    ...placementOf(parsed),
                    ...(parsed.options['--provider'] === undefined ? {} : { provider: parsed.options['--provider'] }),
                }), json);
                return 0;
            }
            usageError('usage: muxr code open <path[:line[:column]]> | muxr code diff [path]');
        }
        usageError('usage: muxr surface|browser|code ...');
    } catch (error) {
        if (error?.code === 'usage') {
            process.stderr.write(`${error.message}\n`);
            return 2;
        }
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        return 1;
    }
    return 1;
}

async function runBrowserSession(args, json) {
    const [verb, ...rest] = args;
    const nameOf = (parsed) => (parsed.options['--name'] === undefined ? {} : { name: parsed.options['--name'] });
    if (verb === 'open') {
        const parsed = splitArgs(rest, { flags: ['--beside', '--focus'], options: ['--name', '--provider'] });
        if (parsed.positionals.length > 0) usageError('usage: muxr browser session open [--beside|--focus] [--name NAME] [--provider ID]');
        printResult(await callSurfaceBroker({
            method: 'browser.session.open',
            ...nameOf(parsed),
            ...placementOf(parsed),
            ...(parsed.options['--provider'] === undefined ? {} : { provider: parsed.options['--provider'] }),
        }), json);
        return 0;
    }
    if (verb === 'navigate') {
        const parsed = splitArgs(rest, { options: ['--name'] });
        if (parsed.positionals.length !== 1) usageError('usage: muxr browser session navigate <http(s)-url> [--name NAME]');
        printResult(await callSurfaceBroker({ method: 'browser.session.navigate', url: parsed.positionals[0], ...nameOf(parsed) }), json);
        return 0;
    }
    if (verb === 'click' || verb === 'fill') {
        const parsed = splitArgs(rest, { options: ['--name'] });
        if (verb === 'click' && parsed.positionals.length !== 1) usageError('usage: muxr browser session click <snapshot-number|selector> [--name NAME]');
        if (verb === 'fill' && parsed.positionals.length !== 2) usageError('usage: muxr browser session fill <snapshot-number|selector> <text> [--name NAME]');
        printResult(await callSurfaceBroker({
            method: `browser.session.${verb}`,
            target: parsed.positionals[0],
            ...(verb === 'fill' ? { text: parsed.positionals[1] } : {}),
            ...nameOf(parsed),
        }), json);
        return 0;
    }
    if (verb === 'scroll') {
        const parsed = splitArgs(rest, { options: ['--name'] });
        if (parsed.positionals.length !== 1) usageError('usage: muxr browser session scroll <pixels> [--name NAME]');
        const dy = Number(parsed.positionals[0]);
        if (!Number.isFinite(dy)) usageError('scroll needs a distance in pixels');
        printResult(await callSurfaceBroker({ method: 'browser.session.scroll', dy, ...nameOf(parsed) }), json);
        return 0;
    }
    if (verb === 'snapshot' || verb === 'help' || verb === 'close') {
        const parsed = splitArgs(rest, { options: ['--name'] });
        if (parsed.positionals.length > 0) usageError(`usage: muxr browser session ${verb} [--name NAME]`);
        printResult(await callSurfaceBroker({ method: `browser.session.${verb}`, ...nameOf(parsed) }), json);
        return 0;
    }
    usageError('usage: muxr browser session open|navigate|snapshot|click|fill|scroll|help|close');
}

function placementOf(parsed) {
    const beside = parsed.flags.has('--beside');
    const focus = parsed.flags.has('--focus');
    if (beside && focus) usageError('choose --beside or --focus, not both');
    if (beside) return { placement: 'beside' };
    if (focus) return { placement: 'focus' };
    return {};
}
