import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE_ROOT = fileURLToPath(new URL('../', import.meta.url));
import type { ServerResponse } from 'node:http';
/** The published docs, in reading order. One table drives the index cards, the
 *  in-page nav, the page titles and the routing allowlist. */
const DOCS: { slug: string; title: string; blurb: string }[] = [
    { slug: 'quickstart', title: 'Quickstart', blurb: 'Start here. Install, get the app, pair, and peek at your computer from your phone.' },
    { slug: 'setup', title: 'Setup walkthrough', blurb: 'Read this to pick a connection: Tailscale, SSH only, your own server, or a browser.' },
    { slug: 'plugins', title: 'Herdr plugins', blurb: 'Install Herdr plugins and run their actions from Applications in muxr.' },
    { slug: 'voice', title: 'Voice', blurb: 'On-device dictation and provider-neutral realtime voice, and exactly what each one sends where.' },
    { slug: 'privacy', title: 'Privacy and trust', blurb: 'What your phone, your computer, and an optional voice provider can each see. Also served verbatim at /privacy as the store-facing policy.' },
    { slug: 'troubleshooting', title: 'Troubleshooting', blurb: 'Pairing, connectivity, key rotation and redacted doctor output.' },
];

export const DOC_SLUGS = DOCS.map((doc) => doc.slug);

export function escapeHtml(value: unknown): string {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function inlineMarkdown(value: string): string {
    return escapeHtml(value)
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\[([^\]]+)\]\((https:\/\/[^)]+|\/[^)]+)\)/g, '<a href="$2">$1</a>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

