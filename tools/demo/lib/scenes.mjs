// The one source of truth for the demo pipeline: what to film, what to say
// about it, and where each frame ends up.
//
//   capture/flows/<id>.yaml     drives the device for that scene
//   store: true, storeOrder     becomes a Play Store frame, in that sequence
//   storeTheme                  which capture that frame shows
//   reel: { order, ... }        becomes a shot in the film
//
// Every scene is filmed against a real host with real agents — the app has no
// fixture or screenshot mode, so what is on camera is what the product does.
// Every scene is filmed twice, once per theme, because the film uses both.

export const scenes = [
    {
        id: 'herd',
        store: true,
        storeOrder: 1,
        storeTheme: 'dark',
        caption: 'Every agent, one screen.',
        sub: 'Working, blocked, or done — the whole herd at a glance.',
        reel: {
            order: 1,
            kicker: 'The herd',
            headline: 'Every agent, one screen',
            theme: 'dark',
            camera: 'push',
            side: 'left',
        },
    },
    {
        id: 'terminal',
        store: true,
        storeOrder: 2,
        storeTheme: 'dark',
        caption: 'Real terminals. Real control.',
        sub: 'Read the output, type into it, interrupt it — the same pane your desktop has open.',
        reel: {
            order: 2,
            kicker: 'Continuity',
            headline: 'Nothing to hand off',
            theme: 'dark',
            // The pane in its desktop window, and the same pane on the phone in
            // front of it. The film's central claim, shown rather than said.
            layout: 'desk',
        },
    },
    {
        id: 'changes',
        store: true,
        storeOrder: 4,
        storeTheme: 'light',
        caption: 'Read the diff before you approve.',
        sub: 'A per-file tab rail and a real dual gutter, rendered natively.',
        reel: {
            order: 4,
            kicker: 'Review',
            headline: 'Read the diff before you approve',
            theme: 'light',
            // Start wide and end inside the gutter: the claim is that this is a
            // real review, so show the characters.
            camera: 'close',
            layout: 'full',
        },
    },
    {
        id: 'files',
        store: false,
        storeTheme: 'light',
        caption: 'Browse the repo it is working in.',
        sub: 'Breadcrumbs down, swipe back up — one level at a time.',
        reel: {
            order: 5,
            kicker: 'Explore',
            headline: 'The whole repo, one level at a time',
            theme: 'light',
            camera: 'tilt',
            side: 'left',
        },
    },
    {
        id: 'usage',
        store: true,
        storeOrder: 6,
        storeTheme: 'dark',
        caption: 'Know what the work costs.',
        sub: 'Tokens and spend per model, read from local agent logs.',
        reel: {
            order: 6,
            kicker: 'Spend',
            headline: 'Know what the work costs',
            theme: 'dark',
            camera: 'orbit',
            side: 'right',
        },
    },
    {
        id: 'plugins',
        store: true,
        storeOrder: 7,
        storeTheme: 'light',
        caption: 'Extensions your machine approves.',
        sub: 'Native UI through a bounded public API. No downloaded HTML, no WebViews.',
        reel: {
            order: 7,
            kicker: 'Extend',
            headline: 'Extensions your machine approves',
            theme: 'light',
            camera: 'push',
            side: 'left',
        },
    },
    {
        id: 'inbox',
        store: true,
        storeOrder: 8,
        storeTheme: 'dark',
        caption: 'Know the moment it is done.',
        sub: 'Everything that finished, went quiet, or needs you — grouped by repo.',
        reel: {
            order: 10,
            kicker: 'Away',
            headline: 'It finds you, day or night',
            // The one shot that turns over: dark on the front, light on the
            // back of the same handset. The theme change is the visual, the
            // line is the point.
            theme: 'dark',
            flipTo: 'light',
            camera: 'flip',
            layout: 'full',
        },
    },
    {
        // Not in the store set — the seeded runbook is three commands deep and
        // reads thin next to the rest. Kept because the flow is written and the
        // shot gets good the moment a project has real saved commands.
        id: 'runbook',
        store: false,
        storeTheme: 'light',
        caption: 'Run your commands remotely.',
        sub: 'Saved project commands, one tap from wherever you are.',
    },
    {
        id: 'voice',
        store: true,
        storeOrder: 3,
        storeTheme: 'dark',
        caption: 'Talk to your agents.',
        sub: 'Native speech to speech. Ask what changed, ask for a status, tell it what to do next.',
        reel: {
            order: 3,
            kicker: 'Voice',
            headline: 'Talk to it. Ask what changed.',
            theme: 'dark',
            camera: 'close',
            layout: 'full',
            status: 'working',
        },
    },
    {
        id: 'connection',
        store: true,
        storeOrder: 5,
        storeTheme: 'dark',
        caption: 'Your relay. Your rules.',
        sub: 'Tailscale, Cloudflare, a VPS you own, or plain LAN — end-to-end encrypted either way.',
        reel: {
            order: 9,
            kicker: 'Self-hosted',
            headline: 'Your relay. Your rules.',
            theme: 'dark',
            camera: 'push',
            side: 'right',
            status: 'done',
        },
    },
    {
        // No device capture: this one is the CLI, snapshotted for real by
        // capture/authoring.mjs. The claim is that you can write your own
        // extension, so the film shows one being written.
        id: 'authoring',
        store: false,
        reel: {
            order: 8,
            kicker: 'Extensible',
            headline: 'Write your own extension',
            theme: 'dark',
            layout: 'panel',
            panel: 'authoring',
            status: 'done',
        },
    },
];

export const reel = {
    /** The site's own hero line, so the film and the page open the same way. */
    tagline: 'Leave the desk. Not the work.',
    install: 'npm install -g --ignore-scripts @trymuxr/cli',
    site: 'trymuxr.com',
    note: 'Open source · Apache-2.0 · self-hosted',
};

/** Frame budget, at 30fps. */
export const timing = {
    // Long enough for a two-line headline to arrive and be read before the cut.
    title: 96,
    shot: 120,
    end: 120,
    transition: 14,
};
