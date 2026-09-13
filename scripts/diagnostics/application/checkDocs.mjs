/**
 * Documentation gate for the canonical beginner pages and every surface that
 * carries an install command:
 *
 *  a. relative links, anchors and images resolve;
 *  b. every `muxr <command>` in a runnable block exists in the CLI; every
 *     `herdr plugin install` names the exact source with a pinned release ref;
 *  c. runnable (```bash / ```text) blocks carry no placeholders, no shell
 *     `a|b` alternatives, no prompt markers, no secrets in argv, no
 *     maintainer-only paths;
 *  d. the Herdr and npm commands are byte-identical everywhere they appear,
 *     including the demo's shared module;
 *  e. numeric lifetimes appear only in generated release-facts blocks;
 *  f. every user page ends with one "Next:" line, and no user page links to
 *     maintainer documents.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkConfigDocs, releaseFacts } from '../../release/index.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const USER_PAGES = ['docs/user/introduction.md', 'docs/user/install.md', 'docs/user/daily-use.md', 'docs/user/configuration.md', 'docs/user/trust.md', 'docs/user/troubleshooting.md'];
const COMMAND_PAGES = [...USER_PAGES, 'README.md', 'docs/README.md', 'docs/npm-readme.md', 'plugins/README.md', 'plugins/control/README.md', 'skills/muxr/SKILL.md', 'skills/muxr/references/onboarding.md', 'skills/muxr/references/herdr.md', 'skills/muxr/references/plugins.md', 'skills/muxr/references/collaboration.md', 'skills/muxr/references/browser-takeover.md'];
const MAINTAINER_DOCS = ['ARCHITECTURE.md', 'RELEASING.md', 'NATIVE-BUILD.md', 'NEW-USER-SMOKE.md', 'HOST-CONTRACT-COMPATIBILITY.md', 'license-inventory.md', 'decisions/', 'specs/', 'CONTEXT.md', 'CONTEXT-MAP.md', 'AGENTS.md', 'CLAUDE.md', 'USE_CASES.md'];

const failures = [];
const fail = (page, message) => failures.push(`${page}: ${message}`);
const read = (page) => readFileSync(join(ROOT, page), 'utf8');

const cliHelp = read('scripts/cli.mjs');
const knownCommands = new Set([...cliHelp.matchAll(/command === '([a-z-]+)'/g)].map((match) => match[1]));
knownCommands.add('--skill');

const facts = await releaseFacts();
const slug = (heading) => heading.toLowerCase().replace(/[`*_]/g, '').replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-');

function fences(text) {
    const out = [];
    const pattern = /```([a-z]*)\n([\s\S]*?)```/g;
    for (const match of text.matchAll(pattern)) out.push({ lang: match[1], body: match[2] });
    return out;
}
function withoutGenerated(text) {
    return text.replace(/<!-- ([a-z-]+):start -->[\s\S]*?<!-- \1:end -->/g, '');
}

for (const page of COMMAND_PAGES) {
    if (!existsSync(join(ROOT, page))) { fail(page, 'missing'); continue; }
    const text = read(page);
    const dir = dirname(join(ROOT, page));
    // a. links
    for (const match of text.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
        const target = match[1];
        if (/^(https?:|mailto:|#)/.test(target)) {
            if (target.startsWith('#')) {
                const anchors = new Set([...text.matchAll(/^#{1,6}\s+(.+)$/gm)].map((heading) => slug(heading[1])));
                if (!anchors.has(target.slice(1))) fail(page, `anchor ${target} not found`);
            }
            continue;
        }
        const [file, anchor] = target.split('#');
        const path = resolve(dir, file);
        if (!existsSync(path)) { fail(page, `link ${target} does not resolve`); continue; }
        if (anchor !== undefined && path.endsWith('.md')) {
            const anchors = new Set([...readFileSync(path, 'utf8').matchAll(/^#{1,6}\s+(.+)$/gm)].map((heading) => slug(heading[1])));
            if (!anchors.has(anchor)) fail(page, `anchor ${target} not found`);
        }
        if (USER_PAGES.includes(page) && MAINTAINER_DOCS.some((doc) => file.includes(doc))) fail(page, `user page links to maintainer document ${file}`);
    }
    // b + c. commands
    for (const fence of fences(text)) {
        if (fence.lang !== 'bash' && fence.lang !== 'text') continue;
        for (const rawLine of fence.body.split('\n')) {
            const line = rawLine.replace(/\s+#.*$/, '').trim();
            if (line === '') continue;
            if (/^\$ /.test(rawLine)) fail(page, `prompt marker in runnable block: ${rawLine}`);
            if (fence.lang === 'bash' && /<[^>]+>/.test(line)) fail(page, `placeholder in bash block: ${line}`);
            if (/\S\|\S/.test(line) && !line.startsWith('|')) fail(page, `shell alternative in runnable block: ${line}`);
            if (/(key|token|secret|password)=\S+/i.test(line) || /\b(sk|xai)-[A-Za-z0-9]{6,}/.test(line)) fail(page, `secret in argv: ${line}`);
            if (/\.\/scripts\/|scripts\/diagnostics|dist-npm|apps\/mobile\//.test(line) && !page.startsWith('docs/README')) fail(page, `maintainer path in runnable block: ${line}`);
            const muxr = /^(?:npx )?muxr\s+(--?[a-z-]+|[a-z-]+)/.exec(line);
            if (muxr !== null && !knownCommands.has(muxr[1]) && !['--version', '-v', '--help'].includes(muxr[1])) fail(page, `unknown muxr command: ${line}`);
            const herdr = /^herdr plugin install\s+(\S+)(.*)$/.exec(line);
            if (herdr !== null) {
                if (herdr[1] !== 'umeranjum17/muxr/plugins/control') fail(page, `herdr plugin install must name the exact source: ${line}`);
                if (!/--ref v\d+\.\d+\.\d+/.test(herdr[2])) fail(page, `herdr plugin install must pin a release ref: ${line}`);
                if (line !== facts.commands.herdrInstall) fail(page, `Herdr install command differs from the release facts: ${line}`);
            }
            if (/^npm install/.test(line) && line !== facts.commands.npmInstall) fail(page, `npm install command differs from the release facts: ${line}`);
        }
    }
    // e. lifetimes outside generated blocks
    const prose = withoutGenerated(text);
    for (const match of prose.matchAll(/\b(?:\d+|two|five|eight|thirty)\s+(?:minutes?|hours?|days?)\b/gi)) {
        fail(page, `lifetime stated outside the release-facts block: "${match[0]}"`);
    }
}

// d. byte-identical commands: the demo's shared module derives the same strings.
const demoCommands = read('apps/mobile/sources/demo/installCommands.ts');
if (!demoCommands.includes("`herdr plugin install ${HERDR_PLUGIN_SOURCE} --ref v${version}`") || !demoCommands.includes(`'${facts.commands.npmInstall}'`) || !demoCommands.includes(`'${facts.commands.herdrSetupPane}'`)) {
    fail('apps/mobile/sources/demo/installCommands.ts', 'demo connect commands differ from the release facts');
}
for (const page of ['README.md', 'docs/user/install.md', 'docs/npm-readme.md', 'skills/muxr/references/onboarding.md']) {
    const text = read(page);
    if (!text.includes(facts.commands.herdrInstall) || !text.includes(facts.commands.herdrSetupPane)) fail(page, 'does not carry the generated Herdr commands');
}
// Generated blocks are current.
for (const stale of await checkConfigDocs()) fail(stale, 'generated block is stale; run node scripts/release/application/generateConfigDocs.mjs');

// f. one Next line at the end of every user page.
for (const page of USER_PAGES) {
    const lines = read(page).trimEnd().split('\n');
    if (!/^Next: /.test(lines[lines.length - 1] ?? '')) fail(page, 'must end with one "Next:" line');
}

if (failures.length > 0) {
    process.stderr.write(`FAIL docs gate:\n${failures.map((line) => `  - ${line}`).join('\n')}\n`);
    process.exit(1);
}
process.stdout.write(`docs gate: ${COMMAND_PAGES.length} pages — links, commands, placeholders, byte-identical install commands, lifetimes, next steps ok\n`);
