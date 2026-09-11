import * as React from 'react';
import { spokenMatches, type SessionInfo } from '@muxr/contract';

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
    private agents: (() => Promise<SessionInfo[]>) | undefined;

    setAgents(agents: () => Promise<SessionInfo[]>): void { this.agents = agents; }
    private navigate: ((path: string) => void | Promise<void>) | undefined;
    private readonly visits = new Map<string, number>();
    private readonly controls = new Map<symbol, RegisteredControl>();

    setNavigation(navigate: (path: string) => void | Promise<void>): void {
        this.navigate = navigate;
    }

    setScreen(pathname: string): void {
        this.pathname = pathname;
        const route = /^\/session\/([^/]+)/.exec(pathname)?.[1];
        if (route) {
            this.visits.delete(route);
            this.visits.set(route, Date.now());
            if (this.visits.size > 20) this.visits.delete(this.visits.keys().next().value!);
        }
    }

    registerControl(screen: string, label: string, activate: () => void | Promise<void>): () => void {
        const token = Symbol(label);
        this.controls.set(token, { screen, label: label.trim(), activate });
        return () => { this.controls.delete(token); };
    }

    async inspect(): Promise<string> {
        const inspectedPath = this.pathname;
        const controls = [...this.controls.values()]
            .filter((control) => control.screen === this.pathname)
            .map((control) => control.label);
        const visible = controls.length === 0 ? 'none registered' : controls.join(', ');
        let context = '';
        if (this.agents) {
            try {
                const agents = await this.agents();
                const label = (agent: SessionInfo): string => [agent.agentName, agent.taskTitle, agent.agentStatus].filter(Boolean).join(' — ').replace(/[\x00-\x1f<>]/g, ' ').slice(0, 220);
                const current = /^\/session\/([^/]+)/.exec(this.pathname)?.[1];
                const focused = agents.find((agent) => encodeURIComponent(agent.id) === current);
                const recent = [...this.visits.entries()].reverse().flatMap(([route, at]) => {
                    const agent = agents.find((candidate) => encodeURIComponent(candidate.id) === route);
                    return agent ? [`${label(agent)} (viewed ${Math.max(0, Math.floor((Date.now() - at) / 1000))} seconds ago)`] : [];
                }).slice(0, 5);
                context = ` Phone focus: ${focused ? label(focused) : 'no agent screen open'}. Recently viewed on this phone: ${recent.join('; ') || 'none recorded in this app session'}.`;
            } catch { context = ' Live phone agent context is unavailable; do not infer a target from stale history.'; }
        }
        if (this.pathname !== inspectedPath) return 'The screen changed while reading context. Inspect the app again before acting.';
        return `Screen: ${screenName(this.pathname)}. Visible controls: ${visible}. Destinations: ${Object.keys(DESTINATIONS).join(', ')}. To open an agent, navigate to agent followed by its name or task title.${context}`;
    }

    async navigateTo(target: string): Promise<string> {
        if (/^agent\s+/i.test(target) && this.agents) {
            const agents = await this.agents();
            const matches = spokenMatches(target.replace(/^agent\s+/i, ''), agents, (agent) =>
                [agent.agentName, agent.taskTitle, agent.agentName && agent.taskTitle ? `${agent.agentName}, ${agent.taskTitle}` : undefined]
                    .filter((label): label is string => Boolean(label)));
            if (matches.length !== 1) return 'No unique live agent matches that description. Search agents by task before navigating.';
            if (!this.navigate) return 'App navigation is unavailable.';
            await this.navigate(`/session/${encodeURIComponent(matches[0]!.id)}`);
            return 'Opened the selected agent on your phone.';
        }
        const matches = spokenMatches(target, Object.entries(DESTINATIONS), ([label]) => [label]);
        if (matches.length !== 1) return 'I could not find one app destination with that name. Ask me to inspect the app.';
        if (this.navigate === undefined) return 'App navigation is unavailable.';
        const [label, path] = matches[0]!;
        await this.navigate(path);
        return `Navigated to ${label}.`;
    }

    async activate(target: string): Promise<string> {
        const matches = spokenMatches(target, [...this.controls.values()].filter((control) => control.screen === this.pathname), (control) => [control.label]);
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
