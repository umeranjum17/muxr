/**
 * Render the configuration attribute table from the one schema into every
 * Markdown page that carries a `config-attributes` block, so docs and the
 * agent skill can never drift from what the CLI validates.
 *
 *   node scripts/release/application/generateConfigDocs.mjs          rewrite the blocks
 *   node scripts/release/application/generateConfigDocs.mjs --check  exit 1 if any block is stale
 *
 * Blocks are delimited by `<!-- config-attributes:start -->` and
 * `<!-- config-attributes:end -->`; everything else on the page is hand-written.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_ATTRIBUTES, CONFIG_CONFLICTS, configSchema } from '../../setup/infrastructure/configSchema.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const CONFIG_DOC_PAGES = ['docs/user/configuration.md', 'skills/muxr/references/onboarding.md'];
const START = '<!-- config-attributes:start -->';
const END = '<!-- config-attributes:end -->';

const shown = (attribute) => {
    if (attribute.default === undefined) return 'unset';
    if (typeof attribute.default === 'object') return 'none';
    return `\`${attribute.default}\``;
};
const valuesOf = (attribute) => (Array.isArray(attribute.values) ? attribute.values.map((value) => `\`${value}\``).join(' · ') : `\`${attribute.values}\``);

export function renderConfigAttributes() {
    const schema = configSchema();
    const lines = [
        START,
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
        END,
    ];
    return lines.join('\n');
}

export function renderPage(text) {
    const start = text.indexOf(START);
    const end = text.indexOf(END);
    if (start < 0 || end < 0 || end < start) throw new Error('page has no config-attributes block');
    return `${text.slice(0, start)}${renderConfigAttributes()}${text.slice(end + END.length)}`;
}

export function checkConfigDocs() {
    const stale = [];
    for (const page of CONFIG_DOC_PAGES) {
        const path = join(ROOT, page);
        if (!existsSync(path)) { stale.push(`${page} (missing)`); continue; }
        const current = readFileSync(path, 'utf8');
        if (renderPage(current) !== current) stale.push(page);
    }
    return stale;
}

if (process.argv[1] !== undefined && /generateConfigDocs\.mjs$/.test(process.argv[1])) {
    if (process.argv.includes('--check')) {
        const stale = checkConfigDocs();
        if (stale.length > 0) {
            process.stderr.write(`FAIL configuration docs are stale: ${stale.join(', ')} — run node scripts/release/application/generateConfigDocs.mjs\n`);
            process.exit(1);
        }
        process.stdout.write(`configuration docs match the schema (${CONFIG_DOC_PAGES.length} pages)\n`);
    } else {
        for (const page of CONFIG_DOC_PAGES) {
            const path = join(ROOT, page);
            writeFileSync(path, renderPage(readFileSync(path, 'utf8')));
            process.stdout.write(`rendered ${page}\n`);
        }
    }
}
