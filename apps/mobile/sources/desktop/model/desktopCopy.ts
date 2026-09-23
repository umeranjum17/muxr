/**
 * What the desktop screen says, in one place.
 *
 * Kept out of the component so the same words are used by the start state, the
 * failure state and anything that quotes them, and so a wording change is one
 * edit rather than three.
 */
export const desktopCopy = {
    startingTitle: 'Starting desktop…',
    startingBody: undefined,
    startingFirstTime: 'Approve screen sharing on the computer. It only asks the first time.',
    reconnectingTitle: 'Reconnecting…',
    reconnectingBody: 'The desktop connection dropped. Trying once more.',
    failedTitle: "Couldn't open this computer",
    failedBody: 'The desktop did not start.',
    consentTitle: 'Screen sharing was not approved',
    consentBody: 'Approve screen sharing on the computer, then try again.',
    endedTitle: 'Desktop closed',
    endedBody: 'The desktop session has ended.',
    endedTakeover: 'This desktop is open on another device.',
    endedTimeLimit: 'This desktop closed after an hour. You can open it again.',
    endedUnencodable: 'This desktop stopped because its screen could not be encoded.',
    endedEngineStopped: 'The computer stopped sharing this desktop.',
    endedUnreachable: "The phone lost its connection to this computer's desktop. Check that it can still reach the computer, then try again.",
    clipboardUnavailable: 'This computer cannot share its clipboard.',
    liveLabel: 'Live',
    connectingLabel: 'Connecting',
    gestureHint: 'Drag to move the pointer; when zoomed, drag to move around. Two fingers scroll. Pinch to zoom. Hold for right-click, or hold and drag to select.',
    textUnsupported: "The desktop can't type that character.",
    textTooLarge: 'That is too much to type at once.',
    textUsePaste: 'Use Paste from Phone.',
} as const;
