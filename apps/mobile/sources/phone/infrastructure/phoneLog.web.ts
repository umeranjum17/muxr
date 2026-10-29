import type { PhoneLog } from '@byokit/phone';

const KEY = 'muxr.phone-chat';

// A browser has no documents directory; the page's own storage keeps the same lines.
export function phoneLog(): PhoneLog {
    return {
        read: async () => (localStorage.getItem(KEY) ?? '').split('\n').filter(Boolean),
        append: async (line) => { localStorage.setItem(KEY, `${localStorage.getItem(KEY) ?? ''}${line}\n`); },
        clear: async () => { localStorage.removeItem(KEY); },
    };
}
