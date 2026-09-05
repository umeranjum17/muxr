import Prism from 'prismjs';

// Keep this list explicit so Metro bundles only the grammars the app renders.
import 'prismjs/components/prism-markup';
import 'prismjs/components/prism-css';
import 'prismjs/components/prism-javascript';
import 'prismjs/components/prism-typescript';
import 'prismjs/components/prism-jsx';
import 'prismjs/components/prism-tsx';
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-markdown';
import 'prismjs/components/prism-yaml';
import 'prismjs/components/prism-toml';
import 'prismjs/components/prism-ini';
import 'prismjs/components/prism-bash';
import 'prismjs/components/prism-docker';
import 'prismjs/components/prism-graphql';
import 'prismjs/components/prism-python';
import 'prismjs/components/prism-go';
import 'prismjs/components/prism-rust';
import 'prismjs/components/prism-java';
import 'prismjs/components/prism-c';
import 'prismjs/components/prism-cpp';
import 'prismjs/components/prism-sql';
import 'prismjs/components/prism-ruby';
import 'prismjs/components/prism-swift';
import 'prismjs/components/prism-kotlin';
import 'prismjs/components/prism-markup-templating';
import 'prismjs/components/prism-php';
import 'prismjs/components/prism-hcl';

/** `mark` is a word-level change highlight, set by the diff, not by Prism. */
export interface SyntaxSpan { text: string; type?: string; mark?: true }

const LANGUAGE_ALIASES: Record<string, string> = {
    js: 'javascript', javascript: 'javascript',
    ts: 'typescript', typescript: 'typescript',
    jsx: 'jsx', tsx: 'tsx',
    html: 'markup', htm: 'markup', xml: 'markup', svg: 'markup', markup: 'markup',
    css: 'css', json: 'json', jsonc: 'json',
    md: 'markdown', mdx: 'markdown', markdown: 'markdown',
    yml: 'yaml', yaml: 'yaml', toml: 'toml', ini: 'ini',
    sh: 'bash', bash: 'bash', shell: 'bash', zsh: 'bash',
    dockerfile: 'docker', docker: 'docker', graphql: 'graphql', gql: 'graphql',
    py: 'python', python: 'python', go: 'go', rs: 'rust', rust: 'rust',
    java: 'java', c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp',
    sql: 'sql', php: 'php', rb: 'ruby', ruby: 'ruby', swift: 'swift', kt: 'kotlin', kts: 'kotlin', kotlin: 'kotlin',
    hcl: 'hcl', tf: 'hcl',
};

export function syntaxLanguage(language?: string, fileName?: string): string | undefined {
    const hint = language?.trim().toLowerCase();
    if (hint && LANGUAGE_ALIASES[hint]) return LANGUAGE_ALIASES[hint];
    const base = fileName?.split('/').pop()?.toLowerCase();
    if (!base) return undefined;
    if (base === 'dockerfile') return 'docker';
    const extension = base.includes('.') ? base.slice(base.lastIndexOf('.') + 1) : '';
    return LANGUAGE_ALIASES[extension];
}

function flatten(content: string | Prism.Token | Prism.TokenStream, type: string | undefined, output: SyntaxSpan[]): void {
    if (typeof content === 'string') {
        output.push(type === undefined ? { text: content } : { text: content, type });
        return;
    }
    if (Array.isArray(content)) {
        for (const token of content) flatten(token, type, output);
        return;
    }
    flatten(content.content, content.type, output);
}

/** Tokenize once, then split spans back into lines for native and web renderers. */
export function highlightCodeLines(code: string, language?: string): SyntaxSpan[][] {
    const grammar = language === undefined ? undefined : Prism.languages[language];
    // Minified files make regex tokenizers backtrack on the JS thread.
    if (grammar === undefined || /[^\n]{4000}/.test(code)) return code.split('\n').map((text) => [{ text }]);
    const flat: SyntaxSpan[] = [];
    try {
        flatten(Prism.tokenize(code, grammar), undefined, flat);
    } catch {
        return code.split('\n').map((text) => [{ text }]);
    }
    const lines: SyntaxSpan[][] = [[]];
    for (const span of flat) {
        const parts = span.text.split('\n');
        for (let index = 0; index < parts.length; index += 1) {
            if (parts[index] !== '') lines[lines.length - 1].push(span.type === undefined ? { text: parts[index] } : { text: parts[index], type: span.type });
            if (index < parts.length - 1) lines.push([]);
        }
    }
    return lines;
}
