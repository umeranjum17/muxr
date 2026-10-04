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
    startingFirstTime: 'Approve screen sharing once on your computer. You will not be asked again unless you revoke it.',
    stoppedTitle: 'Desktop is off',
    stoppedBody: "Start it to see this computer's screen and control it.",
    startAction: 'Start desktop',
    armTitle: 'Tap to control',
    armHint: 'Turns on control of the desktop. This tap is not sent to it.',
    reconnectingTitle: 'Reconnecting…',
    reconnectingBody: 'The desktop connection dropped. Trying once more.',
    failedTitle: "Couldn't open this computer",
    failedBody: 'The desktop did not start.',
    noScreenTitle: 'This computer has no screen to share',
    noScreenBody: "It's a server without a desktop. Run this on it once, then tap Try again. (Ubuntu 24.04)",
    noScreenCommand: 'sudo DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends xvfb xfce4 xfce4-terminal dbus-x11 libpipewire-0.3-0t64 libxkbcommon0 libevdev2',
    consentTitle: 'Screen sharing was not approved',
    consentBody: 'The computer did not answer in time. Another app’s screen-sharing picker may be blocking muxr. Dismiss it on the computer, then try again or run muxr desktop setup there.',
    awaitingConsentTitle: 'Waiting for screen sharing',
    awaitingConsentBody: 'If a prompt appears on the computer, approve it there. Another app’s picker may be blocking this request.',
    endedTitle: 'Desktop closed',
    endedBody: 'The desktop session has ended.',
    endedTakeover: 'This desktop is open on another device.',
    endedTimeLimit: 'This desktop closed after an hour. You can open it again.',
    endedUnencodable: 'This desktop stopped because its screen could not be encoded.',
    endedEngineStopped: 'The computer stopped sharing this desktop.',
    endedUnreachable: "The phone lost its connection to this computer's desktop. Check that it can still reach the computer, then try again.",
    clipboardUnavailable: 'This computer cannot share its clipboard.',
    clipboardBlocked: "The browser didn't allow this site to use the phone's clipboard. Allow it, then try again.",
    liveLabel: 'Live',
    connectingLabel: 'Connecting',
    gestureHint: 'Drag to move the pointer; when zoomed, drag to move around. Two fingers scroll. Pinch to zoom. Hold for right-click, or hold and drag to select.',
    textUnsupported: "The desktop can't type that character.",
    textTooLarge: 'That is too much to type at once.',
    textUsePaste: 'Use Paste from Phone.',
} as const;

/** The agent's own browser, emulator, or simulator, watched live: one wording per kind. */
export const previewCopy = {
    browser: {
        name: 'Browser',
        opening: "Opening your agent's browser…",
        closedTitle: 'The browser closed',
        unreachableTitle: "Can't show the browser from here",
        failedTitle: "Couldn't open the browser",
        viewOnlyBody: 'This phone was paired to watch. It can see the browser but not use it.',
        stage: "Live view of your agent's browser",
    },
    android: {
        name: 'Android emulator',
        opening: 'Opening the emulator…',
        closedTitle: 'The emulator closed',
        unreachableTitle: "Can't show the emulator from here",
        failedTitle: "Couldn't open the emulator",
        viewOnlyBody: 'This phone was paired to watch. It can see the emulator but not use it.',
        stage: "Live view of your agent's Android emulator",
    },
    ios: {
        name: 'iOS Simulator',
        opening: 'Opening the simulator…',
        closedTitle: 'The simulator closed',
        unreachableTitle: "Can't show the simulator from here",
        failedTitle: "Couldn't open the simulator",
        viewOnlyBody: 'This phone was paired to watch. It can see the simulator but not use it.',
        stage: "Live view of your agent's iOS Simulator",
    },
    closedBody: 'Your agent finished with it.',
    closedAction: 'Back to the conversation',
    unreachableBody: 'Live view needs this phone to reach your computer directly or over Tailscale.',
    takenTitle: 'Open on another device',
    takenBody: 'Only one device can watch at a time.',
    takenAction: 'Watch here',
    failedBody: 'The computer did not start the live view.',
    armTitle: 'Tap to take control',
    armHint: 'Lets you use it. This tap is not sent.',
    controlTitle: 'Your agent is waiting',
    handBack: 'Hand back',
    viewOnlyTitle: 'View only',
    liveLabel: 'Live',
    controlLabel: 'You’re in control',
    closedLabel: 'Closed',
} as const;

/** The icon for a preview's kind; an unknown kind reads as a browser. */
export function previewIcon(kind: string) {
    if (kind === 'android') return 'logo-android' as const;
    if (kind === 'ios') return 'logo-apple' as const;
    return 'globe-outline' as const;
}
