import type { TranslationStructure } from '../_default';

/**
 * Russian plural helper function
 * Russian has 3 plural forms: one, few, many
 * @param options - Object containing count and the three plural forms
 * @returns The appropriate form based on Russian plural rules
 */
function plural({ count, one, few, many }: { count: number; one: string; few: string; many: string }): string {
    const n = Math.abs(count);
    const n10 = n % 10;
    const n100 = n % 100;
    
    // Rule: ends in 1 but not 11
    if (n10 === 1 && n100 !== 11) return one;
    
    // Rule: ends in 2-4 but not 12-14
    if (n10 >= 2 && n10 <= 4 && (n100 < 10 || n100 >= 20)) return few;
    
    // Rule: everything else (0, 5-9, 11-19, etc.)
    return many;
}

/**
 * Russian translations for the muxr app
 * Must match the exact structure of the English translations
 */
export const ru: TranslationStructure = {
    tabs: {
        // Tab navigation labels
        sessions: 'Терминалы',
        settings: 'Настройки',
    },

    inbox: {
        // Inbox screen: the sessions currently waiting on you
        reason: {
            waiting: 'ожидает',
            blocked: 'заблокирована',
            failed: 'ошибка',
            done: 'готово',
        },
    },

    plugins: {
        openFromHome: 'Откройте плагин с главного экрана.',
        unavailable: 'Этот плагин отключён или недоступен.',
        goBack: 'Назад',
        couldNotLoad: 'Не удалось загрузить элементы',
        dataUnavailable: 'Плагин сейчас недоступен.',
        nothingHere: 'Здесь пока ничего нет',
        newItems: 'Новые элементы появятся здесь.',
        retry: 'Повторить',
        retryItems: 'Повторить загрузку элементов плагина',
        stale: 'Не удалось обновить. Показан последний результат.',
        nothingToShow: 'Нечего показывать.',
        treeUnavailable: 'Дерево недоступно.',
        dictate: 'Диктовать',
        unavailableSuffix: 'недоступно',
        showingStale: 'показаны устаревшие данные',
        settingsTitle: 'Плагины',
        enableAll: 'Включить все',
        disableAll: 'Отключить все',
        installed: 'Установленные',
        herdrAndMuxr: 'Herdr + muxr',
        herdrAndMuxrFooter: 'Herdr выполняет для них действия, панели или события, а они добавляют интерфейс muxr.',
        muxrOnly: 'Только muxr',
        muxrOnlyFooter: 'Herdr только регистрирует их; всё остальное работает через muxr.',
        herdrOnly: 'Только Herdr',
        herdrOnlyFooter: 'Серверные пакеты без интерфейса muxr. Управляйте ими через CLI herdr.',
        waitingHost: 'Ожидание хоста.',
        linkHost: 'Подключите плагин через Herdr и переподключитесь.',
        enabled: 'включено',
        off: 'выкл.',
        on: 'вкл.',
        unavailableLabel: 'Недоступно',
        runsCode: 'Запускает код от вашего имени',
        uiOnly: 'Только интерфейс',
        readsSessions: 'Читает сводки сессий',
        readsTree: 'Читает дерево рабочего пространства',
        openFailed: 'Не удалось открыть',
        actionFailed: 'Ошибка действия',
        items: 'Элементы',
        openWebsite: 'Открыть сайт?',
        open: 'Открыть',
        realtimeConnecting: 'Подключение голосового сеанса',
        realtimeListening: 'Слушаю',
        realtimeThinking: 'Думаю',
        realtimeSpeaking: 'Говорю',
        realtimeError: 'Ошибка голосового сеанса',
        realtimeOff: 'Голосовой сеанс выключен',
        openConversation: 'Открыть голосовой разговор',
        realtime: 'Голос',
    },

    common: {
        // Simple string constants
        cancel: 'Отмена',
        save: 'Сохранить',
        error: 'Ошибка',
        success: 'Успешно',
        ok: 'ОК',
        back: 'Назад',
        create: 'Создать',
        rename: 'Переименовать',
        logout: 'Выйти',
        yes: 'Да',
        no: 'Нет',
        version: 'Версия',
        copied: 'Скопировано',
        copy: 'Копировать',
        scanning: 'Сканирование...',
        home: 'Главная',
        message: 'Сообщение',
        files: 'Файлы',
        fileViewer: 'Просмотр файла',
        loading: 'Загрузка...',
        delete: 'Удалить',
    },

    connect: {
        restoreAccount: 'Восстановить аккаунт',
        enterSecretKey: 'Пожалуйста, введите секретный ключ',
        invalidSecretKey: 'Неверный секретный ключ. Проверьте и попробуйте снова.',
        qrInstructions: '1. Откройте muxr на мобильном устройстве\n2. Перейдите в Настройки → Аккаунт\n3. Нажмите «Привязать новое устройство»\n4. Отсканируйте этот QR-код',
        restoreWithSecretKeyInstead: 'Или восстановить секретным ключом',
    },

    settings: {
        title: 'Настройки',
        github: 'GitHub',
        machines: 'Машины',
        showOfflineMachines: ({ count }: { count: number }) => {
            const lastTwo = count % 100;
            const lastOne = count % 10;
            if (lastTwo >= 11 && lastTwo <= 14) return `Показать ${count} оффлайн-машин`;
            if (lastOne === 1) return `Показать ${count} оффлайн-машину`;
            if (lastOne >= 2 && lastOne <= 4) return `Показать ${count} оффлайн-машины`;
            return `Показать ${count} оффлайн-машин`;
        },
        hideOfflineMachines: 'Скрыть оффлайн-машины',
        features: 'Функции',
        social: 'Социальное',
        account: 'Аккаунт',
        accountSubtitle: 'Управление учётной записью',
        appearance: 'Внешний вид',
        appearanceSubtitle: 'Настройка внешнего вида приложения',
        featuresTitle: 'Возможности',
        featuresSubtitle: 'Включить или отключить функции приложения',
        about: 'О программе',
        aboutFooter: 'muxr — мобильное приложение для работы с Pi. Сквозное шифрование опционально и по умолчанию отключено; данные аккаунта хранятся только на вашем устройстве. Не связано с Anthropic.',
        whatsNew: 'Что нового',
        whatsNewSubtitle: 'Посмотреть последние обновления и улучшения',
        reportIssue: 'Сообщить о проблеме',
        eula: 'EULA',
        connection: 'Подключение',
        connectionSubtitle: 'URL relay-сервера, машина и токен',
        pushNotifications: 'Push-уведомления',
        pushSubtitleSubscribed: 'Включены — уведомление, когда агенту нужен ответ',
        pushSubtitleDenied: 'Заблокировано браузером — разрешите уведомления, чтобы включить',
        pushSubtitleUnsupported: 'Недоступно в этом браузере',
        pushSubtitleDefault: 'Нажмите, чтобы получать уведомления, когда агенту нужен ответ',
        license: 'Лицензия и уведомления',
        // Dynamic settings messages
    },

    settingsAppearance: {
        // Appearance settings screen
        theme: 'Тема',
        themeDescription: 'Выберите предпочтительную цветовую схему',
        themeOptions: {
            adaptive: 'Адаптивная',
            light: 'Светлая', 
            dark: 'Тёмная',
        },
        themeDescriptions: {
            adaptive: 'Следовать настройкам системы',
            light: 'Всегда использовать светлую тему',
            dark: 'Всегда использовать тёмную тему',
        },
        display: 'Отображение',
        displayDescription: 'Управление макетом и интервалами',

        avatarStyle: 'Стиль аватара',
        avatarStyleDescription: 'Выберите внешний вид аватара сессии',
        avatarOptions: {
            pixelated: 'Пиксельная',
            gradient: 'Градиентная',
            brutalist: 'Бруталистская',
        },
        showFlavorIcons: 'Показывать иконки провайдеров ИИ',
        showFlavorIconsDescription: 'Отображать иконки провайдеров ИИ на аватарах сессий',
    },

    settingsFeatures: {
        // Features settings screen
        experiments: 'Эксперименты',
        experimentsDescription: 'Включить экспериментальные функции, которые всё ещё разрабатываются. Эти функции могут быть нестабильными или изменяться без предупреждения.',
        webFeatures: 'Веб-функции',
        webFeaturesDescription: 'Функции, доступные только в веб-версии приложения.',
        commandPalette: 'Command Palette',
        commandPaletteEnabled: 'Нажмите ⌘K для открытия',
        commandPaletteDisabled: 'Быстрый доступ к командам отключён',
        markdownCopyV2: 'Markdown Copy v2',
        markdownCopyV2Subtitle: 'Долгое нажатие открывает модальное окно копирования',
        hideInactiveSessions: 'Скрывать неактивные сессии',
        hideInactiveSessionsSubtitle: 'Показывать в списке только активные чаты',
        imageUpload: 'Загрузка изображений',
        imageUploadSubtitle: 'Прикрепляйте изображения к сообщениям для анализа поддерживаемыми агентами',
    },

    errors: {
        authenticationFailed: 'Ошибка авторизации',
        failedToLoadProfile: 'Не удалось загрузить профиль пользователя',
        userNotFound: 'Пользователь не найден',
        sessionDeleted: 'Сессия была удалена',
        sessionDeletedDescription: 'Эта сессия была окончательно удалена',

        // Error functions with context
        failedToSendRequest: 'Не удалось отправить запрос в друзья',
    },

    newSession: {
        title: 'Начать новую сессию',
        machineOffline: 'Машина недоступна',
        switchMachinesHint: '• Переключите машину, нажав на неё выше',
    },

    settingsConnection: {
        // Connection settings screen (relay URL, machine, token)
        status: ({ status }: { status: string }) => `Статус: ${status}`,
    },

    optionSheet: {
        // Model/mode picker bottom sheet
        all: 'все',
        searchPlaceholder: ({ count }: { count: number }) => `Поиск ${count}`,
        useCustom: ({ value }: { value: string }) => `использовать ${value}`,
        noResults: 'нет результатов',
    },

    homeDock: {
        // Home screen composer
        inputPlaceholder: 'Планируй, спрашивай, создавай…',
        runCommandPlaceholder: 'Выполнить команду',
        askPlaceholder: ({ name }: { name: string }) => `Спросить ${name}`,
    },

    liveTerminals: {
        // Live terminals strip on the home screen
        title: 'LIVE',
    },

    emptySessions: {
        // Empty state shown on tablets when no sessions are active
        noActiveSessions: 'Нет активных сессий',
        startDescription: 'Запустите новую сессию на любой из подключённых машин.',
        noMachinesDescription: 'Откройте новый терминал на компьютере, чтобы начать сессию.',
    },

    sessionHistory: {
        // Used by session history screen
        title: 'История сессий',
        empty: 'Сессии не найдены',
        today: 'Сегодня',
        yesterday: 'Вчера',
        daysAgo: ({ count }: { count: number }) => `${count} ${plural({ count, one: 'день', few: 'дня', many: 'дней' })} назад`,
    },


    sessionInfo: {
        // Used by Session Info screen (app/(app)/session/[id]/info.tsx)
        archiveSession: 'Архивировать сессию',
        muxrSessionIdCopied: 'ID сессии muxr скопирован в буфер обмена',
        failedToCopySessionId: 'Не удалось скопировать ID сессии muxr',
        muxrSessionId: 'ID сессии muxr',
        claudeCodeSessionId: 'ID сессии Pi',
        claudeCodeSessionIdCopied: 'ID сессии Pi скопирован в буфер обмена',
        codexThreadId: 'ID треда Pi',
        codexThreadIdCopied: 'ID треда Pi скопирован в буфер обмена',
        aiProvider: 'Поставщик ИИ',
        failedToCopyClaudeCodeSessionId: 'Не удалось скопировать ID сессии Pi',
        failedToCopyCodexThreadId: 'Не удалось скопировать ID треда Pi',
        metadataCopied: 'Метаданные скопированы в буфер обмена',
        failedToCopyMetadata: 'Не удалось скопировать метаданные',
        failedToArchiveSession: 'Не удалось архивировать сессию',
        connectionStatus: 'Статус подключения',
        created: 'Создано',
        lastUpdated: 'Последнее обновление',
        sequence: 'Последовательность',
        quickActions: 'Быстрые действия',
        viewMachine: 'Посмотреть машину',
        viewMachineSubtitle: 'Посмотреть детали машины и сессии',
        resumeSession: 'Resume Session',
        resumeSessionSubtitle: 'Resume this session on the same machine',
        resumeSessionSameMachineOnly: 'This session can only be resumed on the same machine it started on.',
        resumeSessionMachineOffline: 'This machine is offline. Resume is only available while it is online.',
        resumeSessionMissingMachine: 'This session is missing its machine metadata, so it cannot be resumed.',
        resumeSessionMissingBackendId: 'This session does not have a resumable Pi identifier.',
        resumeSessionUnexpectedDirectoryPrompt: 'Resume cannot create directories. Start the session manually from its original path.',
        archiveSessionSubtitle: 'Архивировать эту сессию и остановить её',
        metadata: 'Метаданные',
        host: 'Хост',
        path: 'Путь',
        operatingSystem: 'Операционная система',
        processId: 'ID процесса',
        muxrHome: 'Домашний каталог muxr',
        copyMetadata: 'Копировать метаданные',
        agentState: 'Состояние агента',
        controlledByUser: 'Управляется пользователем',
        pendingRequests: 'Ожидающие запросы',
        activity: 'Активность',
        thinking: 'Думает',
        thinkingSince: 'Думает с',
        cliVersion: 'Версия CLI',
        deleteSession: 'Удалить сессию',
        deleteSessionSubtitle: 'Удалить эту сессию навсегда',
        deleteSessionWarning: 'Это действие нельзя отменить. Все сообщения и данные, связанные с этой сессией, будут удалены навсегда.',
        failedToDeleteSession: 'Не удалось удалить сессию',
        worktreeCleanupTitle: 'Удалить Worktree?',
        worktreeCleanupMessage: 'В Worktree нет незафиксированных изменений. Хотите удалить файлы Worktree?',
        worktreeCleanupDelete: 'Удалить Worktree',
        worktreeCleanupKeep: 'Сохранить файлы',
        landWorktree: 'Land Worktree',
        landWorktreeSubtitle: 'Squash this worktree onto the base branch and remove it',
        landWorktreeMessage: 'Commit message for the squashed change',
        landWorktreeFailed: 'Failed to land worktree',
        landWorktreeDone: 'Landed on the base branch. The worktree is gone.',
    },

    archive: {
        select: 'Выбрать',
        selectAll: 'Выбрать все',
        deselectAll: 'Снять выделение',
        archiveCount: ({ count }: { count: number }) => plural({ count, one: 'Архивировать 1 сессию', few: `Архивировать ${count} сессии`, many: `Архивировать ${count} сессий` }),
        unarchiveCount: ({ count }: { count: number }) => plural({ count, one: 'Восстановить 1 сессию', few: `Восстановить ${count} сессии`, many: `Восстановить ${count} сессий` }),
        selectedCount: ({ count }: { count: number }) => `Выбрано: ${count}`,
        archivedCount: ({ count }: { count: number }) => plural({ count, one: 'Архивирована 1 сессия', few: `Архивировано ${count} сессии`, many: `Архивировано ${count} сессий` }),
        undo: 'Отменить',
    },

    components: {
        sessionStatusBar: {
            contextUsage: ({ used, total, percent }: { used: string; total: string; percent: number }) => `Контекст ${used} из ${total} токенов, ${percent}%`,
            limitFiveHour: 'Лимит 5 часов',
            limitSevenDay: 'Лимит 7 дней',
            limitResets: ({ time }: { time: string }) => `сброс ${time}`,
            limitAsOf: ({ age }: { age: string }) => `данные ${age} назад`,
            limitRemaining: ({ percent }: { percent: number }) => `осталось ${percent}%`,
        },
    },

    profile: {
        details: 'Детали',
        firstName: 'Имя',
        lastName: 'Фамилия',
        username: 'Имя пользователя',
        status: 'Статус',
    },


    status: {
        connected: 'подключено',
        connecting: 'подключение',
        disconnected: 'отключено',
        error: 'ошибка',
        pairingIssue: 'проблема сопряжения',
        online: 'online',
        offline: 'offline',
        lastSeen: ({ time }: { time: string }) => `в сети ${time}`,
        permissionRequired: 'требуется разрешение',
        activeNow: 'Активен сейчас',
        unknown: 'неизвестно',
        unread: 'новые результаты',
    },

    time: {
        justNow: 'только что',
        minutesAgo: ({ count }: { count: number }) => `${count} ${plural({ count, one: 'минуту', few: 'минуты', many: 'минут' })} назад`,
        hoursAgo: ({ count }: { count: number }) => `${count} ${plural({ count, one: 'час', few: 'часа', many: 'часов' })} назад`,
        daysAgo: ({ count }: { count: number }) => `${count} ${plural({ count, one: 'день', few: 'дня', many: 'дней' })} назад`,
    },

    session: {
        inputPlaceholder: 'Введите сообщение...',
        inactiveArchived: 'Эта сессия неактивна.',
        resumeFromTerminal: 'Чтобы возобновить её из терминала:',
        newChat: 'Новый чат',
        forkAction: 'Форкнуть сессию',
        forkSubtitle: 'Продолжить в новой сессии с тем же контекстом',
        duplicateAction: 'Откатиться к сообщению…',
        duplicateSubtitle: 'Вернуться к выбранной точке и попробовать иначе',
        duplicateSheetTitle: 'Выберите точку отката',
        duplicateSheetSubtitle: 'Новая сессия сохранит выбранный ход целиком (ваше сообщение и ответ агента) и отбросит все следующие запросы.',
        duplicateSheetConfirm: 'Откатить',
        duplicateSheetEmpty: 'В этой сессии пока нет сообщений, к которым можно откатиться.',
        duplicateRowDisabled: 'К этому сообщению нельзя откатиться.',
        forkedFromLabel: 'Форкнуто из',
        forkedFromSubtitle: 'Открыть исходную сессию, из которой сделан форк',
        forkErrorMissingMetadata: 'Не хватает метаданных сессии для форка.',
        forkErrorGeneric: 'Не удалось форкнуть сессию.',
    },

    commandPalette: {
        placeholder: 'Введите команду или поиск...',
    },

    agentInput: {
        permissionMode: {
            title: 'РЕЖИМ РАЗРЕШЕНИЙ',
            default: 'По умолчанию',
            acceptEdits: 'Принимать правки',
            plan: 'Режим планирования',
            dontAsk: 'Не спрашивать',
            bypassPermissions: 'YOLO режим',
        },
        agent: {
            pi: 'Pi',
        },
        model: {
            title: 'МОДЕЛЬ',
            configureInCli: 'Настройте модели в настройках CLI',
        },
        effort: {
            title: 'УСИЛИЕ',
        },
        codexPermissionMode: {
            title: 'РЕЖИМ РАЗРЕШЕНИЙ PI',
            default: 'Настройки CLI',
            readOnly: 'Read Only Mode',
            safeYolo: 'Safe YOLO',
            yolo: 'YOLO',
            defaultDescription: 'спрашивать перед недоверенными командами',
            readOnlyDescription: 'без записи',
            safeYoloDescription: 'без запросов, песочница рабочей папки',
            yoloDescription: 'без запросов, полный доступ',
        },

        geminiPermissionMode: {
            title: 'РЕЖИМ РАЗРЕШЕНИЙ',
            default: 'По умолчанию',
            autoEdit: 'Авто-редактирование',
            yolo: 'YOLO',
            plan: 'Планирование',
        },
        context: {
            remaining: ({ percent }: { percent: number }) => `Осталось ${percent}%`,
        },
        suggestion: {
            fileLabel: 'ФАЙЛ',
            folderLabel: 'ПАПКА',
        },
        noMachinesAvailable: 'Нет машин',
    },

    machineLauncher: {
        showLess: 'Показать меньше',
        showAll: ({ count }: { count: number }) => `Показать все (${count} ${plural({ count, one: 'путь', few: 'пути', many: 'путей' })})`,
        enterCustomPath: 'Ввести свой путь',
    },

    sidebar: {
        sessionsTitle: 'muxr',
        showArchived: 'Показать архив',
        hideArchived: 'Скрыть архив',
        newSession: 'Новая сессия',
    },

    zen: {
        toggle: 'Дзен-режим',
    },

    toolView: {
        input: 'Входные данные',
        output: 'Результат',
    },

    thinking: {
        active: 'Думает…',
        thought: 'Думало',
        thoughtFor: ({ duration }: { duration: string }) => `Думало ${duration}`,
    },

    sessionAttachments: {
        title: ({ count }: { count: number }) => plural({ count, one: '1 вложение', few: `${count} вложения`, many: `${count} вложений` }),
    },

    turnChanges: {
        filesChanged: ({ count }: { count: number }) => plural({ count, one: 'Изменён 1 файл', few: `Изменено ${count} файла`, many: `Изменено ${count} файлов` }),
    },

    tools: {
        fullView: {
            description: 'Описание',
            inputParams: 'Входные параметры',
            output: 'Результат',
            error: 'Ошибка',
            completed: 'Инструмент выполнен успешно',
            noOutput: 'Результат не получен',
            rawJsonDevMode: 'Исходный JSON (режим разработчика)',
        },


        names: {
            search: 'Поиск',
        },

        desc: {
        }
    },

    files: {
        changes: 'Изменения',
        searchPlaceholder: 'Поиск файлов...',
        detachedHead: 'отделённый HEAD',
        summary: ({ staged, unstaged }: { staged: number; unstaged: number }) => `${staged} подготовлено • ${unstaged} не подготовлено`,
        notRepo: 'Не является git-репозиторием',
        notUnderGit: 'Эта папка не находится под управлением git',
        searching: 'Поиск файлов...',
        noFilesFound: 'Файлы не найдены',
        noFilesInProject: 'Файлов в проекте нет',
        tryDifferentTerm: 'Попробуйте другой поисковый запрос',
        searchResults: ({ count }: { count: number }) => `Результаты поиска (${count})`,
        projectRoot: 'Корень проекта',
        stagedChanges: ({ count }: { count: number }) => `Подготовленные изменения (${count})`,
        unstagedChanges: ({ count }: { count: number }) => `Неподготовленные изменения (${count})`,
        // File viewer strings
        loadingFile: ({ fileName }: { fileName: string }) => `Загрузка ${fileName}...`,
        binaryFile: 'Бинарный файл',
        cannotDisplayBinary: 'Невозможно отобразить содержимое бинарного файла',
        diff: 'Различия',
        file: 'Файл',
        fileEmpty: 'Файл пустой',
        fileDeleted: 'Этот файл больше не существует',
        previousDocument: 'Предыдущий документ',
        nextDocument: 'Следующий документ',
        previousChange: 'Предыдущее изменение',
        nextChange: 'Следующее изменение',
        toggleFileAndDiff: 'Переключить файл и различия',
        previousFile: 'Предыдущий файл',
        nextFile: 'Следующий файл',
        previousFileNamed: ({ title, ordinal, total }: { title: string; ordinal: number; total: number }) => `Предыдущий файл, ${title}, ${ordinal} из ${total}`,
        nextFileNamed: ({ title, ordinal, total }: { title: string; ordinal: number; total: number }) => `Следующий файл, ${title}, ${ordinal} из ${total}`,
        filePosition: ({ current, total }: { current: number; total: number }) => `Файл ${current} из ${total}`,
        diffUnavailable: 'Различия, недоступны, для этого файла нет изменений',
        previousChangeAt: ({ current, total }: { current: number; total: number }) => `Предыдущее изменение, ${current} из ${total}`,
        nextChangeAt: ({ current, total }: { current: number; total: number }) => `Следующее изменение, ${current} из ${total}`,
        graphicsUnavailable: 'Графика недоступна',
        showFullPath: 'Показать полный путь',
        pathShowFullPath: ({ label }: { label: string }) => `Путь ${label}, показать полный путь`,
        goToPath: ({ label }: { label: string }) => `Перейти к ${label}`,
        fullPath: 'Полный путь',
        noChanges: 'Нет изменений для отображения',
        noChangesTitle: 'Нет изменений',
        noChangesSubtitle: 'Рабочее дерево чистое',
        deleted: 'Удалён',
        changedFiles: ({ count }: { count: number }) => `${count} ${count === 1 ? 'изменённый файл' : count < 5 ? 'изменённых файла' : 'изменённых файлов'}`,
        allFiles: 'Все файлы',
        addPanel: 'Добавить панель',
        closePanel: 'Закрыть панель',
        editFile: 'Редактировать',
        saveFile: 'Сохранить',
        failedToRead: 'Не удалось прочитать файл',
        failedToSave: 'Не удалось сохранить файл',
        fileConflict: 'Конфликт файла',
        fileConflictDescription: 'Файл был изменён на устройстве пока вы его редактировали. Перезагрузите чтобы увидеть актуальную версию.',
        reload: 'Перезагрузить',
        overwrite: 'Перезаписать',
    },
    sideChat: {
        panelTitle: 'Боковой чат',
        emptyTitle: 'Начните боковой чат',
        emptySubtitle: 'Спросите агента что-нибудь в стороне. Он наследует контекст этого чата, но остаётся изолированным — ничто здесь не затрагивает основной разговор.',
        startButton: 'Начать боковой чат',
        creating: 'Запуск бокового чата…',
        unavailable: 'Эта сессия пока не может начать боковой чат — дождитесь, когда агент выйдет в сеть.',
        expand: 'Открыть на весь экран',
        tabLabel: ({ index }: { index: number }) => `Боковой чат ${index}`,
        newChat: 'Новый боковой чат',
        close: 'Закрыть боковой чат',
    },


    settingsAccount: {
        // Account settings screen
        accountInformation: 'Информация об аккаунте',
        status: 'Статус',
        statusActive: 'Активный',
        statusNotAuthenticated: 'Не авторизован',
        anonymousId: 'Анонимный ID',
        publicId: 'Публичный ID',
        notAvailable: 'Недоступно',
        linkNewDevice: 'Привязать новое устройство',
        linkNewDeviceSubtitle: 'Отсканируйте QR-код для привязки устройства',
        backup: 'Резервная копия',
        backupDescription: 'Ваш секретный ключ - единственный способ восстановить ваш аккаунт. Сохраните его в безопасном месте, например в менеджере паролей.',
        secretKey: 'Секретный ключ',
        tapToReveal: 'Нажмите для показа',
        tapToHide: 'Нажмите для скрытия',
        secretKeyLabel: 'СЕКРЕТНЫЙ КЛЮЧ (НАЖМИТЕ ДЛЯ КОПИРОВАНИЯ)',
        secretKeyCopied: 'Секретный ключ скопирован в буфер обмена. Сохраните его в безопасном месте!',
        secretKeyCopyFailed: 'Не удалось скопировать секретный ключ',
        dangerZone: 'Опасная зона',
        logout: 'Выйти',
        logoutSubtitle: 'Выйти из аккаунта и очистить локальные данные',
        logoutConfirm: 'Вы уверены, что хотите выйти? Убедитесь, что вы сохранили резервную копию секретного ключа!',
    },


    updateBanner: {
        updateAvailable: 'Доступно обновление',
        pressToApply: 'Нажмите, чтобы применить обновление',
        whatsNew: 'Что нового',
        seeLatest: 'Посмотреть последние обновления и улучшения',
        nativeUpdateAvailable: 'Доступно обновление приложения',
        tapToUpdateAppStore: 'Нажмите для обновления в App Store',
        tapToUpdatePlayStore: 'Нажмите для обновления в Play Store',
    },

    changelog: {
        // Used by the changelog screen
        noEntriesAvailable: 'Записи журнала изменений недоступны.',
    },

    terminal: {
        // Used by terminal connection screens
        webBrowserRequired: 'Требуется веб-браузер',
        webBrowserRequiredDescription: 'Ссылки подключения терминала можно открывать только в веб-браузере по соображениям безопасности. Используйте сканер QR-кодов или откройте эту ссылку на компьютере.',
        processingConnection: 'Обработка подключения...',
        invalidConnectionLink: 'Неверная ссылка подключения',
        invalidConnectionLinkDescription: 'Ссылка подключения отсутствует или неверна. Проверьте URL и попробуйте снова.',
        connectTerminal: 'Подключить терминал',
        terminalRequestDescription: 'Терминал запрашивает подключение к вашему аккаунту muxr. Это позволит терминалу безопасно отправлять и получать сообщения.',
        connectionDetails: 'Детали подключения',
        publicKey: 'Публичный ключ',
        encryption: 'Шифрование',
        endToEndEncrypted: 'Сквозное шифрование',
        acceptConnection: 'Принять подключение',
        connecting: 'Подключение...',
        reject: 'Отклонить',
        security: 'Безопасность',
        securityFooter: 'Эта ссылка подключения была безопасно обработана в вашем браузере и никогда не отправлялась на сервер. Ваши личные данные останутся в безопасности, и только вы можете расшифровать сообщения.',
        securityFooterDevice: 'Это подключение было безопасно обработано на вашем устройстве и никогда не отправлялось на сервер. Ваши личные данные останутся в безопасности, и только вы можете расшифровать сообщения.',
        clientSideProcessing: 'Обработка на стороне клиента',
        linkProcessedLocally: 'Ссылка обработана локально в браузере',
        linkProcessedOnDevice: 'Ссылка обработана локально на устройстве',
    },

    modals: {
        // Used across connect flows and settings
        deviceLinkedSuccessfully: 'Устройство успешно связано',
        invalidAuthUrl: 'Неверный URL авторизации',
        developerMode: 'Режим разработчика',
        developerModeEnabled: 'Режим разработчика включен',
        developerModeDisabled: 'Режим разработчика отключен',
        failedToLinkDevice: 'Не удалось связать устройство',
        cameraPermissionsRequiredToScanQr: 'Для сканирования QR-кодов требуется доступ к камере'
    },

    navigation: {
        // Navigation titles and screen headers
        connectTerminal: 'Подключить терминал',
        linkNewDevice: 'Связать новое устройство',
        restoreWithSecretKey: 'Восстановить секретным ключом',
        browserTakeover: 'Управление браузером',
        whatsNew: 'Что нового',
        friends: 'Друзья',
    },

    welcome: {
        // Main welcome screen for unauthenticated users
        title: 'Мобильный клиент Pi',
        subtitle: 'Аккаунт хранится только на вашем устройстве. Сквозное шифрование опционально.',
        createAccount: 'Создать аккаунт',
        linkOrRestoreAccount: 'Связать или восстановить аккаунт',
        loginWithMobileApp: 'Войти через мобильное приложение',
    },

    review: {
        // Used by utils/requestReview.ts
        enjoyingApp: 'Нравится приложение?',
        feedbackPrompt: 'Мы будем рады вашему отзыву!',
        yesILoveIt: 'Да, мне нравится!',
        notReally: 'Не совсем'
    },

    items: {
        // Used by Item component for copy toast
        copiedToClipboard: ({ label }: { label: string }) => `${label} скопировано в буфер обмена`
    },

    machine: {
        offlineUnableToSpawn: 'Запуск отключен: машина offline',
        launchNewSessionInDirectory: 'Запустить новую сессию в папке',
        daemon: 'Daemon',
        status: 'Статус',
        stopDaemon: 'Остановить daemon',
        lastKnownPid: 'Последний известный PID',
        lastKnownHttpPort: 'Последний известный HTTP порт',
        startedAt: 'Запущен в',
        cliVersion: 'Версия CLI',
        daemonStateVersion: 'Версия состояния daemon',
        stopDaemonConfirmTitle: 'Остановить daemon?',
        stopDaemonConfirmMessage: 'Вы не сможете запускать новые сессии на этой машине, пока снова не перезапустите daemon на компьютере. Текущие сессии продолжат работать.',
        daemonStopped: 'Daemon остановлен',
        stopDaemonFailed: 'Не удалось остановить daemon. Возможно, он не запущен.',
        machineGroup: 'Машина',
        host: 'Хост',
        machineId: 'ID машины',
        username: 'Имя пользователя',
        homeDirectory: 'Домашний каталог',
        platform: 'Платформа',
        architecture: 'Архитектура',
        lastSeen: 'Последняя активность',
        never: 'Никогда',
        metadataVersion: 'Версия метаданных',
        cliAvailability: 'Доступность CLI',
        cliInstalled: 'Установлен',
        cliNotFound: 'Не найден',
        lastDetected: 'Последнее обнаружение',
        back: 'Назад',
        dangerZone: 'Опасная зона',
        delete: 'Удалить машину',
        deleteFooter: 'Удаляет машину из вашего аккаунта. История сессий сохраняется, но вы больше не сможете запускать новые сессии на ней.',
        deleteConfirmTitle: 'Удалить эту машину?',
        deleteConfirmMessage: 'Машина будет удалена из вашего аккаунта. История сессий сохраняется, но вы больше не сможете запускать новые сессии, пока не подключите демон заново.',
        deleteFailed: 'Не удалось удалить машину.',
    },

    message: {
        switchedToMode: ({ mode }: { mode: string }) => `Переключено в режим ${mode}`,
        unknownEvent: 'Неизвестное событие',
        usageLimitUntil: ({ time }: { time: string }) => `Лимит использования достигнут до ${time}`,
        sentAsGoal: 'Отправлено в качестве цели',
        unknownTime: 'неизвестное время',
    },

    codex: {
        // Pi permission dialog buttons
        permissions: {
            yesForSession: 'Да, и не спрашивать для этой сессии',
            stopAndExplain: 'Остановить и объяснить, что делать',
        }
    },

    claude: {
        // Pi permission dialog buttons
        permissions: {
            yesAllowAllEdits: 'Да, разрешить все правки в этой сессии',
            yesAllowEverything: 'Да, разрешить всё в этой сессии',
            yesForTool: 'Да, больше не спрашивать для этого инструмента',
            noTellClaude: 'Нет, дать обратную связь',
        }
    },

    settingsLanguage: {
        // Language settings screen
        title: 'Язык',
        description: 'Выберите предпочтительный язык интерфейса приложения. Настройки синхронизируются на всех ваших устройствах.',
        currentLanguage: 'Текущий язык',
        automatic: 'Автоматически',
        automaticSubtitle: 'Определять по настройкам устройства',
        needsRestart: 'Язык изменён',
        needsRestartMessage: 'Приложение нужно перезапустить для применения новых языковых настроек.',
    },

    textSelection: {
        // Text selection screen
        title: 'Выделить текст',
        noTextProvided: 'Текст не предоставлен',
        textNotFound: 'Текст не найден или устарел',
        textCopied: 'Текст скопирован в буфер обмена',
        failedToCopy: 'Не удалось скопировать текст в буфер обмена',
        noTextToCopy: 'Нет текста для копирования',
    },

    markdown: {
        // Markdown copy functionality
        codeCopied: 'Код скопирован',
        copyFailed: 'Ошибка копирования',
        mermaidRenderFailed: 'Не удалось отобразить диаграмму mermaid',
    },

    artifacts: {
        // Artifacts feature
        title: 'Артефакты',
        empty: 'Артефактов пока нет',
        emptyDescription: 'Создайте первый артефакт, чтобы начать',
        new: 'Новый артефакт',
        edit: 'Редактировать артефакт',
        delete: 'Удалить',
        updateError: 'Не удалось обновить артефакт. Пожалуйста, попробуйте еще раз.',
        notFound: 'Артефакт не найден',
        deleteConfirm: 'Удалить артефакт?',
        deleteConfirmDescription: 'Это действие нельзя отменить',
        titleLabel: 'ЗАГОЛОВОК',
        titlePlaceholder: 'Введите заголовок для вашего артефакта',
        bodyLabel: 'СОДЕРЖИМОЕ',
        bodyPlaceholder: 'Напишите ваш контент здесь...',
        emptyFieldsError: 'Пожалуйста, введите заголовок или содержимое',
        createError: 'Не удалось создать артефакт. Пожалуйста, попробуйте снова.',
        loading: 'Загрузка артефактов...',
        error: 'Не удалось загрузить артефакт',
    },

    friends: {
        // Friends feature
        manageFriends: 'Управляйте своими друзьями и связями',
        pendingRequests: 'Запросы в друзья',
        myFriends: 'Мои друзья',
        noFriendsYet: 'У вас пока нет друзей',
        remove: 'Удалить',
        addFriend: 'Добавить в друзья',
        alreadyFriends: 'Уже в друзьях',
        requestPending: 'Запрос отправлен',
        searchInstructions: 'Введите имя пользователя для поиска друзей',
        searchPlaceholder: 'Введите имя пользователя...',
        searching: 'Поиск...',
        noUserFound: 'Пользователь с таким именем не найден',
        checkUsername: 'Пожалуйста, проверьте имя пользователя и попробуйте снова',
        howToFind: 'Как найти друзей',
        findInstructions: 'Ищите друзей по имени пользователя. И вы, и ваш друг должны подключить GitHub для отправки запросов в друзья.',
        requestSent: 'Запрос в друзья отправлен!',
        confirmRemove: 'Удалить из друзей',
        confirmRemoveMessage: 'Вы уверены, что хотите удалить этого друга?',
        cannotAddYourself: 'Вы не можете отправить запрос в друзья самому себе',
        bothMustHaveGithub: 'Оба пользователя должны подключить GitHub, чтобы стать друзьями',
        status: {
            none: 'Не подключен',
            requested: 'Запрос отправлен',
            pending: 'Запрос ожидается',
            friend: 'Друзья',
            rejected: 'Отклонено',
        },
        acceptRequest: 'Принять запрос',
        removeFriend: 'Удалить из друзей',
        removeFriendConfirm: ({ name }: { name: string }) => `Вы уверены, что хотите удалить ${name} из друзей?`,
        requestFriendship: 'Отправить запрос в друзья',
        cancelRequest: 'Отменить запрос в друзья',
        cancelRequestConfirm: ({ name }: { name: string }) => `Отменить ваш запрос в друзья к ${name}?`,
        denyRequest: 'Отклонить запрос',
    },

    usage: {
        // Usage panel strings
        today: 'Сегодня',
        last7Days: 'Последние 7 дней',
        last30Days: 'Последние 30 дней',
        totalTokens: 'Всего токенов',
        totalCost: 'Общая стоимость',
        tokens: 'Токены',
        cost: 'Стоимость',
        usageOverTime: 'Использование во времени',
        byModel: 'По модели',
    },

    imageUpload: {
        permissionTitle: 'Доступ к библиотеке фото',
        permissionMessage: 'Разрешите доступ к вашей библиотеке фото, чтобы прикреплять изображения к сообщениям.',
        limitTitle: 'Достигнут лимит изображений',
        limitMessage: ({ max }: { max: number }) => `Можно прикрепить не более ${max} изображений на сообщение.`,
        fileTooLargeTitle: 'Файл слишком большой',
        fileTooLargeMessage: ({ name, maxMb }: { name: string; maxMb: number }) => `"${name}" превышает лимит ${maxMb}МБ и не был добавлен.`,
        uploadFailedTitle: 'Ошибка загрузки',
        uploadFailedMessage: ({ count }: { count: number }) => count === 1
            ? 'Одно изображение не удалось загрузить — оно не было отправлено.'
            : `${count} изображений не удалось загрузить — они не были отправлены.`,
        notSupportedTitle: 'Изображения не поддерживаются',
        notSupportedMessage: 'Этот агент не поддерживает вложения изображений. Изображения не были отправлены.',
    },

    feed: {
        // Feed notifications for friend requests and acceptances
    },

} as const;

export type TranslationsRu = typeof ru;
