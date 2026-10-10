import * as React from 'react';
import { CodeCore } from '@/components/code/CodeCore';
import { PLUGIN_CODE_MAX_CHARS, PLUGIN_CODE_MAX_LINES } from '@/components/code/codeLimits';

export const SyntaxHighlightedCode = React.memo(function SyntaxHighlightedCode(props: { code: string; language?: string; fileName?: string }) {
    return <CodeCore code={props.code} language={props.language} fileName={props.fileName} header
        maxLines={PLUGIN_CODE_MAX_LINES} maxChars={PLUGIN_CODE_MAX_CHARS} />;
});
