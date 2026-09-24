import { describe, expect, it, vi } from 'vitest';
import { CommonActions, StackActions, StackRouter, type StackNavigationState } from '@react-navigation/routers';

vi.mock('expo-router', () => ({ useRouter: () => undefined }));

import { navigateToSession } from './useNavigateToSession';

type State = StackNavigationState<Record<string, object | undefined>>;
const AGENT = 'session/[id]';

/** The app stack under the real React Navigation router, driven the way expo-router drives it. */
function appStack() {
    const router = StackRouter({ initialRouteName: 'index' });
    const options = { routeNames: ['index', 'panes', 'new-agent', AGENT], routeParamList: {}, routeGetIdList: {} };
    let state = router.getInitialState(options) as State;
    const apply = (action: Parameters<typeof router.getStateForAction>[1]) => {
        state = (router.getStateForAction(state, action, options) as State | null) ?? state;
    };
    const agentId = (href: string) => ({ id: decodeURIComponent(href.slice('/session/'.length)) });
    const top = () => state.routes[state.index]!;
    return {
        router: {
            canDismiss: () => state.routes.length > 1,
            push: (href: string) => apply(href.startsWith('/session/') ? StackActions.push(AGENT, agentId(href)) : StackActions.push(href.slice(1))),
            dismissTo: (href: string) => apply(StackActions.popTo(AGENT, agentId(href))),
        },
        // The pager swaps the route's params in place (TerminalScreen's switchAgent).
        swipeTo: (id: string) => apply({ ...CommonActions.setParams({ id }), source: top().key }),
        back: () => apply(StackActions.pop()),
        screens: () => state.routes.map((route) => route.name === AGENT ? `agent:${(route.params as { id: string }).id}` : route.name),
    };
}

describe('agent stack', () => {
    it('keeps one agent over Home however agents are visited, so back is Home', () => {
        const app = appStack();
        const open = (id: string) => navigateToSession(app.router as never, id);

        open('a'); // Live row on Home
        expect(app.screens()).toEqual(['index', 'agent:a']);
        app.swipeTo('b');
        open('c'); // pane tab, search or a notification tap while on an agent
        expect(app.screens()).toEqual(['index', 'agent:c']);

        app.router.push('/panes');
        open('d'); // from a screen stacked over the agent
        expect(app.screens()).toEqual(['index', 'agent:d']);

        app.back();
        expect(app.screens()).toEqual(['index']);

        // A picker above Home with no agent under it gives way to the agent.
        app.router.push('/new-agent');
        open('e');
        expect(app.screens()).toEqual(['index', 'agent:e']);
    });
});
