/**
 * The phone's own account of the run, read off the accessibility tree of
 * Settings -> Connection -> Show diagnostics.
 *
 * Never returns a trail it did not read. A missing diagnostics screen parses as
 * zero rows and zero latency, which is indistinguishable from a terminal that
 * scrolled nothing, so an unreadable trail is reported as unavailable and the
 * phase that needed it fails rather than passing on invented numbers.
 *
 * The device is reached only through the callers it is given, so the search can
 * be replayed against recorded pages.
 */
import { decodeUiAttribute, parseRedactedTrail, parseUiNodes, verticalScrollers } from './gestureMetrics.mjs';

/** Bounded swipes per search. Two searches: reach the control, then read down. */
const SWIPES = 10;

/**
 * A node the page is showing. UIAutomator keeps rows that scrolled off, and a
 * zero-area or offscreen box would send a tap wherever those coordinates land.
 */
export function visibleControl(dump, label) {
    const page = verticalScrollers(dump)[0];
    if (page === undefined) return undefined;
    return parseUiNodes(dump).find((node) => node.text === label
        && node.r > node.l && node.b > node.t
        && node.t >= page.t && node.b <= page.b && node.l >= page.l && node.r <= page.r);
}

const atReportEnd = (dump) => visibleControl(dump, 'Copy diagnostics') ?? visibleControl(dump, 'Diagnostics copied');

export async function readPhoneTrail({ openSettings, dumpUi, drag, tap, sleep, returnToHerd }) {
    await openSettings();
    await sleep(1500);
    const fail = async (why) => ({ ok: false, why, returned: await returnToHerd() });

    let dump = await dumpUi();
    if (!/text="Connection &amp;(?:amp;)? updates"|text="Connection & updates"/.test(dump)) {
        return await fail('the Connection & updates route never opened');
    }
    // One page swipe. Whether the page moved is deliberately not reported: the
    // frozen report is a single Text node whose accessibility string is the
    // whole report at every scroll position, so two identical dumps are the
    // normal case while the pixels underneath keep travelling. Ending the
    // search on that equality stopped one swipe short of the closing control.
    const swipePage = async (current) => {
        const page = verticalScrollers(current)[0];
        if (page === undefined) return { why: 'the page has no vertical scroller' };
        const x = Math.round((page.l + page.r) / 2);
        await drag({
            from: { x, y: Math.round(page.t + (page.b - page.t) * 0.75) },
            to: { x, y: Math.round(page.t + (page.b - page.t) * 0.25) },
        });
        await sleep(500);
        return { dump: await dumpUi() };
    };

    // Troubleshooting sits below the hosted status, the version rows and the
    // update rows, so the control starts off screen on this display.
    let control = visibleControl(dump, 'Show diagnostics');
    for (let attempt = 0; attempt < SWIPES && control === undefined; attempt += 1) {
        const swiped = await swipePage(dump);
        if (swiped.dump === undefined) return await fail(swiped.why);
        dump = swiped.dump;
        control = visibleControl(dump, 'Show diagnostics');
    }
    if (control === undefined) return await fail('Show diagnostics was never visible on /settings/connection');
    await tap((control.l + control.r) / 2, (control.t + control.b) / 2);
    await sleep(1000);
    dump = await dumpUi();

    // The report is one frozen block between the control and Copy diagnostics,
    // taller than the page. Read down it until that closing control is really on
    // screen: only then is the whole report accounted for, and only then can a
    // missing summary line mean the phone recorded nothing.
    const lines = [];
    const seen = new Set();
    const readVisible = (current) => {
        for (const match of current.matchAll(/text="([^"]*)"/g)) {
            const line = decodeUiAttribute(match[1]);
            if (line === '' || seen.has(line)) continue;
            seen.add(line);
            lines.push(line);
        }
    };
    readVisible(dump);
    let complete = atReportEnd(dump) !== undefined;
    for (let attempt = 0; attempt < SWIPES && !complete; attempt += 1) {
        const swiped = await swipePage(dump);
        if (swiped.dump === undefined) return await fail(swiped.why);
        dump = swiped.dump;
        readVisible(dump);
        complete = atReportEnd(dump) !== undefined;
    }
    const text = lines.join('\n');
    if (!/Redacted:|No phone transport events yet/.test(text)) {
        return await fail('the diagnostics report never rendered');
    }
    if (!complete) return await fail('the diagnostics report never reached its end');
    if (!await returnToHerd()) return { ok: false, why: 'the herd never came back after the diagnostics report', returned: false };
    return { ok: true, text, trail: parseRedactedTrail(text) };
}
