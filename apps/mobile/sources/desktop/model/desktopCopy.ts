/**
 * What the desktop screen says, in one place.
 *
 * Kept out of the component so the same words are used by the start state, the
 * failure state and anything that quotes them, and so a wording change is one
 * edit rather than three.
 */
export const desktopCopy = {
    startingTitle: 'Opening this computer…',
    startingBody: 'Your desktop will appear here. Nothing on it is being recorded.',
    reconnectingTitle: 'Reconnecting…',
    reconnectingBody: 'The desktop connection dropped. Trying once more.',
    failedTitle: "Couldn't open this computer",
    failedBody: 'The desktop did not start.',
    endedTitle: 'Desktop closed',
    endedBody: 'The desktop session has ended.',
    clipboardUnavailable: 'This computer cannot share its clipboard.',
} as const;
