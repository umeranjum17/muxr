import type { TranslationStructure } from '../_default';

/**
 * Catalan plural helper function
 * Catalan has 2 plural forms: singular, plural
 * @param options - Object containing count, singular, and plural forms
 * @returns The appropriate form based on Catalan plural rules
 */
function plural({ count, singular, plural }: { count: number; singular: string; plural: string }): string {
    return count === 1 ? singular : plural;
}

/**
 * Catalan translations for the muxr app
 * Must match the exact structure of the English translations
 */
export const ca: TranslationStructure = {
    tabs: {
        // Tab navigation labels
        sessions: 'Terminals',
        settings: 'Configuració',
    },

    inbox: {
        // Inbox screen: the sessions currently waiting on you
        reason: {
            waiting: 'esperant',
            blocked: 'bloquejat',
            failed: 'ha fallat',
            done: 'fet',
        },
    },

    plugins: {
        openFromHome: 'Obre un connector des de l’Inici.',
        unavailable: 'Aquest connector està desactivat o no està disponible.',
        goBack: 'Torna',
        couldNotLoad: 'No s’han pogut carregar els elements',
        dataUnavailable: 'El connector no està disponible ara mateix.',
        nothingHere: 'No hi ha res aquí',
        newItems: 'Els elements nous apareixeran aquí.',
        retry: 'Torna-ho a provar',
        retryItems: 'Torna a carregar els elements del connector',
        stale: 'No s’ha pogut actualitzar. Es mostra l’últim resultat.',
        nothingToShow: 'No hi ha res per mostrar.',
        treeUnavailable: 'L’arbre no està disponible.',
        dictate: 'Dicta',
        unavailableSuffix: 'no disponible',
        showingStale: 'mostrant dades anteriors',
        settingsTitle: 'Connectors',
        enableAll: 'Activa’ls tots',
        disableAll: 'Desactiva’ls tots',
        installed: 'Instal·lats',
        herdrAndMuxr: 'Herdr + muxr',
        herdrAndMuxrFooter: 'Herdr executa accions, plafons o esdeveniments per a aquests, i afegeixen UI de muxr.',
        muxrOnly: 'Només muxr',
        muxrOnlyFooter: 'Herdr només els registra; tot el que fan passa per muxr.',
        herdrOnly: 'Només Herdr',
        herdrOnlyFooter: 'Paquets de rerefons sense UI de muxr. Gestiona’ls amb la CLI de herdr.',
        waitingHost: 'Esperant l’amfitrió.',
        linkHost: 'Enllaça un connector amb Herdr i torna a connectar.',
        enabled: 'activats',
        off: 'desact.',
        on: 'act.',
        unavailableLabel: 'No disponible',
        runsCode: 'Executa codi com tu',
        uiOnly: 'Només interfície',
        readsSessions: 'Llegeix resums de sessions',
        readsTree: 'Llegeix l’arbre de l’espai de treball',
        openFailed: 'No s’ha pogut obrir',
        actionFailed: 'L’acció ha fallat',
        items: 'Elements',
        openWebsite: 'Vols obrir el lloc web?',
        open: 'Obre',
        realtimeConnecting: 'Connectant la sessió de veu',
        realtimeListening: 'Escoltant',
        realtimeThinking: 'Pensant',
        realtimeSpeaking: 'Parlant',
        realtimeError: 'Error de la sessió de veu',
        realtimeOff: 'Sessió de veu desactivada',
        openConversation: 'Obre la conversa de veu',
        realtime: 'Veu',
    },

    common: {
        // Simple string constants
        cancel: 'Cancel·la',
        save: 'Desa',
        error: 'Error',
        success: 'Èxit',
        ok: 'D\'acord',
        back: 'Enrere',
        create: 'Crear',
        rename: 'Reanomena',
        logout: 'Tanca la sessió',
        yes: 'Sí',
        no: 'No',
        version: 'Versió',
        copied: 'Copiat',
        copy: 'Copiar',
        scanning: 'Escanejant...',
        home: 'Inici',
        message: 'Missatge',
        files: 'Fitxers',
        fileViewer: 'Visualitzador de fitxers',
        loading: 'Carregant...',
        delete: 'Elimina',
    },

    profile: {
        details: 'Detalls',
        firstName: 'Nom',
        lastName: 'Cognoms',
        username: 'Nom d\'usuari',
        status: 'Estat',
    },


    status: {
        connected: 'connectat',
        connecting: 'connectant',
        disconnected: 'desconnectat',
        error: 'error',
        pairingIssue: 'problema d\'aparellament',
        online: 'en línia',
        offline: 'fora de línia',
        lastSeen: ({ time }: { time: string }) => `vist per última vegada ${time}`,
        permissionRequired: 'permís requerit',
        activeNow: 'Actiu ara',
        unknown: 'desconegut',
        unread: 'nous resultats',
    },

    time: {
        justNow: 'ara mateix',
        minutesAgo: ({ count }: { count: number }) => `fa ${count} minut${count !== 1 ? 's' : ''}`,
        hoursAgo: ({ count }: { count: number }) => `fa ${count} hora${count !== 1 ? 'es' : ''}`,
        daysAgo: ({ count }: { count: number }) => `fa ${count} dia${count !== 1 ? 's' : ''}`,
    },

    connect: {
        restoreAccount: 'Restaura el compte',
        enterSecretKey: 'Introdueix la teva clau secreta',
        invalidSecretKey: 'Clau secreta no vàlida. Comprova-ho i torna-ho a provar.',
        qrInstructions: '1. Obre muxr al teu dispositiu mòbil\n2. Vés a Configuració → Compte\n3. Toca "Enllaça un nou dispositiu"\n4. Escaneja aquest codi QR',
        restoreWithSecretKeyInstead: 'O restaura amb la clau secreta',
    },

    settings: {
        title: 'Configuració',
        github: 'GitHub',
        machines: 'Màquines',
        showOfflineMachines: ({ count }: { count: number }) => count === 1 ? 'Mostra 1 màquina fora de línia' : `Mostra ${count} màquines fora de línia`,
        hideOfflineMachines: 'Amaga màquines fora de línia',
        features: 'Funcions',
        social: 'Social',
        account: 'Compte',
        accountSubtitle: 'Gestiona els detalls del teu compte',
        appearance: 'Aparença',
        appearanceSubtitle: 'Personalitza l\'aspecte de l\'aplicació',
        featuresTitle: 'Funcions',
        featuresSubtitle: 'Activa o desactiva les funcions de l\'aplicació',
        about: 'Quant a',
        aboutFooter: 'muxr és un client mòbil de Pi. El xifratge punt a punt és opcional i està desactivat per defecte; el teu compte es guarda només al teu dispositiu. No està afiliat amb Anthropic.',
        whatsNew: 'Novetats',
        whatsNewSubtitle: 'Mira les últimes actualitzacions i millores',
        reportIssue: 'Informa d\'un problema',
        eula: 'EULA',
        connection: 'Connexió',
        connectionSubtitle: 'URL del relay, màquina i token',
        pushNotifications: 'Notificacions push',
        pushSubtitleSubscribed: 'Activades — reps un avís quan un agent necessita una resposta',
        pushSubtitleDenied: 'Blocades pel navegador — permet les notificacions per activar-les',
        pushSubtitleUnsupported: 'No disponible en aquest navegador',
        pushSubtitleDefault: 'Toca per rebre un avís quan un agent necessiti una resposta',
        license: 'Llicència i avisos',
        // Dynamic settings messages
    },

    settingsAppearance: {
        // Appearance settings screen
        theme: 'Tema',
        themeDescription: 'Tria el teu esquema de colors preferit',
        themeOptions: {
            adaptive: 'Adaptatiu',
            light: 'Clar', 
            dark: 'Fosc',
        },
        themeDescriptions: {
            adaptive: 'Segueix la configuració del sistema',
            light: 'Usa sempre el tema clar',
            dark: 'Usa sempre el tema fosc',
        },
        display: 'Pantalla',
        displayDescription: 'Controla la disposició i l\'espaiat',

        avatarStyle: 'Estil d\'avatar',
        avatarStyleDescription: 'Tria l\'aparença de l\'avatar de la sessió',
        avatarOptions: {
            pixelated: 'Pixelat',
            gradient: 'Gradient',
            brutalist: 'Brutalista',
        },
        showFlavorIcons: "Mostrar icones de proveïdors d'IA",
        showFlavorIconsDescription: "Mostrar icones del proveïdor d'IA als avatars de sessió",
    },

    settingsFeatures: {
        // Features settings screen
        experiments: 'Experiments',
        experimentsDescription: 'Activa funcions experimentals que encara estan en desenvolupament. Aquestes funcions poden ser inestables o canviar sense avís.',
        webFeatures: 'Funcions web',
        webFeaturesDescription: 'Funcions disponibles només a la versió web de l\'app.',
        commandPalette: 'Paleta de comandes',
        commandPaletteEnabled: 'Prem ⌘K per obrir',
        commandPaletteDisabled: 'Accés ràpid a comandes desactivat',
        markdownCopyV2: 'Markdown Copy v2',
        markdownCopyV2Subtitle: 'Pulsació llarga obre modal de còpia',
        hideInactiveSessions: 'Amaga les sessions inactives',
        hideInactiveSessionsSubtitle: 'Mostra només els xats actius a la llista',
        imageUpload: 'Pujada d\'imatges',
        imageUploadSubtitle: 'Adjunta imatges als missatges perquè els agents compatibles les analitzin',
    },

    errors: {
        authenticationFailed: 'L\'autenticació ha fallat',
        failedToLoadProfile: 'No s\'ha pogut carregar el perfil d\'usuari',
        userNotFound: 'Usuari no trobat',
        sessionDeleted: 'La sessió s\'ha eliminat',
        sessionDeletedDescription: 'Aquesta sessió s\'ha eliminat permanentment',

        // Error functions with context
        failedToSendRequest: 'No s\'ha pogut enviar la sol·licitud d\'amistat',
    },

    newSession: {
        title: 'Iniciar nova sessió',
        machineOffline: 'La màquina està fora de línia',
        switchMachinesHint: '• Canvia de màquina fent clic a la màquina de dalt',
    },

    settingsConnection: {
        // Connection settings screen (relay URL, machine, token)
        status: ({ status }: { status: string }) => `Estat: ${status}`,
    },

    optionSheet: {
        // Model/mode picker bottom sheet
        all: 'totes',
        searchPlaceholder: ({ count }: { count: number }) => `Cerca ${count}`,
        useCustom: ({ value }: { value: string }) => `fes servir ${value}`,
        noResults: 'sense resultats',
    },

    homeDock: {
        // Home screen composer
        inputPlaceholder: 'Planifica, pregunta, construeix…',
        runCommandPlaceholder: 'Executa una ordre',
        askPlaceholder: ({ name }: { name: string }) => `Pregunta a ${name}`,
    },

    liveTerminals: {
        // Live terminals strip on the home screen
        title: 'EN DIRECTE',
    },

    emptySessions: {
        // Empty state shown on tablets when no sessions are active
        noActiveSessions: 'No hi ha sessions actives',
        startDescription: 'Inicia una nova sessió en qualsevol de les teves màquines connectades.',
        noMachinesDescription: 'Obre un nou terminal al teu ordinador per iniciar una sessió.',
    },

    sessionHistory: {
        // Used by session history screen
        title: 'Historial de sessions',
        empty: 'No s\'han trobat sessions',
        today: 'Avui',
        yesterday: 'Ahir',
        daysAgo: ({ count }: { count: number }) => `fa ${count} ${count === 1 ? 'dia' : 'dies'}`,
    },

    session: {
        inputPlaceholder: 'Escriu un missatge...',
        inactiveArchived: 'Aquesta sessió està inactiva.',
        resumeFromTerminal: 'Per reprendre-la des del terminal:',
        newChat: 'Nou xat',
        forkAction: 'Bifurca la sessió',
        forkSubtitle: 'Continua en una nova sessió amb el mateix context',
        duplicateAction: 'Duplica des d\'un missatge…',
        duplicateSubtitle: 'Torna a un punt escollit i prova de nou',
        duplicateSheetTitle: 'Tria un punt de retrocés',
        duplicateSheetSubtitle: 'La nova sessió conservarà el torn escollit complet (el teu missatge i la resposta de l\'agent) i descartarà els missatges següents.',
        duplicateSheetConfirm: 'Duplica',
        duplicateSheetEmpty: 'Encara no hi ha missatges per retrocedir en aquesta sessió.',
        duplicateRowDisabled: 'Aquest missatge no es pot usar com a punt de retrocés.',
        forkedFromLabel: 'Bifurcat de',
        forkedFromSubtitle: 'Obre la sessió de la qual prové la bifurcació',
        forkErrorMissingMetadata: 'Falten metadades de la sessió necessàries per bifurcar.',
        forkErrorGeneric: 'No s\'ha pogut bifurcar la sessió.',
    },

    commandPalette: {
        placeholder: 'Escriu una comanda o cerca...',
    },


    sessionInfo: {
        // Used by Session Info screen (app/(app)/session/[id]/info.tsx)
        archiveSession: 'Arxiva la sessió',
        muxrSessionIdCopied: 'ID de la sessió de muxr copiat al porta-retalls',
        failedToCopySessionId: 'Ha fallat copiar l\'ID de la sessió de muxr',
        muxrSessionId: 'ID de la sessió de muxr',
        claudeCodeSessionId: 'ID de la sessió de Pi',
        claudeCodeSessionIdCopied: 'ID de la sessió de Pi copiat al porta-retalls',
        codexThreadId: 'ID del fil de Pi',
        codexThreadIdCopied: 'ID del fil de Pi copiat al porta-retalls',
        aiProvider: 'Proveïdor d\'IA',
        failedToCopyClaudeCodeSessionId: 'Ha fallat copiar l\'ID de la sessió de Pi',
        failedToCopyCodexThreadId: 'Ha fallat copiar l\'ID del fil de Pi',
        metadataCopied: 'Metadades copiades al porta-retalls',
        failedToCopyMetadata: 'Ha fallat copiar les metadades',
        failedToArchiveSession: 'Ha fallat arxivar la sessió',
        connectionStatus: 'Estat de la connexió',
        created: 'Creat',
        lastUpdated: 'Última actualització',
        sequence: 'Seqüència',
        quickActions: 'Accions ràpides',
        viewMachine: 'Veure la màquina',
        viewMachineSubtitle: 'Veure detalls de la màquina i sessions',
        resumeSession: 'Resume Session',
        resumeSessionSubtitle: 'Resume this session on the same machine',
        resumeSessionSameMachineOnly: 'This session can only be resumed on the same machine it started on.',
        resumeSessionMachineOffline: 'This machine is offline. Resume is only available while it is online.',
        resumeSessionMissingMachine: 'This session is missing its machine metadata, so it cannot be resumed.',
        resumeSessionMissingBackendId: 'This session does not have a resumable Pi identifier.',
        resumeSessionUnexpectedDirectoryPrompt: 'Resume cannot create directories. Start the session manually from its original path.',
        archiveSessionSubtitle: 'Arxiva aquesta sessió i atura-la',
        metadata: 'Metadades',
        host: 'Host',
        path: 'Camí',
        operatingSystem: 'Sistema operatiu',
        processId: 'ID del procés',
        muxrHome: 'Directori de muxr',
        copyMetadata: 'Copia les metadades',
        agentState: 'Estat de l\'agent',
        controlledByUser: 'Controlat per l\'usuari',
        pendingRequests: 'Sol·licituds pendents',
        activity: 'Activitat',
        thinking: 'Pensant',
        thinkingSince: 'Pensant des de',
        cliVersion: 'Versió del CLI',
        deleteSession: 'Elimina la sessió',
        deleteSessionSubtitle: 'Elimina permanentment aquesta sessió',
        deleteSessionWarning: 'Aquesta acció no es pot desfer. Tots els missatges i dades associats amb aquesta sessió s\'eliminaran permanentment.',
        failedToDeleteSession: 'Error en eliminar la sessió',
        worktreeCleanupTitle: 'Eliminar Worktree?',
        worktreeCleanupMessage: 'El Worktree no té canvis sense confirmar. Vols eliminar els fitxers del Worktree?',
        worktreeCleanupDelete: 'Eliminar Worktree',
        worktreeCleanupKeep: 'Conservar fitxers',
        landWorktree: 'Land Worktree',
        landWorktreeSubtitle: 'Squash this worktree onto the base branch and remove it',
        landWorktreeMessage: 'Commit message for the squashed change',
        landWorktreeFailed: 'Failed to land worktree',
        landWorktreeDone: 'Landed on the base branch. The worktree is gone.',

    },

    archive: {
        select: 'Selecciona',
        selectAll: 'Selecciona-ho tot',
        deselectAll: 'Desselecciona-ho tot',
        archiveCount: ({ count }: { count: number }) => plural({ count, singular: 'Arxiva 1 sessió', plural: `Arxiva ${count} sessions` }),
        unarchiveCount: ({ count }: { count: number }) => plural({ count, singular: 'Desa 1 sessió', plural: `Desa ${count} sessions` }),
        selectedCount: ({ count }: { count: number }) => `${count} seleccionades`,
        archivedCount: ({ count }: { count: number }) => plural({ count, singular: '1 sessió arxivada', plural: `${count} sessions arxivades` }),
        undo: 'Desfés',
    },

    components: {
        sessionStatusBar: {
            contextUsage: ({ used, total, percent }: { used: string; total: string; percent: number }) => `Context ${used} de ${total} tokens, ${percent}%`,
            limitFiveHour: 'Límit de 5 hores',
            limitSevenDay: 'Límit de 7 dies',
            limitResets: ({ time }: { time: string }) => `es restableix ${time}`,
            limitAsOf: ({ age }: { age: string }) => `fa ${age}`,
            limitRemaining: ({ percent }: { percent: number }) => `${percent}% restant`,
        },
    },

    agentInput: {
        permissionMode: {
            title: 'MODE DE PERMISOS',
            default: 'Per defecte',
            acceptEdits: 'Accepta edicions',
            plan: 'Mode de planificació',
            dontAsk: 'No preguntis',
            bypassPermissions: 'Mode Yolo',
        },
        agent: {
            pi: 'Pi',
        },
        model: {
            title: 'MODEL',
            configureInCli: 'Configura els models a la configuració del CLI',
        },
        effort: {
            title: 'ESFORÇ',
        },
        codexPermissionMode: {
            title: 'MODE DE PERMISOS PI',
            default: 'Configuració del CLI',
            readOnly: 'Read Only Mode',
            safeYolo: 'Safe YOLO',
            yolo: 'YOLO',
            defaultDescription: "pregunta abans d'ordres no fiables",
            readOnlyDescription: 'sense escriptura',
            safeYoloDescription: "sense preguntes, sandbox de l'espai de treball",
            yoloDescription: 'sense preguntes, accés complet',
        },

        geminiPermissionMode: {
            title: 'MODE DE PERMISOS PI',
            default: 'Per defecte',
            autoEdit: 'Edició automàtica',
            yolo: 'YOLO',
            plan: 'Planificació',
        },
        context: {
            remaining: ({ percent }: { percent: number }) => `${percent}% restant`,
        },
        suggestion: {
            fileLabel: 'FITXER',
            folderLabel: 'CARPETA',
        },
        noMachinesAvailable: 'Sense màquines',
    },

    machineLauncher: {
        showLess: 'Mostra menys',
        showAll: ({ count }: { count: number }) => `Mostra tots (${count} camins)`,
        enterCustomPath: 'Introdueix un camí personalitzat',
    },

    sidebar: {
        sessionsTitle: 'muxr',
        showArchived: 'Mostra arxivades',
        hideArchived: 'Amaga arxivades',
        newSession: 'Nova sessió',
    },

    zen: {
        toggle: 'Mode zen',
    },

    toolView: {
        input: 'Entrada',
        output: 'Sortida',
    },

    thinking: {
        active: 'Thinking…',
        thought: 'Thought',
        thoughtFor: ({ duration }: { duration: string }) => `Thought for ${duration}`,
    },

    sessionAttachments: {
        title: ({ count }: { count: number }) => count === 1 ? '1 adjunt' : `${count} adjunts`,
    },

    turnChanges: {
        filesChanged: ({ count }: { count: number }) => count === 1 ? 'S\'ha modificat 1 fitxer' : `S'han modificat ${count} fitxers`,
    },

    tools: {
        fullView: {
            description: 'Descripció',
            inputParams: 'Paràmetres d\'entrada',
            output: 'Sortida',
            error: 'Error',
            completed: 'Eina completada amb èxit',
            noOutput: 'No s\'ha produït cap sortida',
            rawJsonDevMode: 'JSON en brut (mode desenvolupador)',
        },


        names: {
            search: 'Cerca',
        },

        desc: {
        }
    },

    files: {
        changes: 'Canvis',
        searchPlaceholder: 'Cerca fitxers...',
        detachedHead: 'HEAD separat',
        summary: ({ staged, unstaged }: { staged: number; unstaged: number }) => `${staged} preparats • ${unstaged} sense preparar`,
        notRepo: 'No és un repositori git',
        notUnderGit: 'Aquest directori no està sota control de versions git',
        searching: 'Cercant fitxers...',
        noFilesFound: 'No s\'han trobat fitxers',
        noFilesInProject: 'No hi ha fitxers al projecte',
        tryDifferentTerm: 'Prova un terme de cerca diferent',
        searchResults: ({ count }: { count: number }) => `Resultats de la cerca (${count})`,
        projectRoot: 'Arrel del projecte',
        stagedChanges: ({ count }: { count: number }) => `Canvis preparats (${count})`,
        unstagedChanges: ({ count }: { count: number }) => `Canvis sense preparar (${count})`,
        // File viewer strings
        loadingFile: ({ fileName }: { fileName: string }) => `Carregant ${fileName}...`,
        binaryFile: 'Fitxer binari',
        cannotDisplayBinary: 'No es pot mostrar el contingut del fitxer binari',
        diff: 'Diferències',
        file: 'Fitxer',
        fileEmpty: 'El fitxer està buit',
        fileDeleted: 'Aquest fitxer ja no existeix',
        previousDocument: 'Document anterior',
        nextDocument: 'Document següent',
        previousChange: 'Canvi anterior',
        nextChange: 'Canvi següent',
        toggleFileAndDiff: 'Commuta fitxer i diferències',
        wrapLines: 'Ajusta les línies llargues',
        previousFile: 'Fitxer anterior',
        nextFile: 'Fitxer següent',
        previousFileNamed: ({ title, ordinal, total }: { title: string; ordinal: number; total: number }) => `Fitxer anterior, ${title}, ${ordinal} de ${total}`,
        nextFileNamed: ({ title, ordinal, total }: { title: string; ordinal: number; total: number }) => `Fitxer següent, ${title}, ${ordinal} de ${total}`,
        filePosition: ({ current, total }: { current: number; total: number }) => `Fitxer ${current} de ${total}`,
        diffUnavailable: 'Diferències, no disponibles, no hi ha canvis per a aquest fitxer',
        previousChangeAt: ({ current, total }: { current: number; total: number }) => `Canvi anterior, ${current} de ${total}`,
        nextChangeAt: ({ current, total }: { current: number; total: number }) => `Canvi següent, ${current} de ${total}`,
        graphicsUnavailable: 'Gràfics no disponibles',
        showFullPath: 'Mostra el camí complet',
        pathShowFullPath: ({ label }: { label: string }) => `Camí ${label}, mostra el camí complet`,
        goToPath: ({ label }: { label: string }) => `Ves a ${label}`,
        fullPath: 'Camí complet',
        noChanges: 'No hi ha canvis a mostrar',
        noChangesTitle: 'Sense canvis',
        noChangesSubtitle: 'L\'arbre de treball està net',
        deleted: 'Eliminat',
        changedFiles: ({ count }: { count: number }) => `${count} ${count === 1 ? 'fitxer modificat' : 'fitxers modificats'}`,
        allFiles: 'Tots els fitxers',
        addPanel: 'Afegeix un panell',
        closePanel: 'Tanca el panell',
        editFile: 'Editar',
        saveFile: 'Desar',
        failedToRead: 'No s\'ha pogut llegir el fitxer',
        failedToSave: 'No s\'ha pogut desar el fitxer',
        fileConflict: 'Conflicte de fitxer',
        fileConflictDescription: 'Aquest fitxer s\'ha modificat al dispositiu mentre l\'editaves. Recarrega per veure la darrera versió.',
        reload: 'Recarregar',
        overwrite: 'Sobreescriure',
    },
    sideChat: {
        panelTitle: 'Xat lateral',
        emptyTitle: 'Inicia un xat lateral',
        emptySubtitle: 'Pregunta alguna cosa a l’agent a part. Hereta el context d’aquest xat però es manté aïllat — res d’aquí no afecta la conversa principal.',
        startButton: 'Inicia el xat lateral',
        creating: 'Iniciant el xat lateral…',
        unavailable: 'Aquesta sessió encara no pot iniciar un xat lateral — espera que l’agent estigui en línia.',
        expand: 'Obre a pantalla completa',
        tabLabel: ({ index }: { index: number }) => `Xat lateral ${index}`,
        newChat: 'Nou xat lateral',
        close: 'Tanca el xat lateral',
    },


    settingsAccount: {
        // Account settings screen
        accountInformation: 'Informació del compte',
        status: 'Estat',
        statusActive: 'Actiu',
        statusNotAuthenticated: 'No autenticat',
        anonymousId: 'ID anònim',
        publicId: 'ID públic',
        notAvailable: 'No disponible',
        linkNewDevice: 'Enllaça un nou dispositiu',
        linkNewDeviceSubtitle: 'Escaneja el codi QR per enllaçar el dispositiu',
        backup: 'Còpia de seguretat',
        backupDescription: 'La teva clau secreta és l\'única manera de recuperar el teu compte. Desa-la en un lloc segur com un gestor de contrasenyes.',
        secretKey: 'Clau secreta',
        tapToReveal: 'Toca per revelar',
        tapToHide: 'Toca per ocultar',
        secretKeyLabel: 'CLAU SECRETA (TOCA PER COPIAR)',
        secretKeyCopied: 'Clau secreta copiada al porta-retalls. Desa-la en un lloc segur!',
        secretKeyCopyFailed: 'Ha fallat copiar la clau secreta',
        dangerZone: 'Zona de perill',
        logout: 'Tanca la sessió',
        logoutSubtitle: 'Tanca la sessió i esborra les dades locals',
        logoutConfirm: 'Estàs segur que vols tancar la sessió? Assegura\'t d\'haver fet una còpia de seguretat de la teva clau secreta!',
    },

    settingsLanguage: {
        // Language settings screen
        title: 'Idioma',
        description: 'Tria el teu idioma preferit per a la interfície de l\'app. Això se sincronitzarà a tots els teus dispositius.',
        currentLanguage: 'Idioma actual',
        automatic: 'Automàtic',
        automaticSubtitle: 'Detecta des de la configuració del dispositiu',
        needsRestart: 'Idioma canviat',
        needsRestartMessage: 'L\'aplicació necessita reiniciar-se per aplicar la nova configuració d\'idioma.',
    },


    updateBanner: {
        updateAvailable: 'Actualització disponible',
        pressToApply: 'Prem per aplicar l\'actualització',
        whatsNew: 'Novetats',
        seeLatest: 'Mira les últimes actualitzacions i millores',
        nativeUpdateAvailable: 'Actualització de l\'aplicació disponible',
        tapToUpdateAppStore: 'Toca per actualitzar a l\'App Store',
        tapToUpdatePlayStore: 'Toca per actualitzar a Play Store',
    },

    changelog: {
        // Used by the changelog screen
        noEntriesAvailable: 'No hi ha entrades de registre de canvis disponibles.',
    },

    terminal: {
        // Used by terminal connection screens
        webBrowserRequired: 'Es requereix un navegador web',
        webBrowserRequiredDescription: 'Els enllaços de connexió de terminal només es poden obrir en un navegador web per raons de seguretat. Utilitza l\'escàner de codi QR o obre aquest enllaç en un ordinador.',
        processingConnection: 'Processant la connexió...',
        invalidConnectionLink: 'Enllaç de connexió no vàlid',
        invalidConnectionLinkDescription: 'L\'enllaç de connexió falta o no és vàlid. Comprova l\'URL i torna-ho a provar.',
        connectTerminal: 'Connecta el terminal',
        terminalRequestDescription: 'Un terminal està sol·licitant connectar-se al teu compte de muxr. Això permetrà al terminal enviar i rebre missatges de forma segura.',
        connectionDetails: 'Detalls de la connexió',
        publicKey: 'Clau pública',
        encryption: 'Xifratge',
        endToEndEncrypted: 'Xifrat punt a punt',
        acceptConnection: 'Accepta la connexió',
        connecting: 'Connectant...',
        reject: 'Rebutja',
        security: 'Seguretat',
        securityFooter: 'Aquest enllaç de connexió s\'ha processat de forma segura al teu navegador i mai s\'ha enviat a cap servidor. Les teves dades privades es mantindran segures i només tu pots desxifrar els missatges.',
        securityFooterDevice: 'Aquesta connexió s\'ha processat de forma segura al teu dispositiu i mai s\'ha enviat a cap servidor. Les teves dades privades es mantindran segures i només tu pots desxifrar els missatges.',
        clientSideProcessing: 'Processament del costat del client',
        linkProcessedLocally: 'Enllaç processat localment al navegador',
        linkProcessedOnDevice: 'Enllaç processat localment al dispositiu',
    },

    modals: {
        // Used across connect flows and settings
        deviceLinkedSuccessfully: 'Dispositiu enllaçat amb èxit',
        invalidAuthUrl: 'URL d\'autenticació no vàlida',
        developerMode: 'Mode desenvolupador',
        developerModeEnabled: 'Mode desenvolupador activat',
        developerModeDisabled: 'Mode desenvolupador desactivat',
        failedToLinkDevice: 'Ha fallat enllaçar el dispositiu',
        cameraPermissionsRequiredToScanQr: 'Es requereixen permisos de càmera per escanejar codis QR'
    },

    navigation: {
        // Navigation titles and screen headers
        connectTerminal: 'Connecta el terminal',
        linkNewDevice: 'Enllaça un nou dispositiu', 
        restoreWithSecretKey: 'Restaura amb clau secreta',
        browserTakeover: 'Control del navegador',
        whatsNew: 'Novetats',
        friends: 'Amics',
    },

    welcome: {
        // Main welcome screen for unauthenticated users
        title: 'Client mòbil de Pi',
        subtitle: 'Xifrat punt a punt i el teu compte s\'emmagatzema només al teu dispositiu.',
        createAccount: 'Crea un compte',
        linkOrRestoreAccount: 'Enllaça o restaura un compte',
        loginWithMobileApp: 'Inicia sessió amb l\'aplicació mòbil',
    },

    review: {
        // Used by utils/requestReview.ts
        enjoyingApp: 'T\'està agradant l\'aplicació?',
        feedbackPrompt: 'Ens encantaria conèixer la teva opinió!',
        yesILoveIt: 'Sí, m\'encanta!',
        notReally: 'No gaire'
    },

    items: {
        // Used by Item component for copy toast
        copiedToClipboard: ({ label }: { label: string }) => `${label} copiat al porta-retalls`
    },

    machine: {
        offlineUnableToSpawn: 'El llançador està desactivat mentre la màquina està fora de línia',
        launchNewSessionInDirectory: 'Inicia una nova sessió al directori',
        daemon: 'Dimoni',
        status: 'Estat',
        stopDaemon: 'Atura el dimoni',
        lastKnownPid: 'Últim PID conegut',
        lastKnownHttpPort: 'Últim port HTTP conegut',
        startedAt: 'Iniciat a',
        cliVersion: 'Versió del CLI',
        daemonStateVersion: 'Versió de l\'estat del dimoni',
        stopDaemonConfirmTitle: 'Aturar el dimoni?',
        stopDaemonConfirmMessage: 'No podràs iniciar noves sessions en aquesta màquina fins que tornis a reiniciar el dimoni al teu ordinador. Les sessions actuals continuaran actives.',
        daemonStopped: 'Dimoni aturat',
        stopDaemonFailed: 'No s\'ha pogut aturar el dimoni. Potser no s\'està executant.',
        machineGroup: 'Màquina',
        host: 'Host',
        machineId: 'ID de la màquina',
        username: 'Nom d\'usuari',
        homeDirectory: 'Directori principal',
        platform: 'Plataforma',
        architecture: 'Arquitectura',
        lastSeen: 'Vist per última vegada',
        never: 'Mai',
        metadataVersion: 'Versió de les metadades',
        cliAvailability: 'Disponibilitat de CLI',
        cliInstalled: 'Instal·lat',
        cliNotFound: 'No trobat',
        lastDetected: 'Última detecció',
        back: 'Enrere',
        dangerZone: 'Zona de perill',
        delete: 'Elimina la màquina',
        deleteFooter: 'Elimina aquesta màquina del teu compte. L\'historial de sessions es conservarà, però no podràs iniciar noves sessions en aquesta màquina.',
        deleteConfirmTitle: 'Eliminar aquesta màquina?',
        deleteConfirmMessage: 'La màquina s\'eliminarà del teu compte. L\'historial de sessions es conservarà, però no podràs iniciar noves sessions fins que tornis a connectar el dimoni.',
        deleteFailed: 'No s\'ha pogut eliminar la màquina.',
    },

    message: {
        switchedToMode: ({ mode }: { mode: string }) => `S'ha canviat al mode ${mode}`,
        unknownEvent: 'Esdeveniment desconegut',
        usageLimitUntil: ({ time }: { time: string }) => `Límit d'ús assolit fins a ${time}`,
        sentAsGoal: 'Sent as goal',
        unknownTime: 'temps desconegut',
    },

    codex: {
        // Pi permission dialog buttons
        permissions: {
            yesForSession: 'Sí, i no preguntar per aquesta sessió',
            stopAndExplain: 'Atura, i explica què fer',
        }
    },

    claude: {
        // Pi permission dialog buttons
        permissions: {
            yesAllowAllEdits: 'Sí, permet totes les edicions durant aquesta sessió',
            yesAllowEverything: 'Sí, permet-ho tot durant aquesta sessió',
            yesForTool: 'Sí, no tornis a preguntar per aquesta eina',
            noTellClaude: 'No, proporciona comentaris',
        }
    },

    textSelection: {
        // Text selection screen
        title: 'Seleccionar text',
        noTextProvided: 'No s\'ha proporcionat text',
        textNotFound: 'Text no trobat o expirat',
        textCopied: 'Text copiat al porta-retalls',
        failedToCopy: 'No s\'ha pogut copiar el text al porta-retalls',
        noTextToCopy: 'No hi ha text disponible per copiar',
    },

    markdown: {
        // Markdown copy functionality
        codeCopied: 'Codi copiat',
        copyFailed: 'Error al copiar',
        mermaidRenderFailed: 'Error al renderitzar el diagrama mermaid',
    },

    artifacts: {
        title: 'Artefactes',
        empty: 'Encara no hi ha artefactes',
        emptyDescription: 'Crea el teu primer artefacte per desar i organitzar contingut',
        new: 'Nou artefacte',
        edit: 'Edita artefacte',
        delete: 'Elimina',
        updateError: 'No s\'ha pogut actualitzar l\'artefacte. Si us plau, torna-ho a provar.',
        notFound: 'Artefacte no trobat',
        deleteConfirm: 'Eliminar artefacte?',
        deleteConfirmDescription: 'Aquest artefacte s\'eliminarà permanentment.',
        titlePlaceholder: 'Títol de l\'artefacte',
        bodyPlaceholder: 'Escriu aquí el contingut...',
        loading: 'Carregant...',
        error: 'Error en carregar els artefactes',
        titleLabel: 'TÍTOL',
        bodyLabel: 'CONTINGUT',
        emptyFieldsError: 'Si us plau, introdueix un títol o contingut',
        createError: 'No s\'ha pogut crear l\'artefacte. Si us plau, torna-ho a provar.',
    },

    friends: {
        // Friends feature
        manageFriends: 'Gestiona els teus amics i connexions',
        pendingRequests: 'Sol·licituds d\'amistat',
        myFriends: 'Els meus amics',
        noFriendsYet: 'Encara no tens amics',
        remove: 'Eliminar',
        addFriend: 'Afegir amic',
        alreadyFriends: 'Ja sou amics',
        requestPending: 'Sol·licitud pendent',
        searchInstructions: 'Introdueix un nom d\'usuari per buscar amics',
        searchPlaceholder: 'Introdueix nom d\'usuari...',
        searching: 'Buscant...',
        noUserFound: 'No s\'ha trobat cap usuari amb aquest nom',
        checkUsername: 'Si us plau, verifica el nom d\'usuari i torna-ho a provar',
        howToFind: 'Com trobar amics',
        findInstructions: 'Cerca amics pel seu nom d\'usuari. Tant tu com el teu amic heu de tenir GitHub connectat per enviar sol·licituds d\'amistat.',
        requestSent: 'Sol·licitud d\'amistat enviada!',
        confirmRemove: 'Eliminar amic',
        confirmRemoveMessage: 'Estàs segur que vols eliminar aquest amic?',
        cannotAddYourself: 'No pots enviar-te una sol·licitud d\'amistat a tu mateix',
        bothMustHaveGithub: 'Ambdós usuaris han de tenir GitHub connectat per ser amics',
        status: {
            none: 'No connectat',
            requested: 'Sol·licitud enviada',
            pending: 'Sol·licitud pendent',
            friend: 'Amics',
            rejected: 'Rebutjada',
        },
        acceptRequest: 'Acceptar sol·licitud',
        removeFriend: 'Eliminar dels amics',
        removeFriendConfirm: ({ name }: { name: string }) => `Estàs segur que vols eliminar ${name} dels teus amics?`,
        requestFriendship: 'Sol·licitar amistat',
        cancelRequest: 'Cancel·lar sol·licitud d\'amistat',
        cancelRequestConfirm: ({ name }: { name: string }) => `Cancel·lar la teva sol·licitud d\'amistat a ${name}?`,
        denyRequest: 'Rebutjar sol·licitud',
    },

    usage: {
        // Usage panel strings
        today: 'Avui',
        last7Days: 'Últims 7 dies',
        last30Days: 'Últims 30 dies',
        totalTokens: 'Tokens totals',
        totalCost: 'Cost total',
        tokens: 'Tokens',
        cost: 'Cost',
        usageOverTime: 'Ús al llarg del temps',
        byModel: 'Per model',
    },

    imageUpload: {
        permissionTitle: 'Accés a la biblioteca de fotos',
        permissionMessage: "Permet l'accés a la teva biblioteca de fotos per adjuntar imatges als missatges.",
        limitTitle: "Límit d'imatges assolit",
        limitMessage: ({ max }: { max: number }) => `Pots adjuntar fins a ${max} imatges per missatge.`,
        fileTooLargeTitle: 'Fitxer massa gran',
        fileTooLargeMessage: ({ name, maxMb }: { name: string; maxMb: number }) => `"${name}" supera el límit de ${maxMb}MB i no s'ha afegit.`,
        uploadFailedTitle: 'Error en la càrrega',
        uploadFailedMessage: ({ count }: { count: number }) => count === 1
            ? 'No s\'ha pogut pujar una imatge i no s\'ha enviat.'
            : `No s'han pogut pujar ${count} imatges i no s'han enviat.`,
        notSupportedTitle: 'Imatges no compatibles',
        notSupportedMessage: 'Aquest agent no admet fitxers adjunts d\'imatge. Les imatges no s\'han enviat.',
    },

    feed: {
        // Feed notifications for friend requests and acceptances
    }
} as const;

export type TranslationsCa = typeof ca;
