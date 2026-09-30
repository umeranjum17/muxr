import { useEffect } from 'react';
import { Platform } from 'react-native';

/** Own the iOS web shell's visible bounds, including keyboard dismissal. */
export function useWebViewport() {
    useEffect(() => {
        if (Platform.OS !== 'web' || typeof window === 'undefined') return;
        if (!CSS.supports('-webkit-touch-callout', 'none')) return;
        const viewport = window.visualViewport;
        const root = document.getElementById('root');
        if (viewport === null || root === null) return;

        const update = () => {
            // Pinch zoom must keep its ordinary viewport and panning behavior.
            if (viewport.scale !== 1) return;
            root.style.setProperty('--muxr-viewport-top', `${viewport.offsetTop}px`);
            root.style.setProperty('--muxr-viewport-height', `${viewport.height}px`);
            root.classList.add('muxr-visual-viewport');
        };
        update();
        viewport.addEventListener('resize', update);
        viewport.addEventListener('scroll', update);
        window.addEventListener('pageshow', update);
        return () => {
            viewport.removeEventListener('resize', update);
            viewport.removeEventListener('scroll', update);
            window.removeEventListener('pageshow', update);
            root.classList.remove('muxr-visual-viewport');
            root.style.removeProperty('--muxr-viewport-top');
            root.style.removeProperty('--muxr-viewport-height');
        };
    }, []);
}
