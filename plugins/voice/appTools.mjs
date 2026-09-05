import { randomUUID } from 'node:crypto';

/** Provider-independent request/reply bridge to the phone's semantic controls. */
export function createAppTools(emit) {
    const pending = new Map();
    return {
        run(name, input = {}) {
            const actions = { inspect_app: 'view', navigate_app: 'navigate', activate_app_control: 'activate' };
            const action = Object.hasOwn(actions, name) ? actions[name] : undefined;
            if (!action) return undefined;
            const target = String(action === 'navigate' ? input.destination ?? '' : input.control ?? '').trim();
            if (action !== 'view' && (!target || Buffer.byteLength(target) > 160)) return Promise.resolve('Choose a destination or control from inspect_app.');
            if (pending.size >= 8) return Promise.resolve('App requests are busy. Wait for the current request.');
            return new Promise((resolve) => {
                const requestId = randomUUID();
                const finish = (text) => { clearTimeout(timer); pending.delete(requestId); resolve(text); };
                const timer = setTimeout(() => finish('The app did not answer that request.'), 15000);
                pending.set(requestId, finish);
                try {
                    if (emit({ type: 'realtime.app.request', requestId, action, ...(target ? { target } : {}) }) === false) finish('The app could not receive that request.');
                } catch { finish('App navigation is unavailable.'); }
            });
        },
        receive(frame) {
            if (frame.type !== 'realtime.app.result') return false;
            pending.get(frame.requestId)?.(frame.ok ? String(frame.text).slice(0, 4000) : 'The app could not complete that request.');
            return true;
        },
        close() { for (const finish of pending.values()) finish('App request cancelled.'); },
    };
}
