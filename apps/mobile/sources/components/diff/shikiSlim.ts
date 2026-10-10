/**
 * What `import "shiki"` resolves to on web (metro.config.js), for the diff
 * viewer.
 *
 * The stock bundle lazy-imports every grammar; the grammars embed one another,
 * so Metro's serializer files the shared ones under `__common`, which
 * index.html loads eagerly: megabytes of grammars before the first paint. Here
 * the grammars people actually diff are imported statically, so the whole set
 * lives in the lazy diff chunk.
 *
 * Every other grammar is fetched on demand as one JSON file per language from
 * `/shiki-langs/` (built by scripts/buildShikiLangs.mjs). Metro cannot split
 * per-grammar chunks without hoisting their shared embedded grammars back into
 * the eager `__common` chunk, so the payload leaves the bundle entirely and
 * loads only when a diff needs that language. Until it arrives the file renders
 * as plain text; the async highlight re-renders it once the grammar resolves.
 */
import { createBundledHighlighter, createSingletonShorthands, guessEmbeddedLanguages } from '@shikijs/core';
import type { LanguageRegistration } from '@shikijs/core';
import { createOnigurumaEngine } from '@shikijs/engine-oniguruma';
import { languageAliasNames, languageNames } from '@shikijs/langs';
import { bundledThemes } from 'shiki/themes';
import c from '@shikijs/langs/c';
import cpp from '@shikijs/langs/cpp';
import css from '@shikijs/langs/css';
import diff from '@shikijs/langs/diff';
import dockerfile from '@shikijs/langs/dockerfile';
import go from '@shikijs/langs/go';
import graphql from '@shikijs/langs/graphql';
import html from '@shikijs/langs/html';
import ini from '@shikijs/langs/ini';
import java from '@shikijs/langs/java';
import javascript from '@shikijs/langs/javascript';
import json from '@shikijs/langs/json';
import jsonc from '@shikijs/langs/jsonc';
import jsx from '@shikijs/langs/jsx';
import kotlin from '@shikijs/langs/kotlin';
import make from '@shikijs/langs/make';
import markdown from '@shikijs/langs/markdown';
import php from '@shikijs/langs/php';
import python from '@shikijs/langs/python';
import ruby from '@shikijs/langs/ruby';
import rust from '@shikijs/langs/rust';
import scss from '@shikijs/langs/scss';
import shellscript from '@shikijs/langs/shellscript';
import sql from '@shikijs/langs/sql';
import swift from '@shikijs/langs/swift';
import toml from '@shikijs/langs/toml';
import tsx from '@shikijs/langs/tsx';
import typescript from '@shikijs/langs/typescript';
import xml from '@shikijs/langs/xml';
import yaml from '@shikijs/langs/yaml';

export * from '@shikijs/core';
export { bundledThemes, bundledThemesInfo } from 'shiki/themes';
export { createJavaScriptRegexEngine } from '@shikijs/engine-javascript';
export { createOnigurumaEngine } from '@shikijs/engine-oniguruma';

type Grammar = LanguageRegistration[];
type GrammarLoader = () => Promise<{ default: Grammar }>;
const grammars: Record<string, Grammar> = {
    c, cpp, css, diff, dockerfile, go, graphql, html, ini, java, javascript, json, jsonc, jsx, kotlin, make,
    markdown, php, python, ruby, rust, scss, shellscript, sql, swift, toml, tsx, typescript, xml, yaml,
};
const slimBases: Record<string, GrammarLoader> = Object.fromEntries(
    Object.entries(grammars).map(([id, grammar]) => [id, () => Promise.resolve({ default: grammar })]),
);
const slimAliases: Record<string, GrammarLoader> = Object.fromEntries(
    Object.entries(grammars).flatMap(([id, grammar]) =>
        (grammar[grammar.length - 1]?.aliases ?? []).map((alias) => [alias, () => Promise.resolve({ default: grammars[id]! })] as const)),
);
export const bundledLanguagesBase = slimBases;
export const bundledLanguagesAlias = slimAliases;
export const bundledLanguagesInfo = Object.entries(grammars).map(([id, grammar]) => ({
    id, name: grammar[grammar.length - 1]?.displayName ?? id, aliases: grammar[grammar.length - 1]?.aliases, import: slimBases[id]!,
}));

// A fetched grammar's JSON holds only the grammars outside the slim set; the
// slim grammars are prepended so shiki can resolve the embedded grammars it
// names (loadLanguages throws if any named grammar is missing from the batch).
const slimGrammars = Object.values(grammars).flat();
const slimKeys = new Set([...Object.keys(slimBases), ...Object.keys(slimAliases)]);

let aliasMap: Promise<Record<string, string>> | undefined;
function loadAliasMap(): Promise<Record<string, string>> {
    aliasMap ??= fetch('/shiki-langs/index.json')
        .then((response) => (response.ok ? response.json() : {}))
        .then((manifest: { aliases?: Record<string, string> }) => manifest.aliases ?? {})
        .catch(() => ({}));
    return aliasMap;
}

async function loadExtraGrammar(key: string): Promise<{ default: Grammar }> {
    const id = (await loadAliasMap())[key] ?? key;
    const response = await fetch(`/shiki-langs/${id}.json`);
    if (!response.ok) throw new Error(`shiki grammar "${key}" unavailable (${response.status})`);
    const data: Grammar = await response.json();
    return { default: [...slimGrammars, ...data] };
}

const extraLoaders: Record<string, GrammarLoader> = Object.fromEntries(
    [...languageNames, ...languageAliasNames]
        .filter((key) => !slimKeys.has(key))
        .map((key) => [key, () => loadExtraGrammar(key)]),
);
export const bundledLanguages: Record<string, GrammarLoader> = { ...slimBases, ...slimAliases, ...extraLoaders };

export const createHighlighter = createBundledHighlighter({
    langs: bundledLanguages,
    themes: bundledThemes,
    engine: () => createOnigurumaEngine(import('shiki/wasm')),
});
export const {
    codeToHtml,
    codeToHast,
    codeToTokens,
    codeToTokensBase,
    codeToTokensWithThemes,
    getSingletonHighlighter,
    getLastGrammarState,
} = createSingletonShorthands(createHighlighter, { guessEmbeddedLanguages });
