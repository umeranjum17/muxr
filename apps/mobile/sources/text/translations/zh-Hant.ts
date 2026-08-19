/**
 * Chinese (Traditional) translations for the muxr app
 * Values can be:
 * - String constants for static text
 * - Functions with typed object parameters for dynamic text
 */

import { TranslationStructure } from "../_default";

/**
 * Chinese plural helper function
 * @param options - Object containing count, singular, and plural forms
 * @returns The appropriate form based on count
 */
function plural({ count, singular, plural }: { count: number; singular: string; plural: string }): string {
    return count === 1 ? singular : plural;
}

export const zhHant: TranslationStructure = {
    tabs: {
        // Tab navigation labels
        sessions: '終端',
        settings: '設定',
    },

    inbox: {
        // Inbox screen: the sessions currently waiting on you
        reason: {
            waiting: '等待中',
            blocked: '受阻',
            failed: '失敗',
            done: '已完成',
        },
    },

    plugins: {
        openFromHome: '從首頁開啟外掛程式。',
        unavailable: '此外掛程式已停用或無法使用。',
        goBack: '返回',
        couldNotLoad: '無法載入項目',
        dataUnavailable: '外掛程式目前無法使用。',
        nothingHere: '這裡沒有內容',
        newItems: '新項目會顯示在這裡。',
        retry: '重試',
        retryItems: '重新載入外掛程式項目',
        stale: '無法重新整理，正在顯示上次結果。',
        nothingToShow: '沒有可顯示的內容。',
        treeUnavailable: '樹狀結構無法使用。',
        dictate: '聽寫',
        unavailableSuffix: '無法使用',
        showingStale: '正在顯示舊資料',
        settingsTitle: '外掛程式',
        enableAll: '全部啟用',
        disableAll: '全部停用',
        installed: '已安裝',
        waitingHost: '正在等待主機。',
        linkHost: '透過 Herdr 連結外掛程式後重新連線。',
        enabled: '已啟用',
        off: '關',
        on: '開',
        unavailableLabel: '無法使用',
        runsCode: '以你的身分執行程式碼',
        uiOnly: '僅介面',
        readsSessions: '讀取工作階段摘要',
        readsTree: '讀取工作區樹',
        openFailed: '無法開啟',
        actionFailed: '操作失敗',
        items: '項目',
        openWebsite: '開啟網站？',
        open: '開啟',
        realtimeConnecting: '正在連接語音工作階段',
        realtimeListening: '正在聆聽',
        realtimeThinking: '正在思考',
        realtimeSpeaking: '正在說話',
        realtimeError: '語音工作階段錯誤',
        realtimeOff: '語音工作階段已關閉',
        openConversation: '開啟語音對話',
        realtime: '語音',
    },

    common: {
        // Simple string constants
        cancel: '取消',
        save: '儲存',
        error: '錯誤',
        success: '成功',
        ok: '確定',
        back: '返回',
        create: '建立',
        rename: '重新命名',
        logout: '登出',
        yes: '是',
        no: '否',
        version: '版本',
        copied: '已複製',
        copy: '複製',
        scanning: '掃描中...',
        home: '首頁',
        message: '訊息',
        files: '檔案',
        fileViewer: '檔案檢視器',
        loading: '載入中...',
        delete: '刪除',
    },

    profile: {
        details: '詳情',
        firstName: '名',
        lastName: '姓',
        username: '使用者名稱',
        status: '狀態',
    },

    status: {
        connected: '已連線',
        connecting: '連線中',
        disconnected: '已中斷連線',
        error: '錯誤',
        pairingIssue: '配對問題',
        online: '線上',
        offline: '離線',
        lastSeen: ({ time }: { time: string }) => `最後活躍時間 ${time}`,
        permissionRequired: '需要權限',
        activeNow: '目前活躍',
        unknown: '未知',
        unread: '新結果',
    },

    time: {
        justNow: '剛剛',
        minutesAgo: ({ count }: { count: number }) => `${count} 分鐘前`,
        hoursAgo: ({ count }: { count: number }) => `${count} 小時前`,
        daysAgo: ({ count }: { count: number }) => `${count} 天前`,
    },

    connect: {
        restoreAccount: '恢復帳戶',
        enterSecretKey: '請輸入金鑰',
        invalidSecretKey: '無效的金鑰，請檢查後重試。',
        qrInstructions: '1. 在您的行動裝置上開啟 muxr\n2. 前往 設定 → 帳戶\n3. 點選「連結新裝置」\n4. 掃描此 QR Code',
        restoreWithSecretKeyInstead: '或改用金鑰恢復',
    },

    settings: {
        title: '設定',
        github: 'GitHub',
        machines: '裝置',
        showOfflineMachines: ({ count }: { count: number }) => `顯示 ${count} 台離線裝置`,
        hideOfflineMachines: '隱藏離線裝置',
        features: '功能',
        social: '社交',
        account: '帳戶',
        accountSubtitle: '管理您的帳戶詳情',
        appearance: '外觀',
        appearanceSubtitle: '自訂應用程式外觀',
        featuresTitle: '功能',
        featuresSubtitle: '啟用或停用應用程式功能',
        about: '關於',
        aboutFooter: 'muxr 是一個 Pi 行動用戶端。端對端加密為選用功能，預設關閉；您的帳戶僅儲存在本機裝置上。與 Anthropic 無關聯。',
        whatsNew: '更新日誌',
        whatsNewSubtitle: '查看最新更新和改進',
        reportIssue: '回報問題',
        eula: '終端使用者授權協議',
        connection: '連線',
        connectionSubtitle: '中繼 URL、機器與權杖',
        pushNotifications: '推播通知',
        pushSubtitleSubscribed: '已開啟 — 當代理需要回答時通知您',
        pushSubtitleDenied: '已被瀏覽器封鎖 — 請允許通知以啟用',
        pushSubtitleUnsupported: '此瀏覽器不支援',
        pushSubtitleDefault: '點選以在代理需要回答時收到通知',
        license: '授權條款與聲明',
        // Dynamic settings messages
    },

    settingsAppearance: {
        // Appearance settings screen
        theme: '主題',
        themeDescription: '選擇您喜歡的配色方案',
        themeOptions: {
            adaptive: '自適應',
            light: '淺色',
            dark: '深色',
        },
        themeDescriptions: {
            adaptive: '跟隨系統設定',
            light: '始終使用淺色主題',
            dark: '始終使用深色主題',
        },
        display: '顯示',
        displayDescription: '控制版面配置和間距',

        avatarStyle: '頭像風格',
        avatarStyleDescription: '選擇工作階段頭像外觀',
        avatarOptions: {
            pixelated: '像素化',
            gradient: '漸層',
            brutalist: '粗獷風格',
        },
        showFlavorIcons: '顯示 AI 提供者圖示',
        showFlavorIconsDescription: '在工作階段頭像上顯示 AI 提供者圖示',
    },

    settingsFeatures: {
        // Features settings screen
        experiments: '實驗功能',
        experimentsDescription: '啟用仍在開發中的實驗功能。這些功能可能不穩定或會在沒有通知的情況下改變。',
        webFeatures: 'Web 功能',
        webFeaturesDescription: '僅在應用程式的 Web 版本中可用的功能。',
        commandPalette: '命令面板',
        commandPaletteEnabled: '按 ⌘K 開啟',
        commandPaletteDisabled: '快速命令存取已停用',
        markdownCopyV2: 'Markdown 複製 v2',
        markdownCopyV2Subtitle: '長按開啟複製強制回應視窗',
        hideInactiveSessions: '隱藏非活躍工作階段',
        hideInactiveSessionsSubtitle: '僅在清單中顯示活躍的聊天',
        imageUpload: '圖片上傳',
        imageUploadSubtitle: '將圖片附加到訊息中，讓支援的代理分析',
    },

    errors: {
        authenticationFailed: '驗證失敗',
        failedToLoadProfile: '無法載入使用者資料',
        userNotFound: '未找到使用者',
        sessionDeleted: '工作階段已被刪除',
        sessionDeletedDescription: '此工作階段已被永久刪除',

        // Error functions with context
        failedToSendRequest: '傳送好友請求失敗',
    },

    newSession: {
        title: '開始新工作階段',
        machineOffline: '裝置離線',
        switchMachinesHint: '• 點擊上方的裝置來切換裝置',
    },

    settingsConnection: {
        // Connection settings screen (relay URL, machine, token)
        status: ({ status }: { status: string }) => `狀態：${status}`,
    },

    optionSheet: {
        // Model/mode picker bottom sheet
        all: '全部',
        searchPlaceholder: ({ count }: { count: number }) => `搜尋 ${count}`,
        useCustom: ({ value }: { value: string }) => `使用 ${value}`,
        noResults: '無結果',
    },

    homeDock: {
        // Home screen composer
        inputPlaceholder: '規劃、提問、建構…',
        runCommandPlaceholder: '執行指令',
        askPlaceholder: ({ name }: { name: string }) => `詢問 ${name}`,
    },

    liveTerminals: {
        // Live terminals strip on the home screen
        title: '直播中',
    },

    emptySessions: {
        // Empty state shown on tablets when no sessions are active
        noActiveSessions: '沒有使用中的會話',
        startDescription: '在任一已連線的機器上啟動新會話。',
        noMachinesDescription: '在電腦上開啟新終端機以啟動會話。',
    },

    sessionHistory: {
        // Used by session history screen
        title: '工作階段歷史',
        empty: '未找到工作階段',
        today: '今天',
        yesterday: '昨天',
        daysAgo: ({ count }: { count: number }) => `${count} 天前`,
    },

    session: {
        inputPlaceholder: '輸入訊息...',
        inactiveArchived: '此會話處於非活動狀態。',
        resumeFromTerminal: '若要從終端恢復它：',
        newChat: '新對話',
        forkAction: '分叉會話',
        forkSubtitle: '在相同上下文中開啟新會話繼續',
        duplicateAction: '從訊息處複製…',
        duplicateSubtitle: '回到選定位置重新嘗試',
        duplicateSheetTitle: '選擇回退點',
        duplicateSheetSubtitle: '新會話將保留所選輪次完整內容（你的訊息與智能體的回覆），並丟棄其後的所有訊息。',
        duplicateSheetConfirm: '複製',
        duplicateSheetEmpty: '此會話還沒有可回退的訊息。',
        duplicateRowDisabled: '此訊息不能作為回退點。',
        forkedFromLabel: '分叉自',
        forkedFromSubtitle: '開啟分叉來源的會話',
        forkErrorMissingMetadata: '缺少分叉所需的會話元資料。',
        forkErrorGeneric: '分叉會話失敗。',
    },

    commandPalette: {
        placeholder: '輸入命令或搜尋...',
    },


    sessionInfo: {
        // Used by Session Info screen (app/(app)/session/[id]/info.tsx)
        archiveSession: '封存工作階段',
        muxrSessionIdCopied: 'muxr 工作階段 ID 已複製到剪貼簿',
        failedToCopySessionId: '複製 muxr 工作階段 ID 失敗',
        muxrSessionId: 'muxr 工作階段 ID',
        claudeCodeSessionId: 'Pi 工作階段 ID',
        claudeCodeSessionIdCopied: 'Pi 工作階段 ID 已複製到剪貼簿',
        codexThreadId: 'Pi 執行緒 ID',
        codexThreadIdCopied: 'Pi 執行緒 ID 已複製到剪貼簿',
        aiProvider: 'AI 提供者',
        failedToCopyClaudeCodeSessionId: '複製 Pi 工作階段 ID 失敗',
        failedToCopyCodexThreadId: '複製 Pi 執行緒 ID 失敗',
        metadataCopied: '中繼資料已複製到剪貼簿',
        failedToCopyMetadata: '複製中繼資料失敗',
        failedToArchiveSession: '封存工作階段失敗',
        connectionStatus: '連線狀態',
        created: '建立時間',
        lastUpdated: '最後更新',
        sequence: '序列',
        quickActions: '快速操作',
        viewMachine: '查看裝置',
        viewMachineSubtitle: '查看裝置詳情和工作階段',
        resumeSession: 'Resume Session',
        resumeSessionSubtitle: 'Resume this session on the same machine',
        resumeSessionSameMachineOnly: 'This session can only be resumed on the same machine it started on.',
        resumeSessionMachineOffline: 'This machine is offline. Resume is only available while it is online.',
        resumeSessionMissingMachine: 'This session is missing its machine metadata, so it cannot be resumed.',
        resumeSessionMissingBackendId: 'This session does not have a resumable Pi identifier.',
        resumeSessionUnexpectedDirectoryPrompt: 'Resume cannot create directories. Start the session manually from its original path.',
        archiveSessionSubtitle: '封存此工作階段並停止它',
        metadata: '中繼資料',
        host: '主機',
        path: '路徑',
        operatingSystem: '作業系統',
        processId: '處理程序 ID',
        muxrHome: 'muxr 主目錄',
        copyMetadata: '複製中繼資料',
        agentState: 'Agent 狀態',
        controlledByUser: '使用者控制',
        pendingRequests: '待處理請求',
        activity: '活動',
        thinking: '思考中',
        thinkingSince: '思考開始時間',
        cliVersion: 'CLI 版本',
        deleteSession: '刪除工作階段',
        deleteSessionSubtitle: '永久刪除此工作階段',
        deleteSessionWarning: '此操作無法復原。與此工作階段相關的所有訊息和資料將被永久刪除。',
        failedToDeleteSession: '刪除工作階段失敗',
        worktreeCleanupTitle: '刪除 Worktree？',
        worktreeCleanupMessage: 'Worktree 沒有未提交的變更。是否要刪除 Worktree 檔案？',
        worktreeCleanupDelete: '刪除 Worktree',
        worktreeCleanupKeep: '保留檔案',
        landWorktree: 'Land Worktree',
        landWorktreeSubtitle: 'Squash this worktree onto the base branch and remove it',
        landWorktreeMessage: 'Commit message for the squashed change',
        landWorktreeFailed: 'Failed to land worktree',
        landWorktreeDone: 'Landed on the base branch. The worktree is gone.',

    },

    archive: {
        select: '選擇',
        selectAll: '全選',
        deselectAll: '取消全選',
        archiveCount: ({ count }: { count: number }) => plural({ count, singular: '封存 1 個工作階段', plural: `封存 ${count} 個工作階段` }),
        unarchiveCount: ({ count }: { count: number }) => plural({ count, singular: '取消封存 1 個工作階段', plural: `取消封存 ${count} 個工作階段` }),
        selectedCount: ({ count }: { count: number }) => `已選擇 ${count} 個`,
        archivedCount: ({ count }: { count: number }) => plural({ count, singular: '已封存 1 個工作階段', plural: `已封存 ${count} 個工作階段` }),
        undo: '復原',
    },

    components: {
        sessionStatusBar: {
            contextUsage: ({ used, total, percent }: { used: string; total: string; percent: number }) => `上下文 ${used}/${total} 個權杖，${percent}%`,
            limitFiveHour: '5 小時額度',
            limitSevenDay: '7 天額度',
            limitResets: ({ time }: { time: string }) => `${time} 重置`,
            limitAsOf: ({ age }: { age: string }) => `數據為 ${age} 前`,
            limitRemaining: ({ percent }: { percent: number }) => `剩餘 ${percent}%`,
        },
    },

    agentInput: {
        permissionMode: {
            title: '權限模式',
            default: '預設',
            acceptEdits: '接受編輯',
            plan: '計畫模式',
            dontAsk: '不再詢問',
            bypassPermissions: 'Yolo 模式',
        },
        agent: {
            pi: 'Pi',
        },
        model: {
            title: '模型',
            configureInCli: '在 CLI 設定中配置模型',
        },
        effort: {
            title: '工作量',
        },
        codexPermissionMode: {
            title: 'PI 權限模式',
            default: 'CLI 設定',
            readOnly: '唯讀模式',
            safeYolo: '安全 YOLO',
            yolo: 'YOLO',
            defaultDescription: '不受信任的命令前詢問',
            readOnlyDescription: '禁止寫入',
            safeYoloDescription: '無需確認，工作區沙盒',
            yoloDescription: '無需確認，完全存取',
        },

        geminiPermissionMode: {
            title: 'PI 權限模式',
            default: '預設',
            autoEdit: '自動編輯',
            yolo: 'YOLO',
            plan: '計畫',
        },
        context: {
            remaining: ({ percent }: { percent: number }) => `剩餘 ${percent}%`,
        },
        suggestion: {
            fileLabel: '檔案',
            folderLabel: '資料夾',
        },
        noMachinesAvailable: '無裝置',
    },

    machineLauncher: {
        showLess: '顯示更少',
        showAll: ({ count }: { count: number }) => `顯示全部 (${count} 個路徑)`,
        enterCustomPath: '輸入自訂路徑',
    },

    sidebar: {
        sessionsTitle: 'muxr',
        showArchived: '顯示已封存',
        hideArchived: '隱藏已封存',
        newSession: '新建對話',
    },

    zen: {
        toggle: '禪模式',
    },

    toolView: {
        input: '輸入',
        output: '輸出',
    },

    thinking: {
        active: 'Thinking…',
        thought: 'Thought',
        thoughtFor: ({ duration }: { duration: string }) => `Thought for ${duration}`,
    },

    sessionAttachments: {
        title: ({ count }: { count: number }) => `${count} 個附件`,
    },

    turnChanges: {
        filesChanged: ({ count }: { count: number }) => `已修改 ${count} 個檔案`,
    },

    tools: {
        fullView: {
            description: '描述',
            inputParams: '輸入參數',
            output: '輸出',
            error: '錯誤',
            completed: '工具已成功完成',
            noOutput: '未產生輸出',
            rawJsonDevMode: '原始 JSON（開發模式）',
        },


        names: {
            search: '搜尋',
        },

        desc: {
        }
    },

    files: {
        changes: '變更',
        searchPlaceholder: '搜尋檔案...',
        detachedHead: '游離 HEAD',
        summary: ({ staged, unstaged }: { staged: number; unstaged: number }) => `${staged} 已暫存 • ${unstaged} 未暫存`,
        notRepo: '不是 git 倉庫',
        notUnderGit: '此目錄不在 git 版本控制下',
        searching: '正在搜尋檔案...',
        noFilesFound: '未找到檔案',
        noFilesInProject: '專案中沒有檔案',
        tryDifferentTerm: '嘗試不同的搜尋詞',
        searchResults: ({ count }: { count: number }) => `搜尋結果 (${count})`,
        projectRoot: '專案根目錄',
        stagedChanges: ({ count }: { count: number }) => `已暫存的更改 (${count})`,
        unstagedChanges: ({ count }: { count: number }) => `未暫存的更改 (${count})`,
        // File viewer strings
        loadingFile: ({ fileName }: { fileName: string }) => `正在載入 ${fileName}...`,
        binaryFile: '二進位檔案',
        cannotDisplayBinary: '無法顯示二進位檔案內容',
        diff: '差異',
        file: '檔案',
        fileEmpty: '檔案為空',
        noChanges: '沒有要顯示的更改',
        noChangesTitle: '沒有變更',
        noChangesSubtitle: '工作區是乾淨的',
        deleted: '已刪除',
        changedFiles: ({ count }: { count: number }) => `${count} 個已變更的檔案`,
        allFiles: '所有檔案',
        addPanel: '新增面板',
        closePanel: '關閉面板',
        editFile: '編輯',
        saveFile: '儲存',
        failedToRead: '讀取檔案失敗',
        failedToSave: '儲存檔案失敗',
        fileConflict: '檔案衝突',
        fileConflictDescription: '編輯期間檔案已在裝置上被修改。重新載入以查看最新版本。',
        reload: '重新載入',
        overwrite: '覆蓋',
    },
    sideChat: {
        panelTitle: '側邊聊天',
        emptyTitle: '開始側邊聊天',
        emptySubtitle: '在一旁向智能體提問。它會繼承此聊天的上下文，但保持獨立——這裡的任何操作都不會影響主對話。',
        startButton: '開始側邊聊天',
        creating: '正在開始側邊聊天…',
        unavailable: '此工作階段暫時無法開始側邊聊天——請等待智能體上線。',
        expand: '全螢幕開啟',
        tabLabel: ({ index }: { index: number }) => `側邊聊天 ${index}`,
        newChat: '新增側邊聊天',
        close: '關閉側邊聊天',
    },


    settingsAccount: {
        // Account settings screen
        accountInformation: '帳戶資訊',
        status: '狀態',
        statusActive: '活躍',
        statusNotAuthenticated: '未驗證',
        anonymousId: '匿名 ID',
        publicId: '公共 ID',
        notAvailable: '不可用',
        linkNewDevice: '連結新裝置',
        linkNewDeviceSubtitle: '掃描 QR Code 來連結裝置',
        backup: '備份',
        backupDescription: '您的金鑰是恢復帳戶的唯一方法。請將其保存在安全的地方，比如密碼管理器中。',
        secretKey: '金鑰',
        tapToReveal: '點擊顯示',
        tapToHide: '點擊隱藏',
        secretKeyLabel: '金鑰（點擊複製）',
        secretKeyCopied: '金鑰已複製到剪貼簿。請將其保存在安全的地方！',
        secretKeyCopyFailed: '複製金鑰失敗',
        dangerZone: '危險區域',
        logout: '登出',
        logoutSubtitle: '登出並清除本機資料',
        logoutConfirm: '您確定要登出嗎？請確保您已備份金鑰！',
    },

    settingsLanguage: {
        // Language settings screen
        title: '語言',
        description: '選擇您希望應用程式介面使用的語言。此設定將在您的所有裝置間同步。',
        currentLanguage: '目前語言',
        automatic: '自動',
        automaticSubtitle: '從裝置設定中偵測',
        needsRestart: '語言已更改',
        needsRestartMessage: '應用程式需要重新啟動以套用新的語言設定。',
    },


    updateBanner: {
        updateAvailable: '有可用更新',
        pressToApply: '點擊套用更新',
        whatsNew: "更新內容",
        seeLatest: '查看最新更新和改進',
        nativeUpdateAvailable: '應用程式更新可用',
        tapToUpdateAppStore: '點擊在 App Store 中更新',
        tapToUpdatePlayStore: '點擊在 Play Store 中更新',
    },

    changelog: {
        // Used by the changelog screen
        noEntriesAvailable: '沒有可用的更新日誌條目。',
    },

    terminal: {
        // Used by terminal connection screens
        webBrowserRequired: '需要 Web 瀏覽器',
        webBrowserRequiredDescription: '出於安全原因，終端連線連結只能在 Web 瀏覽器中開啟。請使用 QR Code 掃描器或在電腦上開啟此連結。',
        processingConnection: '正在處理連線...',
        invalidConnectionLink: '無效的連線連結',
        invalidConnectionLinkDescription: '連線連結缺失或無效。請檢查 URL 並重試。',
        connectTerminal: '連線終端',
        terminalRequestDescription: '有終端正在請求連線到您的 muxr 帳戶。這將允許終端安全地傳送和接收訊息。',
        connectionDetails: '連線詳情',
        publicKey: '公鑰',
        encryption: '加密',
        endToEndEncrypted: '端對端加密',
        acceptConnection: '接受連線',
        connecting: '連線中...',
        reject: '拒絕',
        security: '安全',
        securityFooter: '此連線連結在您的瀏覽器中安全處理，從未傳送到任何伺服器。您的私人資料將保持安全，只有您能解密訊息。',
        securityFooterDevice: '此連線在您的裝置上安全處理，從未傳送到任何伺服器。您的私人資料將保持安全，只有您能解密訊息。',
        clientSideProcessing: '用戶端處理',
        linkProcessedLocally: '連結在瀏覽器中本機處理',
        linkProcessedOnDevice: '連結在裝置上本機處理',
    },

    modals: {
        // Used across connect flows and settings
        deviceLinkedSuccessfully: '裝置連結成功',
        invalidAuthUrl: '無效的驗證 URL',
        developerMode: '開發者模式',
        developerModeEnabled: '開發者模式已啟用',
        developerModeDisabled: '開發者模式已停用',
        failedToLinkDevice: '連結裝置失敗',
        cameraPermissionsRequiredToScanQr: '掃描 QR Code 需要相機權限'
    },

    navigation: {
        // Navigation titles and screen headers
        connectTerminal: '連線終端',
        linkNewDevice: '連結新裝置',
        restoreWithSecretKey: '透過金鑰恢復',
        browserPreview: '瀏覽器預覽',
        whatsNew: "更新日誌",
        friends: '好友',
    },

    welcome: {
        // Main welcome screen for unauthenticated users
        title: 'Pi 行動用戶端',
        subtitle: '您的帳戶僅儲存在您的裝置上。端對端加密為選用功能。',
        createAccount: '建立帳戶',
        linkOrRestoreAccount: '連結或恢復帳戶',
        loginWithMobileApp: '使用行動應用程式登入',
    },

    review: {
        // Used by utils/requestReview.ts
        enjoyingApp: '喜歡這個應用程式嗎？',
        feedbackPrompt: "我們很希望聽到您的回饋！",
        yesILoveIt: '是的，我喜歡！',
        notReally: '不太喜歡'
    },

    items: {
        // Used by Item component for copy toast
        copiedToClipboard: ({ label }: { label: string }) => `${label} 已複製到剪貼簿`
    },

    machine: {
        launchNewSessionInDirectory: '在目錄中啟動新工作階段',
        offlineUnableToSpawn: '裝置離線時無法啟動',
        daemon: '守護程序',
        status: '狀態',
        stopDaemon: '停止守護程序',
        lastKnownPid: '最後已知 PID',
        lastKnownHttpPort: '最後已知 HTTP 連接埠',
        startedAt: '啟動時間',
        cliVersion: 'CLI 版本',
        daemonStateVersion: '守護程序狀態版本',
        stopDaemonConfirmTitle: '停止守護程序？',
        stopDaemonConfirmMessage: '在電腦上重新啟動守護程序之前，您將無法在此機器上啟動新會話。目前的會話將保持運作。',
        daemonStopped: '守護程序已停止',
        stopDaemonFailed: '無法停止守護程序，它可能未在執行。',
        machineGroup: '裝置',
        host: '主機',
        machineId: '裝置 ID',
        username: '使用者名稱',
        homeDirectory: '主目錄',
        platform: '平台',
        architecture: '架構',
        lastSeen: '最後活躍',
        never: '從未',
        metadataVersion: '中繼資料版本',
        cliAvailability: 'CLI 可用性',
        cliInstalled: '已安裝',
        cliNotFound: '未找到',
        lastDetected: '最近偵測',
        back: '返回',
        dangerZone: '危險區域',
        delete: '刪除裝置',
        deleteFooter: '從您的帳戶中移除此裝置。工作階段歷史將保留,但您將無法在此裝置上啟動新的工作階段。',
        deleteConfirmTitle: '刪除此裝置?',
        deleteConfirmMessage: '裝置將從您的帳戶中移除。工作階段歷史將保留,但在您重新連接守護程序之前,您將無法啟動新的工作階段。',
        deleteFailed: '刪除裝置失敗。',
    },

    message: {
        switchedToMode: ({ mode }: { mode: string }) => `已切換到 ${mode} 模式`,
        unknownEvent: '未知事件',
        usageLimitUntil: ({ time }: { time: string }) => `使用限制到 ${time}`,
        sentAsGoal: 'Sent as goal',
        unknownTime: '未知時間',
    },

    codex: {
        // Pi permission dialog buttons
        permissions: {
            yesForSession: '是，並且本次工作階段不再詢問',
            stopAndExplain: '停止，並說明該做什麼',
        }
    },

    claude: {
        // Pi permission dialog buttons
        permissions: {
            yesAllowAllEdits: '是，允許本次工作階段的所有編輯',
            yesAllowEverything: '是，允許本次工作階段的所有操作',
            yesForTool: '是，不再詢問此工具',
            noTellClaude: '否，並告訴 Pi 該如何不同地操作',
        }
    },

    textSelection: {
        // Text selection screen
        title: '選擇文字',
        noTextProvided: '未提供文字',
        textNotFound: '文字未找到或已過期',
        textCopied: '文字已複製到剪貼簿',
        failedToCopy: '複製文字到剪貼簿失敗',
        noTextToCopy: '沒有可複製的文字',
    },

    markdown: {
        // Markdown copy functionality
        codeCopied: '程式碼已複製',
        copyFailed: '複製失敗',
        mermaidRenderFailed: '渲染 mermaid 圖表失敗',
    },

    artifacts: {
        title: '工件',
        empty: '暫無工件',
        emptyDescription: '建立您的第一個工件來儲存和組織內容',
        new: '新建工件',
        edit: '編輯工件',
        delete: '刪除',
        updateError: '更新工件失敗。請重試。',
        notFound: '未找到工件',
        deleteConfirm: '刪除工件？',
        deleteConfirmDescription: '此工件將被永久刪除。',
        titlePlaceholder: '工件標題',
        bodyPlaceholder: '在此輸入內容...',
        loading: '載入中...',
        error: '載入工件失敗',
        titleLabel: '標題',
        bodyLabel: '內容',
        emptyFieldsError: '请输入標題或內容',
        createError: '建立工件失敗。請重試。',
    },

    friends: {
        // Friends feature
        manageFriends: '管理您的好友和連結',
        pendingRequests: '好友請求',
        myFriends: '我的好友',
        noFriendsYet: '您還沒有好友',
        remove: '刪除',
        addFriend: '新增好友',
        alreadyFriends: '已是好友',
        requestPending: '請求待處理',
        searchInstructions: '輸入使用者名稱搜尋好友',
        searchPlaceholder: '輸入使用者名稱...',
        searching: '搜尋中...',
        noUserFound: '未找到該使用者名稱的使用者',
        checkUsername: '請檢查使用者名稱後重試',
        howToFind: '如何尋找好友',
        findInstructions: '透過使用者名稱搜尋好友。您和您的好友都需要連結 GitHub 才能傳送好友請求。',
        requestSent: '好友請求已傳送！',
        confirmRemove: '刪除好友',
        confirmRemoveMessage: '確定要刪除這位好友嗎？',
        cannotAddYourself: '您不能向自己傳送好友請求',
        bothMustHaveGithub: '雙方都必須連結 GitHub 才能成為好友',
        status: {
            none: '未連結',
            requested: '請求已傳送',
            pending: '請求待處理',
            friend: '好友',
            rejected: '已拒絕',
        },
        acceptRequest: '接受請求',
        removeFriend: '移除好友',
        removeFriendConfirm: ({ name }: { name: string }) => `確定要將 ${name} 從好友清單中移除嗎？`,
        requestFriendship: '請求加為好友',
        cancelRequest: '取消好友請求',
        cancelRequestConfirm: ({ name }: { name: string }) => `取消傳送給 ${name} 的好友請求？`,
        denyRequest: '拒絕請求',
    },

    usage: {
        // Usage panel strings
        today: '今天',
        last7Days: '過去 7 天',
        last30Days: '過去 30 天',
        totalTokens: '總權杖數',
        totalCost: '總費用',
        tokens: '權杖',
        cost: '費用',
        usageOverTime: '使用趨勢',
        byModel: '按模型',
    },

    imageUpload: {
        permissionTitle: '存取照片圖庫',
        permissionMessage: '允許存取您的照片圖庫以在訊息中附加圖片。',
        limitTitle: '已達到圖片限制',
        limitMessage: ({ max }: { max: number }) => `每則訊息最多可附加 ${max} 張圖片。`,
        fileTooLargeTitle: '檔案太大',
        fileTooLargeMessage: ({ name, maxMb }: { name: string; maxMb: number }) => `"${name}"超過了 ${maxMb}MB 的限制，未能新增。`,
        uploadFailedTitle: '上傳失敗',
        uploadFailedMessage: ({ count }: { count: number }) => count === 1
            ? '一張圖片上傳失敗，未傳送。'
            : `${count} 張圖片上傳失敗，未傳送。`,
        notSupportedTitle: '不支援圖片',
        notSupportedMessage: '此代理不支援圖片附件。圖片未傳送。',
    },

    feed: {
        // Feed notifications for friend requests and acceptances
    },
} as const;
