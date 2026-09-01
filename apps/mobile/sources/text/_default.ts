/**
 * English translations for the muxr app
 * Values can be:
 * - String constants for static text
 * - Functions with typed object parameters for dynamic text
 */

/**
 * English plural helper function
 * @param options - Object containing count, singular, and plural forms
 * @returns The appropriate form based on count
 */
function plural({ count, singular, plural }: { count: number; singular: string; plural: string }): string {
    return count === 1 ? singular : plural;
}

export const en = {
    tabs: {
        // Tab navigation labels
        sessions: 'Herd',
        settings: 'Settings',
    },

    inbox: {
        // Inbox screen: the sessions currently waiting on you
        reason: {
            waiting: 'waiting',
            blocked: 'blocked',
            failed: 'failed',
            done: 'done',
        },
    },

    plugins: {
        openFromHome: 'Open a plugin from Home.',
        unavailable: 'This plugin is disabled or unavailable.',
        goBack: 'Go back',
        couldNotLoad: 'Could not load items',
        dataUnavailable: 'The plugin is unavailable right now.',
        nothingHere: 'Nothing here',
        newItems: 'New items will appear here.',
        retry: 'Retry',
        retryItems: 'Retry loading plugin items',
        stale: 'Could not refresh. Showing the last result.',
        nothingToShow: 'Nothing to show.',
        treeUnavailable: 'Tree unavailable.',
        dictate: 'Dictate',
        unavailableSuffix: 'unavailable',
        showingStale: 'showing stale data',
        settingsTitle: 'Plugins',
        enableAll: 'Enable all',
        disableAll: 'Disable all',
        installed: 'Installed',
        herdrAndMuxr: 'Herdr + muxr',
        herdrAndMuxrFooter: 'Herdr runs actions, panes or event hooks for these, and they add muxr UI.',
        muxrOnly: 'muxr only',
        muxrOnlyFooter: 'Herdr registers these; everything they do runs through muxr.',
        herdrOnly: 'Herdr only',
        herdrOnlyFooter: 'Backend packages with no muxr UI. Manage them with the herdr CLI.',
        waitingHost: 'Waiting for the host.',
        linkHost: 'Link a plugin through Herdr, then reconnect.',
        enabled: 'enabled',
        off: 'off',
        on: 'on',
        unavailableLabel: 'Unavailable',
        runsCode: 'Runs code as you',
        uiOnly: 'UI only',
        readsSessions: 'Reads session summaries',
        readsTree: 'Reads workspace tree',
        openFailed: 'Open failed',
        actionFailed: 'Action failed',
        items: 'Items',
        openWebsite: 'Open website?',
        open: 'Open',
        realtimeConnecting: 'Connecting realtime session',
        realtimeListening: 'Listening',
        realtimeThinking: 'Thinking',
        realtimeSpeaking: 'Speaking',
        realtimeError: 'Realtime session error',
        realtimeOff: 'Realtime session off',
        openConversation: 'Open realtime conversation',
        realtime: 'Realtime',
    },

    common: {
        // Simple string constants
        cancel: 'Cancel',
        save: 'Save',
        error: 'Error',
        success: 'Success',
        ok: 'OK',
        back: 'Back',
        create: 'Create',
        rename: 'Rename',
        logout: 'Logout',
        yes: 'Yes',
        no: 'No',
        version: 'Version',
        copied: 'Copied',
        copy: 'Copy',
        scanning: 'Scanning...',
        home: 'Home',
        message: 'Message',
        files: 'Files',
        fileViewer: 'File Viewer',
        loading: 'Loading...',
        delete: 'Delete',
    },

    profile: {
        details: 'Details',
        firstName: 'First Name',
        lastName: 'Last Name',
        username: 'Username',
        status: 'Status',
    },

    status: {
        connected: 'connected',
        connecting: 'connecting',
        disconnected: 'disconnected',
        error: 'host not responding',
        pairingIssue: 'pairing issue',
        online: 'online',
        offline: 'offline',
        lastSeen: ({ time }: { time: string }) => `last seen ${time}`,
        permissionRequired: 'permission required',
        activeNow: 'Active now',
        unknown: 'unknown',
        unread: 'new results',
    },

    time: {
        justNow: 'just now',
        minutesAgo: ({ count }: { count: number }) => `${count} minute${count !== 1 ? 's' : ''} ago`,
        hoursAgo: ({ count }: { count: number }) => `${count} hour${count !== 1 ? 's' : ''} ago`,
        daysAgo: ({ count }: { count: number }) => `${count} day${count !== 1 ? 's' : ''} ago`,
    },

    connect: {
        restoreAccount: 'Restore Account',
        enterSecretKey: 'Please enter a secret key',
        invalidSecretKey: 'Invalid secret key. Please check and try again.',
        qrInstructions: '1. Open muxr on your mobile device\n2. Go to Settings → Account\n3. Tap "Link New Device"\n4. Scan this QR code',
        restoreWithSecretKeyInstead: 'Restore with Secret Key Instead',
    },

    settings: {
        title: 'Settings',
        github: 'GitHub',
        machines: 'Machines',
        showOfflineMachines: ({ count }: { count: number }) => count === 1 ? 'Show 1 offline machine' : `Show ${count} offline machines`,
        hideOfflineMachines: 'Hide offline machines',
        features: 'Features',
        social: 'Social',
        account: 'Account',
        accountSubtitle: 'Manage your account details',
        appearance: 'Appearance',
        appearanceSubtitle: 'Customize how the app looks',
        featuresTitle: 'Features',
        featuresSubtitle: 'Enable or disable app features',
        about: 'About',
        aboutFooter: 'muxr drives your coding agents through herdr. End-to-end encryption is optional and off by default; your account is stored only on your device.',
        whatsNew: 'What\'s New',
        whatsNewSubtitle: 'See the latest updates and improvements',
        reportIssue: 'Report an Issue',
        eula: 'EULA',
        connection: 'Connection',
        connectionSubtitle: 'Relay URL, machine and token',
        pushNotifications: 'Push notifications',
        pushSubtitleSubscribed: 'On — pinged when an agent needs an answer',
        pushSubtitleDenied: 'Blocked by the browser — allow notifications to enable',
        pushSubtitleUnsupported: 'Not available in this browser',
        pushSubtitleDefault: 'Tap to get notified when an agent needs an answer',
        license: 'License & notices',
        // Dynamic settings messages
    },

    settingsAppearance: {
        // Appearance settings screen
        theme: 'Theme',
        themeDescription: 'Choose your preferred color scheme',
        themeOptions: {
            adaptive: 'Adaptive',
            light: 'Light', 
            dark: 'Dark',
        },
        themeDescriptions: {
            adaptive: 'Match system settings',
            light: 'Always use light theme',
            dark: 'Always use dark theme',
        },
        display: 'Display',
        displayDescription: 'Control layout and spacing',

        avatarStyle: 'Avatar Style',
        avatarStyleDescription: 'Choose session avatar appearance',
        avatarOptions: {
            pixelated: 'Pixelated',
            gradient: 'Gradient',
            brutalist: 'Brutalist',
        },
        showFlavorIcons: 'Show AI Provider Icons',
        showFlavorIconsDescription: 'Display AI provider icons on session avatars',
    },

    settingsFeatures: {
        // Features settings screen
        experiments: 'Experiments',
        experimentsDescription: 'Enable experimental features that are still in development. These features may be unstable or change without notice.',
        webFeatures: 'Web Features',
        webFeaturesDescription: 'Features available only in the web version of the app.',
        commandPalette: 'Command Palette',
        commandPaletteEnabled: 'Press ⌘K to open',
        commandPaletteDisabled: 'Quick command access disabled',
        markdownCopyV2: 'Markdown Copy v2',
        markdownCopyV2Subtitle: 'Long press opens copy modal',
        hideInactiveSessions: 'Hide inactive sessions',
        hideInactiveSessionsSubtitle: 'Show only active chats in your list',
        imageUpload: 'Image Upload',
        imageUploadSubtitle: 'Attach images to messages for supported agents to analyze',
    },

    imageUpload: {
        permissionTitle: 'Photo Library Access',
        permissionMessage: 'Allow access to your photo library to attach images to messages.',
        limitTitle: 'Image Limit Reached',
        limitMessage: ({ max }: { max: number }) => `You can attach up to ${max} images per message.`,
        fileTooLargeTitle: 'File Too Large',
        fileTooLargeMessage: ({ name, maxMb }: { name: string; maxMb: number }) => `"${name}" exceeds the ${maxMb}MB limit and was not added.`,
        uploadFailedTitle: 'Upload Failed',
        uploadFailedMessage: ({ count }: { count: number }) => count === 1
            ? 'One image could not be uploaded and was not sent.'
            : `${count} images could not be uploaded and were not sent.`,
        notSupportedTitle: 'Images Not Supported',
        notSupportedMessage: 'This agent does not support image attachments. Images were not sent.',
    },

    errors: {
        authenticationFailed: 'Authentication failed',
        failedToLoadProfile: 'Failed to load user profile',
        userNotFound: 'User not found',
        sessionDeleted: 'Session has been deleted',
        sessionDeletedDescription: 'This session has been permanently removed',

        // Error functions with context
        failedToSendRequest: 'Failed to send friend request',
    },

    newSession: {
        title: 'Start New Session',
        machineOffline: 'Machine is offline',
        switchMachinesHint: '• Switch machines by clicking on the machine above',
    },

    settingsConnection: {
        // Connection settings screen (relay URL, machine, token)
        status: ({ status }: { status: string }) => `Status: ${status}`,
    },

    optionSheet: {
        // Model/mode picker bottom sheet
        all: 'all',
        searchPlaceholder: ({ count }: { count: number }) => `Search ${count}`,
        useCustom: ({ value }: { value: string }) => `use ${value}`,
        noResults: 'no results',
    },

    homeDock: {
        // Home screen composer
        inputPlaceholder: 'Plan, ask, build…',
        runCommandPlaceholder: 'Run a command',
        askPlaceholder: ({ name }: { name: string }) => `Ask ${name}`,
    },

    liveTerminals: {
        // Live terminals strip on the home screen
        title: 'LIVE',
    },

    emptySessions: {
        // Empty state shown on tablets when no sessions are active
        noActiveSessions: 'No active sessions',
        startDescription: 'Start a new session on any of your connected machines.',
        noMachinesDescription: 'Open a new terminal on your computer to start a session.',
    },

    sessionHistory: {
        // Used by session history screen
        title: 'Session History',
        empty: 'No agents found',
        today: 'Today',
        yesterday: 'Yesterday',
        daysAgo: ({ count }: { count: number }) => `${count} ${count === 1 ? 'day' : 'days'} ago`,
    },

    session: {
        inputPlaceholder: 'Type a message ...',
        inactiveArchived: 'This session is inactive.',
        resumeFromTerminal: 'To resume it from the terminal:',
        newChat: 'New agent',
        // Fork / duplicate / rewind flow (Pi only)
        forkAction: 'Fork session',
        forkSubtitle: 'Continue in a new session with the same context',
        duplicateAction: 'Duplicate from message…',
        duplicateSubtitle: 'Rewind to a chosen point and try again',
        duplicateSheetTitle: 'Choose a rewind point',
        duplicateSheetSubtitle: 'The new session keeps the chosen turn complete (your message and the agent’s response) and drops every prompt after it.',
        duplicateSheetConfirm: 'Duplicate',
        duplicateSheetEmpty: 'No messages eligible for rewind in this session yet.',
        duplicateRowDisabled: "This message can't be used as a rewind point.",
        forkedFromLabel: 'Forked from',
        forkedFromSubtitle: 'Open the session this fork was branched from',
        forkErrorMissingMetadata: 'Missing session metadata required to fork.',
        forkErrorGeneric: 'Failed to fork the session.',
    },

    commandPalette: {
        placeholder: 'Type a command or search...',
    },


    sessionInfo: {
        // Used by Session Info screen (app/(app)/session/[id]/info.tsx)
        archiveSession: 'Archive Session',
        muxrSessionIdCopied: 'muxr Session ID copied to clipboard',
        failedToCopySessionId: 'Failed to copy muxr Session ID',
        muxrSessionId: 'muxr Session ID',
        claudeCodeSessionId: 'Pi Session ID',
        claudeCodeSessionIdCopied: 'Pi Session ID copied to clipboard',
        codexThreadId: 'Pi Thread ID',
        codexThreadIdCopied: 'Pi Thread ID copied to clipboard',
        aiProvider: 'AI Provider',
        failedToCopyClaudeCodeSessionId: 'Failed to copy Pi Session ID',
        failedToCopyCodexThreadId: 'Failed to copy Pi Thread ID',
        metadataCopied: 'Session metadata copied to clipboard',
        failedToCopyMetadata: 'Failed to copy session metadata',
        failedToArchiveSession: 'Failed to archive session',
        connectionStatus: 'Connection Status',
        created: 'Created',
        lastUpdated: 'Last Updated',
        sequence: 'Sequence',
        quickActions: 'Quick Actions',
        viewMachine: 'View Machine',
        viewMachineSubtitle: 'View machine details and sessions',
        resumeSession: 'Resume Session',
        resumeSessionSubtitle: 'Resume this session on the same machine',
        resumeSessionSameMachineOnly: 'This session can only be resumed on the same machine it started on.',
        resumeSessionMachineOffline: 'This machine is offline. Resume is only available while it is online.',
        resumeSessionMissingMachine: 'This session is missing its machine metadata, so it cannot be resumed.',
        resumeSessionMissingBackendId: 'This session does not have a resumable Pi identifier.',
        resumeSessionUnexpectedDirectoryPrompt: 'Resume cannot create directories. Start the session manually from its original path.',
        archiveSessionSubtitle: 'Archive this session and stop it',
        metadata: 'Metadata',
        host: 'Host',
        path: 'Path',
        operatingSystem: 'Operating System',
        processId: 'Process ID',
        muxrHome: 'muxr Home',
        copyMetadata: 'Copy session metadata',
        agentState: 'Agent State',
        controlledByUser: 'Controlled by User',
        pendingRequests: 'Pending Requests',
        activity: 'Activity',
        thinking: 'Thinking',
        thinkingSince: 'Thinking Since',
        cliVersion: 'CLI Version',
        deleteSession: 'Delete Session',
        deleteSessionSubtitle: 'Permanently remove this session',
        deleteSessionWarning: 'This action cannot be undone. All messages and data associated with this session will be permanently deleted.',
        failedToDeleteSession: 'Failed to delete session',
        worktreeCleanupTitle: 'Delete Worktree?',
        worktreeCleanupMessage: 'The worktree has no uncommitted changes. Would you like to delete the worktree files?',
        worktreeCleanupDelete: 'Delete Worktree',
        worktreeCleanupKeep: 'Keep Files',
        landWorktree: 'Land Worktree',
        landWorktreeSubtitle: 'Squash this worktree onto the base branch',
        landWorktreeMessage: 'Commit message for the squashed change',
        landWorktreeFailed: 'Failed to land worktree',
        landWorktreeDone: 'Landed on the base branch.',
        
    },

    archive: {
        select: 'Select',
        selectAll: 'Select all',
        deselectAll: 'Deselect all',
        archiveCount: ({ count }: { count: number }) => plural({ count, singular: 'Archive 1 session', plural: `Archive ${count} sessions` }),
        unarchiveCount: ({ count }: { count: number }) => plural({ count, singular: 'Unarchive 1 session', plural: `Unarchive ${count} sessions` }),
        selectedCount: ({ count }: { count: number }) => `${count} selected`,
        archivedCount: ({ count }: { count: number }) => plural({ count, singular: 'Archived 1 session', plural: `Archived ${count} sessions` }),
        undo: 'Undo',
    },

    components: {
        sessionStatusBar: {
            contextUsage: ({ used, total, percent }: { used: string; total: string; percent: number }) => `Context ${used} of ${total} tokens, ${percent}%`,
            limitFiveHour: '5-hour limit',
            limitSevenDay: '7-day limit',
            limitResets: ({ time }: { time: string }) => `resets ${time}`,
            limitAsOf: ({ age }: { age: string }) => `as of ${age} ago`,
            limitRemaining: ({ percent }: { percent: number }) => `${percent}% left`,
        },
    },

    agentInput: {
        permissionMode: {
            title: 'PERMISSION MODE',
            default: 'default permissions',
            acceptEdits: 'accept edits',
            plan: 'plan',
            dontAsk: "don't ask",
            bypassPermissions: 'yolo',
        },
        agent: {
            pi: 'Pi',
        },
        model: {
            title: 'MODEL',
            configureInCli: 'Configure models in CLI settings',
        },
        effort: {
            title: 'EFFORT',
        },
        codexPermissionMode: {
            title: 'PI PERMISSION MODE',
            default: 'default permissions',
            readOnly: 'read-only',
            safeYolo: 'safe yolo',
            yolo: 'yolo',
            defaultDescription: 'ask before untrusted commands',
            readOnlyDescription: 'no writes',
            safeYoloDescription: 'no prompts, workspace sandbox',
            yoloDescription: 'no prompts, full access',
        },

        geminiPermissionMode: {
            title: 'PI PERMISSION MODE',
            default: 'default permissions',
            autoEdit: 'auto edit',
            yolo: 'yolo',
            plan: 'plan',
        },
        context: {
            remaining: ({ percent }: { percent: number }) => `${percent}% left`,
        },
        suggestion: {
            fileLabel: 'FILE',
            folderLabel: 'FOLDER',
        },
        noMachinesAvailable: 'No machines',
    },

    machineLauncher: {
        showLess: 'Show less',
        showAll: ({ count }: { count: number }) => `Show all (${count} paths)`,
        enterCustomPath: 'Enter custom path',
    },

    sidebar: {
        sessionsTitle: 'muxr',
        showArchived: 'Show archived',
        hideArchived: 'Hide archived',
        newSession: 'New session',
    },

    zen: {
        toggle: 'Zen mode',
    },

    toolView: {
        input: 'Input',
        output: 'Output',
    },

    thinking: {
        active: 'Thinking…',
        thought: 'Thought',
        thoughtFor: ({ duration }: { duration: string }) => `Thought for ${duration}`,
    },

    sessionAttachments: {
        title: ({ count }: { count: number }) => count === 1 ? '1 attachment' : `${count} attachments`,
    },

    turnChanges: {
        filesChanged: ({ count }: { count: number }) => count === 1 ? '1 file changed' : `${count} files changed`,
    },

    tools: {
        fullView: {
            description: 'Description',
            inputParams: 'Input Parameters',
            output: 'Output',
            error: 'Error',
            completed: 'Tool completed successfully',
            noOutput: 'No output was produced',
            rawJsonDevMode: 'Raw JSON (Dev Mode)',
        },


        names: {
            search: 'Search',
        },

        desc: {
        }
    },

    files: {
        changes: 'Changes',
        searchPlaceholder: 'Search files...',
        detachedHead: 'detached HEAD',
        summary: ({ staged, unstaged }: { staged: number; unstaged: number }) => `${staged} staged • ${unstaged} unstaged`,
        notRepo: 'Not a git repository',
        notUnderGit: 'This directory is not under git version control',
        searching: 'Searching files...',
        noFilesFound: 'No files found',
        noFilesInProject: 'No files in project',
        tryDifferentTerm: 'Try a different search term',
        searchResults: ({ count }: { count: number }) => `Search Results (${count})`,
        projectRoot: 'Project root',
        stagedChanges: ({ count }: { count: number }) => `Staged Changes (${count})`,
        unstagedChanges: ({ count }: { count: number }) => `Unstaged Changes (${count})`,
        // File viewer strings
        loadingFile: ({ fileName }: { fileName: string }) => `Loading ${fileName}...`,
        binaryFile: 'Binary File',
        cannotDisplayBinary: 'Cannot display binary file content',
        diff: 'Diff',
        file: 'File',
        fileEmpty: 'File is empty',
        noChanges: 'No changes to display',
        noChangesTitle: 'No changes',
        noChangesSubtitle: 'Working tree is clean',
        deleted: 'Deleted',
        changedFiles: ({ count }: { count: number }) => `${count} changed ${count === 1 ? 'file' : 'files'}`,
        allFiles: 'All Files',
        addPanel: 'Add panel',
        closePanel: 'Close panel',
        editFile: 'Edit',
        saveFile: 'Save',
        failedToRead: 'Failed to read file',
        failedToSave: 'Failed to save file',
        fileConflict: 'File conflict',
        fileConflictDescription: 'This file was modified on the device while you were editing. Reload to see the latest version.',
        reload: 'Reload',
        overwrite: 'Overwrite',
    },
    sideChat: {
        panelTitle: 'Side chat',
        emptyTitle: 'Start a side chat',
        emptySubtitle: 'Ask the agent something on the side. It inherits this chat’s context but stays isolated — nothing here touches the main conversation.',
        startButton: 'Start side chat',
        creating: 'Starting side chat…',
        unavailable: 'This session can’t start a side chat yet — wait for the agent to come online.',
        expand: 'Open full screen',
        tabLabel: ({ index }: { index: number }) => `Side chat ${index}`,
        newChat: 'New side chat',
        close: 'Close side chat',
    },


    settingsAccount: {
        // Account settings screen
        accountInformation: 'Account Information',
        status: 'Status',
        statusActive: 'Active',
        statusNotAuthenticated: 'Not Authenticated',
        anonymousId: 'Anonymous ID',
        publicId: 'Public ID',
        notAvailable: 'Not available',
        linkNewDevice: 'Link New Device',
        linkNewDeviceSubtitle: 'Scan QR code to link device',
        backup: 'Backup',
        backupDescription: 'Your secret key is the only way to recover your account. Save it in a secure place like a password manager.',
        secretKey: 'Secret Key',
        tapToReveal: 'Tap to reveal',
        tapToHide: 'Tap to hide',
        secretKeyLabel: 'SECRET KEY (TAP TO COPY)',
        secretKeyCopied: 'Secret key copied to clipboard. Store it in a safe place!',
        secretKeyCopyFailed: 'Failed to copy secret key',
        dangerZone: 'Danger Zone',
        logout: 'Logout',
        logoutSubtitle: 'Sign out and clear local data',
        logoutConfirm: 'Are you sure you want to logout? Make sure you have backed up your secret key!',
    },

    settingsLanguage: {
        // Language settings screen
        title: 'Language',
        description: 'Choose your preferred language for the app interface. This will sync across all your devices.',
        currentLanguage: 'Current Language',
        automatic: 'Automatic',
        automaticSubtitle: 'Detect from device settings',
        needsRestart: 'Language Changed',
        needsRestartMessage: 'The app needs to restart to apply the new language setting.',
    },


    updateBanner: {
        updateAvailable: 'Update available',
        pressToApply: 'Press to apply the update',
        whatsNew: "What's new",
        seeLatest: 'See the latest updates and improvements',
        nativeUpdateAvailable: 'App Update Available',
        tapToUpdateAppStore: 'Tap to update in App Store',
        tapToUpdatePlayStore: 'Tap to update in Play Store',
    },

    changelog: {
        // Used by the changelog screen
        noEntriesAvailable: 'No changelog entries available.',
    },

    terminal: {
        // Used by terminal connection screens
        webBrowserRequired: 'Web Browser Required',
        webBrowserRequiredDescription: 'Terminal connection links can only be opened in a web browser for security reasons. Please use the QR code scanner or open this link on a computer.',
        processingConnection: 'Processing connection...',
        invalidConnectionLink: 'Invalid Connection Link',
        invalidConnectionLinkDescription: 'The connection link is missing or invalid. Please check the URL and try again.',
        connectTerminal: 'Connect Terminal',
        terminalRequestDescription: 'A terminal is requesting to connect to your muxr account. This will allow the terminal to send and receive messages securely.',
        connectionDetails: 'Connection Details',
        publicKey: 'Public Key',
        encryption: 'Encryption',
        endToEndEncrypted: 'End-to-end encrypted',
        acceptConnection: 'Accept Connection',
        connecting: 'Connecting...',
        reject: 'Reject',
        security: 'Security',
        securityFooter: 'This connection link was processed securely in your browser and was never sent to any server. Your private data will remain secure and only you can decrypt the messages.',
        securityFooterDevice: 'This connection was processed securely on your device and was never sent to any server. Your private data will remain secure and only you can decrypt the messages.',
        clientSideProcessing: 'Client-Side Processing',
        linkProcessedLocally: 'Link processed locally in browser',
        linkProcessedOnDevice: 'Link processed locally on device',
    },

    modals: {
        // Used across connect flows and settings
        deviceLinkedSuccessfully: 'Device linked successfully',
        invalidAuthUrl: 'Invalid authentication URL',
        developerMode: 'Developer Mode',
        developerModeEnabled: 'Developer mode enabled',
        developerModeDisabled: 'Developer mode disabled',
        failedToLinkDevice: 'Failed to link device',
        cameraPermissionsRequiredToScanQr: 'Camera permissions are required to scan QR codes'
    },

    navigation: {
        // Navigation titles and screen headers
        connectTerminal: 'Connect Terminal',
        linkNewDevice: 'Link New Device', 
        restoreWithSecretKey: 'Restore with Secret Key',
        browserTakeover: 'Browser takeover',
        whatsNew: "What's New",
        friends: 'Friends',
    },

    welcome: {
        // Main welcome screen for unauthenticated users
        title: 'Your herd, in your pocket',
        subtitle: 'Your account is stored only on your device. End-to-end encryption is optional.',
        createAccount: 'Create account',
        linkOrRestoreAccount: 'Link or restore account',
        loginWithMobileApp: 'Login with mobile app',
    },

    review: {
        // Used by utils/requestReview.ts
        enjoyingApp: 'Enjoying the app?',
        feedbackPrompt: "We'd love to hear your feedback!",
        yesILoveIt: 'Yes, I love it!',
        notReally: 'Not really'
    },

    items: {
        // Used by Item component for copy toast
        copiedToClipboard: ({ label }: { label: string }) => `${label} copied to clipboard`
    },

    machine: {
        launchNewSessionInDirectory: 'Launch New Session in Directory',
        offlineUnableToSpawn: 'Launcher disabled while machine is offline',
        daemon: 'Daemon',
        status: 'Status',
        stopDaemon: 'Stop Daemon',
        lastKnownPid: 'Last Known PID',
        lastKnownHttpPort: 'Last Known HTTP Port',
        startedAt: 'Started At',
        cliVersion: 'CLI Version',
        daemonStateVersion: 'Daemon State Version',
        stopDaemonConfirmTitle: 'Stop Daemon?',
        stopDaemonConfirmMessage: 'You will not be able to spawn new sessions on this machine until you restart the daemon on your computer again. Your current sessions will stay alive.',
        daemonStopped: 'Daemon Stopped',
        stopDaemonFailed: 'Failed to stop daemon. It may not be running.',
        machineGroup: 'Machine',
        host: 'Host',
        machineId: 'Machine ID',
        username: 'Username',
        homeDirectory: 'Home Directory',
        platform: 'Platform',
        architecture: 'Architecture',
        lastSeen: 'Last Seen',
        never: 'Never',
        metadataVersion: 'Metadata Version',
        cliAvailability: 'CLI Availability',
        cliInstalled: 'Installed',
        cliNotFound: 'Not found',
        lastDetected: 'Last Detected',
        back: 'Back',
        dangerZone: 'Danger Zone',
        delete: 'Delete Machine',
        deleteFooter: 'Remove this machine from your account. Session history will be preserved, but you will not be able to start new sessions on this machine.',
        deleteConfirmTitle: 'Delete this machine?',
        deleteConfirmMessage: 'The machine will be removed from your account. Session history will be preserved, but you will not be able to start new sessions until you reconnect the daemon.',
        deleteFailed: 'Failed to delete machine.',
    },

    message: {
        switchedToMode: ({ mode }: { mode: string }) => `Switched to ${mode} mode`,
        unknownEvent: 'Unknown event',
        usageLimitUntil: ({ time }: { time: string }) => `Usage limit reached until ${time}`,
        sentAsGoal: 'Sent as goal',
        unknownTime: 'unknown time',
    },

    codex: {
        // Pi permission dialog buttons
        permissions: {
            yesForSession: "Yes, and don't ask for a session",
            stopAndExplain: 'Stop, and explain what to do',
        }
    },

    claude: {
        // Pi permission dialog buttons
        permissions: {
            yesAllowAllEdits: 'Yes, allow all edits during this session',
            yesAllowEverything: 'Yes, allow everything during this session',
            yesForTool: "Yes, don't ask again for this tool",
            noTellClaude: 'No, and provide feedback',
        }
    },

    textSelection: {
        // Text selection screen
        title: 'Select Text',
        noTextProvided: 'No text provided',
        textNotFound: 'Text not found or expired',
        textCopied: 'Text copied to clipboard',
        failedToCopy: 'Failed to copy text to clipboard',
        noTextToCopy: 'No text available to copy',
    },

    markdown: {
        // Markdown copy functionality
        codeCopied: 'Code copied',
        copyFailed: 'Copy failed',
        mermaidRenderFailed: 'Failed to render mermaid diagram',
    },

    artifacts: {
        // Artifacts feature
        title: 'Artifacts',
        empty: 'No artifacts yet',
        emptyDescription: 'Create your first artifact to get started',
        new: 'New Artifact',
        edit: 'Edit Artifact',
        delete: 'Delete',
        updateError: 'Failed to update artifact. Please try again.',
        notFound: 'Artifact not found',
        deleteConfirm: 'Delete artifact?',
        deleteConfirmDescription: 'This action cannot be undone',
        titleLabel: 'TITLE',
        titlePlaceholder: 'Enter a title for your artifact',
        bodyLabel: 'CONTENT',
        bodyPlaceholder: 'Write your content here...',
        emptyFieldsError: 'Please enter a title or content',
        createError: 'Failed to create artifact. Please try again.',
        loading: 'Loading artifacts...',
        error: 'Failed to load artifact',
    },

    friends: {
        // Friends feature
        manageFriends: 'Manage your friends and connections',
        pendingRequests: 'Friend Requests',
        myFriends: 'My Friends',
        noFriendsYet: "You don't have any friends yet",
        remove: 'Remove',
        addFriend: 'Add Friend',
        alreadyFriends: 'Already Friends',
        requestPending: 'Request Pending',
        searchInstructions: 'Enter a username to search for friends',
        searchPlaceholder: 'Enter username...',
        searching: 'Searching...',
        noUserFound: 'No user found with that username',
        checkUsername: 'Please check the username and try again',
        howToFind: 'How to Find Friends',
        findInstructions: 'Search for friends by their username. Both you and your friend need to have GitHub connected to send friend requests.',
        requestSent: 'Friend request sent!',
        confirmRemove: 'Remove Friend',
        confirmRemoveMessage: 'Are you sure you want to remove this friend?',
        cannotAddYourself: 'You cannot send a friend request to yourself',
        bothMustHaveGithub: 'Both users must have GitHub connected to become friends',
        status: {
            none: 'Not connected',
            requested: 'Request sent',
            pending: 'Request pending',
            friend: 'Friends',
            rejected: 'Rejected',
        },
        acceptRequest: 'Accept Request',
        removeFriend: 'Remove Friend',
        removeFriendConfirm: ({ name }: { name: string }) => `Are you sure you want to remove ${name} as a friend?`,
        requestFriendship: 'Request friendship',
        cancelRequest: 'Cancel friendship request',
        cancelRequestConfirm: ({ name }: { name: string }) => `Cancel your friendship request to ${name}?`,
        denyRequest: 'Deny friendship',
    },

    usage: {
        // Usage panel strings
        today: 'Today',
        last7Days: 'Last 7 days',
        last30Days: 'Last 30 days',
        totalTokens: 'Total Tokens',
        totalCost: 'Total Cost',
        tokens: 'Tokens',
        cost: 'Cost',
        usageOverTime: 'Usage over time',
        byModel: 'By Model',
    },

    feed: {
        // Feed notifications for friend requests and acceptances
    },

} as const;

export type Translations = typeof en;

/**
 * Generic translation type that matches the structure of Translations
 * but allows different string values (for other languages)
 */
export type TranslationStructure = {
    readonly [K in keyof Translations]: {
        readonly [P in keyof Translations[K]]: Translations[K][P] extends string 
            ? string 
            : Translations[K][P] extends (...args: any[]) => string 
                ? Translations[K][P] 
                : Translations[K][P] extends object
                    ? {
                        readonly [Q in keyof Translations[K][P]]: Translations[K][P][Q] extends string
                            ? string
                            : Translations[K][P][Q]
                      }
                    : Translations[K][P]
    }
};
