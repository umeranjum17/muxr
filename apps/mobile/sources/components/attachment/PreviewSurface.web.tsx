import * as React from 'react';
export function PreviewSurface({ html, onError }: { html: string; onError: () => void }) {
    return <iframe title="Attachment preview" srcDoc={html} sandbox="allow-scripts" referrerPolicy="no-referrer"
        onError={onError} style={{ flex: 1, width: '100%', border: 0, background: '#fff' }} />;
}
