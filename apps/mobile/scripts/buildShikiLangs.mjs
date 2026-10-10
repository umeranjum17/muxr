#!/usr/bin/env node
/**
 * Generate the web diff viewer's on-demand grammar assets.
 *
 * The web build ships a fixed 30-grammar slim set with the diff viewer
 * (`sources/components/diff/shikiSlim.ts`); every other shiki grammar is fetched
 * here on demand, one JSON file per language, so the landing and pair routes
 * never carry them. `checkWebExport` ratchets that.
 *
 * Each file holds only the grammars the slim set does NOT already provide
 * (the language plus any embedded grammars outside the slim set); the slim set
 * is prepended at load time so shiki can resolve embedded grammars. A tiny
 * `index.json` maps aliases (`zsh`, `cmd`, ...) to their canonical file, because
 * Pierre resolves a file to an alias id from its extension.
 *
 * Run before `expo export` (see the `setup-shiki-langs` script). Output is
 * build data under `public/`, gitignored like canvaskit and mermaid.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// The workspace hoists @shikijs/langs to the repo root; resolve where it really is.
const langsDir = dirname(fileURLToPath(import.meta.resolve('@shikijs/langs')));
const outDir = join(root, 'public', 'shiki-langs');

// Must match the static set in sources/components/diff/shikiSlim.ts.
const SLIM = new Set([
    'c', 'cpp', 'css', 'diff', 'dockerfile', 'go', 'graphql', 'html', 'ini', 'java', 'javascript', 'json', 'jsonc',
    'jsx', 'kotlin', 'make', 'markdown', 'php', 'python', 'ruby', 'rust', 'scss', 'shellscript', 'sql', 'swift',
    'toml', 'tsx', 'typescript', 'xml', 'yaml',
]);

const { languageNames, languageAliasNames } = await import('@shikijs/langs');

// An alias module is `/* Alias <alias> for <canonical> */ export { default } from './<canonical>.mjs'`.
function aliasTarget(alias) {
    const source = readFileSync(join(langsDir, `${alias}.mjs`), 'utf8');
    return /from\s+["']\.\/([^"']+)\.mjs["']/.exec(source)?.[1];
}

const aliasToId = {};
for (const alias of languageAliasNames) {
    const target = aliasTarget(alias);
    if (target === undefined || SLIM.has(target)) continue;
    aliasToId[alias] = target;
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

let count = 0;
let bytes = 0;
for (const id of languageNames) {
    if (SLIM.has(id)) continue;
    const { default: data } = await import(`@shikijs/langs/${id}`);
    const stripped = data.filter((grammar) => !SLIM.has(grammar.name));
    const json = JSON.stringify(stripped);
    writeFileSync(join(outDir, `${id}.json`), json);
    count += 1;
    bytes += json.length;
}
writeFileSync(join(outDir, 'index.json'), JSON.stringify({ aliases: aliasToId }));

process.stdout.write(
    `buildShikiLangs: ${count} grammars (${(bytes / 1024 / 1024).toFixed(2)} MB) + ${Object.keys(aliasToId).length} aliases -> public/shiki-langs/\n`,
);
