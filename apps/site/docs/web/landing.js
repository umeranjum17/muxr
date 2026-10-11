// Landing films: silent loops that play only while on screen, never for a
// visitor who reduces motion, and always with a pause button (a loop that runs
// past five seconds must be stoppable). No dependencies. Without this file the
// hero still loops and every other film shows its poster, which carries the alt.
(() => {
    const still = matchMedia('(prefers-reduced-motion: reduce)');
    const films = [...document.querySelectorAll('video[data-film]')];
    const paused = new WeakSet();
    const visible = new WeakSet();

    const sync = (video) => {
        const play = visible.has(video) && !paused.has(video) && !still.matches;
        // With reduced motion the video steps aside so the poster shows, not frame one.
        video.hidden = still.matches;
        if (play) video.play().catch(() => {});
        else video.pause();
    };

    const seen = new IntersectionObserver((entries) => {
        for (const entry of entries) {
            if (entry.isIntersecting) visible.add(entry.target);
            else visible.delete(entry.target);
            sync(entry.target);
        }
    }, { rootMargin: '120px 0px' });

    for (const video of films) {
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'film-toggle';
        toggle.setAttribute('aria-label', 'Pause film');
        toggle.setAttribute('aria-pressed', 'false');
        toggle.hidden = still.matches;
        toggle.addEventListener('click', () => {
            if (paused.has(video)) paused.delete(video);
            else paused.add(video);
            const now = paused.has(video);
            toggle.setAttribute('aria-pressed', String(now));
            toggle.setAttribute('aria-label', now ? 'Play film' : 'Pause film');
            sync(video);
        });
        video.after(toggle);
        sync(video);
        seen.observe(video);
    }

    still.addEventListener('change', () => {
        for (const video of films) {
            video.nextElementSibling.hidden = still.matches;
            sync(video);
        }
    });
})();
