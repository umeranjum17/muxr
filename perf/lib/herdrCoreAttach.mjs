/**
 * A lab-only viewer for Herdr Core terminals: it attaches to a terminal and answers the
 * terminal queries a TUI sends before it draws (device attributes, cursor position, colours,
 * keyboard mode, window size). Pi, OpenCode, Gemini and Grok draw nothing until someone answers
 * these, and a lab core has no phone to do it. Measurement scripts use this; the product
 * terminal bridge in apps/host shares no code with it.
 */

const ESC = '\x1b';
const BEL = '\x07';
const answers = (cols, rows) => [
    // [pattern, reply]: the reply is a function of the match.
    [/\x1b\[(?:0)?c/g, () => `${ESC}[?62;22c`],                              // primary device attributes
    [/\x1b\[>(?:0)?c/g, () => `${ESC}[>0;10;1c`],                            // secondary device attributes
    [/\x1b\[>0?q/g, () => `${ESC}P>|lab-viewer 1${ESC}\\`],                  // XTVERSION
    [/\x1b\[5n/g, () => `${ESC}[0n`],                                        // device status
    [/\x1b\[6n/g, () => `${ESC}[1;1R`],                                      // cursor position
    [/\x1b\[\?6n/g, () => `${ESC}[?1;1R`],
    [/\x1b\[\?u/g, () => `${ESC}[?0u`],                                      // kitty keyboard flags: none
    [/\x1b\[(\?)?(\d+)\$p/g, (m) => `${ESC}[${m[1] ?? ''}${m[2]};0$y`],     // mode report: not recognised
    [/\x1b\[18t/g, () => `${ESC}[8;${rows};${cols}t`],                       // text area size in cells
    [/\x1b\[14t/g, () => `${ESC}[4;${rows * 16};${cols * 8}t`],              // text area size in pixels
    [/\x1b\[16t/g, () => `${ESC}[6;16;8t`],                                  // cell size in pixels
    [/\x1b\](10|11);\?(?:\x07|\x1b\\)/g, (m) => `${ESC}]${m[1]};rgb:${m[1] === '10' ? 'e0e0/e0e0/e0e0' : '1010/1010/1010'}${BEL}`], // fg / bg colour
];

/**
 * Attach `client` (a hello'd coreClient) to `terminal` and answer its queries until `stop()`.
 * Returns the attach channel and how many queries were answered.
 */
export async function attachAnswering(client, terminal, { cols = 100, rows = 30 } = {}) {
    const { channel } = await client.call('terminal.attach', { terminal, cols, rows });
    const table = answers(cols, rows);
    let seen = 0;
    let answered = 0;
    const scan = () => {
        const text = client.screen(channel);
        // Hold back a trailing, unfinished escape sequence until the rest arrives.
        const open = text.lastIndexOf(ESC);
        const end = open >= seen && !/[\x40-\x7e\x07]$|\x1b\\$/.test(text.slice(open + 1)) ? open : text.length;
        const fresh = text.slice(seen, end);
        seen = end;
        for (const [pattern, reply] of table) {
            for (const match of fresh.matchAll(pattern)) { client.type(channel, reply(match)); answered += 1; }
        }
    };
    const timer = setInterval(scan, 50);
    return {
        channel,
        answered: () => answered,
        stop: () => { clearInterval(timer); try { client.detach(channel); } catch { /* connection already closed */ } },
    };
}
