import * as React from 'react';
import { View } from 'react-native';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';

/**
 * Web-only replay terminal: authentic ANSI through the same xterm.js stack
 * as TerminalView.web. The parent keys this component by pane id, so each
 * agent gets a fresh terminal — replay state never leaks across switches.
 */
export function DemoTerminal({ lines, live }: { lines: string[]; live: boolean }) {
    const hostRef = React.useRef<View | null>(null);

    React.useEffect(() => {
        const host = hostRef.current as unknown as HTMLElement | null;
        if (!host) return undefined;
        const term = new Terminal({ scrollback: 500, fontSize: 13 });
        const fit = new FitAddon();
        term.loadAddon(fit);
        term.loadAddon(new WebLinksAddon());
        term.open(host);
        fit.fit();
        let cancelled = false;
        const timers = lines.map((line, index) => setTimeout(() => {
            if (!cancelled) term.writeln(line);
        }, (live ? 350 : 0) * (index + 1)));
        return () => {
            cancelled = true;
            timers.forEach(clearTimeout);
            term.dispose();
        };
    }, [lines, live]);

    return <View ref={hostRef} style={{ height: 220, borderRadius: 8, overflow: 'hidden' }} />;
}
