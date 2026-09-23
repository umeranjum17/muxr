type KeyboardMotion = { covered: number; phase: number };

const subscribers = new Set<(motion: KeyboardMotion) => void>();
let viewport: VisualViewport | null = null;
let settledHeight = 0;
let falling = false;
let quiet: ReturnType<typeof setTimeout> | null = null;
let motion: KeyboardMotion = { covered: 0, phase: 0 };

function publish(covered: number, phase: number): void {
    motion = { covered, phase };
    for (const subscriber of subscribers) subscriber(motion);
}

function measure(): void {
    if (viewport === null) return;
    const covered = Math.max(0, globalThis.innerHeight - viewport.offsetTop - viewport.height);
    if (covered < motion.covered) falling = true;
    else if (covered > motion.covered) falling = false;
    publish(covered, covered > 0 ? Math.min(1, covered / (settledHeight || covered)) : 0);
    if (quiet !== null) clearTimeout(quiet);
    quiet = null;
    if (covered === 0 || falling) return;
    quiet = setTimeout(() => {
        quiet = null;
        settledHeight = covered;
        publish(covered, 1);
    }, 180);
}

export function observeWebKeyboardMotion(subscriber: (motion: KeyboardMotion) => void): () => void {
    subscribers.add(subscriber);
    if (subscribers.size === 1) {
        viewport = globalThis.visualViewport ?? null;
        viewport?.addEventListener('resize', measure);
        viewport?.addEventListener('scroll', measure);
        if (viewport === null) subscriber(motion);
        else measure();
    } else {
        subscriber(motion);
    }
    return () => {
        subscribers.delete(subscriber);
        if (subscribers.size !== 0) return;
        viewport?.removeEventListener('resize', measure);
        viewport?.removeEventListener('scroll', measure);
        if (quiet !== null) clearTimeout(quiet);
        viewport = null;
        quiet = null;
        settledHeight = 0;
        falling = false;
        motion = { covered: 0, phase: 0 };
    };
}
