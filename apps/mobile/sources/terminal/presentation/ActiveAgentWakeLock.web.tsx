import * as React from 'react';

export function ActiveAgentWakeLock() {
    React.useEffect(() => {
        if (!('wakeLock' in navigator)) return;
        let cancelled = false;
        let lock: WakeLockSentinel | undefined;
        let pending = false;
        const request = () => {
            if (document.visibilityState !== 'visible' || lock !== undefined || pending) return;
            pending = true;
            void navigator.wakeLock.request('screen').then((next) => {
                pending = false;
                if (cancelled || document.visibilityState !== 'visible') {
                    void next.release();
                    return;
                }
                lock = next;
                next.addEventListener('release', () => { if (lock === next) lock = undefined; });
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
