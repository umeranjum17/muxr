/**
 * Web-only code editor with syntax highlighting.
 * Uses react-simple-code-editor + Prism.js.
 * Theme colors match the app's syntax highlighting (Pierre-consistent).
 */
import * as React from 'react';
import Editor from 'react-simple-code-editor';
import Prism from 'prismjs';
import { syntaxLanguage } from '@/components/code/syntaxHighlighting';

interface CodeEditorProps {
    value: string;
    onChange: (value: string) => void;
    language: string | null;
    darkMode: boolean;
    readOnly?: boolean;
}

export const CodeEditor = React.memo(function CodeEditor({
    value,
    onChange,
    language,
    darkMode,
    readOnly = false,
}: CodeEditorProps) {
    const highlight = React.useCallback((code: string) => {
        const prismLang = syntaxLanguage(language ?? undefined);
        const grammar = prismLang ? Prism.languages[prismLang] : undefined;
        if (!grammar || !prismLang) return escapeHtml(code);
        try {
            return Prism.highlight(code, grammar, prismLang);
        } catch {
            return escapeHtml(code);
        }
    }, [language]);

    // Inject theme CSS into document head
    React.useEffect(() => {
        const id = 'prism-editor-theme';
        let el = document.getElementById(id);
        if (!el) {
            el = document.createElement('style');
            el.id = id;
            document.head.appendChild(el);
        }
        el.textContent = darkMode ? DARK_THEME_CSS : LIGHT_THEME_CSS;
    }, [darkMode]);

    return (
        <div
            style={{
                flex: 1,
                overflow: 'auto',
                backgroundColor: 'transparent',
            }}
        >
            <Editor
                value={value}
                onValueChange={readOnly ? () => {} : onChange}
                highlight={highlight}
                padding={16}
                readOnly={readOnly}
                style={{
                    fontFamily: 'ui-monospace, "SF Mono", "Cascadia Code", "Segoe UI Mono", Menlo, Monaco, Consolas, monospace',
                    fontSize: 14,
                    lineHeight: 1.5,
                    minHeight: '100%',
                    color: darkMode ? '#D4D4D4' : '#374151',
                    backgroundColor: 'transparent',
                }}
                textareaClassName="code-editor-textarea"
            />
        </div>
    );
});

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// Colors from theme.ts dark mode (matches Pierre github-dark-default)
const DARK_THEME_CSS = `
.code-editor-textarea {
    outline: none !important;
    caret-color: #fff !important;
}
.token.comment, .token.prolog, .token.doctype, .token.cdata { color: #6A9955; font-style: italic; }
.token.punctuation { color: #D4D4D4; }
.token.property, .token.tag, .token.boolean, .token.number, .token.constant, .token.symbol { color: #B5CEA8; }
.token.selector, .token.attr-name, .token.string, .token.char, .token.builtin, .token.inserted { color: #CE9178; }
.token.operator, .token.entity, .token.url { color: #D4D4D4; }
.token.atrule, .token.attr-value, .token.keyword, .token.class-name { color: #569CD6; }
.token.function { color: #DCDCAA; }
.token.regex, .token.important, .token.variable { color: #D16969; }
.token.deleted { color: #CE9178; text-decoration: line-through; }
.token.namespace { color: #4EC9B0; }
.token.tag .token.punctuation { color: #808080; }
.token.tag .token.attr-name { color: #9CDCFE; }
.token.tag .token.attr-value { color: #CE9178; }
`;

// Colors from theme.ts light mode
const LIGHT_THEME_CSS = `
.code-editor-textarea {
    outline: none !important;
    caret-color: #000 !important;
}
.token.comment, .token.prolog, .token.doctype, .token.cdata { color: #6b7280; font-style: italic; }
.token.punctuation { color: #374151; }
.token.property, .token.tag, .token.boolean, .token.number, .token.constant, .token.symbol { color: #0891b2; }
.token.selector, .token.attr-name, .token.string, .token.char, .token.builtin, .token.inserted { color: #059669; }
.token.operator, .token.entity, .token.url { color: #374151; }
.token.atrule, .token.attr-value, .token.keyword, .token.class-name { color: #1d4ed8; }
.token.function { color: #9333ea; }
.token.regex, .token.important, .token.variable { color: #dc2626; }
.token.deleted { color: #dc2626; text-decoration: line-through; }
.token.namespace { color: #0d9488; }
.token.tag .token.punctuation { color: #6b7280; }
.token.tag .token.attr-name { color: #1d4ed8; }
.token.tag .token.attr-value { color: #059669; }
`;
