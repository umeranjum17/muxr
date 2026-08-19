import type { TranslationStructure } from '../_default';

/**
 * Italian plural helper function
 * Italian has 2 plural forms: singular, plural
 * @param options - Object containing count, singular, and plural forms
 * @returns The appropriate form based on Italian plural rules
 */
function plural({ count, singular, plural }: { count: number; singular: string; plural: string }): string {
    return count === 1 ? singular : plural;
}

/**
 * Italian translations for the muxr app
 * Must match the exact structure of the English translations
 */
export const it: TranslationStructure = {
    tabs: {
        // Tab navigation labels
        sessions: 'Terminali',
        settings: 'Impostazioni',
    },

    inbox: {
        // Inbox screen: the sessions currently waiting on you
        reason: {
            waiting: 'in attesa',
            blocked: 'bloccato',
            failed: 'fallito',
            done: 'completato',
        },
    },

    plugins: {
        openFromHome: 'Apri un plugin dalla Home.',
        unavailable: 'Questo plugin è disattivato o non disponibile.',
        goBack: 'Indietro',
        couldNotLoad: 'Impossibile caricare gli elementi',
        dataUnavailable: 'Il plugin non è disponibile al momento.',
        nothingHere: 'Non c’è nulla qui',
        newItems: 'I nuovi elementi appariranno qui.',
        retry: 'Riprova',
        retryItems: 'Riprova a caricare gli elementi del plugin',
        stale: 'Impossibile aggiornare. Mostro l’ultimo risultato.',
        nothingToShow: 'Niente da mostrare.',
        treeUnavailable: 'Albero non disponibile.',
        dictate: 'Detta',
        unavailableSuffix: 'non disponibile',
        showingStale: 'dati non aggiornati',
        settingsTitle: 'Plugin',
        enableAll: 'Abilita tutti',
        disableAll: 'Disabilita tutti',
        installed: 'Installati',
        waitingHost: 'In attesa dell’host.',
        linkHost: 'Collega un plugin tramite Herdr e riconnettiti.',
        enabled: 'abilitati',
        off: 'off',
        on: 'on',
        unavailableLabel: 'Non disponibile',
        runsCode: 'Esegue codice come te',
        uiOnly: 'Solo interfaccia',
        readsSessions: 'Legge i riepiloghi delle sessioni',
        readsTree: 'Legge l’albero dell’area di lavoro',
        openFailed: 'Apertura non riuscita',
        actionFailed: 'Azione non riuscita',
        items: 'Elementi',
        openWebsite: 'Aprire il sito web?',
        open: 'Apri',
        realtimeConnecting: 'Connessione sessione vocale',
        realtimeListening: 'In ascolto',
        realtimeThinking: 'Sto pensando',
        realtimeSpeaking: 'Sto parlando',
        realtimeError: 'Errore sessione vocale',
        realtimeOff: 'Sessione vocale disattivata',
        openConversation: 'Apri conversazione vocale',
        realtime: 'Voce',
    },

    common: {
        // Simple string constants
        cancel: 'Annulla',
        save: 'Salva',
        error: 'Errore',
        success: 'Successo',
        ok: 'OK',
        back: 'Indietro',
        create: 'Crea',
        rename: 'Rinomina',
        logout: 'Esci',
        yes: 'Sì',
        no: 'No',
        version: 'Versione',
        copied: 'Copiato',
        copy: 'Copia',
        scanning: 'Scansione...',
        home: 'Home',
        message: 'Messaggio',
        files: 'File',
        fileViewer: 'Visualizzatore file',
        loading: 'Caricamento...',
        delete: 'Elimina',
    },

    profile: {
        details: 'Dettagli',
        firstName: 'Nome',
        lastName: 'Cognome',
        username: 'Nome utente',
        status: 'Stato',
    },

    status: {
        connected: 'connesso',
        connecting: 'connessione in corso',
        disconnected: 'disconnesso',
        error: 'errore',
        pairingIssue: 'problema di abbinamento',
        online: 'online',
        offline: 'offline',
        lastSeen: ({ time }: { time: string }) => `visto l'ultima volta ${time}`,
        permissionRequired: 'permesso richiesto',
        activeNow: 'Attivo ora',
        unknown: 'sconosciuto',
        unread: 'nuovi risultati',
    },

    time: {
        justNow: 'proprio ora',
        minutesAgo: ({ count }: { count: number }) => `${count} ${count === 1 ? 'minuto' : 'minuti'} fa`,
        hoursAgo: ({ count }: { count: number }) => `${count} ${count === 1 ? 'ora' : 'ore'} fa`,
        daysAgo: ({ count }: { count: number }) => `${count} ${count === 1 ? 'giorno' : 'giorni'} fa`,
    },

    connect: {
        restoreAccount: 'Ripristina account',
        enterSecretKey: 'Inserisci la chiave segreta',
        invalidSecretKey: 'Chiave segreta non valida. Controlla e riprova.',
        qrInstructions: '1. Apri muxr sul tuo dispositivo mobile\n2. Vai su Impostazioni → Account\n3. Tocca "Collega nuovo dispositivo"\n4. Scansiona questo codice QR',
        restoreWithSecretKeyInstead: 'O ripristina con la chiave segreta',
    },

    settings: {
        title: 'Impostazioni',
        github: 'GitHub',
        machines: 'Macchine',
        showOfflineMachines: ({ count }: { count: number }) => count === 1 ? 'Mostra 1 macchina offline' : `Mostra ${count} macchine offline`,
        hideOfflineMachines: 'Nascondi macchine offline',
        features: 'Funzionalità',
        social: 'Social',
        account: 'Account',
        accountSubtitle: 'Gestisci i dettagli del tuo account',
        appearance: 'Aspetto',
        appearanceSubtitle: 'Personalizza l\'aspetto dell\'app',
        featuresTitle: 'Funzionalità',
        featuresSubtitle: 'Abilita o disabilita le funzionalità dell\'app',
        about: 'Informazioni',
        aboutFooter: 'muxr è un client mobile per Pi. La cifratura end-to-end è opzionale e disattivata per impostazione predefinita; il tuo account è memorizzato solo sul tuo dispositivo. Non affiliato con Anthropic.',
        whatsNew: 'Novità',
        whatsNewSubtitle: 'Scopri gli ultimi aggiornamenti e miglioramenti',
        reportIssue: 'Segnala un problema',
        eula: 'EULA',
        connection: 'Connessione',
        connectionSubtitle: 'URL del relay, macchina e token',
        pushNotifications: 'Notifiche push',
        pushSubtitleSubscribed: 'Attive — ricevi un avviso quando un agente ha bisogno di una risposta',
        pushSubtitleDenied: 'Bloccate dal browser — consenti le notifiche per attivarle',
        pushSubtitleUnsupported: 'Non disponibile in questo browser',
        pushSubtitleDefault: 'Tocca per ricevere un avviso quando un agente ha bisogno di una risposta',
        license: 'Licenza e note legali',
        // Dynamic settings messages
    },

    settingsAppearance: {
        // Appearance settings screen
        theme: 'Tema',
        themeDescription: 'Scegli lo schema di colori preferito',
        themeOptions: {
            adaptive: 'Adattivo',
            light: 'Chiaro',
            dark: 'Scuro',
        },
        themeDescriptions: {
            adaptive: 'Segui le impostazioni di sistema',
            light: 'Usa sempre il tema chiaro',
            dark: 'Usa sempre il tema scuro',
        },
        display: 'Schermo',
        displayDescription: 'Controlla layout e spaziatura',

        avatarStyle: 'Stile avatar',
        avatarStyleDescription: 'Scegli l\'aspetto dell\'avatar di sessione',
        avatarOptions: {
            pixelated: 'Pixelato',
            gradient: 'Gradiente',
            brutalist: 'Brutalista',
        },
        showFlavorIcons: 'Mostra icone provider IA',
        showFlavorIconsDescription: 'Mostra le icone del provider IA sugli avatar di sessione',
    },

    settingsFeatures: {
        // Features settings screen
        experiments: 'Esperimenti',
        experimentsDescription: 'Abilita funzionalità sperimentali ancora in sviluppo. Queste funzionalità possono essere instabili o cambiare senza preavviso.',
        webFeatures: 'Funzionalità web',
        webFeaturesDescription: 'Funzionalità disponibili solo nella versione web dell\'app.',
        commandPalette: 'Palette comandi',
        commandPaletteEnabled: 'Premi ⌘K per aprire',
        commandPaletteDisabled: 'Accesso rapido ai comandi disabilitato',
        markdownCopyV2: 'Markdown Copy v2',
        markdownCopyV2Subtitle: 'Pressione lunga apre la finestra di copia',
        hideInactiveSessions: 'Nascondi sessioni inattive',
        hideInactiveSessionsSubtitle: 'Mostra solo le chat attive nella tua lista',
        imageUpload: 'Caricamento immagini',
        imageUploadSubtitle: 'Allega immagini ai messaggi per farle analizzare dagli agenti supportati',
    },

    errors: {
        authenticationFailed: 'Autenticazione non riuscita',
        failedToLoadProfile: 'Impossibile caricare il profilo utente',
        userNotFound: 'Utente non trovato',
        sessionDeleted: 'La sessione è stata eliminata',
        sessionDeletedDescription: 'Questa sessione è stata rimossa definitivamente',

        // Error functions with context
        failedToSendRequest: 'Impossibile inviare la richiesta di amicizia',
    },

    newSession: {
        title: 'Avvia nuova sessione',
        machineOffline: 'La macchina è offline',
        switchMachinesHint: '• Cambia macchina cliccando sulla macchina sopra',
    },

    settingsConnection: {
        // Connection settings screen (relay URL, machine, token)
        status: ({ status }: { status: string }) => `Stato: ${status}`,
    },

    optionSheet: {
        // Model/mode picker bottom sheet
        all: 'tutti',
        searchPlaceholder: ({ count }: { count: number }) => `Cerca ${count}`,
        useCustom: ({ value }: { value: string }) => `usa ${value}`,
        noResults: 'nessun risultato',
    },

    homeDock: {
        // Home screen composer
        inputPlaceholder: 'Pianifica, chiedi, costruisci…',
        runCommandPlaceholder: 'Esegui un comando',
        askPlaceholder: ({ name }: { name: string }) => `Chiedi a ${name}`,
    },

    liveTerminals: {
        // Live terminals strip on the home screen
        title: 'DAL VIVO',
    },

    emptySessions: {
        // Empty state shown on tablets when no sessions are active
        noActiveSessions: 'Nessuna sessione attiva',
        startDescription: 'Avvia una nuova sessione su una qualsiasi delle tue macchine connesse.',
        noMachinesDescription: 'Apri un nuovo terminale sul tuo computer per avviare una sessione.',
    },

    sessionHistory: {
        // Used by session history screen
        title: 'Cronologia sessioni',
        empty: 'Nessuna sessione trovata',
        today: 'Oggi',
        yesterday: 'Ieri',
        daysAgo: ({ count }: { count: number }) => `${count} ${count === 1 ? 'giorno' : 'giorni'} fa`,
    },

    session: {
        inputPlaceholder: 'Scrivi un messaggio ...',
        inactiveArchived: 'Questa sessione è inattiva.',
        resumeFromTerminal: 'Per riprenderla dal terminale:',
        newChat: 'Nuova chat',
        forkAction: 'Biforca sessione',
        forkSubtitle: 'Continua in una nuova sessione con lo stesso contesto',
        duplicateAction: 'Duplica da un messaggio…',
        duplicateSubtitle: 'Torna a un punto scelto e riprova',
        duplicateSheetTitle: 'Scegli un punto di ritorno',
        duplicateSheetSubtitle: 'La nuova sessione manterrà il turno scelto completo (il tuo messaggio e la risposta dell\'agente) e scarterà i messaggi successivi.',
        duplicateSheetConfirm: 'Duplica',
        duplicateSheetEmpty: 'Nessun messaggio idoneo per il ritorno in questa sessione.',
        duplicateRowDisabled: 'Questo messaggio non può essere usato come punto di ritorno.',
        forkedFromLabel: 'Biforcato da',
        forkedFromSubtitle: 'Apri la sessione da cui è stata creata la biforcazione',
        forkErrorMissingMetadata: 'Mancano i metadati della sessione necessari per biforcare.',
        forkErrorGeneric: 'Impossibile biforcare la sessione.',
    },

    commandPalette: {
        placeholder: 'Digita un comando o cerca...',
    },


    sessionInfo: {
        // Used by Session Info screen (app/(app)/session/[id]/info.tsx)
        archiveSession: 'Archivia sessione',
        muxrSessionIdCopied: 'ID sessione muxr copiato negli appunti',
        failedToCopySessionId: 'Impossibile copiare l\'ID sessione muxr',
        muxrSessionId: 'ID sessione muxr',
        claudeCodeSessionId: 'ID sessione Pi',
        claudeCodeSessionIdCopied: 'ID sessione Pi copiato negli appunti',
        codexThreadId: 'ID thread Pi',
        codexThreadIdCopied: 'ID thread Pi copiato negli appunti',
        aiProvider: 'Provider IA',
        failedToCopyClaudeCodeSessionId: 'Impossibile copiare l\'ID sessione Pi',
        failedToCopyCodexThreadId: 'Impossibile copiare l\'ID thread Pi',
        metadataCopied: 'Metadati copiati negli appunti',
        failedToCopyMetadata: 'Impossibile copiare i metadati',
        failedToArchiveSession: 'Impossibile archiviare la sessione',
        connectionStatus: 'Stato connessione',
        created: 'Creato',
        lastUpdated: 'Ultimo aggiornamento',
        sequence: 'Sequenza',
        quickActions: 'Azioni rapide',
        viewMachine: 'Visualizza macchina',
        viewMachineSubtitle: 'Visualizza dettagli e sessioni della macchina',
        resumeSession: 'Resume Session',
        resumeSessionSubtitle: 'Resume this session on the same machine',
        resumeSessionSameMachineOnly: 'This session can only be resumed on the same machine it started on.',
        resumeSessionMachineOffline: 'This machine is offline. Resume is only available while it is online.',
        resumeSessionMissingMachine: 'This session is missing its machine metadata, so it cannot be resumed.',
        resumeSessionMissingBackendId: 'This session does not have a resumable Pi identifier.',
        resumeSessionUnexpectedDirectoryPrompt: 'Resume cannot create directories. Start the session manually from its original path.',
        archiveSessionSubtitle: 'Archivia questa sessione e fermala',
        metadata: 'Metadati',
        host: 'Host',
        path: 'Percorso',
        operatingSystem: 'Sistema operativo',
        processId: 'ID processo',
        muxrHome: 'muxr Home',
        copyMetadata: 'Copia metadati',
        agentState: 'Stato agente',
        controlledByUser: 'Controllato dall\'utente',
        pendingRequests: 'Richieste in sospeso',
        activity: 'Attività',
        thinking: 'Pensando',
        thinkingSince: 'Pensando da',
        cliVersion: 'Versione CLI',
        deleteSession: 'Elimina sessione',
        deleteSessionSubtitle: 'Rimuovi definitivamente questa sessione',
        deleteSessionWarning: 'Questa azione non può essere annullata. Tutti i messaggi e i dati associati a questa sessione verranno eliminati definitivamente.',
        failedToDeleteSession: 'Impossibile eliminare la sessione',
        worktreeCleanupTitle: 'Eliminare Worktree?',
        worktreeCleanupMessage: 'Il Worktree non ha modifiche non confermate. Vuoi eliminare i file del Worktree?',
        worktreeCleanupDelete: 'Elimina Worktree',
        worktreeCleanupKeep: 'Conserva file',
        landWorktree: 'Land Worktree',
        landWorktreeSubtitle: 'Squash this worktree onto the base branch and remove it',
        landWorktreeMessage: 'Commit message for the squashed change',
        landWorktreeFailed: 'Failed to land worktree',
        landWorktreeDone: 'Landed on the base branch. The worktree is gone.',

    },

    archive: {
        select: 'Seleziona',
        selectAll: 'Seleziona tutto',
        deselectAll: 'Deseleziona tutto',
        archiveCount: ({ count }: { count: number }) => plural({ count, singular: 'Archivia 1 sessione', plural: `Archivia ${count} sessioni` }),
        unarchiveCount: ({ count }: { count: number }) => plural({ count, singular: 'Ripristina 1 sessione', plural: `Ripristina ${count} sessioni` }),
        selectedCount: ({ count }: { count: number }) => `${count} selezionate`,
        archivedCount: ({ count }: { count: number }) => plural({ count, singular: '1 sessione archiviata', plural: `${count} sessioni archiviate` }),
        undo: 'Annulla',
    },

    components: {
        sessionStatusBar: {
            contextUsage: ({ used, total, percent }: { used: string; total: string; percent: number }) => `Contesto ${used} di ${total} token, ${percent}%`,
            limitFiveHour: 'Limite di 5 ore',
            limitSevenDay: 'Limite di 7 giorni',
            limitResets: ({ time }: { time: string }) => `si azzera ${time}`,
            limitAsOf: ({ age }: { age: string }) => `${age} fa`,
            limitRemaining: ({ percent }: { percent: number }) => `${percent}% rimanente`,
        },
    },

    agentInput: {
        permissionMode: {
            title: 'MODALITÀ PERMESSI',
            default: 'Predefinito',
            acceptEdits: 'Accetta modifiche',
            plan: 'Modalità piano',
            dontAsk: 'Non chiedere',
            bypassPermissions: 'Modalità YOLO',
        },
        agent: {
            pi: 'Pi',
        },
        model: {
            title: 'MODELLO',
            configureInCli: 'Configura i modelli nelle impostazioni CLI',
        },
        effort: {
            title: 'IMPEGNO',
        },
        codexPermissionMode: {
            title: 'MODALITÀ PERMESSI PI',
            default: 'Impostazioni CLI',
            readOnly: 'Modalità sola lettura',
            safeYolo: 'YOLO sicuro',
            yolo: 'YOLO',
            defaultDescription: 'chiedi prima dei comandi non attendibili',
            readOnlyDescription: 'nessuna scrittura',
            safeYoloDescription: "nessuna richiesta, sandbox dell'area di lavoro",
            yoloDescription: 'nessuna richiesta, accesso completo',
        },

        geminiPermissionMode: {
            title: 'MODALITÀ PERMESSI PI',
            default: 'Predefinito',
            autoEdit: 'Modifica automatica',
            yolo: 'YOLO',
            plan: 'Pianificazione',
        },
        context: {
            remaining: ({ percent }: { percent: number }) => `${percent}% restante`,
        },
        suggestion: {
            fileLabel: 'FILE',
            folderLabel: 'CARTELLA',
        },
        noMachinesAvailable: 'Nessuna macchina',
    },

    machineLauncher: {
        showLess: 'Mostra meno',
        showAll: ({ count }: { count: number }) => `Mostra tutto (${count} percorsi)`,
        enterCustomPath: 'Inserisci percorso personalizzato',
    },

    sidebar: {
        sessionsTitle: 'muxr',
        showArchived: 'Mostra archiviate',
        hideArchived: 'Nascondi archiviate',
        newSession: 'Nuova sessione',
    },

    zen: {
        toggle: 'Modalità zen',
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
        title: ({ count }: { count: number }) => count === 1 ? '1 allegato' : `${count} allegati`,
    },

    turnChanges: {
        filesChanged: ({ count }: { count: number }) => count === 1 ? 'Modificato 1 file' : `Modificati ${count} file`,
    },

    tools: {
        fullView: {
            description: 'Descrizione',
            inputParams: 'Parametri di input',
            output: 'Output',
            error: 'Errore',
            completed: 'Strumento completato con successo',
            noOutput: 'Nessun output prodotto',
            rawJsonDevMode: 'JSON grezzo (Modalità sviluppatore)',
        },



        names: {
            search: 'Cerca',
        },
        desc: {
        }
    },

    files: {
        changes: 'Modifiche',
        searchPlaceholder: 'Cerca file...',
        detachedHead: 'HEAD scollegato',
        summary: ({ staged, unstaged }: { staged: number; unstaged: number }) => `${staged} in stage • ${unstaged} non in stage`,
        notRepo: 'Non è un repository git',
        notUnderGit: 'Questa directory non è sotto controllo versione git',
        searching: 'Ricerca file...',
        noFilesFound: 'Nessun file trovato',
        noFilesInProject: 'Nessun file nel progetto',
        tryDifferentTerm: 'Prova un termine di ricerca diverso',
        searchResults: ({ count }: { count: number }) => `Risultati ricerca (${count})`,
        projectRoot: 'Radice progetto',
        stagedChanges: ({ count }: { count: number }) => `Modifiche in stage (${count})`,
        unstagedChanges: ({ count }: { count: number }) => `Modifiche non in stage (${count})`,
        // File viewer strings
        loadingFile: ({ fileName }: { fileName: string }) => `Caricamento ${fileName}...`,
        binaryFile: 'File binario',
        cannotDisplayBinary: 'Impossibile mostrare il contenuto del file binario',
        diff: 'Diff',
        file: 'File',
        fileEmpty: 'File vuoto',
        noChanges: 'Nessuna modifica da mostrare',
        noChangesTitle: 'Nessuna modifica',
        noChangesSubtitle: 'L\'albero di lavoro è pulito',
        deleted: 'Eliminato',
        changedFiles: ({ count }: { count: number }) => `${count} ${count === 1 ? 'file modificato' : 'file modificati'}`,
        allFiles: 'Tutti i file',
        addPanel: 'Aggiungi pannello',
        closePanel: 'Chiudi pannello',
        editFile: 'Modifica',
        saveFile: 'Salva',
        failedToRead: 'Impossibile leggere il file',
        failedToSave: 'Impossibile salvare il file',
        fileConflict: 'Conflitto file',
        fileConflictDescription: 'Questo file è stato modificato sul dispositivo mentre lo stavi modificando. Ricarica per vedere l\'ultima versione.',
        reload: 'Ricarica',
        overwrite: 'Sovrascrivi',
    },
    sideChat: {
        panelTitle: 'Chat laterale',
        emptyTitle: 'Avvia una chat laterale',
        emptySubtitle: 'Chiedi qualcosa all’agente a parte. Eredita il contesto di questa chat ma rimane isolata — nulla qui tocca la conversazione principale.',
        startButton: 'Avvia chat laterale',
        creating: 'Avvio della chat laterale…',
        unavailable: 'Questa sessione non può ancora avviare una chat laterale — attendi che l’agente sia online.',
        expand: 'Apri a schermo intero',
        tabLabel: ({ index }: { index: number }) => `Chat laterale ${index}`,
        newChat: 'Nuova chat laterale',
        close: 'Chiudi chat laterale',
    },


    settingsAccount: {
        // Account settings screen
        accountInformation: 'Informazioni account',
        status: 'Stato',
        statusActive: 'Attivo',
        statusNotAuthenticated: 'Non autenticato',
        anonymousId: 'ID anonimo',
        publicId: 'ID pubblico',
        notAvailable: 'Non disponibile',
        linkNewDevice: 'Collega nuovo dispositivo',
        linkNewDeviceSubtitle: 'Scansiona il codice QR per collegare il dispositivo',
        backup: 'Backup',
        backupDescription: 'La tua chiave segreta è l\'unico modo per recuperare l\'account. Salvala in un posto sicuro come un gestore di password.',
        secretKey: 'Chiave segreta',
        tapToReveal: 'Tocca per mostrare',
        tapToHide: 'Tocca per nascondere',
        secretKeyLabel: 'CHIAVE SEGRETA (TOCCA PER COPIARE)',
        secretKeyCopied: 'Chiave segreta copiata negli appunti. Conservala in un luogo sicuro!',
        secretKeyCopyFailed: 'Impossibile copiare la chiave segreta',
        dangerZone: 'Zona pericolosa',
        logout: 'Esci',
        logoutSubtitle: 'Disconnetti e cancella i dati locali',
        logoutConfirm: 'Sei sicuro di voler uscire? Assicurati di aver fatto il backup della tua chiave segreta!',
    },

    settingsLanguage: {
        // Language settings screen
        title: 'Lingua',
        description: 'Scegli la tua lingua preferita per l\'interfaccia dell\'app. Questo si sincronizza su tutti i tuoi dispositivi.',
        currentLanguage: 'Lingua attuale',
        automatic: 'Automatico',
        automaticSubtitle: 'Rileva dalle impostazioni del dispositivo',
        needsRestart: 'Lingua cambiata',
        needsRestartMessage: 'L\'app deve riavviarsi per applicare la nuova impostazione della lingua.',
    },


    updateBanner: {
        updateAvailable: 'Aggiornamento disponibile',
        pressToApply: 'Premi per applicare l\'aggiornamento',
        whatsNew: 'Novità',
        seeLatest: 'Vedi gli ultimi aggiornamenti e miglioramenti',
        nativeUpdateAvailable: 'Aggiornamento app disponibile',
        tapToUpdateAppStore: 'Tocca per aggiornare nell\'App Store',
        tapToUpdatePlayStore: 'Tocca per aggiornare nel Play Store',
    },

    changelog: {
        // Used by the changelog screen
        noEntriesAvailable: 'Nessuna voce di changelog disponibile.',
    },

    terminal: {
        // Used by terminal connection screens
        webBrowserRequired: 'Browser web richiesto',
        webBrowserRequiredDescription: 'I link di connessione del terminale possono essere aperti solo in un browser web per motivi di sicurezza. Usa lo scanner QR o apri questo link su un computer.',
        processingConnection: 'Elaborazione connessione...',
        invalidConnectionLink: 'Link di connessione non valido',
        invalidConnectionLinkDescription: 'Il link di connessione è mancante o non valido. Controlla l\'URL e riprova.',
        connectTerminal: 'Connetti terminale',
        terminalRequestDescription: 'Un terminale richiede di connettersi al tuo account muxr. Questo consentirà al terminale di inviare e ricevere messaggi in modo sicuro.',
        connectionDetails: 'Dettagli connessione',
        publicKey: 'Chiave pubblica',
        encryption: 'Cifratura',
        endToEndEncrypted: 'Crittografia end-to-end',
        acceptConnection: 'Accetta connessione',
        connecting: 'Connessione...',
        reject: 'Rifiuta',
        security: 'Sicurezza',
        securityFooter: 'Questo link di connessione è stato elaborato in modo sicuro nel tuo browser e non è mai stato inviato a nessun server. I tuoi dati privati rimarranno sicuri e solo tu potrai decifrare i messaggi.',
        securityFooterDevice: 'Questa connessione è stata elaborata in modo sicuro sul tuo dispositivo e non è mai stata inviata a nessun server. I tuoi dati privati rimarranno sicuri e solo tu potrai decifrare i messaggi.',
        clientSideProcessing: 'Elaborazione lato client',
        linkProcessedLocally: 'Link elaborato localmente nel browser',
        linkProcessedOnDevice: 'Link elaborato localmente sul dispositivo',
    },

    modals: {
        // Used across connect flows and settings
        deviceLinkedSuccessfully: 'Dispositivo collegato con successo',
        invalidAuthUrl: 'URL di autenticazione non valido',
        developerMode: 'Modalità sviluppatore',
        developerModeEnabled: 'Modalità sviluppatore attivata',
        developerModeDisabled: 'Modalità sviluppatore disattivata',
        failedToLinkDevice: 'Impossibile collegare il dispositivo',
        cameraPermissionsRequiredToScanQr: 'Sono necessarie le autorizzazioni della fotocamera per scansionare i codici QR'
    },

    navigation: {
        // Navigation titles and screen headers
        connectTerminal: 'Connetti terminale',
        linkNewDevice: 'Collega nuovo dispositivo', 
        restoreWithSecretKey: 'Ripristina con chiave segreta',
        browserPreview: 'Anteprima del browser',
        whatsNew: 'Novità',
        friends: 'Amici',
    },

    welcome: {
        // Main welcome screen for unauthenticated users
        title: 'Client mobile di Pi',
        subtitle: 'Crittografia end-to-end e account memorizzato solo sul tuo dispositivo.',
        createAccount: 'Crea account',
        linkOrRestoreAccount: 'Collega o ripristina account',
        loginWithMobileApp: 'Accedi con l\'app mobile',
    },

    review: {
        // Used by utils/requestReview.ts
        enjoyingApp: 'Ti piace l\'app?',
        feedbackPrompt: 'Ci piacerebbe ricevere il tuo feedback!',
        yesILoveIt: 'Sì, mi piace!',
        notReally: 'Non proprio'
    },

    items: {
        // Used by Item component for copy toast
        copiedToClipboard: ({ label }: { label: string }) => `${label} copiato negli appunti`
    },

    machine: {
        launchNewSessionInDirectory: 'Avvia nuova sessione nella directory',
        offlineUnableToSpawn: 'Avvio disabilitato quando la macchina è offline',
        daemon: 'Daemon',
        status: 'Stato',
        stopDaemon: 'Arresta daemon',
        lastKnownPid: 'Ultimo PID noto',
        lastKnownHttpPort: 'Ultima porta HTTP nota',
        startedAt: 'Avviato alle',
        cliVersion: 'Versione CLI',
        daemonStateVersion: 'Versione stato daemon',
        stopDaemonConfirmTitle: 'Arrestare il daemon?',
        stopDaemonConfirmMessage: 'Non potrai avviare nuove sessioni su questa macchina finché non riavvii il daemon sul tuo computer. Le sessioni correnti rimarranno attive.',
        daemonStopped: 'Daemon arrestato',
        stopDaemonFailed: 'Impossibile arrestare il daemon. Potrebbe non essere in esecuzione.',
        machineGroup: 'Macchina',
        host: 'Host',
        machineId: 'ID macchina',
        username: 'Nome utente',
        homeDirectory: 'Directory home',
        platform: 'Piattaforma',
        architecture: 'Architettura',
        lastSeen: 'Ultimo accesso',
        never: 'Mai',
        metadataVersion: 'Versione metadati',
        cliAvailability: 'Disponibilità CLI',
        cliInstalled: 'Installato',
        cliNotFound: 'Non trovato',
        lastDetected: 'Ultimo rilevamento',
        back: 'Indietro',
        dangerZone: 'Zona di pericolo',
        delete: 'Elimina macchina',
        deleteFooter: 'Rimuove questa macchina dal tuo account. La cronologia delle sessioni viene mantenuta, ma non potrai più avviare nuove sessioni su di essa.',
        deleteConfirmTitle: 'Eliminare questa macchina?',
        deleteConfirmMessage: 'La macchina verrà rimossa dal tuo account. La cronologia delle sessioni viene mantenuta, ma non potrai avviare nuove sessioni finché non riconnetti il daemon.',
        deleteFailed: 'Impossibile eliminare la macchina.',
    },

    message: {
        switchedToMode: ({ mode }: { mode: string }) => `Passato alla modalità ${mode}`,
        unknownEvent: 'Evento sconosciuto',
        usageLimitUntil: ({ time }: { time: string }) => `Limite di utilizzo raggiunto fino a ${time}`,
        sentAsGoal: 'Sent as goal',
        unknownTime: 'ora sconosciuta',
    },

    codex: {
        // Pi permission dialog buttons
        permissions: {
            yesForSession: 'Sì, e non chiedere per una sessione',
            stopAndExplain: 'Fermati e spiega cosa devo fare',
        }
    },

    claude: {
        // Pi permission dialog buttons
        permissions: {
            yesAllowAllEdits: 'Sì, consenti tutte le modifiche durante questa sessione',
            yesAllowEverything: 'Sì, consenti tutto durante questa sessione',
            yesForTool: 'Sì, non chiedere più per questo strumento',
            noTellClaude: 'No, fornisci feedback',
        }
    },

    textSelection: {
        // Text selection screen
        title: 'Seleziona testo',
        noTextProvided: 'Nessun testo fornito',
        textNotFound: 'Testo non trovato o scaduto',
        textCopied: 'Testo copiato negli appunti',
        failedToCopy: 'Impossibile copiare il testo negli appunti',
        noTextToCopy: 'Nessun testo disponibile da copiare',
    },

    markdown: {
        // Markdown copy functionality
        codeCopied: 'Codice copiato',
        copyFailed: 'Copia non riuscita',
        mermaidRenderFailed: 'Impossibile renderizzare il diagramma mermaid',
    },

    artifacts: {
        // Artifacts feature
        title: 'Artefatti',
        empty: 'Nessun artefatto',
        emptyDescription: 'Crea il tuo primo artefatto per iniziare',
        new: 'Nuovo artefatto',
        edit: 'Modifica artefatto',
        delete: 'Elimina',
        updateError: 'Impossibile aggiornare l\'artefatto. Riprova.',
        notFound: 'Artefatto non trovato',
        deleteConfirm: 'Eliminare artefatto?',
        deleteConfirmDescription: 'Questa azione non può essere annullata',
        titleLabel: 'TITOLO',
        titlePlaceholder: 'Inserisci un titolo per il tuo artefatto',
        bodyLabel: 'CONTENUTO',
        bodyPlaceholder: 'Scrivi il tuo contenuto qui...',
        emptyFieldsError: 'Inserisci un titolo o un contenuto',
        createError: 'Impossibile creare l\'artefatto. Riprova.',
        loading: 'Caricamento artefatti...',
        error: 'Impossibile caricare l\'artefatto',
    },

    friends: {
        // Friends feature
        manageFriends: 'Gestisci i tuoi amici e le connessioni',
        pendingRequests: 'Richieste di amicizia',
        myFriends: 'I miei amici',
        noFriendsYet: 'Non hai ancora amici',
        remove: 'Rimuovi',
        addFriend: 'Aggiungi amico',
        alreadyFriends: 'Già amici',
        requestPending: 'Richiesta in sospeso',
        searchInstructions: 'Inserisci un nome utente per cercare amici',
        searchPlaceholder: 'Inserisci nome utente...',
        searching: 'Ricerca...',
        noUserFound: 'Nessun utente trovato con quel nome',
        checkUsername: 'Controlla il nome utente e riprova',
        howToFind: 'Come trovare amici',
        findInstructions: 'Cerca amici tramite il loro nome utente. Sia tu che il tuo amico dovete avere GitHub collegato per inviare richieste di amicizia.',
        requestSent: 'Richiesta di amicizia inviata!',
        confirmRemove: 'Rimuovi amico',
        confirmRemoveMessage: 'Sei sicuro di voler rimuovere questo amico?',
        cannotAddYourself: 'Non puoi inviare una richiesta di amicizia a te stesso',
        bothMustHaveGithub: 'Entrambi gli utenti devono avere GitHub collegato per diventare amici',
        status: {
            none: 'Non connesso',
            requested: 'Richiesta inviata',
            pending: 'Richiesta in sospeso',
            friend: 'Amici',
            rejected: 'Rifiutata',
        },
        acceptRequest: 'Accetta richiesta',
        removeFriend: 'Rimuovi amico',
        removeFriendConfirm: ({ name }: { name: string }) => `Sei sicuro di voler rimuovere ${name} dagli amici?`,
        requestFriendship: 'Richiedi amicizia',
        cancelRequest: 'Annulla richiesta di amicizia',
        cancelRequestConfirm: ({ name }: { name: string }) => `Annullare la tua richiesta di amicizia a ${name}?`,
        denyRequest: 'Rifiuta richiesta',
    },

    usage: {
        // Usage panel strings
        today: 'Oggi',
        last7Days: 'Ultimi 7 giorni',
        last30Days: 'Ultimi 30 giorni',
        totalTokens: 'Token totali',
        totalCost: 'Costo totale',
        tokens: 'Token',
        cost: 'Costo',
        usageOverTime: 'Utilizzo nel tempo',
        byModel: 'Per modello',
    },

    imageUpload: {
        permissionTitle: 'Accesso alla libreria foto',
        permissionMessage: "Consenti l'accesso alla tua libreria foto per allegare immagini ai messaggi.",
        limitTitle: 'Limite immagini raggiunto',
        limitMessage: ({ max }: { max: number }) => `Puoi allegare fino a ${max} immagini per messaggio.`,
        fileTooLargeTitle: 'File troppo grande',
        fileTooLargeMessage: ({ name, maxMb }: { name: string; maxMb: number }) => `"${name}" supera il limite di ${maxMb}MB e non è stato aggiunto.`,
        uploadFailedTitle: 'Caricamento non riuscito',
        uploadFailedMessage: ({ count }: { count: number }) => count === 1
            ? 'Un\'immagine non è stata caricata e non è stata inviata.'
            : `Non è stato possibile caricare ${count} immagini e non sono state inviate.`,
        notSupportedTitle: 'Immagini non supportate',
        notSupportedMessage: 'Questo agente non supporta gli allegati immagine. Le immagini non sono state inviate.',
    },

    feed: {
        // Feed notifications for friend requests and acceptances
    }
} as const;

export type TranslationsIt = typeof it;
