// The one source of truth for the demo pipeline: what to film, what to say
// about it, and where each frame ends up.
//
//   capture/flows/<id>.yaml   drives the device for that scene
//   store: true               becomes a Play Store frame, in this array order
//   reel: { order, ... }      becomes a shot in the demo video
//
// Every scene is filmed against a real host with real agents — the app has no
// fixture or screenshot mode, so what is on camera is what the product does.

export const scenes = [
    {
        id: 'herd',
        store: true,
        caption: 'Every agent, one screen.',
        sub: 'Working, blocked, or done — the whole herd at a glance.',
        reel: {
            order: 1,
            kicker: 'The herd',
            headline: 'Every agent, one screen',
            body: 'Every terminal you have running, on one page — who is working, who is blocked, who is done.',
        },
    },
    {
        id: 'terminal',
        store: true,
        caption: 'Real terminals. Real control.',
        sub: 'Read the output, type into it, interrupt it — the same pane your desktop has open.',
        reel: {
            order: 2,
            kicker: 'Control',
            headline: 'A real terminal, not a mirror',
            body: 'Read the output, type into it, interrupt it. Your machine stays the source of truth.',
        },
    },
    {
        id: 'changes',
        store: true,
        caption: 'Read the diff before you approve.',
        sub: 'A per-file tab rail and a real dual gutter, rendered natively.',
        reel: {
            order: 3,
            kicker: 'Review',
            headline: 'Read the diff before you approve',
            body: 'A per-file tab rail and a real dual gutter — the review you would do at your desk.',
        },
    },
    {
        id: 'files',
        store: true,
        caption: 'Browse the repo it is working in.',
        sub: 'Breadcrumbs down, swipe back up — one level at a time.',
        reel: {
            order: 4,
            kicker: 'Explore',
            headline: 'The whole repo, one level at a time',
            body: 'Breadcrumbs down, swipe back up. The glyph carries the file type so nothing else has to.',
        },
    },
    {
        id: 'usage',
        store: true,
        caption: 'Know what the work costs.',
        sub: 'Tokens and spend per model, read from local agent logs.',
        reel: {
            order: 5,
            kicker: 'Spend',
            headline: 'Know what the work costs',
            body: 'Tokens and spend per model and per day, read from the agent logs already on your machine.',
        },
    },
    {
        id: 'plugins',
        store: true,
        caption: 'Extensions your machine approves.',
        sub: 'Native UI through a bounded public API. No downloaded HTML, no WebViews.',
        reel: {
            order: 6,
            kicker: 'Extend',
            headline: 'Extensions your machine approves',
            body: 'Native UI through one bounded public contract. Plugins never ship executable interface.',
        },
    },
    {
        id: 'inbox',
        store: true,
        caption: 'Know the moment it is done.',
        sub: 'Everything that finished, went quiet, or needs you — grouped by repo.',
        reel: {
            order: 7,
            kicker: 'Away',
            headline: 'Know the moment it is done',
            body: 'Everything that finished, went quiet, or needs an answer, grouped by the repo it came from.',
        },
    },
    {
        // Not in the store set — the seeded runbook is three commands deep and
        // reads thin next to the rest. Kept because the flow is written and the
        // shot gets good the moment a project has real saved commands.
        id: 'runbook',
        store: false,
        caption: 'Run your commands remotely.',
        sub: 'Saved project commands, one tap from wherever you are.',
    },
    {
        // Blocked: the realtime overlay blanks the app on 0.1.12 — see
        // tools/demo/README.md. The flow is kept so this returns to the set the
        // moment that is fixed.
        id: 'voice',
        store: false,
        caption: 'Talk to your agents.',
        sub: 'Native speech to speech — the visual answers your voice and the agent’s.',
    },
];

export const reel = {
    tagline: 'Every coding agent, on your phone.',
    install: 'npm install -g --ignore-scripts @trymuxr/cli',
    site: 'trymuxr.com',
    note: 'Open source · Apache-2.0 · self-hosted',
};
