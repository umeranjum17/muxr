import type { TranslationStructure } from '../_default';

/**
 * Polish plural helper function
 * Polish has 3 plural forms: one, few, many
 * @param options - Object containing count and the three plural forms
 * @returns The appropriate form based on Polish plural rules
 */
function plural({ count, one, few, many }: { count: number; one: string; few: string; many: string }): string {
    const n = Math.abs(count);
    const n10 = n % 10;
    const n100 = n % 100;
    
    // Rule: 1 (but not 11)
    if (n === 1) return one;
    
    // Rule: 2-4 but not 12-14
    if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return few;
    
    // Rule: everything else (0, 5-19, 11, 12-14, etc.)
    return many;
}

/**
 * Polish translations for the muxr app
 * Must match the exact structure of the English translations
 */
export const pl: TranslationStructure = {
    tabs: {
        // Tab navigation labels
        sessions: 'Terminale',
        settings: 'Ustawienia',
    },

    inbox: {
        // Inbox screen: the sessions currently waiting on you
        reason: {
            waiting: 'czeka',
            blocked: 'zablokowana',
            failed: 'błąd',
            done: 'gotowe',
        },
    },

    plugins: {
        openFromHome: 'Otwórz wtyczkę z ekranu głównego.',
        unavailable: 'Ta wtyczka jest wyłączona lub niedostępna.',
        goBack: 'Wróć',
        couldNotLoad: 'Nie udało się wczytać elementów',
        dataUnavailable: 'Wtyczka jest teraz niedostępna.',
        nothingHere: 'Nic tu nie ma',
        newItems: 'Nowe elementy pojawią się tutaj.',
        retry: 'Ponów',
        retryItems: 'Ponów wczytywanie elementów wtyczki',
        stale: 'Nie udało się odświeżyć. Pokazano ostatni wynik.',
        nothingToShow: 'Brak danych do wyświetlenia.',
        treeUnavailable: 'Drzewo jest niedostępne.',
        dictate: 'Dyktuj',
        unavailableSuffix: 'niedostępne',
        showingStale: 'pokazano nieaktualne dane',
        settingsTitle: 'Wtyczki',
        enableAll: 'Włącz wszystkie',
        disableAll: 'Wyłącz wszystkie',
        installed: 'Zainstalowane',
        herdrAndMuxr: 'Herdr + muxr',
        herdrAndMuxrFooter: 'Herdr uruchamia dla nich akcje, panele lub zdarzenia, a one dodają interfejs muxr.',
        muxrOnly: 'Tylko muxr',
        muxrOnlyFooter: 'Herdr tylko je rejestruje; wszystko robią przez muxr.',
        herdrOnly: 'Tylko Herdr',
        herdrOnlyFooter: 'Pakiety backendu bez interfejsu muxr. Zarządzaj nimi przez CLI herdr.',
        waitingHost: 'Oczekiwanie na hosta.',
        linkHost: 'Połącz wtyczkę przez Herdr i połącz ponownie.',
        enabled: 'włączone',
        off: 'wył.',
        on: 'wł.',
        unavailableLabel: 'Niedostępne',
        runsCode: 'Uruchamia kod jako Ty',
        uiOnly: 'Tylko interfejs',
        readsSessions: 'Czyta podsumowania sesji',
        readsTree: 'Czyta drzewo obszaru roboczego',
        openFailed: 'Nie udało się otworzyć',
        actionFailed: 'Działanie nie powiodło się',
        items: 'Elementy',
        openWebsite: 'Otworzyć witrynę?',
        open: 'Otwórz',
        realtimeConnecting: 'Łączenie sesji głosowej',
        realtimeListening: 'Słucham',
        realtimeThinking: 'Myślę',
        realtimeSpeaking: 'Mówię',
        realtimeError: 'Błąd sesji głosowej',
        realtimeOff: 'Sesja głosowa wyłączona',
        openConversation: 'Otwórz rozmowę głosową',
        realtime: 'Głos',
    },

    common: {
        // Simple string constants
        cancel: 'Anuluj',
        save: 'Zapisz',
        error: 'Błąd',
        success: 'Sukces',
        ok: 'OK',
        back: 'Wstecz',
        create: 'Utwórz',
        rename: 'Zmień nazwę',
        logout: 'Wyloguj',
        yes: 'Tak',
        no: 'Nie',
        version: 'Wersja',
        copied: 'Skopiowano',
        copy: 'Kopiuj',
        scanning: 'Skanowanie...',
        home: 'Główna',
        message: 'Wiadomość',
        files: 'Pliki',
        fileViewer: 'Przeglądarka plików',
        loading: 'Ładowanie...',
        delete: 'Usuń',
    },

    profile: {
        details: 'Szczegóły',
        firstName: 'Imię',
        lastName: 'Nazwisko',
        username: 'Nazwa użytkownika',
        status: 'Status',
    },


    status: {
        connected: 'połączono',
        connecting: 'łączenie',
        disconnected: 'rozłączono',
        error: 'błąd',
        pairingIssue: 'problem z parowaniem',
        online: 'online',
        offline: 'offline',
        lastSeen: ({ time }: { time: string }) => `ostatnio widziano ${time}`,
        permissionRequired: 'wymagane uprawnienie',
        activeNow: 'Aktywny teraz',
        unknown: 'nieznane',
        unread: 'nowe wyniki',
    },

    time: {
        justNow: 'teraz',
        minutesAgo: ({ count }: { count: number }) => `${count} ${plural({ count, one: 'minuta', few: 'minuty', many: 'minut' })} temu`,
        hoursAgo: ({ count }: { count: number }) => `${count} ${plural({ count, one: 'godzina', few: 'godziny', many: 'godzin' })} temu`,
        daysAgo: ({ count }: { count: number }) => `${count} ${plural({ count, one: 'dzień', few: 'dni', many: 'dni' })} temu`,
    },

    connect: {
        restoreAccount: 'Przywróć konto',
        enterSecretKey: 'Proszę wprowadzić klucz tajny',
        invalidSecretKey: 'Nieprawidłowy klucz tajny. Sprawdź i spróbuj ponownie.',
        qrInstructions: '1. Otwórz muxr na urządzeniu mobilnym\n2. Przejdź do Ustawienia → Konto\n3. Dotknij „Połącz nowe urządzenie”\n4. Zeskanuj ten kod QR',
        restoreWithSecretKeyInstead: 'Lub przywróć kluczem tajnym',
    },

    settings: {
        title: 'Ustawienia',
        github: 'GitHub',
        machines: 'Maszyny',
        showOfflineMachines: ({ count }: { count: number }) => {
            const mod10 = count % 10;
            const mod100 = count % 100;
            if (count === 1) return 'Pokaż 1 maszynę offline';
            if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `Pokaż ${count} maszyny offline`;
            return `Pokaż ${count} maszyn offline`;
        },
        hideOfflineMachines: 'Ukryj maszyny offline',
        features: 'Funkcje',
        social: 'Społeczność',
        account: 'Konto',
        accountSubtitle: 'Zarządzaj szczegółami konta',
        appearance: 'Wygląd',
        appearanceSubtitle: 'Dostosuj wygląd aplikacji',
        featuresTitle: 'Funkcje',
        featuresSubtitle: 'Włącz lub wyłącz funkcje aplikacji',
        about: 'O aplikacji',
        aboutFooter: 'muxr to mobilny klient Pi. Szyfrowanie end-to-end jest opcjonalne i domyślnie wyłączone; Twoje konto jest przechowywane tylko na Twoim urządzeniu. Nie jest powiązany z Anthropic.',
        whatsNew: 'Co nowego',
        whatsNewSubtitle: 'Zobacz najnowsze aktualizacje i ulepszenia',
        reportIssue: 'Zgłoś problem',
        eula: 'EULA',
        connection: 'Połączenie',
        connectionSubtitle: 'URL serwera relay, maszyna i token',
        pushNotifications: 'Powiadomienia push',
        pushSubtitleSubscribed: 'Włączone — powiadomienie, gdy agent potrzebuje odpowiedzi',
        pushSubtitleDenied: 'Zablokowane przez przeglądarkę — zezwól na powiadomienia, aby włączyć',
        pushSubtitleUnsupported: 'Niedostępne w tej przeglądarce',
        pushSubtitleDefault: 'Dotknij, aby otrzymywać powiadomienia, gdy agent potrzebuje odpowiedzi',
        license: 'Licencja i informacje prawne',
        // Dynamic settings messages
    },

    settingsAppearance: {
        // Appearance settings screen
        theme: 'Motyw',
        themeDescription: 'Wybierz preferowaną kolorystykę',
        themeOptions: {
            adaptive: 'Adaptacyjny',
            light: 'Jasny',
            dark: 'Ciemny',
        },
        themeDescriptions: {
            adaptive: 'Dopasuj do ustawień systemu',
            light: 'Zawsze używaj jasnego motywu',
            dark: 'Zawsze używaj ciemnego motywu',
        },
        display: 'Wyświetlanie',
        displayDescription: 'Kontroluj układ i odstępy',

        avatarStyle: 'Styl awatara',
        avatarStyleDescription: 'Wybierz wygląd awatara sesji',
        avatarOptions: {
            pixelated: 'Pikselowy',
            gradient: 'Gradientowy',
            brutalist: 'Brutalistyczny',
        },
        showFlavorIcons: 'Pokaż ikony dostawcy AI',
        showFlavorIconsDescription: 'Wyświetlaj ikony dostawcy AI na awatarach sesji',
    },

    settingsFeatures: {
        // Features settings screen
        experiments: 'Eksperymenty',
        experimentsDescription: 'Włącz eksperymentalne funkcje, które są nadal w rozwoju. Te funkcje mogą być niestabilne lub zmienić się bez ostrzeżenia.',
        webFeatures: 'Funkcje webowe',
        webFeaturesDescription: 'Funkcje dostępne tylko w wersji webowej aplikacji.',
        commandPalette: 'Paleta poleceń',
        commandPaletteEnabled: 'Naciśnij ⌘K, aby otworzyć',
        commandPaletteDisabled: 'Szybki dostęp do poleceń wyłączony',
        markdownCopyV2: 'Markdown Copy v2',
        markdownCopyV2Subtitle: 'Długie naciśnięcie otwiera modal kopiowania',
        hideInactiveSessions: 'Ukryj nieaktywne sesje',
        hideInactiveSessionsSubtitle: 'Wyświetlaj tylko aktywne czaty na liście',
        imageUpload: 'Przesyłanie obrazów',
        imageUploadSubtitle: 'Dołączaj obrazy do wiadomości, aby obsługiwani agenci mogli je analizować',
    },

    errors: {
        authenticationFailed: 'Uwierzytelnienie nie powiodło się',
        failedToLoadProfile: 'Nie udało się załadować profilu użytkownika',
        userNotFound: 'Użytkownik nie został znaleziony',
        sessionDeleted: 'Sesja została usunięta',
        sessionDeletedDescription: 'Ta sesja została trwale usunięta',

        // Error functions with context
        failedToSendRequest: 'Nie udało się wysłać zaproszenia do znajomych',
    },

    newSession: {
        title: 'Rozpocznij nową sesję',
        machineOffline: 'Maszyna jest offline',
        switchMachinesHint: '• Przełącz maszynę, klikając na nią powyżej',
    },

    settingsConnection: {
        // Connection settings screen (relay URL, machine, token)
        status: ({ status }: { status: string }) => `Status: ${status}`,
    },

    optionSheet: {
        // Model/mode picker bottom sheet
        all: 'wszystkie',
        searchPlaceholder: ({ count }: { count: number }) => `Szukaj ${count}`,
        useCustom: ({ value }: { value: string }) => `użyj ${value}`,
        noResults: 'brak wyników',
    },

    homeDock: {
        // Home screen composer
        inputPlaceholder: 'Planuj, pytaj, buduj…',
        runCommandPlaceholder: 'Uruchom polecenie',
        askPlaceholder: ({ name }: { name: string }) => `Zapytaj ${name}`,
    },

    liveTerminals: {
        // Live terminals strip on the home screen
        title: 'NA ŻYWO',
    },

    emptySessions: {
        // Empty state shown on tablets when no sessions are active
        noActiveSessions: 'Brak aktywnych sesji',
        startDescription: 'Rozpocznij nową sesję na dowolnej z podłączonych maszyn.',
        noMachinesDescription: 'Otwórz nowy terminal na komputerze, aby rozpocząć sesję.',
    },

    sessionHistory: {
        // Used by session history screen
        title: 'Historia sesji',
        empty: 'Nie znaleziono sesji',
        today: 'Dzisiaj',
        yesterday: 'Wczoraj',
        daysAgo: ({ count }: { count: number }) => `${count} ${plural({ count, one: 'dzień', few: 'dni', many: 'dni' })} temu`,
    },

    session: {
        inputPlaceholder: 'Wpisz wiadomość...',
        inactiveArchived: 'Ta sesja jest nieaktywna.',
        resumeFromTerminal: 'Aby wznowić ją z terminala:',
        newChat: 'Nowy czat',
        forkAction: 'Rozwidl sesję',
        forkSubtitle: 'Kontynuuj w nowej sesji z tym samym kontekstem',
        duplicateAction: 'Duplikuj od wiadomości…',
        duplicateSubtitle: 'Cofnij się do wybranego punktu i spróbuj inaczej',
        duplicateSheetTitle: 'Wybierz punkt cofnięcia',
        duplicateSheetSubtitle: 'Nowa sesja zachowa wybraną turę w całości (twoja wiadomość i odpowiedź agenta) i odrzuci wszystkie kolejne wiadomości.',
        duplicateSheetConfirm: 'Duplikuj',
        duplicateSheetEmpty: 'W tej sesji nie ma jeszcze wiadomości, do których można się cofnąć.',
        duplicateRowDisabled: 'Tej wiadomości nie można użyć jako punktu cofnięcia.',
        forkedFromLabel: 'Rozwidlone z',
        forkedFromSubtitle: 'Otwórz sesję, z której powstało rozwidlenie',
        forkErrorMissingMetadata: 'Brak metadanych sesji wymaganych do rozwidlenia.',
        forkErrorGeneric: 'Nie udało się rozwidlić sesji.',
    },

    commandPalette: {
        placeholder: 'Wpisz polecenie lub wyszukaj...',
    },


    sessionInfo: {
        // Used by Session Info screen (app/(app)/session/[id]/info.tsx)
        archiveSession: 'Zarchiwizuj sesję',
        muxrSessionIdCopied: 'ID sesji muxr skopiowane do schowka',
        failedToCopySessionId: 'Nie udało się skopiować ID sesji muxr',
        muxrSessionId: 'ID sesji muxr',
        claudeCodeSessionId: 'ID sesji Pi',
        claudeCodeSessionIdCopied: 'ID sesji Pi skopiowane do schowka',
        codexThreadId: 'ID wątku Pi',
        codexThreadIdCopied: 'ID wątku Pi skopiowane do schowka',
        aiProvider: 'Dostawca AI',
        failedToCopyClaudeCodeSessionId: 'Nie udało się skopiować ID sesji Pi',
        failedToCopyCodexThreadId: 'Nie udało się skopiować ID wątku Pi',
        metadataCopied: 'Metadane skopiowane do schowka',
        failedToCopyMetadata: 'Nie udało się skopiować metadanych',
        failedToArchiveSession: 'Nie udało się zarchiwizować sesji',
        connectionStatus: 'Status połączenia',
        created: 'Utworzono',
        lastUpdated: 'Ostatnia aktualizacja',
        sequence: 'Sekwencja',
        quickActions: 'Szybkie akcje',
        viewMachine: 'Zobacz maszynę',
        viewMachineSubtitle: 'Zobacz szczegóły maszyny i sesje',
        resumeSession: 'Resume Session',
        resumeSessionSubtitle: 'Resume this session on the same machine',
        resumeSessionSameMachineOnly: 'This session can only be resumed on the same machine it started on.',
        resumeSessionMachineOffline: 'This machine is offline. Resume is only available while it is online.',
        resumeSessionMissingMachine: 'This session is missing its machine metadata, so it cannot be resumed.',
        resumeSessionMissingBackendId: 'This session does not have a resumable Pi identifier.',
        resumeSessionUnexpectedDirectoryPrompt: 'Resume cannot create directories. Start the session manually from its original path.',
        archiveSessionSubtitle: 'Zarchiwizuj tę sesję i zatrzymaj ją',
        metadata: 'Metadane',
        host: 'Host',
        path: 'Ścieżka',
        operatingSystem: 'System operacyjny',
        processId: 'ID procesu',
        muxrHome: 'Katalog domowy muxr',
        copyMetadata: 'Kopiuj metadane',
        agentState: 'Stan agenta',
        controlledByUser: 'Kontrolowany przez użytkownika',
        pendingRequests: 'Oczekujące żądania',
        activity: 'Aktywność',
        thinking: 'Myśli',
        thinkingSince: 'Myśli od',
        cliVersion: 'Wersja CLI',
        deleteSession: 'Usuń sesję',
        deleteSessionSubtitle: 'Trwale usuń tę sesję',
        deleteSessionWarning: 'Ta operacja jest nieodwracalna. Wszystkie wiadomości i dane powiązane z tą sesją zostaną trwale usunięte.',
        failedToDeleteSession: 'Nie udało się usunąć sesji',
        worktreeCleanupTitle: 'Usunąć Worktree?',
        worktreeCleanupMessage: 'Worktree nie ma niezatwierdzonych zmian. Czy chcesz usunąć pliki Worktree?',
        worktreeCleanupDelete: 'Usuń Worktree',
        worktreeCleanupKeep: 'Zachowaj pliki',
        landWorktree: 'Land Worktree',
        landWorktreeSubtitle: 'Squash this worktree onto the base branch and remove it',
        landWorktreeMessage: 'Commit message for the squashed change',
        landWorktreeFailed: 'Failed to land worktree',
        landWorktreeDone: 'Landed on the base branch. The worktree is gone.',
    },

    archive: {
        select: 'Wybierz',
        selectAll: 'Zaznacz wszystko',
        deselectAll: 'Odznacz wszystko',
        archiveCount: ({ count }: { count: number }) => plural({ count, one: 'Zarchiwizuj 1 sesję', few: `Zarchiwizuj ${count} sesje`, many: `Zarchiwizuj ${count} sesji` }),
        unarchiveCount: ({ count }: { count: number }) => plural({ count, one: 'Przywróć 1 sesję', few: `Przywróć ${count} sesje`, many: `Przywróć ${count} sesji` }),
        selectedCount: ({ count }: { count: number }) => `${count} wybrane`,
        archivedCount: ({ count }: { count: number }) => plural({ count, one: 'Zarchiwizowano 1 sesję', few: `Zarchiwizowano ${count} sesje`, many: `Zarchiwizowano ${count} sesji` }),
        undo: 'Cofnij',
    },

    components: {
        sessionStatusBar: {
            contextUsage: ({ used, total, percent }: { used: string; total: string; percent: number }) => `Kontekst ${used} z ${total} tokenów, ${percent}%`,
            limitFiveHour: 'Limit 5-godzinny',
            limitSevenDay: 'Limit 7-dniowy',
            limitResets: ({ time }: { time: string }) => `reset ${time}`,
            limitAsOf: ({ age }: { age: string }) => `sprzed ${age}`,
            limitRemaining: ({ percent }: { percent: number }) => `pozostało ${percent}%`,
        },
    },

    agentInput: {
        permissionMode: {
            title: 'TRYB UPRAWNIEŃ',
            default: 'Domyślny',
            acceptEdits: 'Akceptuj edycje',
            plan: 'Tryb planowania',
            dontAsk: 'Nie pytaj',
            bypassPermissions: 'Tryb YOLO',
        },
        agent: {
            pi: 'Pi',
        },
        model: {
            title: 'MODEL',
            configureInCli: 'Skonfiguruj modele w ustawieniach CLI',
        },
        effort: {
            title: 'WYSIŁEK',
        },
        codexPermissionMode: {
            title: 'TRYB UPRAWNIEŃ PI',
            default: 'Ustawienia CLI',
            readOnly: 'Read Only Mode',
            safeYolo: 'Safe YOLO',
            yolo: 'YOLO',
            defaultDescription: 'pytaj przed niezaufanymi poleceniami',
            readOnlyDescription: 'bez zapisu',
            safeYoloDescription: 'bez pytań, piaskownica obszaru roboczego',
            yoloDescription: 'bez pytań, pełny dostęp',
        },

        geminiPermissionMode: {
            title: 'TRYB UPRAWNIEŃ PI',
            default: 'Domyślny',
            autoEdit: 'Auto edycja',
            yolo: 'YOLO',
            plan: 'Planowanie',
        },
        context: {
            remaining: ({ percent }: { percent: number }) => `Pozostało ${percent}%`,
        },
        suggestion: {
            fileLabel: 'PLIK',
            folderLabel: 'FOLDER',
        },
        noMachinesAvailable: 'Brak maszyn',
    },

    machineLauncher: {
        showLess: 'Pokaż mniej',
        showAll: ({ count }: { count: number }) => `Pokaż wszystkie (${count} ${plural({ count, one: 'ścieżka', few: 'ścieżki', many: 'ścieżek' })})`,
        enterCustomPath: 'Wprowadź niestandardową ścieżkę',
    },

    sidebar: {
        sessionsTitle: 'muxr',
        showArchived: 'Pokaż zarchiwizowane',
        hideArchived: 'Ukryj zarchiwizowane',
        newSession: 'Nowa sesja',
    },

    zen: {
        toggle: 'Tryb zen',
    },

    toolView: {
        input: 'Wejście',
        output: 'Wyjście',
    },

    thinking: {
        active: 'Thinking…',
        thought: 'Thought',
        thoughtFor: ({ duration }: { duration: string }) => `Thought for ${duration}`,
    },

    sessionAttachments: {
        title: ({ count }: { count: number }) => plural({ count, one: '1 załącznik', few: `${count} załączniki`, many: `${count} załączników` }),
    },

    turnChanges: {
        filesChanged: ({ count }: { count: number }) => plural({ count, one: 'Zmieniono 1 plik', few: `Zmieniono ${count} pliki`, many: `Zmieniono ${count} plików` }),
    },

    tools: {
        fullView: {
            description: 'Opis',
            inputParams: 'Parametry wejściowe',
            output: 'Wyjście',
            error: 'Błąd',
            completed: 'Narzędzie ukończone pomyślnie',
            noOutput: 'Nie wygenerowano żadnego wyjścia',
            rawJsonDevMode: 'Surowy JSON (tryb deweloperski)',
        },


        names: {
            search: 'Wyszukaj',
        },

        desc: {
        }
    },

    files: {
        changes: 'Zmiany',
        searchPlaceholder: 'Wyszukaj pliki...',
        detachedHead: 'odłączony HEAD',
        summary: ({ staged, unstaged }: { staged: number; unstaged: number }) => `${staged} przygotowanych • ${unstaged} nieprzygotowanych`,
        notRepo: 'To nie jest repozytorium git',
        notUnderGit: 'Ten katalog nie jest pod kontrolą wersji git',
        searching: 'Wyszukiwanie plików...',
        noFilesFound: 'Nie znaleziono plików',
        noFilesInProject: 'Brak plików w projekcie',
        tryDifferentTerm: 'Spróbuj innego terminu wyszukiwania',
        searchResults: ({ count }: { count: number }) => `Wyniki wyszukiwania (${count})`,
        projectRoot: 'Katalog główny projektu',
        stagedChanges: ({ count }: { count: number }) => `Przygotowane zmiany (${count})`,
        unstagedChanges: ({ count }: { count: number }) => `Nieprzygotowane zmiany (${count})`,
        // File viewer strings
        loadingFile: ({ fileName }: { fileName: string }) => `Ładowanie ${fileName}...`,
        binaryFile: 'Plik binarny',
        cannotDisplayBinary: 'Nie można wyświetlić zawartości pliku binarnego',
        diff: 'Różnice',
        file: 'Plik',
        fileEmpty: 'Plik jest pusty',
        noChanges: 'Brak zmian do wyświetlenia',
        noChangesTitle: 'Brak zmian',
        noChangesSubtitle: 'Drzewo robocze jest czyste',
        deleted: 'Usunięty',
        changedFiles: ({ count }: { count: number }) => `${count} ${count === 1 ? 'zmieniony plik' : 'zmienionych plików'}`,
        allFiles: 'Wszystkie pliki',
        addPanel: 'Dodaj panel',
        closePanel: 'Zamknij panel',
        editFile: 'Edytuj',
        saveFile: 'Zapisz',
        failedToRead: 'Nie udało się odczytać pliku',
        failedToSave: 'Nie udało się zapisać pliku',
        fileConflict: 'Konflikt pliku',
        fileConflictDescription: 'Ten plik został zmodyfikowany na urządzeniu podczas edycji. Załaduj ponownie aby zobaczyć najnowszą wersję.',
        reload: 'Załaduj ponownie',
        overwrite: 'Nadpisz',
    },
    sideChat: {
        panelTitle: 'Czat boczny',
        emptyTitle: 'Rozpocznij czat boczny',
        emptySubtitle: 'Zapytaj agenta o coś na boku. Dziedziczy kontekst tego czatu, ale pozostaje odizolowany — nic tutaj nie wpływa na główną rozmowę.',
        startButton: 'Rozpocznij czat boczny',
        creating: 'Uruchamianie czatu bocznego…',
        unavailable: 'Ta sesja nie może jeszcze rozpocząć czatu bocznego — poczekaj, aż agent będzie online.',
        expand: 'Otwórz na pełnym ekranie',
        tabLabel: ({ index }: { index: number }) => `Czat boczny ${index}`,
        newChat: 'Nowy czat boczny',
        close: 'Zamknij czat boczny',
    },


    settingsAccount: {
        // Account settings screen
        accountInformation: 'Informacje o koncie',
        status: 'Status',
        statusActive: 'Aktywny',
        statusNotAuthenticated: 'Nie uwierzytelniony',
        anonymousId: 'ID anonimowe',
        publicId: 'ID publiczne',
        notAvailable: 'Niedostępne',
        linkNewDevice: 'Połącz nowe urządzenie',
        linkNewDeviceSubtitle: 'Zeskanuj kod QR, aby połączyć urządzenie',
        backup: 'Kopia zapasowa',
        backupDescription: 'Twój klucz tajny to jedyny sposób na odzyskanie konta. Zapisz go w bezpiecznym miejscu, takim jak menedżer haseł.',
        secretKey: 'Klucz tajny',
        tapToReveal: 'Dotknij, aby pokazać',
        tapToHide: 'Dotknij, aby ukryć',
        secretKeyLabel: 'KLUCZ TAJNY (DOTKNIJ, ABY SKOPIOWAĆ)',
        secretKeyCopied: 'Klucz tajny skopiowany do schowka. Przechowuj go w bezpiecznym miejscu!',
        secretKeyCopyFailed: 'Nie udało się skopiować klucza tajnego',
        dangerZone: 'Strefa niebezpieczna',
        logout: 'Wyloguj',
        logoutSubtitle: 'Wyloguj się i wyczyść dane lokalne',
        logoutConfirm: 'Czy na pewno chcesz się wylogować? Upewnij się, że masz kopię zapasową klucza tajnego!',
    },

    settingsLanguage: {
        // Language settings screen
        title: 'Język',
        description: 'Wybierz preferowany język interfejsu aplikacji. To ustawienie zostanie zsynchronizowane na wszystkich Twoich urządzeniach.',
        currentLanguage: 'Aktualny język',
        automatic: 'Automatycznie',
        automaticSubtitle: 'Wykrywaj na podstawie ustawień urządzenia',
        needsRestart: 'Język zmieniony',
        needsRestartMessage: 'Aplikacja musi zostać uruchomiona ponownie, aby zastosować nowe ustawienia języka.',
    },


    updateBanner: {
        updateAvailable: 'Dostępna aktualizacja',
        pressToApply: 'Naciśnij, aby zastosować aktualizację',
        whatsNew: 'Co nowego',
        seeLatest: 'Zobacz najnowsze aktualizacje i ulepszenia',
        nativeUpdateAvailable: 'Dostępna aktualizacja aplikacji',
        tapToUpdateAppStore: 'Naciśnij, aby zaktualizować w App Store',
        tapToUpdatePlayStore: 'Naciśnij, aby zaktualizować w Sklepie Play',
    },

    changelog: {
        // Used by the changelog screen
        noEntriesAvailable: 'Brak dostępnych wpisów dziennika zmian.',
    },

    terminal: {
        // Used by terminal connection screens
        webBrowserRequired: 'Wymagana przeglądarka internetowa',
        webBrowserRequiredDescription: 'Linki połączenia terminala można otwierać tylko w przeglądarce internetowej ze względów bezpieczeństwa. Użyj skanera kodów QR lub otwórz ten link na komputerze.',
        processingConnection: 'Przetwarzanie połączenia...',
        invalidConnectionLink: 'Nieprawidłowy link połączenia',
        invalidConnectionLinkDescription: 'Link połączenia jest nieprawidłowy lub go brakuje. Sprawdź URL i spróbuj ponownie.',
        connectTerminal: 'Połącz terminal',
        terminalRequestDescription: 'Terminal żąda połączenia z Twoim kontem muxr. Pozwoli to terminalowi bezpiecznie wysyłać i odbierać wiadomości.',
        connectionDetails: 'Szczegóły połączenia',
        publicKey: 'Klucz publiczny',
        encryption: 'Szyfrowanie',
        endToEndEncrypted: 'Szyfrowanie end-to-end',
        acceptConnection: 'Akceptuj połączenie',
        connecting: 'Łączenie...',
        reject: 'Odrzuć',
        security: 'Bezpieczeństwo',
        securityFooter: 'Ten link połączenia został bezpiecznie przetworzony w Twojej przeglądarce i nigdy nie został wysłany na żaden serwer. Twoje prywatne dane pozostaną bezpieczne i tylko Ty możesz odszyfrować wiadomości.',
        securityFooterDevice: 'To połączenie zostało bezpiecznie przetworzone na Twoim urządzeniu i nigdy nie zostało wysłane na żaden serwer. Twoje prywatne dane pozostaną bezpieczne i tylko Ty możesz odszyfrować wiadomości.',
        clientSideProcessing: 'Przetwarzanie po stronie klienta',
        linkProcessedLocally: 'Link przetworzony lokalnie w przeglądarce',
        linkProcessedOnDevice: 'Link przetworzony lokalnie na urządzeniu',
    },

    modals: {
        // Used across connect flows and settings
        deviceLinkedSuccessfully: 'Urządzenie połączone pomyślnie',
        invalidAuthUrl: 'Nieprawidłowy URL uwierzytelnienia',
        developerMode: 'Tryb deweloperski',
        developerModeEnabled: 'Tryb deweloperski włączony',
        developerModeDisabled: 'Tryb deweloperski wyłączony',
        failedToLinkDevice: 'Nie udało się połączyć urządzenia',
        cameraPermissionsRequiredToScanQr: 'Uprawnienia do kamery są wymagane do skanowania kodów QR'
    },

    navigation: {
        // Navigation titles and screen headers
        connectTerminal: 'Połącz terminal',
        linkNewDevice: 'Połącz nowe urządzenie',
        restoreWithSecretKey: 'Przywróć kluczem tajnym',
        browserPreview: 'Podgląd w przeglądarce',
        browserTakeover: 'Przejęcie przeglądarki',
        whatsNew: 'Co nowego',
        friends: 'Przyjaciele',
    },

    welcome: {
        // Main welcome screen for unauthenticated users
        title: 'Mobilny klient Pi',
        subtitle: 'Twoje konto jest przechowywane tylko na Twoim urządzeniu. Szyfrowanie end-to-end jest opcjonalne.',
        createAccount: 'Utwórz konto',
        linkOrRestoreAccount: 'Połącz lub przywróć konto',
        loginWithMobileApp: 'Zaloguj się przez aplikację mobilną',
    },

    review: {
        // Used by utils/requestReview.ts
        enjoyingApp: 'Podoba Ci się aplikacja?',
        feedbackPrompt: 'Chcielibyśmy usłyszeć Twoją opinię!',
        yesILoveIt: 'Tak, uwielbiam ją!',
        notReally: 'Nie bardzo'
    },

    items: {
        // Used by Item component for copy toast
        copiedToClipboard: ({ label }: { label: string }) => `${label} skopiowano do schowka`
    },

    machine: {
        offlineUnableToSpawn: 'Launcher wyłączony, gdy maszyna jest offline',
        launchNewSessionInDirectory: 'Uruchom nową sesję w katalogu',
        daemon: 'Daemon',
        status: 'Status',
        stopDaemon: 'Zatrzymaj daemon',
        lastKnownPid: 'Ostatni znany PID',
        lastKnownHttpPort: 'Ostatni znany port HTTP',
        startedAt: 'Uruchomiony o',
        cliVersion: 'Wersja CLI',
        daemonStateVersion: 'Wersja stanu daemon',
        stopDaemonConfirmTitle: 'Zatrzymać daemona?',
        stopDaemonConfirmMessage: 'Nie będzie można uruchamiać nowych sesji na tej maszynie, dopóki ponownie nie uruchomisz daemona na komputerze. Bieżące sesje pozostaną aktywne.',
        daemonStopped: 'Daemon zatrzymany',
        stopDaemonFailed: 'Nie udało się zatrzymać daemona. Może nie jest uruchomiony.',
        machineGroup: 'Maszyna',
        host: 'Host',
        machineId: 'ID maszyny',
        username: 'Nazwa użytkownika',
        homeDirectory: 'Katalog domowy',
        platform: 'Platforma',
        architecture: 'Architektura',
        lastSeen: 'Ostatnio widziana',
        never: 'Nigdy',
        metadataVersion: 'Wersja metadanych',
        cliAvailability: 'Dostępność CLI',
        cliInstalled: 'Zainstalowany',
        cliNotFound: 'Nie znaleziono',
        lastDetected: 'Ostatnio wykryto',
        back: 'Wstecz',
        dangerZone: 'Strefa niebezpieczna',
        delete: 'Usuń maszynę',
        deleteFooter: 'Usuń tę maszynę ze swojego konta. Historia sesji zostanie zachowana, ale nie będziesz mógł uruchamiać nowych sesji na tej maszynie.',
        deleteConfirmTitle: 'Usunąć tę maszynę?',
        deleteConfirmMessage: 'Maszyna zostanie usunięta z twojego konta. Historia sesji zostanie zachowana, ale nie będziesz mógł uruchamiać nowych sesji, dopóki ponownie nie podłączysz demona.',
        deleteFailed: 'Nie udało się usunąć maszyny.',
    },

    message: {
        switchedToMode: ({ mode }: { mode: string }) => `Przełączono na tryb ${mode}`,
        unknownEvent: 'Nieznane zdarzenie',
        usageLimitUntil: ({ time }: { time: string }) => `Osiągnięto limit użycia do ${time}`,
        sentAsGoal: 'Sent as goal',
        unknownTime: 'nieznany czas',
    },

    codex: {
        // Pi permission dialog buttons
        permissions: {
            yesForSession: 'Tak, i nie pytaj dla tej sesji',
            stopAndExplain: 'Zatrzymaj i wyjaśnij, co zrobić',
        }
    },

    claude: {
        // Pi permission dialog buttons
        permissions: {
            yesAllowAllEdits: 'Tak, zezwól na wszystkie edycje podczas tej sesji',
            yesAllowEverything: 'Tak, zezwól na wszystko podczas tej sesji',
            yesForTool: 'Tak, nie pytaj ponownie dla tego narzędzia',
            noTellClaude: 'Nie, przekaż opinię',
        }
    },

    textSelection: {
        // Text selection screen
        title: 'Wybierz tekst',
        noTextProvided: 'Nie podano tekstu',
        textNotFound: 'Tekst nie został znaleziony lub wygasł',
        textCopied: 'Tekst skopiowany do schowka',
        failedToCopy: 'Nie udało się skopiować tekstu do schowka',
        noTextToCopy: 'Brak tekstu do skopiowania',
    },

    markdown: {
        // Markdown copy functionality
        codeCopied: 'Kod skopiowany',
        copyFailed: 'Błąd kopiowania',
        mermaidRenderFailed: 'Nie udało się wyświetlić diagramu mermaid',
    },

    artifacts: {
        // Artifacts feature
        title: 'Artefakty',
        empty: 'Brak artefaktów',
        emptyDescription: 'Utwórz pierwszy artefakt, aby rozpocząć',
        new: 'Nowy artefakt',
        edit: 'Edytuj artefakt',
        delete: 'Usuń',
        updateError: 'Nie udało się zaktualizować artefaktu. Spróbuj ponownie.',
        notFound: 'Artefakt nie został znaleziony',
        deleteConfirm: 'Usunąć artefakt?',
        deleteConfirmDescription: 'Tej operacji nie można cofnąć',
        titleLabel: 'TYTUŁ',
        titlePlaceholder: 'Wprowadź tytuł dla swojego artefaktu',
        bodyLabel: 'TREŚĆ',
        bodyPlaceholder: 'Napisz swoją treść tutaj...',
        emptyFieldsError: 'Proszę wprowadzić tytuł lub treść',
        createError: 'Nie udało się utworzyć artefaktu. Spróbuj ponownie.',
        loading: 'Ładowanie artefaktów...',
        error: 'Nie udało się załadować artefaktu',
    },

    friends: {
        // Friends feature
        manageFriends: 'Zarządzaj swoimi przyjaciółmi i połączeniami',
        pendingRequests: 'Zaproszenia do znajomych',
        myFriends: 'Moi przyjaciele',
        noFriendsYet: 'Nie masz jeszcze żadnych przyjaciół',
        remove: 'Usuń',
        addFriend: 'Dodaj do znajomych',
        alreadyFriends: 'Już jesteście znajomymi',
        requestPending: 'Zaproszenie oczekuje',
        searchInstructions: 'Wprowadź nazwę użytkownika, aby znaleźć przyjaciół',
        searchPlaceholder: 'Wprowadź nazwę użytkownika...',
        searching: 'Szukanie...',
        noUserFound: 'Nie znaleziono użytkownika o tej nazwie',
        checkUsername: 'Sprawdź nazwę użytkownika i spróbuj ponownie',
        howToFind: 'Jak znaleźć przyjaciół',
        findInstructions: 'Szukaj przyjaciół po nazwie użytkownika. Zarówno ty, jak i twój przyjaciel musicie mieć połączony GitHub, aby wysyłać zaproszenia do znajomych.',
        requestSent: 'Zaproszenie do znajomych wysłane!',
        confirmRemove: 'Usuń przyjaciela',
        confirmRemoveMessage: 'Czy na pewno chcesz usunąć tego przyjaciela?',
        cannotAddYourself: 'Nie możesz wysłać zaproszenia do siebie',
        bothMustHaveGithub: 'Obaj użytkownicy muszą mieć połączony GitHub, aby zostać przyjaciółmi',
        status: {
            none: 'Nie połączono',
            requested: 'Zaproszenie wysłane',
            pending: 'Zaproszenie oczekuje',
            friend: 'Przyjaciele',
            rejected: 'Odrzucone',
        },
        acceptRequest: 'Zaakceptuj zaproszenie',
        removeFriend: 'Usuń z przyjaciół',
        removeFriendConfirm: ({ name }: { name: string }) => `Czy na pewno chcesz usunąć ${name} z przyjaciół?`,
        requestFriendship: 'Wyślij zaproszenie do znajomych',
        cancelRequest: 'Anuluj zaproszenie do znajomych',
        cancelRequestConfirm: ({ name }: { name: string }) => `Anulować zaproszenie do znajomych wysłane do ${name}?`,
        denyRequest: 'Odrzuć zaproszenie',
    },

    usage: {
        // Usage panel strings
        today: 'Dzisiaj',
        last7Days: 'Ostatnie 7 dni',
        last30Days: 'Ostatnie 30 dni',
        totalTokens: 'Łącznie tokenów',
        totalCost: 'Całkowity koszt',
        tokens: 'Tokeny',
        cost: 'Koszt',
        usageOverTime: 'Użycie w czasie',
        byModel: 'Według modelu',
    },

    imageUpload: {
        permissionTitle: 'Dostęp do biblioteki zdjęć',
        permissionMessage: 'Zezwól na dostęp do biblioteki zdjęć, aby załączać obrazy do wiadomości.',
        limitTitle: 'Osiągnięto limit obrazów',
        limitMessage: ({ max }: { max: number }) => `Możesz dołączyć maksymalnie ${max} obrazów na wiadomość.`,
        fileTooLargeTitle: 'Plik zbyt duży',
        fileTooLargeMessage: ({ name, maxMb }: { name: string; maxMb: number }) => `"${name}" przekracza limit ${maxMb}MB i nie został dodany.`,
        uploadFailedTitle: 'Przesyłanie nieudane',
        uploadFailedMessage: ({ count }: { count: number }) => count === 1
            ? 'Nie udało się przesłać jednego zdjęcia i nie zostało wysłane.'
            : `Nie udało się przesłać ${count} zdjęć i nie zostały wysłane.`,
        notSupportedTitle: 'Obrazy nieobsługiwane',
        notSupportedMessage: 'Ten agent nie obsługuje załączników obrazów. Obrazy nie zostały wysłane.',
    },

    feed: {
        // Feed notifications for friend requests and acceptances
    },

} as const;

export type TranslationsPl = typeof pl;
