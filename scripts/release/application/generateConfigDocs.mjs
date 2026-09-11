/**
 * Render the configuration attribute table from the one schema into every
 * Markdown page that carries a `config-attributes` block, so docs and the
 * agent skill can never drift from what the CLI validates.
 *
 *   node scripts/release/application/generateConfigDocs.mjs          rewrite the blocks
 *   node scripts/release/application/generateConfigDocs.mjs --check  exit 1 if any block is stale
 *
 * Blocks are delimited by `<!-- <kind>:start -->` and `<!-- <kind>:end -->`;
 * everything else on the page is hand-written.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_ATTRIBUTES, CONFIG_CONFLICTS, configSchema } from '../../setup/index.mjs';
import { releaseFacts } from './releaseFacts.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
/** Every page that carries at least one generated block. */
export const CONFIG_DOC_PAGES = [
    'README.md',
    'docs/npm-readme.md',
    'docs/user/introduction.md',
    'docs/user/install.md',
    'docs/user/daily-use.md',
    'docs/user/configuration.md',
    'docs/user/trust.md',
    'docs/user/troubleshooting.md',
    'skills/muxr/references/onboarding.md',
    'plugins/control/README.md',
];

const shown = (attribute) => {
    if (attribute.default === undefined) return 'unset';
    if (typeof attribute.default === 'object') return 'none';
    return `\`${attribute.default}\``;
};
const valuesOf = (attribute) => (Array.isArray(attribute.values) ? attribute.values.map((value) => `\`${value}\``).join(' · ') : `\`${attribute.values}\``);

export function renderConfigAttributes() {
    const schema = configSchema();
    const lines = [
        `_Generated from the configuration schema (version ${schema.version}) by \`scripts/release/application/generateConfigDocs.mjs\`; edit the schema, not this table._`,
        '',
        '| Key | Values | Default | Applies to | Restart | Meaning |',
        '|---|---|---|---|---|---|',
        ...CONFIG_ATTRIBUTES.map((attribute) => `| \`${attribute.key}\` | ${valuesOf(attribute)} | ${shown(attribute)} | ${attribute.appliesTo} | ${attribute.restart} | ${attribute.description.replace(/\|/g, '\\|')} |`),
        '',
        'Rules across keys:',
        '',
        ...CONFIG_CONFLICTS.map((conflict) => `- ${conflict.rule}.`),
        '',
        `Not configuration (never in this file, never in a receipt): ${schema.notConfiguration.join('; ')}.`,
        '',
        `Precedence, everywhere: ${schema.precedence.map((source) => `\`${source}\``).join(' > ')}. Exit codes for \`muxr setup --apply-config\`: ${Object.entries(schema.exitCodes).map(([code, meaning]) => `\`${code}\` ${meaning}`).join('; ')}.`,
    ];
    return lines.join('\n');
}

/**
 * Generated blocks a page may carry, each delimited by
 * `<!-- <kind>:start -->` / `<!-- <kind>:end -->`:
 *   config-attributes  the attribute table above
 *   herdr-commands     the two Herdr commands (exact source, pinned release ref, Setup pane)
 *   npm-commands       the npm fallback (install, then `muxr`)
 *   release-facts      the numbers every page quotes (lifetimes, port, versions)
 */
function renderBlock(kind, facts) {
    if (kind === 'config-attributes') return renderConfigAttributes();
    if (kind === 'herdr-commands') return ['```text', facts.commands.herdrInstall, facts.commands.herdrSetupPane, '```'].join('\n');
    if (kind === 'npm-commands') return ['```bash', facts.commands.npmInstall, facts.commands.npmSetup, '```'].join('\n');
    if (kind === 'release-facts') {
        return [
            '| Fact | Value |',
            '|---|---|',
            `| Current release | \`${facts.package}@${facts.version}\` (tag \`${facts.releaseTag}\`) |`,
            `| Minimum Herdr | ${facts.minHerdrVersion} |`,
            `| Minimum Node (npm path) | ${facts.nodeMinimum} |`,
            `| Default relay port | ${facts.defaultRelayPort} |`,
            `| Pairing link | one use, expires in ${facts.pairingLinkLifetime} |`,
            `| Browser access (Control or View-only) | ${facts.browserGrantLifetime} |`,
            `| Personal Control (installed browser you own) | ${facts.personalGrantLifetime} |`,
            `| Machine enrollment (shared relay) | ${facts.enrollmentLifetime} |`,
            `| Native apps | optional: [Android APK](${facts.native.androidStableApk}) ([checksums](${facts.native.androidChecksums})), [Google Play testing](${facts.native.googlePlayTesting}), [iOS TestFlight](${facts.native.iosTestFlight}) — availability depends on store review; [all channels](${facts.native.allChannels}) |`,
        ].join('\n');
    }
    throw new Error(`unknown generated block: ${kind}`);
}

const BLOCK = /<!-- ([a-z-]+):start -->[\s\S]*?<!-- \1:end -->/g;

export function renderPage(text, facts) {
    let seen = 0;
    const out = text.replace(BLOCK, (_match, kind) => { seen += 1; return `<!-- ${kind}:start -->\n${renderBlock(kind, facts)}\n<!-- ${kind}:end -->`; });
    if (seen === 0) throw new Error('page has no generated block');
    return out;
}

export async function checkConfigDocs() {
    const facts = await releaseFacts();
    const stale = [];
    for (const page of CONFIG_DOC_PAGES) {
        const path = join(ROOT, page);
        if (!existsSync(path)) { stale.push(`${page} (missing)`); continue; }
        const current = readFileSync(path, 'utf8');
        if (renderPage(current, facts) !== current) stale.push(page);
    }
    return stale;
}

/** Rewrite every generated block on every page. */
export async function generateConfigDocs() {
    const facts = await releaseFacts();
    for (const page of CONFIG_DOC_PAGES) {
        const path = join(ROOT, page);
        writeFileSync(path, renderPage(readFileSync(path, 'utf8'), facts));
    }
    return CONFIG_DOC_PAGES;
}

if (process.argv[1] !== undefined && /generateConfigDocs\.mjs$/.test(process.argv[1])) {
    if (process.argv.includes('--check')) {
        const stale = await checkConfigDocs();
        if (stale.length > 0) {
            process.stderr.write(`FAIL generated doc blocks are stale: ${stale.join(', ')} — run node scripts/release/application/generateConfigDocs.mjs\n`);
            process.exit(1);
        }
        process.stdout.write(`generated doc blocks match the schema and release facts (${CONFIG_DOC_PAGES.length} pages)\n`);
    } else {
        for (const page of await generateConfigDocs()) process.stdout.write(`rendered ${page}\n`);
    }
}
