import * as React from 'react';

const DESTINATIONS = {
    home: '/',
    'recent agents': '/session/recent',
    'new agent': '/new-agent',
    settings: '/settings',
    'voice settings': '/settings/voice',
    plugins: '/settings/plugins',
    appearance: '/settings/appearance',
    preferences: '/settings/features',
    connection: '/settings/connection',
} as const;

const key = (value: string): string => value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase();

function screenName(pathname: string): string {
    const fixed = Object.entries(DESTINATIONS).find(([, path]) => path === pathname)?.[0];
    if (fixed !== undefined) return fixed;
    if (pathname.startsWith('/session/')) return 'agent conversation';
    if (pathname.startsWith('/machine/')) return 'machine';
    if (pathname.startsWith('/workspace/')) return 'workspace';
    if (pathname.startsWith('/plugin')) return 'plugin';
    return 'app';
}

interface RegisteredControl {
    screen: string;
    label: string;
    activate: () => void | Promise<void>;
}

export class RealtimeAppController {
    private pathname = '/';
    private navigate: ((path: string) => void | Promise<void>) | undefined;
    private readonly controls = new Map<symbol, RegisteredControl>();

    setNavigation(navigate: (path: string) => void | Promise<void>): void {
        this.navigate = navigate;
    }

    setScreen(pathname: string): void {
        this.pathname = pathname;
    }

    registerControl(screen: string, label: string, activate: () => void | Promise<void>): () => void {
        const token = Symbol(label);
        this.controls.set(token, { screen, label: label.trim(), activate });
        return () => { this.controls.delete(token); };
    }

    inspect(): string {
        const controls = [...this.controls.values()]
            .filter((control) => control.screen === this.pathname)
            .map((control) => control.label);
        const visible = controls.length === 0 ? 'none registered' : controls.join(', ');
        return `Screen: ${screenName(this.pathname)}. Visible controls: ${visible}. Destinations: ${Object.keys(DESTINATIONS).join(', ')}.`;
    }

    async navigateTo(target: string): Promise<string> {
        const matches = Object.entries(DESTINATIONS).filter(([label]) => key(label) === key(target));
        if (matches.length !== 1) return 'I could not find one app destination with that name. Ask me to inspect the app.';
        if (this.navigate === undefined) return 'App navigation is unavailable.';
        const [label, path] = matches[0]!;
        await this.navigate(path);
        return `Navigated to ${label}.`;
    }

    async activate(target: string): Promise<string> {
        const matches = [...this.controls.values()].filter((control) => control.screen === this.pathname && key(control.label) === key(target));
        if (matches.length !== 1) return 'I could not find one visible control with that name. Ask me to inspect the app.';
        await matches[0]!.activate();
        return `Activated ${matches[0]!.label}.`;
    }
}

export const realtimeAppController = new RealtimeAppController();

export function useRealtimeAppControl(label: string, activate: () => void | Promise<void>, screen: string): void {
    const action = React.useRef(activate);
    action.current = activate;
    React.useEffect(
        () => realtimeAppController.registerControl(screen, label, () => action.current()),
        [label, screen],
    );
}