export function renderMarkdown(source: string): string {
    const lines = source.replaceAll('\r\n', '\n').split('\n');
    const html: string[] = [];
    let paragraph: string[] = [];
    let listOpen: false | 'ul' | 'ol' = false;
    let codeOpen = false;
    /** Buffered so the fence emits one element. Pushing each line with its own
     *  '\n' double-spaced every code block once html.join('\n') ran too. */
    let code: string[] = [];
    const flush = (): void => {
        if (paragraph.length > 0) html.push(`<p>${inlineMarkdown(paragraph.join(' '))}</p>`);
        paragraph = [];
    };
    const closeCode = (): void => {
        html.push(`<pre><code>${code.join('\n')}</code></pre>`);
        code = [];
    };
    for (const line of lines) {
        if (line.startsWith('```')) {
            flush();
            if (listOpen) { html.push(`</${listOpen}>`); listOpen = false; }
            if (codeOpen) closeCode();
            codeOpen = !codeOpen;
            continue;
        }
        if (codeOpen) { code.push(escapeHtml(line)); continue; }
        const heading = /^(#{1,3})\s+(.+)$/.exec(line);
        if (heading) {
            flush();
            if (listOpen) { html.push(`</${listOpen}>`); listOpen = false; }
            const level = heading[1]!.length;
            html.push(`<h${level}>${inlineMarkdown(heading[2]!)}</h${level}>`);
            continue;
        }
        const bullet = /^-\s+(.+)$/.exec(line);
        if (bullet) {
            flush();
            if (listOpen && listOpen !== 'ul') { html.push(`</${listOpen}>`); listOpen = false; }
            if (!listOpen) { html.push('<ul>'); listOpen = 'ul'; }
            html.push(`<li>${inlineMarkdown(bullet[1]!)}</li>`);
            continue;
        }
        const ordered = /^\d+\.\s+(.+)$/.exec(line);
        if (ordered) {
            flush();
            if (listOpen && listOpen !== 'ol') { html.push(`</${listOpen}>`); listOpen = false; }
            if (!listOpen) { html.push('<ol>'); listOpen = 'ol'; }
            html.push(`<li>${inlineMarkdown(ordered[1]!)}</li>`);
            continue;
        }
        if (line.trim() === '') {
            flush();
            if (listOpen) { html.push(`</${listOpen}>`); listOpen = false; }
        } else paragraph.push(line.trim());
    }
    flush();
    if (listOpen) html.push(`</${listOpen}>`);
    if (codeOpen) closeCode();
    return html.join('\n');
}

const BRAND_WORDMARK = '<img src="/marketing/wordmark.png" width="112" height="13" alt="muxr">';

const SHELL_CSS = `
/* --- tokens -------------------------------------------------------------
   One set for the whole site. Light is the films' world: ink on warm paper,
   with exactly three colours that carry meaning, the app's own lifecycle:
   green done / yes, red needs you, blue working. Dark is the app's seamless
   near-black and its grey ramp. --app-* is the app surface itself (terminal,
   install block) and does not change with the page theme. */
@font-face{font-family:'Bricolage Grotesque';font-weight:700;font-display:swap;src:url(/marketing/bricolage-grotesque-bold.woff2) format('woff2')}
@font-face{font-family:'IBM Plex Sans';font-weight:400;font-display:swap;src:url(/marketing/ibm-plex-sans-regular.woff2) format('woff2')}
@font-face{font-family:'IBM Plex Sans';font-weight:600;font-display:swap;src:url(/marketing/ibm-plex-sans-semibold.woff2) format('woff2')}
@font-face{font-family:'IBM Plex Mono';font-weight:400;font-display:swap;src:url(/marketing/ibm-plex-mono-regular.woff2) format('woff2')}
:root{color-scheme:light dark;
--paper:#f3eee3;--paper-2:#ebe5d7;--paper-3:#e2dbcb;--ink:#1d1b18;--ink-2:#4a4640;--ink-3:#6b665d;--rule:#1d1b181f;--rule-2:#1d1b1838;
--green:#1c9f63;--red:#d9483b;--blue:#3d6fd6;--wordmark:invert(89%);--topbar:#f3eee3d9;
--app-canvas:#0c0c0b;--app-raised:#131312;--app-divider:#262625;--app-text:#ececec;--app-dim:#9b9b98;
--display:'Bricolage Grotesque','IBM Plex Sans',system-ui,sans-serif;--sans:'IBM Plex Sans',system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;--mono:'IBM Plex Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
--ease-out:cubic-bezier(.23,1,.32,1)}
@media(prefers-color-scheme:dark){:root{
--paper:#0c0c0b;--paper-2:#131312;--paper-3:#1c1c1b;--ink:#ececec;--ink-2:#b4b3af;--ink-3:#9b9b98;--rule:#262625;--rule-2:#3a3a38;
--green:#30d158;--red:#ff453a;--blue:#0a84ff;--wordmark:none;--topbar:#0c0c0bd9}}
*{box-sizing:border-box}
::selection{background:var(--ink);color:var(--paper)}
html{overflow-x:clip}
[id]{scroll-margin-top:5rem}
body{margin:0;overflow-x:clip;background:var(--paper);color:var(--ink);font:400 17px/1.6 var(--sans);-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;text-rendering:optimizeLegibility}
.wrap{width:min(76rem,calc(100% - 5rem));margin-inline:auto}
:focus-visible{outline:2px solid var(--blue);outline-offset:3px;border-radius:4px}
a{color:var(--ink);text-decoration-color:var(--rule-2);text-underline-offset:.22em}
@media(hover:hover) and (pointer:fine){a:hover{text-decoration-color:currentColor}}
h1,h2,h3{font-family:var(--display);font-weight:700;margin:0;text-wrap:balance;letter-spacing:-.025em}
h1{font-size:clamp(2.6rem,5.4vw,4.6rem);line-height:1}
h2{font-size:clamp(2rem,3.6vw,2.9rem);line-height:1.04}
h3{font-size:1.4rem;line-height:1.15;letter-spacing:-.015em}
p{margin:0 0 1rem;text-wrap:pretty}
strong{font-weight:600}
.lede{font-size:clamp(1.06rem,1.4vw,1.2rem);color:var(--ink-2);max-width:40rem;line-height:1.55;margin-top:1.1rem}
.muted{color:var(--ink-3)}
code,pre{font-family:var(--mono);font-size:.92em}
.skip{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.skip:focus{position:fixed;left:1rem;top:.6rem;width:auto;height:auto;clip-path:none;z-index:20;background:var(--ink);color:var(--paper);padding:.5rem .9rem;border-radius:8px;text-decoration:none;font-weight:600}
.eyebrow{display:block;font:400 .78rem/1.4 var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3);margin:0 0 1rem}
.dot{display:inline-block;width:.55em;height:.55em;border-radius:50%;background:var(--state);vertical-align:.08em;margin-right:.4em}

/* --- top bar ------------------------------------------------------------ */
.topbar{position:sticky;top:0;z-index:9;background:var(--paper);border-bottom:1px solid var(--rule)}
@supports(backdrop-filter:blur(1px)){.topbar{background:var(--topbar);backdrop-filter:saturate(140%) blur(16px)}}
.bar{display:flex;justify-content:space-between;align-items:center;gap:1rem;padding:.55rem 0}
.brand{display:inline-flex;align-items:center;min-height:2.75rem;text-decoration:none}
.brand img{display:block;width:6.5rem;height:auto;filter:var(--wordmark)}
nav{display:flex;gap:.1rem;align-items:center}
nav a{color:var(--ink-2);text-decoration:none;font-size:.92rem;padding:.55rem .75rem;border-radius:8px;transition:color 150ms ease,background 150ms ease}
nav a.nav-cta{color:var(--paper);background:var(--ink);font-weight:600;margin-left:.4rem}
@media(hover:hover) and (pointer:fine){nav a:hover{color:var(--ink)}nav a.nav-cta:hover{color:var(--paper);opacity:.88}}

section{padding-block:clamp(4.5rem,10vh,7.5rem)}
.rail{margin:0 0 1rem;font:400 .78rem/1.4 var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3)}
.rail b{font-weight:400;color:var(--ink)}

/* --- buttons ------------------------------------------------------------ */
button,.button,input{font:inherit;border-radius:10px;padding:.75rem 1.25rem}
button,.button{display:inline-flex;align-items:center;justify-content:center;gap:.5rem;min-height:2.75rem;border:1px solid transparent;background:var(--ink);color:var(--paper);text-decoration:none;cursor:pointer;font-weight:600;font-size:.95rem;transition:transform 160ms var(--ease-out),opacity 150ms ease,border-color 150ms ease}
button:active,.button:active{transform:scale(.98)}
button.secondary,.button.secondary{background:transparent;color:var(--ink);border-color:var(--rule-2)}
@media(hover:hover) and (pointer:fine){button:hover,.button:hover{opacity:.88}button.secondary:hover,.button.secondary:hover{opacity:1;border-color:var(--ink)}}
.cta-row{display:flex;gap:.65rem;flex-wrap:wrap;margin-top:1.75rem}
.textlink{display:inline-flex;align-items:center;gap:.4rem;min-height:2.75rem;padding:.35rem 0;color:var(--ink);text-decoration:underline;text-decoration-color:var(--rule-2);font-weight:600;font-size:.95rem}
@media(hover:hover) and (pointer:fine){.textlink:hover{text-decoration-color:currentColor}}
.docs .textlink+.textlink{margin-left:1.25rem}

/* --- the install command: an app surface, so it keeps the app's near-black
       in both themes ---------------------------------------------------- */
.term{background:var(--app-canvas);color:var(--app-text);border:1px solid var(--app-divider);border-radius:12px;overflow:hidden;max-width:42rem}
.term-head{display:flex;align-items:center;justify-content:space-between;gap:.8rem;padding:.6rem 1rem;background:var(--app-raised);border-bottom:1px solid var(--app-divider);font:400 .75rem var(--mono);color:var(--app-dim)}
.term pre{margin:0;padding:1rem 1.1rem;overflow-x:auto;font-size:.9rem;line-height:1.85;-webkit-user-select:all;user-select:all}
.term .pr{color:var(--app-dim);-webkit-user-select:none;user-select:none}
.term .cm{color:var(--app-dim)}

/* --- cards -------------------------------------------------------------- */
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(16rem,1fr));gap:1rem;margin-top:2.25rem}
.grid.three{grid-template-columns:repeat(auto-fit,minmax(min(19rem,100%),1fr))}
.card{background:var(--paper-2);border:1px solid var(--rule);border-radius:14px;padding:1.4rem}
.card h3,.card strong{display:block;font:600 1.02rem/1.35 var(--sans);letter-spacing:0}
.card p{margin:.5rem 0 0;color:var(--ink-2);font-size:.93rem;line-height:1.6}
a.card{text-decoration:none;color:inherit;display:block;transition:border-color 150ms ease}
@media(hover:hover) and (pointer:fine){a.card:hover{border-color:var(--rule-2)}}
a.card h3::after,a.card strong::after{content:' \\2192'}
.lede code,section>p code,.step-note code,.faq code{background:var(--paper-3);border-radius:5px;padding:.08em .38em;font-size:.86em;color:var(--ink)}
.credit p:last-child{margin-top:.75rem;font-family:var(--mono);font-size:.8rem;line-height:1.55}

/* --- films: a paper frame that shows its poster until the loop plays ---- */
.film{position:relative;margin:0;aspect-ratio:16/9;overflow:hidden;border-radius:16px;background:#f3eee3;box-shadow:0 0 0 1px var(--rule)}
.film img,.film video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block}
.film-toggle{position:absolute;right:.6rem;bottom:.6rem;width:2.75rem;height:2.75rem;padding:0;border-radius:50%;background:#1d1b18b3;color:#f3eee3;opacity:0;transition:opacity 150ms ease}
.film:hover .film-toggle,.film-toggle:focus-visible,.film-toggle[aria-pressed=true]{opacity:1}
.film-toggle::before{content:'';width:.7rem;height:.8rem;border-inline:.22rem solid currentColor}
.film-toggle[aria-pressed=true]::before{width:0;height:0;border-inline:0;border-block:.42rem solid transparent;border-left:.7rem solid currentColor;margin-left:.2rem}
@media(hover:none){.film-toggle{opacity:1}}

/* --- landing: hero ------------------------------------------------------ */
.hero{padding-block:clamp(3rem,8vh,5.5rem) clamp(4rem,9vh,6.5rem)}
.hero-head{display:grid;grid-template-columns:minmax(0,7fr) minmax(0,5fr);gap:2rem 4rem;align-items:end}
.hero-head h1{max-width:none}
.hero-head .lede{margin:0}
.hero-head .cta-row{margin-top:1.4rem}
.hero .film{margin-top:clamp(2.25rem,5vh,3.5rem)}
.film-note{display:flex;flex-wrap:wrap;justify-content:space-between;gap:.5rem 1.5rem;margin-top:1rem;color:var(--ink-3);font-size:.9rem}
.film-note em{font-style:normal;color:var(--ink)}
.legend{display:flex;flex-wrap:wrap;gap:.35rem 1.1rem;font-family:var(--mono);font-size:.8rem}

/* --- herd drawings: the films' pen on every page. Each is a transparent
       WebP with a dark re-inking, so it sits on the page in both themes ---- */
.drawing,.step-icon{display:block}
.drawing img,.step-icon img{display:block;width:100%;height:auto}
.fenceline{margin:0 auto;overflow:hidden}
.fenceline img{display:block;width:max(100%,75rem);max-width:none;height:auto}
.fenceline+.band{border-top:0}
.spot{width:min(100%,var(--w,20rem));margin:0 0 1.75rem}

/* --- landing: episodes -------------------------------------------------- */
.section-head{display:grid;grid-template-columns:minmax(0,7fr) minmax(0,5fr);gap:1rem 4rem;align-items:end;margin-bottom:clamp(2.5rem,5vw,3.5rem)}
.section-head .lede{margin:0}
.episodes{list-style:none;margin:0;padding:0;display:grid;gap:clamp(4rem,9vw,7rem)}
.episode{display:grid;grid-template-columns:minmax(0,7fr) minmax(0,5fr);gap:clamp(1.75rem,4.5vw,4.5rem);align-items:center}
.episode:nth-child(even){grid-template-columns:minmax(0,5fr) minmax(0,7fr)}.episode:nth-child(even) .film{order:2}
.ep-no{display:flex;align-items:baseline;gap:.5rem;margin:0 0 1rem;font:400 .78rem/1 var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3)}
.ep-no b{font:700 2.1rem/.8 var(--display);letter-spacing:-.03em;color:var(--ink);margin-right:.35rem}
.episode h3{font-size:clamp(1.3rem,2vw,1.6rem);line-height:1.2;max-width:28rem}
.episode-copy>p:not(.ep-no){color:var(--ink-2);margin:.8rem 0 0;max-width:31rem}
.episode-copy>p.ep-then{display:flex;gap:.1rem;color:var(--ink)}.ep-then .dot{flex:none;margin-top:.52em;vertical-align:0}
/* The real screen the story turns on: an app surface, near-black in both themes,
   outlined in the page's ink the way the films draw a phone. */
.moment{display:flex;align-items:flex-end;gap:1rem;margin:1.6rem 0 0}
.moment img{display:block;flex:none;width:min(62%,17.5rem);height:auto;border-radius:12px;background:var(--app-canvas);box-shadow:0 0 0 1.5px var(--ink),5px 6px 0 var(--rule)}
.moment figcaption{font:400 .76rem/1.55 var(--mono);color:var(--ink-2)}
.moment figcaption span:last-child{display:block;color:var(--ink-3)}
/* Review before it ships: an episode-shaped row whose picture is the real diff,
   a phone screen rising out of a paper panel the size of a film. */
.feature{display:grid;grid-template-columns:minmax(0,7fr) minmax(0,5fr);gap:clamp(1.75rem,4.5vw,4.5rem);align-items:center;margin-top:clamp(4rem,9vw,7rem)}
.feature h3{font-size:clamp(1.3rem,2vw,1.6rem);line-height:1.2;max-width:28rem}
.feature-screen{display:flex;justify-content:center;align-items:flex-end;aspect-ratio:16/9;padding-top:6%;overflow:hidden;border-radius:16px;background:var(--paper-2);box-shadow:0 0 0 1px var(--rule)}
.feature-screen img{display:block;width:38%;height:100%;object-fit:cover;object-position:50% 0;border-radius:12px 12px 0 0;background:var(--app-canvas);box-shadow:0 0 0 1.5px var(--ink)}
/* Everything else in your pocket: one ruled row per job, three real screens each. */
.pocket-head{margin-top:clamp(5rem,10vw,7.5rem)}
.pocket{display:grid;gap:clamp(2.5rem,5vw,3.5rem)}
.pocket-group{display:grid;grid-template-columns:minmax(0,3fr) minmax(0,9fr);gap:1.25rem 3rem;padding-top:1.5rem;border-top:1px solid var(--rule)}
.pocket-group h3{font-size:1.15rem}
.pocket-group h3 span{display:block;margin-bottom:.45rem;font:400 .78rem/1.4 var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3)}
.pocket-group ul{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1.75rem 1.5rem}
.pocket-group img{display:block;width:100%;height:auto;border-radius:10px;background:var(--app-canvas);box-shadow:0 0 0 1.5px var(--ink),4px 5px 0 var(--rule)}
.pocket-group strong{display:block;margin-top:1.1rem;font-size:1rem;line-height:1.35}
.pocket-group p{margin:.35rem 0 0;color:var(--ink-2);font-size:.9rem;line-height:1.55}
.agents{display:grid;grid-template-columns:minmax(0,4fr) minmax(0,8fr);gap:1rem 3rem;margin-top:clamp(4rem,8vw,6rem);padding-top:1.5rem;border-top:1px solid var(--rule)}
.agents h3{font-size:1.15rem}
.agents p{margin:1rem 0 0;color:var(--ink-2);font-size:.93rem}
/* The app's own agent marks: monochrome masks, tinted like the app tints them. */
.agent-list{display:flex;flex-wrap:wrap;gap:.5rem;margin:0;padding:0;list-style:none}
.agent-list li{display:inline-flex;align-items:center;gap:.5rem;min-height:2.25rem;padding:.3rem .8rem .3rem .6rem;border:1px solid var(--rule);border-radius:999px;background:var(--paper-2);font-size:.88rem;line-height:1.2}
.mark{width:1.1rem;height:1.1rem;flex:none;background:var(--ink);-webkit-mask:var(--mark) center/contain no-repeat;mask:var(--mark) center/contain no-repeat}

/* --- landing: install --------------------------------------------------- */
.band{border-top:1px solid var(--rule)}
.install-grid{display:grid;grid-template-columns:minmax(0,7fr) minmax(0,5fr);gap:clamp(2.5rem,6vw,5rem);align-items:start}
.steps{list-style:none;margin:2rem 0 0;padding:0;display:grid;gap:1.75rem}
.steps li{display:grid;grid-template-columns:3.5rem minmax(0,1fr);gap:1rem;align-items:start}
.step-icon{width:3.5rem;margin-top:-.35rem}
.step-body{min-width:0}.step-body>strong{display:block;font-size:1.05rem;margin:.2rem 0 .6rem}.step-body .term{max-width:none}
.step-k{font:400 .8rem var(--mono);color:var(--ink-3);margin-right:.6rem}
.step-buttons{display:flex;flex-wrap:wrap;gap:.6rem}
.steps+.textlink{margin:1rem 0 0 4.5rem}
.faq .drawing{width:min(15rem,70%);margin:0 0 1.25rem}
#open-source .section-head .lede{margin-top:1.1rem}
#open-source .section-head .drawing{justify-self:end;width:min(100%,30rem)}
.step-note{display:block;margin-top:.6rem;color:var(--ink-2);font-size:.92rem;line-height:1.55}
.faq details{border-top:1px solid var(--rule);padding:.25rem 0}.faq details:last-child{border-bottom:1px solid var(--rule)}
.faq summary{cursor:pointer;font-weight:600;min-height:2.75rem;display:flex;align-items:center;list-style-position:outside}
.faq details p{margin:0 0 .9rem;color:var(--ink-2)}

/* --- landing: open source ----------------------------------------------- */
.trust-statements{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:2.25rem 1.5rem}
.trust-statement{padding-top:1.1rem;border-top:1px solid var(--ink)}.trust-statement strong{display:block;font-size:1.02rem}.trust-statement span{display:block;margin-top:.4rem;color:var(--ink-2);font-size:.93rem;line-height:1.55}
.plugins{display:grid;grid-template-columns:minmax(0,5fr) minmax(0,7fr);gap:1.5rem 4rem;margin-top:clamp(3.5rem,7vw,5rem);padding:clamp(1.5rem,3vw,2.25rem);border-radius:16px;background:var(--paper-2);border:1px solid var(--rule)}
.plugin-examples{display:grid;border-top:1px solid var(--rule)}
.plugin-example{display:grid;grid-template-columns:5.5rem 1fr;gap:1rem;padding:.8rem 0;border-bottom:1px solid var(--rule)}
.plugin-example strong{font:400 .8rem/1.6 var(--mono);text-transform:uppercase;letter-spacing:.06em}
.plugin-example span{color:var(--ink-2);font-size:.93rem;line-height:1.5}
.plugin-links{display:flex;flex-wrap:wrap;gap:1.35rem;margin-top:.75rem}

/* --- docs --------------------------------------------------------------- */
.docs{max-width:44rem}
.docs h1{font-size:clamp(2.1rem,5vw,3rem);margin-bottom:.9rem}
.docs h2{font-size:clamp(1.4rem,2.4vw,1.75rem);margin-top:3rem;margin-bottom:.6rem}
.docs h3{margin:2rem 0 .4rem;font-size:1.15rem}
.docs p,.docs li{color:var(--ink-2)}
.docs ul,.docs ol{padding-left:1.15rem}
.docs li{margin:.4rem 0}
.docs li::marker{color:var(--ink-3)}
.docs pre{white-space:pre-wrap;overflow:auto;background:var(--app-canvas);color:var(--app-text);border:1px solid var(--app-divider);border-radius:12px;padding:1rem 1.15rem;font-size:.88rem;line-height:1.8}
.docs :not(pre)>code{background:var(--paper-3);border-radius:5px;padding:.08em .38em;font-size:.86em;color:var(--ink)}
.docs details{margin:1.25rem 0;border-top:1px solid var(--rule);padding-top:.5rem}.docs summary{cursor:pointer;font-weight:600;min-height:2.75rem;display:flex;align-items:center}
.docs .button{margin:.25rem .35rem .25rem 0}
.doc-nav{display:flex;flex-wrap:wrap;gap:.4rem;margin:0 0 2.25rem;padding:0;list-style:none}
.doc-nav a{display:inline-flex;align-items:center;min-height:2.25rem;font:400 .78rem var(--mono);color:var(--ink-2);text-decoration:none;border:1px solid var(--rule);border-radius:8px;padding:.3rem .7rem}
.doc-nav a[aria-current]{color:var(--ink);border-color:var(--ink)}
@media(hover:hover) and (pointer:fine){.doc-nav a:hover{color:var(--ink);border-color:var(--rule-2)}}

/* --- forms, kept for the paired control-plane build --------------------- */
input{width:100%;border:1px solid var(--rule-2);background:var(--paper-2);color:var(--ink);margin:.35rem 0 1rem}
input:focus{outline:2px solid var(--blue);outline-offset:1px}
label{font-size:.92rem;color:var(--ink-2)}
form.inline{display:inline-block;margin:.25rem}
.danger{border-color:var(--red)}
.status{font-weight:600}
.auth{max-width:30rem;margin:12vh auto;background:var(--paper-2);border:1px solid var(--rule);border-radius:18px;padding:2rem}
.auth h1{font-size:1.9rem;margin:.1rem 0 .6rem}
.auth p{color:var(--ink-2)}
.auth button{width:100%;margin-top:.4rem}
.lost{max-width:36rem;margin:0 auto;padding-top:clamp(2.5rem,8vh,5rem);text-align:center}
.lost .drawing{width:min(100%,24rem);margin:0 auto 1.5rem}.lost .lede{margin-inline:auto}.lost .cta-row{justify-content:center}

/* --- download channels -------------------------------------------------- */
.dl-cards{display:grid;gap:1rem;margin:1.75rem 0 2rem}
@media(min-width:52rem){.dl-cards{grid-template-columns:repeat(2,1fr)}}
.dl-card{display:flex;flex-direction:column;gap:.5rem;padding:1.2rem 1.25rem;border:1px solid var(--rule);border-radius:14px;background:var(--paper-2)}
.dl-card h3{margin:0;font-size:1.2rem}
.dl-card .dl-version{font:400 .85rem/1.35 var(--mono);color:var(--ink-2);overflow-wrap:anywhere}
.dl-card p{margin:0;color:var(--ink-2);font-size:.93rem;line-height:1.5}
.dl-card .button{margin-top:.35rem;align-self:flex-start}

/* --- footer: the herd trots along the fence line ----------------------- */
.foot-wrap{color:var(--ink-3);font-size:.92rem}
.foot-fence{position:relative;height:5.25rem;margin-top:clamp(2rem,5vw,4rem)}
.foot-fence .fenceline{position:absolute;inset:auto 0 0}
.foot-herd{position:absolute;right:4%;bottom:0;width:17.5rem}
.foot-inner{padding:3rem 0 2.5rem}
.foot{display:grid;grid-template-columns:2fr repeat(4,1fr);gap:2rem;margin-bottom:2.5rem}
.foot h4{font:400 .75rem var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3);margin:0 0 .8rem}
.foot a{display:block;color:var(--ink-2);text-decoration:none;padding:.3rem 0}
.foot a.brand{display:inline-flex;padding:0}
@media(hover:hover) and (pointer:fine){.foot a:hover{color:var(--ink)}}
.foot-note{display:flex;justify-content:space-between;gap:1rem;flex-wrap:wrap;padding-top:1.5rem;border-top:1px solid var(--rule)}
.foot-note a{display:inline;color:var(--ink-2)}

/* --- responsive --------------------------------------------------------- */
@media(max-width:64rem){.foot{grid-template-columns:repeat(3,1fr)}.foot>div:first-child{grid-column:1/-1}}
@media(max-width:56rem){.hero-head,.section-head,.episode,.feature,.pocket-group,.install-grid,.plugins,.agents{grid-template-columns:1fr}.episode:nth-child(even){grid-template-columns:1fr}.episode:nth-child(even) .film{order:0}.trust-statements{grid-template-columns:1fr}
/* One column: number and title lead, then the film, then the copy and real screen. */
.episode,.feature{gap:0}.episode>.episode-copy,.feature>.episode-copy{display:contents}.ep-no,.feature .eyebrow{order:-2}.episode h3,.feature h3{order:-1}.episode>.film,.feature-screen{margin:1.25rem 0 .4rem}
#open-source .section-head .drawing{justify-self:start}}
@media(max-width:46rem){
.wrap{width:calc(100% - 2.5rem)}
nav a{display:none}nav a.nav-cta{display:inline-flex}
section{padding-block:3.5rem}
.hero{padding-top:2.25rem}
/* The real screen stays a supporting detail beside its caption, as on desktop,
   so the film leads each episode. */
.moment{gap:.85rem;margin-top:1.4rem}.moment img{width:55%}
.feature-screen{aspect-ratio:4/3}.feature-screen img{width:52%}
.pocket-group ul{grid-template-columns:1fr;gap:1.5rem}.pocket-group li{display:grid;grid-template-columns:8.5rem minmax(0,1fr);gap:1rem;align-items:start}.pocket-group strong{margin-top:0}
.foot-herd{width:12.5rem;right:0}
/* A smaller disc in the corner of the smaller film, on the same 44px target. */
.film-toggle{right:.15rem;bottom:.15rem;background:radial-gradient(circle,#1d1b18b3 0 .95rem,transparent calc(.95rem + 1px))}.film-toggle::before{scale:.72}
.term pre{font-size:.82rem;white-space:pre-wrap;overflow-wrap:anywhere}.term-head span:last-child{display:none}
.foot{grid-template-columns:1fr 1fr}
}
@media(max-width:22rem){.wrap{width:calc(100% - 2rem)}}
@media(prefers-reduced-motion:reduce){
*,*::before,*::after{animation:none!important;transition-duration:.01ms!important;scroll-behavior:auto!important}
button:active,.button:active{transform:none}
}
`;

export const REPO = 'https://github.com/umeranjum17/muxr';
/** Permanent surfaces: the channel catalog decides what they resolve to. */
const ANDROID = '/downloads/stable/android';
const DOWNLOADS = '/downloads';
const TESTFLIGHT = 'https://testflight.apple.com/join/aJSbs8pN';

const FOOTER = `<div class="foot">
<div><a class="brand" href="/">${BRAND_WORDMARK}</a><p class="muted" style="margin:.9rem 0 0;max-width:20rem">Leave the desk. Keep the run.</p></div>
<div><h4>Start</h4><a href="/#install">Install muxr</a><a href="${DOWNLOADS}">Downloads</a><a href="${TESTFLIGHT}">iOS TestFlight</a><a href="${REPO}">GitHub</a></div>
<div><h4>Plugins</h4><a href="/docs/plugins">Use Herdr plugins</a><a href="https://herdr.dev/plugins/">Browse Herdr plugins</a></div>
<div><h4>Project</h4><a href="/docs">Docs</a><a href="/docs/voice">Voice</a><a href="/docs/privacy">Privacy and trust</a><a href="/opensource">Open source &amp; credits</a></div>
<div><h4>Legal</h4><a href="/privacy">Privacy policy</a><a href="/support">Support</a></div>
</div><div class="foot-note"><span>© ${new Date().getFullYear()} muxr · Apache-2.0</span><span>Built for coding agents</span><span>By <a href="https://x.com/umership">Umer Farooq (@umership)</a></span></div>`;

const FONT_PRELOAD = ['ibm-plex-sans-regular', 'bricolage-grotesque-bold']
    .map((name) => `<link rel="preload" href="/marketing/${name}.woff2" as="font" type="font/woff2" crossorigin>`).join('');

function shell(title: string, body: string): string {
    const description = 'Your coding agents, on your phone. See which are working, need you or are done, and answer in the same session. Self-hosted and open source.';
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="theme-color" content="#f3eee3" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#0c0c0b" media="(prefers-color-scheme: dark)"><meta name="description" content="${description}"><meta property="og:title" content="muxr — every agent, in your pocket"><meta property="og:description" content="${description}"><meta property="og:type" content="website"><meta property="og:site_name" content="muxr"><meta property="og:url" content="https://trymuxr.com/"><meta property="og:image" content="https://trymuxr.com/film/gate-16x9.jpg"><meta property="og:image:width" content="1280"><meta property="og:image:height" content="720"><meta name="twitter:card" content="summary_large_image"><title>${escapeHtml(title)} · muxr</title><link rel="icon" href="/favicon.ico" sizes="16x16 32x32 48x48"><link rel="icon" type="image/svg+xml" href="/icons/favicon.svg" sizes="any"><link rel="icon" type="image/png" href="/icons/favicon-16.png" sizes="16x16"><link rel="icon" type="image/png" href="/icons/favicon-32.png" sizes="32x32"><link rel="apple-touch-icon" href="/apple-touch-icon.png" sizes="180x180">${FONT_PRELOAD}<style>${SHELL_CSS}</style></head><body><a class="skip" href="#main">Skip to content</a><header class="topbar"><div class="bar wrap"><a class="brand" href="/">${BRAND_WORDMARK}</a><nav><a href="/#films">Films</a><a href="/#open-source">Open source</a><a href="/docs">Docs</a><a class="nav-cta" href="/#install">Install</a></nav></div></header><main id="main" class="wrap">${body}</main><footer class="foot-wrap"><div class="foot-fence wrap">${FENCE}${drawing('herd', '', 280, 84, 'drawing foot-herd')}</div><div class="foot-inner wrap">${FOOTER}</div></footer></body></html>`;
}

/** The mono label that opens a page: index and name. */
function rail(index: string, label: string): string {
    return `<p class="rail"><b>${index}</b><span>${label}</span></p>`;
}

/** Install block. The command is the CTA, so it is selectable, not a button. */
export function term(head: string, lines: string[]): string {
    const body = lines.map((line) => (line.startsWith('#')
        ? `<span class="cm">${escapeHtml(line)}</span>`
        : `<span class="pr">$</span> ${escapeHtml(line)}`)).join('\n');
    return `<div class="term"><div class="term-head"><span>${escapeHtml(head)}</span><span>Select command</span></div><pre tabindex="0"><code>${body}</code></pre></div>`;
}

export function writeHtml(res: ServerResponse, status: number, title: string, body: string, extraHeaders: Record<string, string> = {}): void {
    res.writeHead(status, {
        'cache-control': 'no-store',
        'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; media-src 'self'; font-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
        'content-type': 'text/html; charset=utf-8',
        'cross-origin-opener-policy': 'same-origin',
        'cross-origin-resource-policy': 'same-origin',
        'permissions-policy': 'camera=(), microphone=(), geolocation=()',
        'referrer-policy': 'no-referrer',
        'strict-transport-security': 'max-age=31536000; includeSubDomains',
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'DENY',
        ...extraHeaders,
    });
    res.end(shell(title, body));
}

export const INSTALL = ['npm install -g --ignore-scripts @trymuxr/cli@latest', 'muxr'];

/** Film metadata generated from the checksum-locked public artifact. */
type DemoFilm = { duration: number; width: number; height: number; poster: { at: number; width: number; height: number }; sourceCommit: string };

export function readDemoFilm(mediaDir = join('docs', 'media')): DemoFilm | undefined {
    try {
        const parsed = JSON.parse(readFileSync(join(SITE_ROOT, mediaDir, 'demo.json'), 'utf8')) as DemoFilm;
        if (!Number.isFinite(parsed.duration) || !Number.isFinite(parsed.width) || !Number.isFinite(parsed.height)) return undefined;
        return parsed;
    } catch {
        return undefined;
    }
}

const AV1 = 'video/webm; codecs="av01.0.05M.08"';

/**
 * A silent loop from docs/film. Its poster sits underneath and is all a visitor
 * sees until the loop plays, or ever, with reduced motion or no script.  * landing.js plays each loop only while it is on screen.
 */
function film(name: string, alt: string, hero = false): string {
    const sources = `<source src="/film/${name}-16x9.webm" type='${AV1}'><source src="/film/${name}-16x9.mp4" type="video/mp4">`;
    const poster = `<picture><img src="/film/${name}-16x9.webp" alt="${escapeHtml(alt)}" width="1280" height="720" decoding="async"${hero ? ' fetchpriority="high"' : ' loading="lazy"'}></picture>`;
    return `<figure class="film">${poster}<video data-film muted loop playsinline aria-hidden="true"${hero ? ' autoplay preload="auto"' : ' preload="none"'}>${sources}</video></figure>`;
}

/** A spot drawing from docs/herd: the films' pen, re-inked for the dark page. */
export function drawing(name: string, alt: string, width: number, height: number, className = 'drawing'): string {
    const hidden = alt === '' ? ' aria-hidden="true"' : '';
    return `<picture class="${className}"${hidden}><source srcset="/herd/${name}-dark.webp" media="(prefers-color-scheme: dark)"><img src="/herd/${name}.webp" alt="${escapeHtml(alt)}" width="${width}" height="${height}" loading="lazy" decoding="async"></picture>`;
}

/** The fence line the films' hills are drawn with, as a divider between parts of a page. */
const FENCE = `<div class="fenceline">${drawing('fence', '', 1200, 44)}</div>`;

const status = (state: string, label: string): string => `<span><span class="dot" style="--state:var(--${state})"></span>${label}</span>`;

type Episode = {
    film: string; no: number; title: string; alt: string;
    /** The situation, what you do in muxr, and how it ends. */
    when: string; you: string; then: string;
    /** The real app screen the story turns on, and its label. */
    moment: { file: string; alt: string; width: number; height: number; state: string; label: string };
};

/** Tales from the Herd, in order. A new episode is one entry here plus its cut in scripts/encode-film.mjs. */
const EPISODES: Episode[] = [
    {
        film: 'gate-answer', no: 1, title: 'The Gate',
        alt: 'The Gate: on a train, the developer’s phone buzzes. He taps Yes on the agent’s question, and far away in the meadow a gate swings open for the lamb.',
        when: 'You’re on a train, and one agent needs a yes.',
        you: 'Its question reaches your lock screen. Tap it to open the agent’s own terminal, where the answers are buttons, and tap 1 Yes.',
        then: 'It runs the tests and keeps going. You stay on the train.',
        moment: { file: 'gate', alt: 'The lamb agent’s terminal on a phone: Claude Code asks to run npm test, with numbered answers to tap', width: 720, height: 576, state: 'red', label: 'lamb · needs you' },
    },
    {
        film: 'good-morning', no: 2, title: 'Good Morning',
        alt: 'Good Morning: sheep jump a fence in a dream while you sleep, then over coffee your phone shows which agents finished and how much of your plan is left.',
        when: 'You left three agents working overnight.',
        you: 'Over coffee, open Home. Ready · unseen lists what finished while you slept, and Right now shows how much of your plan is left.',
        then: 'You know where the day starts before you reach your desk.',
        moment: { file: 'good-morning', alt: 'Home on a phone: ram needs you, and lamb and ewe are ready and unseen', width: 720, height: 494, state: 'green', label: 'lamb, ewe · done' },
    },
    {
        film: 'shearing', no: 3, title: 'The Shearing',
        alt: 'The Shearing: a sheep’s fleece swells until it sticks in a stile, you tap /compact on your phone, and it trots through light again.',
        when: 'An agent’s context is nearly full, and it’s slowing down.',
        you: 'Open its commands and tap /compact, or any command you’ve saved.',
        then: 'It carries on lighter, in the same session.',
        moment: { file: 'shearing', alt: 'The Claude commands sheet on a phone: Continue, Run tests, Summarize and /compact', width: 540, height: 480, state: 'blue', label: 'sparrow · working' },
    },
    {
        film: 'line-up', no: 4, title: 'The Line-up',
        alt: 'The Line-up: at a station café, the developer swipes across his phone, and the meadow slides from one sheep’s pen to the next as each agent’s terminal slides in.',
        when: 'Your train is two minutes away, and three agents are working.',
        you: 'Open one agent’s terminal and swipe between agents: sideways to the next, then the next.',
        then: 'All three checked before the train pulls in.',
        moment: { file: 'line-up', alt: 'Mid-swipe on a phone: the lamb agent’s terminal slides away as ram’s slides in', width: 720, height: 540, state: 'blue', label: 'lamb → ram · working' },
    },
    {
        film: 'farmhouse', no: 5, title: 'The Farmhouse Window',
        alt: 'The Farmhouse Window: the ram waits at a farmhouse keypad. At the beach, the developer opens Computer on his phone, types the sign-in code on his desktop at home, and the door opens.',
        when: 'You’re at the beach, and a deploy at home is stuck on a sign-in code.',
        you: 'Open the agent’s menu and tap Computer. Your desktop appears live: tap the code box and type the code with your phone’s keyboard.',
        then: 'You’re signed in, the deploy finishes, and you never left the beach.',
        moment: { file: 'farmhouse', alt: 'Computer on a phone: the desktop browser at home says You’re signed in', width: 720, height: 540, state: 'green', label: 'Computer · signed in' },
    },
    {
        film: 'whole-farm', no: 6, title: 'The Whole Farm',
        alt: 'The Whole Farm: from above, twenty fields across two machines, each with its flock. Three flocks stand idle until the developer types, says or taps their next task, and the whole farm moves.',
        when: 'Twenty projects on two machines, and three agents waiting for work.',
        you: 'Home groups agents by project. Pin the spaces you return to and they stay at the top; open one to type a task, say it, or tap a saved command.',
        then: 'Every field is moving again, from one hand.',
        moment: { file: 'whole-farm', alt: 'Spaces on a phone: meadow with lamb and ram, and meadow-web with ewe', width: 720, height: 540, state: 'blue', label: 'meadow, meadow-web' },
    },
    {
        film: 'talk-to-the-herd', no: 7, title: 'Talk to the Herd',
        alt: 'Talk to the Herd: hands full in the kitchen, the developer asks out loud what the herd is doing. The phone answers agent by agent, he tells lamb to open a pull request, and lamb does.',
        when: 'Your hands are full, and you want to know how the herd is doing.',
        you: 'Start a voice session and ask what the herd is doing. It answers agent by agent, and you say what one should do next.',
        then: 'Lamb opens the pull request. No screen needed.',
        moment: { file: 'talk-to-the-herd', alt: 'A realtime voice session on a phone: asking what the herd is doing, and sending lamb a follow-up', width: 540, height: 405, state: 'blue', label: 'Voice · listening' },
    },
];

function episode(ep: Episode): string {
    const m = ep.moment;
    return `<li class="episode">${film(ep.film, ep.alt)}<div class="episode-copy">
<p class="ep-no"><span>No.</span><b>${ep.no}</b><span>${ep.title}</span></p>
<h3>${ep.when}</h3><p>${ep.you}</p><p class="ep-then"><span class="dot" style="--state:var(--green)"></span>${ep.then}</p>
<figure class="moment"><img src="/film/screen-${m.file}.webp" alt="${escapeHtml(m.alt)}" width="${m.width}" height="${m.height}" loading="lazy" decoding="async"><figcaption><span class="dot" style="--state:var(--${m.state})"></span>${m.label}<span>In the app</span></figcaption></figure>
</div></li>`;
}

/** Everything else in your pocket, grouped by what you are doing. Each item is
 *  a crop of a real app screen from docs/screens (scripts/crop-screens.mjs). */
const POCKET: { group: string; when: string; items: { screen: string; title: string; sentence: string; alt: string }[] }[] = [
    {
        group: 'Answer', when: 'When one needs you.',
        items: [
            { screen: 'lock-screen', title: 'On your lock screen', sentence: 'A notification names the agent that needs you or has finished. Tap it to open that agent.', alt: 'A phone’s lock screen with a muxr notification: ram needs attention' },
            { screen: 'dictation', title: 'Dictate as you speak', sentence: 'Words land in the prompt while you talk, transcribed on your phone. Cancel if you change your mind, then undo within five seconds.', alt: 'A dictated prompt in an agent’s composer, above the tabs row and key row' },
        ],
    },
    {
        group: 'Watch', when: 'While they work.',
        items: [
            { screen: 'live', title: 'Live, at a glance', sentence: 'Home’s Live row shows each agent’s terminal as it runs, with the ones that need you first.', alt: 'Home’s Live row: lamb’s live terminal asking to run npm test, marked Needs you, under the plan and machine strip' },
            { screen: 'usage', title: 'Know your limits', sentence: 'See what’s left in each plan window, when it resets, and whether you’re on pace to run out. Home and Usage show the same numbers.', alt: 'Usage: go ahead with 59% left, and session and weekly limits on pace' },
            { screen: 'tabs', title: 'Every tab, one tap', sentence: 'The tabs row keeps an agent, its tests and its dev server one tap apart, and + opens a new tab on your computer.', alt: 'A workspace’s tests tab with every cart test passing' },
        ],
    },
    {
        group: 'Steer', when: 'Your way.',
        items: [
            { screen: 'keys', title: 'Real keys', sentence: 'Sticky modifiers, a key row you can reorder and add to, and your phone’s keyboard in the agent’s own terminal.', alt: 'An agent’s terminal with the tabs row, the key row and a typed prompt above the phone keyboard' },
            { screen: 'gestures', title: 'Gestures your way', sentence: 'Swipe between agents with one finger or two, choose where a swipe stops, and pinch to zoom the text.', alt: 'Gestures settings: swipe with one finger, stopping at working agents' },
            { screen: 'appearance', title: 'Your look', sentence: 'Pick seamless near-black or raised surfaces, the terminal text size, and which rows the terminal shows.', alt: 'Appearance settings: theme automatic, dark surfaces seamless' },
        ],
    },
];

const screenImg = (name: string, alt: string, width: number, height: number): string =>
    `<img src="/screens/${name}.webp" alt="${escapeHtml(alt)}" width="${width}" height="${height}" loading="lazy" decoding="async">`;

const pocket = (): string => POCKET.map(({ group, when, items }) => `<div class="pocket-group"><h3><span>${group}</span>${when}</h3><ul>${
    items.map((item) => `<li>${screenImg(item.screen, item.alt, 640, 480)}<div><strong>${item.title}</strong><p>${item.sentence}</p></div></li>`).join('')}</ul></div>`).join('\n');

/** The agents muxr opens, with the app's own marks (synced masks, tinted with the page's ink). */
const AGENTS: [string, string][] = [['claude', 'Claude Code'], ['codex', 'Codex'], ['gemini', 'Gemini CLI'], ['cursor', 'Cursor'], ['copilot', 'GitHub Copilot'],
    ['opencode', 'OpenCode'], ['pi', 'Pi'], ['omp', 'OMP'], ['cline', 'Cline'], ['kimi', 'Kimi'], ['amp', 'Amp'], ['grok', 'Grok'], ['devin', 'Devin'],
    ['antigravity', 'Antigravity'], ['kiro', 'Kiro'], ['droid', 'Factory Droid'], ['hermes', 'Hermes'], ['kilocode', 'Kilo Code'], ['qoder', 'Qoder'],
    ['mastracode', 'Mastra Code'], ['maki', 'Maki']];

const agentChips = (): string => AGENTS.map(([mark, name]) =>
    `<li><span class="mark" style="--mark:url(/marketing/agent-${mark}.png)"></span>${name}</li>`).join('');

export function writeLanding(res: ServerResponse): void {
    writeHtml(res, 200, 'Home', `<section class="hero">
<div class="hero-head"><div><p class="eyebrow">For the coding agents on your computer</p><h1>Every agent.<br>The real terminal.<br>In your pocket.</h1></div>
<div><p class="lede">See which agents are working, which need you, and which are done. Answer from your phone and the agent carries on in the same session.</p>
<div class="cta-row"><a class="button" href="#install">Install muxr</a><a class="button secondary" href="${REPO}">View on GitHub</a></div></div></div>
${film('gate', 'Tales from the Herd, The Gate: a lamb stops at a gate marked npm test and needs you. On a train miles away, you tap Yes on your phone, and the gate swings open.', true)}
<div class="film-note"><p><em>Tales from the Herd, No. 1: The Gate.</em> A lamb waits at <code>npm test</code>. You answer from the train.</p><p class="legend">${status('blue', 'working')}${status('red', 'needs you')}${status('green', 'done')}</p></div>
</section>
${FENCE}
<section class="band" id="films">
<div class="section-head"><div><p class="eyebrow">Tales from the Herd</p><h2>Your agents are the herd.</h2></div><p class="lede">Each sheep is a coding agent on your computer. Seven short films, seven ordinary moments, each beside the real screen that handles it.</p></div>
<ol class="episodes" aria-label="Tales from the Herd">
${EPISODES.map(episode).join('\n')}
</ol>
<div class="feature" id="review"><div class="feature-screen">${screenImg('review', 'An agent’s uncommitted change to cart.js, removed lines in red and added lines in green', 540, 1200)}</div><div class="episode-copy">
<p class="eyebrow">Review before it ships</p>
<h3>An agent says it’s done, and you’re away from your desk.</h3><p>Open its changes and read the real diff, every line: the working tree, what’s staged, or the whole branch.</p><p class="ep-then"><span class="dot" style="--state:var(--green)"></span>Tell it to ship, or what to fix, before anything leaves your computer.</p>
</div></div>
<p class="eyebrow pocket-head">Everything else in your pocket</p>
<div class="pocket">
${pocket()}
</div>
<div class="agents" id="agents"><h3>Works with the agents you already use.</h3><div><ul class="agent-list">${agentChips()}</ul><p>And more. Their subscriptions, tools and repositories stay where they are.</p></div></div>
</section>

<section class="band" id="install"><div class="install-grid">
<div><p class="eyebrow">Install and pair</p><h2>Set up in three steps.</h2><p class="lede">Setup inspects your machine first and changes nothing until you choose Apply.</p>
<ol class="steps" aria-label="Set up in three steps">
<li>${drawing('step-install', '', 64, 64, 'step-icon')}<div class="step-body"><strong><span class="step-k">1</span>Install on your computer</strong>${term('Terminal', INSTALL)}<span class="step-note">Needs Node.js 22 or newer on Linux, macOS or WSL.</span></div></li>
<li>${drawing('step-app', '', 64, 64, 'step-icon')}<div class="step-body"><strong><span class="step-k">2</span>Get the app</strong><div class="step-buttons"><a class="button secondary" href="${ANDROID}">Android APK</a><a class="button secondary" href="${TESTFLIGHT}">iOS TestFlight</a></div><span class="step-note">Or pair a browser during setup, with control or view only, for eight hours. TestFlight availability depends on review and tester capacity at Apple.</span></div></li>
<li>${drawing('step-scan', '', 64, 64, 'step-icon')}<div class="step-body"><strong><span class="step-k">3</span>Scan the pairing code</strong><span class="step-note"><code>muxr</code> shows a one-use QR code when setup is ready. Scan it from the app. <a href="/docs/quickstart">Quickstart &#8594;</a></span></div></li>
</ol>
<a class="textlink" href="${DOWNLOADS}">Stable and nightly downloads &#8594;</a></div>
<div class="faq">${drawing('question', 'The developer from the films, looking up with a question', 300, 300)}<p class="eyebrow">Questions</p>
<details><summary>Does muxr replace my coding agent?</summary><p>No. Keep the agents already installed on your computer. muxr is how you reach them from your phone.</p></details>
<details><summary>Can I continue the same session from my phone?</summary><p>Yes. muxr opens the agent’s live terminal with its current output and context, so your next prompt lands in the same session.</p></details>
<details><summary>Can I just watch what my agent is doing?</summary><p>Yes. Tap Computer to see your screen live, over your LAN, a mesh VPN or SSH. Nothing moves until you tap to take control: the pointer follows your finger, and copy and paste goes both ways.</p></details>
<details><summary>Does it work with a cloud server?</summary><p>Yes, even when SSH on port 22 is the only way in. The server gets a virtual display, so you can see it too.</p></details>
<details><summary>What do I need?</summary><p>Node.js 22 or newer on your computer, and the Android app, iOS TestFlight or a browser on your phone. Remote desktop needs a Linux x64 host for now.</p></details>
<details><summary>Do I need a muxr account?</summary><p>No. muxr is self-hosted only. Install it on your computer or a server you control.</p></details>
</div></div></section>

<section class="band" id="open-source">
<div class="section-head"><div><p class="eyebrow">Open source and self-hosted</p><h2>Yours to run.</h2><p class="lede">Your agents, code and keys stay on your computer. muxr is how your phone reaches them.</p></div>${drawing('farm', 'A farmhouse with its window lit and the herd grazing behind its own fence', 620, 330)}</div>
<div class="trust-statements" id="trust"><div class="trust-statement"><strong>Self-hosted</strong><span>Runs on your computer or a server you control. Nothing to sign up for.</span></div><div class="trust-statement"><strong>Open source</strong><span>Apache-2.0 app, CLI and host. <a href="${REPO}">Read the code</a>.</span></div><div class="trust-statement"><strong>No muxr servers</strong><span>We operate no backend. Your phone connects to machines you run.</span></div><div class="trust-statement"><strong>End-to-end encrypted</strong><span>Prompts, output, keystrokes, files and pairing secrets are encrypted between your phone and your computer.</span></div><div class="trust-statement"><strong>Any way in</strong><span>Pair over the same Wi-Fi, a mesh VPN, or SSH alone, even when port 22 is the only way in.</span></div><div class="trust-statement"><strong>Or just a browser</strong><span>Pair any browser for eight hours, view only or with control, or your own for 30 days. It installs as an app and gets notifications.</span></div></div>
<div class="plugins" id="plugins"><div><p class="eyebrow">Herdr plugins</p><h3>Your plugins, in your pocket.</h3><p class="muted" style="margin-top:.6rem">muxr runs Herdr plugins from Applications. Their code runs on your computer.</p><div class="plugin-links"><a class="textlink" href="https://herdr.dev/plugins/">Browse Herdr plugins &#8594;</a><a class="textlink" href="/docs/plugins">How it works &#8594;</a></div></div>
<div class="plugin-examples"><div class="plugin-example"><strong>Install</strong><span>Choose a plugin from herdr.dev/plugins and install it in Herdr.</span></div><div class="plugin-example"><strong>Open</strong><span>Enabled plugins appear under Applications in muxr.</span></div><div class="plugin-example"><strong>Run</strong><span>Launch their actions from your phone.</span></div></div></div>
</section><script src="/landing.js" defer></script>`);
}

/** Credits for the open-source projects muxr is built on. Keep in sync with NOTICE. */
export function writeOpenSource(res: ServerResponse): void {
    const credit = (href: string, name: string, what: string, license: string): string =>
        `<a class="card credit" href="${href}"><h3>${name}</h3><p>${what}</p><p class="muted">${license}</p></a>`;
    writeHtml(res, 200, 'Open source', `<section>${rail('', 'Open source &amp; credits')}<h1>Standing on other people’s work.</h1><p class="lede">The muxr app, CLI, host, pairing flow, and encryption are Apache-2.0. <a href="${REPO}">Read the source</a>, fork it, self-host it. Full third-party licence texts ship in the repository's NOTICE and LICENSES/, and in the npm package.</p><div class="grid">${[
        credit('https://herdr.dev', 'Herdr', 'The persistent agent runtime muxr connects to. muxr is an independent project, not affiliated with or endorsed by Herdr.', 'Apache-2.0 · Herdr contributors'),
        credit('https://github.com/slopus/happy', 'Happy', 'The mobile foundations began as a fork of Happy Coder.', 'MIT · Happy Coder Contributors'),
        credit('https://github.com/jmfederico/pi-web', 'PI WEB', 'Parts of the original session lifecycle and notification model were derived from PI WEB.', 'MIT · Federico Jaramillo Martinez'),
        credit('https://github.com/badlogic/pi', 'Pi Coding Agent', 'One of the first-class coding agents available through muxr and Herdr.', 'MIT · Mario Zechner and contributors'),
        credit('https://github.com/websockets/ws', 'ws', 'WebSocket transport for the published host.', 'MIT · Einar Otto Stangvik, Arnout Kazemier, Luigi Pinca and contributors'),
        credit('https://github.com/dchest/tweetnacl-js', 'TweetNaCl', 'X25519 key agreement and XSalsa20-Poly1305 authenticated encryption for the E2EE data plane.', 'Public domain / Unlicense'),
        credit('https://github.com/ggerganov/whisper.cpp', 'Whisper · whisper.cpp · whisper.rn', 'Fully on-device dictation with the quantized English Whisper Base model. Audio never leaves the phone.', 'MIT · OpenAI, the ggml authors, Jhen-Jie Hong'),
    ].join('')}</div><p class="muted" style="margin-top:2rem">Set in the app’s own type: Bricolage Grotesque and IBM Plex, both under the SIL Open Font License. Also built with Expo and React Native. Agent marks are the app’s own, drawn from each project’s published assets, and belong to their owners.</p><div class="cta-row"><a class="button" href="${REPO}">View the repository</a><a class="button secondary" href="/docs/plugins">Use Herdr plugins</a></div></section>`);
}

/** Lowercase basenames only: no slash, no backslash, no dot before the extension,
 *  so join() cannot escape the directory. A hand-kept allowlist silently 404'd
 *  every new capture the page started using, which is a worse failure than the
 *  traversal it was guarding against — the shape guard has no such drift. */
const SCREENSHOT_NAME = /^[a-z0-9][a-z0-9-]*\.(jpg|png|webp|svg|ico|woff2)$/;
const SCREENSHOT_TYPE: Record<string, string> = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon', woff2: 'font/woff2' };

/** Serves the images and fonts the pages use. No traversal. */
export function writeScreenshot(res: ServerResponse, name: string, screenshotsDir: string): boolean {
    if (!SCREENSHOT_NAME.test(name)) return false;
    const file = join(SITE_ROOT, screenshotsDir, name);
    if (!existsSync(file)) return false;
    res.writeHead(200, {
        'cache-control': 'public, max-age=3600',
        'content-length': statSync(file).size,
        'content-type': SCREENSHOT_TYPE[name.slice(name.lastIndexOf('.') + 1)] ?? 'application/octet-stream',
        'cross-origin-resource-policy': 'same-origin',
        'strict-transport-security': 'max-age=31536000; includeSubDomains',
        'x-content-type-options': 'nosniff',
    });
    createReadStream(file).pipe(res);
    return true;
}

/** The landing page's one script. Fixed path, so there is nothing to traverse. */
export function writeLandingScript(res: ServerResponse, webDir = join('docs', 'web')): boolean {
    const file = join(SITE_ROOT, webDir, 'landing.js');
    if (!existsSync(file)) return false;
    res.writeHead(200, {
        'cache-control': 'public, max-age=3600',
        'content-length': statSync(file).size,
        'content-type': 'text/javascript; charset=utf-8',
        'cross-origin-resource-policy': 'same-origin',
        'strict-transport-security': 'max-age=31536000; includeSubDomains',
        'x-content-type-options': 'nosniff',
    });
    createReadStream(file).pipe(res);
    return true;
}

const MEDIA_NAME = /^[a-z0-9][a-z0-9-]*\.(mp4|webm)$/;
const MEDIA_TYPE: Record<string, string> = { mp4: 'video/mp4', webm: 'video/webm' };

/**
 * Serves the films. Plain basenames only, no traversal, and a single
 * Range reply because Safari refuses to start a <video> that answers its
 * probe request with 200 instead of 206. Returns false when the file is not
 * there yet, so the page degrades to its poster frame during development.
 * ponytail: one range span only; multipart ranges if a longer film ever ships.
 */
export function writeMedia(res: ServerResponse, name: string, mediaDir: string, range?: string): boolean {
    if (!MEDIA_NAME.test(name)) return false;
    const type = MEDIA_TYPE[name.slice(name.lastIndexOf('.') + 1)]!;
    const file = join(SITE_ROOT, mediaDir, name);
    if (!existsSync(file)) return false;
    const size = statSync(file).size;
    const match = /^bytes=(\d*)-(\d*)$/.exec(range?.trim() ?? '');
    const headers = {
        'accept-ranges': 'bytes',
        'cache-control': 'public, max-age=3600',
        'content-type': type,
        'cross-origin-resource-policy': 'same-origin',
        'strict-transport-security': 'max-age=31536000; includeSubDomains',
        'x-content-type-options': 'nosniff',
    };
    if (match === null) {
        res.writeHead(200, { ...headers, 'content-length': size });
        createReadStream(file).pipe(res);
        return true;
    }
    const suffix = match[1] === '' && match[2] !== '' ? Number(match[2]) : undefined;
    const start = suffix === undefined ? Number(match[1]) : Math.max(0, size - suffix);
    const end = suffix === undefined
        ? (match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1))
        : size - 1;
    if ((suffix !== undefined && (!Number.isFinite(suffix) || suffix <= 0))
        || !Number.isFinite(start) || start > end || start >= size) {
        res.writeHead(416, { ...headers, 'content-range': `bytes */${size}` });
        res.end();
        return true;
    }
    res.writeHead(206, { ...headers, 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${size}` });
    createReadStream(file, { start, end }).pipe(res);
    return true;
}

/** Tabs across every doc page, so a reader never has to go back to the index. */
function docNav(current?: string): string {
    const tabs = DOCS.map((doc) => `<li><a href="/docs/${doc.slug}"${doc.slug === current ? ' aria-current="page"' : ''}>${doc.title}</a></li>`).join('');
    return `<ul class="doc-nav"><li><a href="/docs"${current === undefined ? ' aria-current="page"' : ''}>All docs</a></li>${tabs}</ul>`;
}

export function writeDocsIndex(res: ServerResponse): void {
    const cards = DOCS.map((doc) => `<a class="card" href="/docs/${doc.slug}"><h3>${doc.title}</h3><p>${doc.blurb}</p></a>`).join('');
    writeHtml(res, 200, 'Docs', `<section class="docs" style="max-width:none">${docNav()}<p class="eyebrow">Documentation</p><h1>Run it yourself.</h1><p class="lede">Six pages. Everything else lives beside the code in the <a href="${REPO}">public repository</a>.</p><div style="margin-top:1.9rem">${term('install', INSTALL)}</div><div class="grid three">${cards}</div></section>`);
}

export function writeDoc(res: ServerResponse, slug: string): boolean {
    const doc = DOCS.find((entry) => entry.slug === slug);
    if (doc === undefined) return false;
    const source = readFileSync(join(SITE_ROOT, 'docs', 'site', `${doc.slug}.md`), 'utf8');
    writeHtml(res, 200, doc.title, `<article class="docs">${docNav(doc.slug)}${renderMarkdown(source)}</article>`);
    return true;
}

/** Store-facing pages (Google Play / App Store listing URLs). Same markdown
 *  pipeline as the docs, but served at root paths with their legal titles and
 *  kept out of the docs index and nav. The allowlist doubles as the router's. */
const STORE_PAGES: Record<string, string> = {
    privacy: 'Privacy Policy',
    support: 'Support',
};

export const STORE_PAGE_PATHS = Object.keys(STORE_PAGES).map((slug) => `/${slug}`);

export function writeStorePage(res: ServerResponse, slug: string): boolean {
    const title = STORE_PAGES[slug];
    if (title === undefined) return false;
    const source = readFileSync(join(SITE_ROOT, 'docs', 'site', `${slug}.md`), 'utf8');
    writeHtml(res, 200, title, `<article class="docs">${renderMarkdown(source)}</article>`);
    return true;
}

export function writeMessage(res: ServerResponse, status: number, title: string, message: string, link = '/', extraHeaders: Record<string, string> = {}): void {
    writeHtml(res, status, title, `<section class="auth"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><a class="button" href="${escapeHtml(link)}">Continue</a></section>`, extraHeaders);
}

/** People who follow a dead link meet the lost lamb, and three ways home. */
export function writeNotFound(res: ServerResponse): void {
    writeHtml(res, 404, 'Nothing at this address', `<section class="lost">${drawing('lost', 'A lost lamb at a signpost, with a question mark over its head', 420, 330)}<p class="eyebrow">404</p><h1>This page has wandered off.</h1><p class="lede">It may have moved, or the link may be mistyped. Home, the docs and the downloads are one step away.</p><div class="cta-row"><a class="button" href="/">Home</a><a class="button secondary" href="/docs">Docs</a><a class="button secondary" href="/downloads">Downloads</a></div></section>`);
}

/** The /pair landing for a pairing link opened somewhere the app is not installed. */
export function writePair(res: ServerResponse): void {
    writeHtml(res, 200, 'Open muxr', `<section class="docs">${drawing('pair', 'The developer from the films holds his phone up to the pairing code on his laptop', 480, 300, 'drawing spot')}<p class="eyebrow">Pairing link</p><h1>Open this link on the device you are pairing.</h1><p class="lede">On a phone with the muxr app installed, this link opens the app and completes pairing. Otherwise install the app, then scan the QR code or paste the pairing string that <code>muxr</code> shows on your computer. To pair a browser, use the link <code>muxr</code> prints: it points at your own host, never at this site.</p><p><a class="button" href="/docs/quickstart">Read the quickstart</a> <a class="button secondary" href="/downloads">Get the app</a></p></section>`);
}
