import * as React from 'react';

export function ActiveAgentWakeLock() {
    React.useEffect(() => {
        if (!('wakeLock' in navigator)) return;
        let cancelled = false;
        let lock: WakeLockSentinel | undefined;
        let pending = false;
        const request = () => {
            if (cancelled || document.visibilityState !== 'visible' || lock !== undefined || pending) return;
            pending = true;
            void navigator.wakeLock.request('screen').then((next) => {
                pending = false;
                if (cancelled || document.visibilityState !== 'visible') {
                    void next.release();
                    return;
                }
                lock = next;
                // An OS-initiated release (battery saver, tab throttling) fires
                // this handler while we are still visible: re-request so the
                // screen does not sleep mid-watch.
                next.addEventListener('release', () => {
                    if (lock !== next) return;
                    lock = undefined;
                    request();
                });
            }).catch(() => { pending = false; });
        };
        const onVisibility = () => {
            if (document.visibilityState === 'visible') request();
            else {
                const previous = lock;
                lock = undefined;
                void previous?.release();
            }
        };
        request();
        document.addEventListener('visibilitychange', onVisibility);
        return () => {
            cancelled = true;
            document.removeEventListener('visibilitychange', onVisibility);
            void lock?.release();
        };
    }, []);
    return null;
}
