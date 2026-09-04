/**
 * Chinese (Simplified) translations for the muxr app
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

export const zhHans: TranslationStructure = {
    tabs: {
        // Tab navigation labels
        sessions: '终端',
        settings: '设置',
    },

    inbox: {
        // Inbox screen: the sessions currently waiting on you
        reason: {
            waiting: '等待中',
            blocked: '受阻',
            failed: '失败',
            done: '已完成',
        },
    },

    plugins: {
        openFromHome: '从主页打开插件。',
        unavailable: '此插件已停用或不可用。',
        goBack: '返回',
        couldNotLoad: '无法加载项目',
        dataUnavailable: '插件当前不可用。',
        nothingHere: '这里暂无内容',
        newItems: '新项目会显示在这里。',
        retry: '重试',
        retryItems: '重新加载插件项目',
        stale: '无法刷新，正在显示上次结果。',
        nothingToShow: '没有可显示的内容。',
        treeUnavailable: '树不可用。',
        dictate: '听写',
        unavailableSuffix: '不可用',
        showingStale: '正在显示旧数据',
        settingsTitle: '插件',
        enableAll: '全部启用',
        disableAll: '全部停用',
        installed: '已安装',
        herdrAndMuxr: 'Herdr + muxr',
        herdrAndMuxrFooter: 'Herdr 为它们运行操作、窗格或事件挂钩，它们还提供 muxr 界面。',
        muxrOnly: '仅 muxr',
        muxrOnlyFooter: 'Herdr 仅注册它们，其余全部通过 muxr 运行。',
        herdrOnly: '仅 Herdr',
        herdrOnlyFooter: '没有 muxr 界面的后端包。请使用 herdr 命令行管理。',
        waitingHost: '正在等待主机。',
        linkHost: '通过 Herdr 链接插件后重新连接。',
        enabled: '已启用',
        off: '关',
        on: '开',
        unavailableLabel: '不可用',
        runsCode: '以你的身份运行代码',
        uiOnly: '仅界面',
        readsSessions: '读取会话摘要',
        readsTree: '读取工作区树',
        openFailed: '无法打开',
        actionFailed: '操作失败',
        items: '项目',
        openWebsite: '打开网站？',
        open: '打开',
        realtimeConnecting: '正在连接语音会话',
        realtimeListening: '正在聆听',
        realtimeThinking: '正在思考',
        realtimeSpeaking: '正在说话',
        realtimeError: '语音会话错误',
        realtimeOff: '语音会话已关闭',
        openConversation: '打开语音对话',
        realtime: '语音',
    },

    common: {
        // Simple string constants
        cancel: '取消',
        save: '保存',
        error: '错误',
        success: '成功',
        ok: '确定',
        back: '返回',
        create: '创建',
        rename: '重命名',
        logout: '登出',
        yes: '是',
        no: '否',
        version: '版本',
        copied: '已复制',
        copy: '复制',
        scanning: '扫描中...',
        home: '主页',
        message: '消息',
        files: '文件',
        fileViewer: '文件查看器',
        loading: '加载中...',
        delete: '删除',
    },

    profile: {
        details: '详情',
        firstName: '名',
        lastName: '姓',
        username: '用户名',
        status: '状态',
    },


    status: {
        connected: '已连接',
        connecting: '连接中',
        disconnected: '已断开',
        error: '错误',
        pairingIssue: '配对问题',
        online: '在线',
        offline: '离线',
        lastSeen: ({ time }: { time: string }) => `最后活跃时间 ${time}`,
        permissionRequired: '需要权限',
        activeNow: '当前活跃',
        unknown: '未知',
        unread: '新结果',
    },

    time: {
        justNow: '刚刚',
        minutesAgo: ({ count }: { count: number }) => `${count} 分钟前`,
        hoursAgo: ({ count }: { count: number }) => `${count} 小时前`,
        daysAgo: ({ count }: { count: number }) => `${count} 天前`,
    },

    connect: {
        restoreAccount: '恢复账户',
        enterSecretKey: '请输入密钥',
        invalidSecretKey: '无效的密钥，请检查后重试。',
        qrInstructions: '1. 在您的移动设备上打开 muxr\n2. 前往 设置 → 账户\n3. 点击“链接新设备”\n4. 扫描此二维码',
        restoreWithSecretKeyInstead: '或改用密钥恢复',
    },

    settings: {
        title: '设置',
        github: 'GitHub',
        machines: '设备',
        showOfflineMachines: ({ count }: { count: number }) => `显示 ${count} 台离线设备`,
        hideOfflineMachines: '隐藏离线设备',
        features: '功能',
        social: '社交',
        account: '账户',
        accountSubtitle: '管理您的账户详情',
        appearance: '外观',
        appearanceSubtitle: '自定义应用外观',
        featuresTitle: '功能',
        featuresSubtitle: '启用或禁用应用功能',
        about: '关于',
        aboutFooter: 'muxr 是一个 Pi 移动客户端。端到端加密为可选项，默认关闭；您的账户仅存储在本地设备上。与 Anthropic 无关联。',
        whatsNew: '更新日志',
        whatsNewSubtitle: '查看最新更新和改进',
        reportIssue: '报告问题',
        eula: '最终用户许可协议',
        connection: '连接',
        connectionSubtitle: '中继 URL、设备和令牌',
        pushNotifications: '推送通知',
        pushSubtitleSubscribed: '已开启 — 当代理需要回答时通知您',
        pushSubtitleDenied: '已被浏览器阻止 — 请允许通知以启用',
        pushSubtitleUnsupported: '此浏览器不支持',
        pushSubtitleDefault: '点按以在代理需要回答时收到通知',
        license: '许可证与声明',
        // Dynamic settings messages
    },

    settingsAppearance: {
        // Appearance settings screen
        theme: '主题',
        themeDescription: '选择您喜欢的配色方案',
        themeOptions: {
            adaptive: '自适应',
            light: '浅色', 
            dark: '深色',
        },
        themeDescriptions: {
            adaptive: '跟随系统设置',
            light: '始终使用浅色主题',
            dark: '始终使用深色主题',
        },
        display: '显示',
        displayDescription: '控制布局和间距',

        avatarStyle: '头像风格',
        avatarStyleDescription: '选择会话头像外观',
        avatarOptions: {
            pixelated: '像素化',
            gradient: '渐变',
            brutalist: '粗糙风格',
        },
        showFlavorIcons: '显示 AI 提供商图标',
        showFlavorIconsDescription: '在会话头像上显示 AI 提供商图标',
    },

    settingsFeatures: {
        // Features settings screen
        experiments: '实验功能',
        experimentsDescription: '启用仍在开发中的实验功能。这些功能可能不稳定或会在没有通知的情况下改变。',
        webFeatures: 'Web 功能',
        webFeaturesDescription: '仅在应用的 Web 版本中可用的功能。',
        commandPalette: '命令面板',
        commandPaletteEnabled: '按 ⌘K 打开',
        commandPaletteDisabled: '快速命令访问已禁用',
        markdownCopyV2: 'Markdown 复制 v2',
        markdownCopyV2Subtitle: '长按打开复制模态框',
        hideInactiveSessions: '隐藏非活跃会话',
        hideInactiveSessionsSubtitle: '仅在列表中显示活跃的聊天',
        imageUpload: '图片上传',
        imageUploadSubtitle: '将图片附加到消息中，以便受支持的代理进行分析',
    },

    errors: {
        authenticationFailed: '认证失败',
        failedToLoadProfile: '无法加载用户资料',
        userNotFound: '未找到用户',
        sessionDeleted: '会话已被删除',
        sessionDeletedDescription: '此会话已被永久删除',

        // Error functions with context
        failedToSendRequest: '发送好友请求失败',
    },

    newSession: {
        title: '开始新会话',
        machineOffline: '设备离线',
        switchMachinesHint: '• 点击上方的设备来切换设备',
    },

    settingsConnection: {
        // Connection settings screen (relay URL, machine, token)
        status: ({ status }: { status: string }) => `状态：${status}`,
    },

    optionSheet: {
        // Model/mode picker bottom sheet
        all: '全部',
        searchPlaceholder: ({ count }: { count: number }) => `搜索 ${count}`,
        useCustom: ({ value }: { value: string }) => `使用 ${value}`,
        noResults: '无结果',
    },

    homeDock: {
        // Home screen composer
        inputPlaceholder: '规划、提问、构建…',
        runCommandPlaceholder: '运行命令',
        askPlaceholder: ({ name }: { name: string }) => `询问 ${name}`,
    },

    liveTerminals: {
        // Live terminals strip on the home screen
        title: '直播中',
    },

    emptySessions: {
        // Empty state shown on tablets when no sessions are active
        noActiveSessions: '没有活动会话',
        startDescription: '在任一已连接的设备上启动新会话。',
        noMachinesDescription: '在电脑上打开新终端以启动会话。',
    },

    sessionHistory: {
        // Used by session history screen
        title: '会话历史',
        empty: '未找到会话',
        today: '今天',
        yesterday: '昨天',
        daysAgo: ({ count }: { count: number }) => `${count} 天前`,
    },

    session: {
        inputPlaceholder: '输入消息...',
        inactiveArchived: '此会话处于非活动状态。',
        resumeFromTerminal: '要从终端恢复它：',
        newChat: '新对话',
        forkAction: '分叉会话',
        forkSubtitle: '在相同上下文中开启新会话继续',
        duplicateAction: '从消息处复制…',
        duplicateSubtitle: '回到选定位置重新尝试',
        duplicateSheetTitle: '选择回退点',
        duplicateSheetSubtitle: '新会话将保留所选轮次完整内容（你的消息与智能体的回复），并丢弃其后的所有消息。',
        duplicateSheetConfirm: '复制',
        duplicateSheetEmpty: '此会话还没有可回退的消息。',
        duplicateRowDisabled: '此消息不能作为回退点。',
        forkedFromLabel: '分叉自',
        forkedFromSubtitle: '打开分叉来源的会话',
        forkErrorMissingMetadata: '缺少分叉所需的会话元数据。',
        forkErrorGeneric: '分叉会话失败。',
    },

    commandPalette: {
        placeholder: '输入命令或搜索...',
    },


    sessionInfo: {
        // Used by Session Info screen (app/(app)/session/[id]/info.tsx)
        archiveSession: '归档会话',
        muxrSessionIdCopied: 'muxr 会话 ID 已复制到剪贴板',
        failedToCopySessionId: '复制 muxr 会话 ID 失败',
        muxrSessionId: 'muxr 会话 ID',
        claudeCodeSessionId: 'Pi 会话 ID',
        claudeCodeSessionIdCopied: 'Pi 会话 ID 已复制到剪贴板',
        codexThreadId: 'Pi 线程 ID',
        codexThreadIdCopied: 'Pi 线程 ID 已复制到剪贴板',
        aiProvider: 'AI 提供商',
        failedToCopyClaudeCodeSessionId: '复制 Pi 会话 ID 失败',
        failedToCopyCodexThreadId: '复制 Pi 线程 ID 失败',
        metadataCopied: '元数据已复制到剪贴板',
        failedToCopyMetadata: '复制元数据失败',
        failedToArchiveSession: '归档会话失败',
        connectionStatus: '连接状态',
        created: '创建时间',
        lastUpdated: '最后更新',
        sequence: '序列',
        quickActions: '快速操作',
        viewMachine: '查看设备',
        viewMachineSubtitle: '查看设备详情和会话',
        resumeSession: 'Resume Session',
        resumeSessionSubtitle: 'Resume this session on the same machine',
        resumeSessionSameMachineOnly: 'This session can only be resumed on the same machine it started on.',
        resumeSessionMachineOffline: 'This machine is offline. Resume is only available while it is online.',
        resumeSessionMissingMachine: 'This session is missing its machine metadata, so it cannot be resumed.',
        resumeSessionMissingBackendId: 'This session does not have a resumable Pi identifier.',
        resumeSessionUnexpectedDirectoryPrompt: 'Resume cannot create directories. Start the session manually from its original path.',
        archiveSessionSubtitle: '归档此会话并停止它',
        metadata: '元数据',
        host: '主机',
        path: '路径',
        operatingSystem: '操作系统',
        processId: '进程 ID',
        muxrHome: 'muxr 主目录',
        copyMetadata: '复制元数据',
        agentState: 'Agent 状态',
        controlledByUser: '用户控制',
        pendingRequests: '待处理请求',
        activity: '活动',
        thinking: '思考中',
        thinkingSince: '思考开始时间',
        cliVersion: 'CLI 版本',
        deleteSession: '删除会话',
        deleteSessionSubtitle: '永久删除此会话',
        deleteSessionWarning: '此操作无法撤销。与此会话相关的所有消息和数据将被永久删除。',
        failedToDeleteSession: '删除会话失败',
        worktreeCleanupTitle: '删除 Worktree？',
        worktreeCleanupMessage: 'Worktree 没有未提交的更改。是否要删除 Worktree 文件？',
        worktreeCleanupDelete: '删除 Worktree',
        worktreeCleanupKeep: '保留文件',
        landWorktree: 'Land Worktree',
        landWorktreeSubtitle: 'Squash this worktree onto the base branch and remove it',
        landWorktreeMessage: 'Commit message for the squashed change',
        landWorktreeFailed: 'Failed to land worktree',
        landWorktreeDone: 'Landed on the base branch. The worktree is gone.',

    },

    archive: {
        select: '选择',
        selectAll: '全选',
        deselectAll: '取消全选',
        archiveCount: ({ count }: { count: number }) => plural({ count, singular: '归档 1 个会话', plural: `归档 ${count} 个会话` }),
        unarchiveCount: ({ count }: { count: number }) => plural({ count, singular: '取消归档 1 个会话', plural: `取消归档 ${count} 个会话` }),
        selectedCount: ({ count }: { count: number }) => `已选择 ${count} 个`,
        archivedCount: ({ count }: { count: number }) => plural({ count, singular: '已归档 1 个会话', plural: `已归档 ${count} 个会话` }),
        undo: '撤销',
    },

    components: {
        sessionStatusBar: {
            contextUsage: ({ used, total, percent }: { used: string; total: string; percent: number }) => `上下文 ${used}/${total} 个令牌，${percent}%`,
            limitFiveHour: '5 小时额度',
            limitSevenDay: '7 天额度',
            limitResets: ({ time }: { time: string }) => `${time} 重置`,
            limitAsOf: ({ age }: { age: string }) => `数据为 ${age} 前`,
            limitRemaining: ({ percent }: { percent: number }) => `剩余 ${percent}%`,
        },
    },

    agentInput: {
        permissionMode: {
            title: '权限模式',
            default: '默认',
            acceptEdits: '接受编辑',
            plan: '计划模式',
            dontAsk: '不再询问',
            bypassPermissions: 'Yolo 模式',
        },
        agent: {
            pi: 'Pi',
        },
        model: {
            title: '模型',
            configureInCli: '在 CLI 设置中配置模型',
        },
        effort: {
            title: '工作量',
        },
        codexPermissionMode: {
            title: 'PI 权限模式',
            default: 'CLI 设置',
            readOnly: 'Read Only Mode',
            safeYolo: 'Safe YOLO',
            yolo: 'YOLO',
            defaultDescription: '不受信任的命令前询问',
            readOnlyDescription: '禁止写入',
            safeYoloDescription: '无需确认，工作区沙盒',
            yoloDescription: '无需确认，完全访问',
        },

        geminiPermissionMode: {
            title: 'PI 权限模式',
            default: '默认',
            autoEdit: '自动编辑',
            yolo: 'YOLO',
            plan: '计划',
        },
        context: {
            remaining: ({ percent }: { percent: number }) => `剩余 ${percent}%`,
        },
        suggestion: {
            fileLabel: '文件',
            folderLabel: '文件夹',
        },
        noMachinesAvailable: '无设备',
    },

    machineLauncher: {
        showLess: '显示更少',
        showAll: ({ count }: { count: number }) => `显示全部 (${count} 个路径)`,
        enterCustomPath: '输入自定义路径',
    },

    sidebar: {
        sessionsTitle: 'muxr',
        showArchived: '显示已归档',
        hideArchived: '隐藏已归档',
        newSession: '新建会话',
    },

    zen: {
        toggle: '禅模式',
    },

    toolView: {
        input: '输入',
        output: '输出',
    },

    thinking: {
        active: 'Thinking…',
        thought: 'Thought',
        thoughtFor: ({ duration }: { duration: string }) => `Thought for ${duration}`,
    },

    sessionAttachments: {
        title: ({ count }: { count: number }) => `${count} 个附件`,
    },

    turnChanges: {
        filesChanged: ({ count }: { count: number }) => `已修改 ${count} 个文件`,
    },

    tools: {
        fullView: {
            description: '描述',
            inputParams: '输入参数',
            output: '输出',
            error: '错误',
            completed: '工具已成功完成',
            noOutput: '未产生输出',
            rawJsonDevMode: '原始 JSON（开发模式）',
        },


        names: {
            search: '搜索',
        },

        desc: {
        }
    },

    files: {
        changes: '更改',
        searchPlaceholder: '搜索文件...',
        detachedHead: '游离 HEAD',
        summary: ({ staged, unstaged }: { staged: number; unstaged: number }) => `${staged} 已暂存 • ${unstaged} 未暂存`,
        notRepo: '不是 git 仓库',
        notUnderGit: '此目录不在 git 版本控制下',
        searching: '正在搜索文件...',
        noFilesFound: '未找到文件',
        noFilesInProject: '项目中没有文件',
        tryDifferentTerm: '尝试不同的搜索词',
        searchResults: ({ count }: { count: number }) => `搜索结果 (${count})`,
        projectRoot: '项目根目录',
        stagedChanges: ({ count }: { count: number }) => `已暂存的更改 (${count})`,
        unstagedChanges: ({ count }: { count: number }) => `未暂存的更改 (${count})`,
        // File viewer strings
        loadingFile: ({ fileName }: { fileName: string }) => `正在加载 ${fileName}...`,
        binaryFile: '二进制文件',
        cannotDisplayBinary: '无法显示二进制文件内容',
        diff: '差异',
        file: '文件',
        fileEmpty: '文件为空',
        fileDeleted: '此文件已不存在',
        previousDocument: '上一份文档',
        nextDocument: '下一份文档',
        previousChange: '上一处更改',
        nextChange: '下一处更改',
        toggleFileAndDiff: '切换文件和差异',
        wrapLines: '长行自动换行',
        previousFile: '上一个文件',
        nextFile: '下一个文件',
        previousFileNamed: ({ title, ordinal, total }: { title: string; ordinal: number; total: number }) => `上一个文件，${title}，第 ${ordinal} 个，共 ${total} 个`,
        nextFileNamed: ({ title, ordinal, total }: { title: string; ordinal: number; total: number }) => `下一个文件，${title}，第 ${ordinal} 个，共 ${total} 个`,
        filePosition: ({ current, total }: { current: number; total: number }) => `文件 ${current} / ${total}`,
        diffUnavailable: '差异不可用，此文件没有更改',
        previousChangeAt: ({ current, total }: { current: number; total: number }) => `上一处更改，${current} / ${total}`,
        nextChangeAt: ({ current, total }: { current: number; total: number }) => `下一处更改，${current} / ${total}`,
        graphicsUnavailable: '图形不可用',
        folderNotFile: 'That path is a folder, not a file.',
        showFullPath: '显示完整路径',
        pathShowFullPath: ({ label }: { label: string }) => `路径 ${label}，显示完整路径`,
        goToPath: ({ label }: { label: string }) => `转到 ${label}`,
        fullPath: '完整路径',
        noChanges: '没有要显示的更改',
        noChangesTitle: '没有更改',
        noChangesSubtitle: '工作区是干净的',
        deleted: '已删除',
        changedFiles: ({ count }: { count: number }) => `${count} 个已更改的文件`,
        allFiles: '所有文件',
        addPanel: '添加面板',
        closePanel: '关闭面板',
        editFile: '编辑',
        saveFile: '保存',
        failedToRead: '读取文件失败',
        failedToSave: '保存文件失败',
        fileConflict: '文件冲突',
        fileConflictDescription: '编辑期间文件已在设备上被修改。重新加载以查看最新版本。',
        reload: '重新加载',
        overwrite: '覆盖',
    },
    sideChat: {
        panelTitle: '侧边聊天',
        emptyTitle: '开始侧边聊天',
        emptySubtitle: '在一旁向智能体提问。它会继承此聊天的上下文，但保持独立——这里的任何操作都不会影响主对话。',
        startButton: '开始侧边聊天',
        creating: '正在开始侧边聊天…',
        unavailable: '此会话暂时无法开始侧边聊天——请等待智能体上线。',
        expand: '全屏打开',
        tabLabel: ({ index }: { index: number }) => `侧边聊天 ${index}`,
        newChat: '新建侧边聊天',
        close: '关闭侧边聊天',
    },


    settingsAccount: {
        // Account settings screen
        accountInformation: '账户信息',
        status: '状态',
        statusActive: '活跃',
        statusNotAuthenticated: '未认证',
        anonymousId: '匿名 ID',
        publicId: '公共 ID',
        notAvailable: '不可用',
        linkNewDevice: '链接新设备',
        linkNewDeviceSubtitle: '扫描二维码来链接设备',
        backup: '备份',
        backupDescription: '您的密钥是恢复账户的唯一方法。请将其保存在安全的地方，比如密码管理器中。',
        secretKey: '密钥',
        tapToReveal: '点击显示',
        tapToHide: '点击隐藏',
        secretKeyLabel: '密钥（点击复制）',
        secretKeyCopied: '密钥已复制到剪贴板。请将其保存在安全的地方！',
        secretKeyCopyFailed: '复制密钥失败',
        dangerZone: '危险区域',
        logout: '登出',
        logoutSubtitle: '登出并清除本地数据',
        logoutConfirm: '您确定要登出吗？请确保您已备份密钥！',
    },

    settingsLanguage: {
        // Language settings screen
        title: '语言',
        description: '选择您希望应用界面使用的语言。此设置将在您的所有设备间同步。',
        currentLanguage: '当前语言',
        automatic: '自动',
        automaticSubtitle: '从设备设置中检测',
        needsRestart: '语言已更改',
        needsRestartMessage: '应用需要重启以应用新的语言设置。',
    },


    updateBanner: {
        updateAvailable: '有可用更新',
        pressToApply: '点击应用更新',
        whatsNew: "更新内容",
        seeLatest: '查看最新更新和改进',
        nativeUpdateAvailable: '应用更新可用',
        tapToUpdateAppStore: '点击在 App Store 中更新',
        tapToUpdatePlayStore: '点击在 Play Store 中更新',
    },

    changelog: {
        // Used by the changelog screen
        noEntriesAvailable: '没有可用的更新日志条目。',
    },

    terminal: {
        // Used by terminal connection screens
        webBrowserRequired: '需要 Web 浏览器',
        webBrowserRequiredDescription: '出于安全原因，终端连接链接只能在 Web 浏览器中打开。请使用二维码扫描器或在计算机上打开此链接。',
        processingConnection: '正在处理连接...',
        invalidConnectionLink: '无效的连接链接',
        invalidConnectionLinkDescription: '连接链接缺失或无效。请检查 URL 并重试。',
        connectTerminal: '连接终端',
        terminalRequestDescription: '有终端正在请求连接到您的 muxr 账户。这将允许终端安全地发送和接收消息。',
        connectionDetails: '连接详情',
        publicKey: '公钥',
        encryption: '加密',
        endToEndEncrypted: '端到端加密',
        acceptConnection: '接受连接',
        connecting: '连接中...',
        reject: '拒绝',
        security: '安全',
        securityFooter: '此连接链接在您的浏览器中安全处理，从未发送到任何服务器。您的私人数据将保持安全，只有您能解密消息。',
        securityFooterDevice: '此连接在您的设备上安全处理，从未发送到任何服务器。您的私人数据将保持安全，只有您能解密消息。',
        clientSideProcessing: '客户端处理',
        linkProcessedLocally: '链接在浏览器中本地处理',
        linkProcessedOnDevice: '链接在设备上本地处理',
    },

    modals: {
        // Used across connect flows and settings
        deviceLinkedSuccessfully: '设备链接成功',
        invalidAuthUrl: '无效的认证 URL',
        developerMode: '开发者模式',
        developerModeEnabled: '开发者模式已启用',
        developerModeDisabled: '开发者模式已禁用',
        failedToLinkDevice: '链接设备失败',
        cameraPermissionsRequiredToScanQr: '扫描二维码需要相机权限'
    },

    navigation: {
        // Navigation titles and screen headers
        connectTerminal: '连接终端',
        linkNewDevice: '链接新设备', 
        restoreWithSecretKey: '通过密钥恢复',
        browserTakeover: '浏览器接管',
        whatsNew: "更新日志",
        friends: '好友',
    },

    welcome: {
        // Main welcome screen for unauthenticated users
        title: 'Pi 移动客户端',
        subtitle: '您的账户仅存储在您的设备上。端到端加密为可选项。',
        createAccount: '创建账户',
        linkOrRestoreAccount: '链接或恢复账户',
        loginWithMobileApp: '使用移动应用登录',
    },

    review: {
        // Used by utils/requestReview.ts
        enjoyingApp: '喜欢这个应用吗？',
        feedbackPrompt: "我们很希望听到您的反馈！",
        yesILoveIt: '是的，我喜欢！',
        notReally: '不太喜欢'
    },

    items: {
        // Used by Item component for copy toast
        copiedToClipboard: ({ label }: { label: string }) => `${label} 已复制到剪贴板`
    },

    machine: {
        launchNewSessionInDirectory: '在目录中启动新会话',
        offlineUnableToSpawn: '设备离线时无法启动',
        daemon: '守护进程',
        status: '状态',
        stopDaemon: '停止守护进程',
        lastKnownPid: '最后已知 PID',
        lastKnownHttpPort: '最后已知 HTTP 端口',
        startedAt: '启动时间',
        cliVersion: 'CLI 版本',
        daemonStateVersion: '守护进程状态版本',
        stopDaemonConfirmTitle: '停止守护进程？',
        stopDaemonConfirmMessage: '在电脑上重新启动守护进程之前，您将无法在此设备上启动新会话。当前会话将保持运行。',
        daemonStopped: '守护进程已停止',
        stopDaemonFailed: '无法停止守护进程，它可能未在运行。',
        machineGroup: '设备',
        host: '主机',
        machineId: '设备 ID',
        username: '用户名',
        homeDirectory: '主目录',
        platform: '平台',
        architecture: '架构',
        lastSeen: '最后活跃',
        never: '从未',
        metadataVersion: '元数据版本',
        cliAvailability: 'CLI 可用性',
        cliInstalled: '已安装',
        cliNotFound: '未找到',
        lastDetected: '最近检测',
        back: '返回',
        dangerZone: '危险区域',
        delete: '删除设备',
        deleteFooter: '从您的账户中移除此设备。会话历史将保留，但您无法再在此设备上启动新会话。',
        deleteConfirmTitle: '删除此设备？',
        deleteConfirmMessage: '设备将从您的账户中移除。会话历史将保留，但在您重新连接守护进程之前，您将无法启动新会话。',
        deleteFailed: '删除设备失败。',
    },

    message: {
        switchedToMode: ({ mode }: { mode: string }) => `已切换到 ${mode} 模式`,
        unknownEvent: '未知事件',
        usageLimitUntil: ({ time }: { time: string }) => `使用限制到 ${time}`,
        sentAsGoal: 'Sent as goal',
        unknownTime: '未知时间',
    },

    codex: {
        // Pi permission dialog buttons
        permissions: {
            yesForSession: '是，并且本次会话不再询问',
            stopAndExplain: '停止，并说明该做什么',
        }
    },

    claude: {
        // Pi permission dialog buttons
        permissions: {
            yesAllowAllEdits: '是，允许本次会话的所有编辑',
            yesAllowEverything: '是，允许本次会话的所有操作',
            yesForTool: '是，不再询问此工具',
            noTellClaude: '否，提供反馈',
        }
    },

    textSelection: {
        // Text selection screen
        title: '选择文本',
        noTextProvided: '未提供文本',
        textNotFound: '文本未找到或已过期',
        textCopied: '文本已复制到剪贴板',
        failedToCopy: '复制文本到剪贴板失败',
        noTextToCopy: '没有可复制的文本',
    },

    markdown: {
        // Markdown copy functionality
        codeCopied: '代码已复制',
        copyFailed: '复制失败',
        mermaidRenderFailed: '渲染 mermaid 图表失败',
    },

    artifacts: {
        title: '工件',
        empty: '暂无工件',
        emptyDescription: '创建您的第一个工件来保存和组织内容',
        new: '新建工件',
        edit: '编辑工件',
        delete: '删除',
        updateError: '更新工件失败。请重试。',
        notFound: '未找到工件',
        deleteConfirm: '删除工件？',
        deleteConfirmDescription: '此工件将被永久删除。',
        titlePlaceholder: '工件标题',
        bodyPlaceholder: '在此输入内容...',
        loading: '加载中...',
        error: '加载工件失败',
        titleLabel: '标题',
        bodyLabel: '内容',
        emptyFieldsError: '请输入标题或内容',
        createError: '创建工件失败。请重试。',
    },

    friends: {
        // Friends feature
        manageFriends: '管理您的好友和连接',
        pendingRequests: '好友请求',
        myFriends: '我的好友',
        noFriendsYet: '您还没有好友',
        remove: '删除',
        addFriend: '添加好友',
        alreadyFriends: '已是好友',
        requestPending: '请求待处理',
        searchInstructions: '输入用户名搜索好友',
        searchPlaceholder: '输入用户名...',
        searching: '搜索中...',
        noUserFound: '未找到该用户名的用户',
        checkUsername: '请检查用户名后重试',
        howToFind: '如何查找好友',
        findInstructions: '通过用户名搜索好友。您和您的好友都需要连接 GitHub 才能发送好友请求。',
        requestSent: '好友请求已发送！',
        confirmRemove: '删除好友',
        confirmRemoveMessage: '确定要删除这位好友吗？',
        cannotAddYourself: '您不能向自己发送好友请求',
        bothMustHaveGithub: '双方都必须连接 GitHub 才能成为好友',
        status: {
            none: '未连接',
            requested: '请求已发送',
            pending: '请求待处理',
            friend: '好友',
            rejected: '已拒绝',
        },
        acceptRequest: '接受请求',
        removeFriend: '移除好友',
        removeFriendConfirm: ({ name }: { name: string }) => `确定要将 ${name} 从好友列表中移除吗？`,
        requestFriendship: '请求加为好友',
        cancelRequest: '取消好友请求',
        cancelRequestConfirm: ({ name }: { name: string }) => `取消发送给 ${name} 的好友请求？`,
        denyRequest: '拒绝请求',
    },

    usage: {
        // Usage panel strings
        today: '今天',
        last7Days: '过去 7 天',
        last30Days: '过去 30 天',
        totalTokens: '总令牌数',
        totalCost: '总费用',
        tokens: '令牌',
        cost: '费用',
        usageOverTime: '使用趋势',
        byModel: '按模型',
    },

    imageUpload: {
        permissionTitle: '访问照片库',
        permissionMessage: '允许访问您的照片库以在消息中附加图片。',
        limitTitle: '已达到图片限制',
        limitMessage: ({ max }: { max: number }) => `每条消息最多可附加 ${max} 张图片。`,
        fileTooLargeTitle: '文件过大',
        fileTooLargeMessage: ({ name, maxMb }: { name: string; maxMb: number }) => `"${name}"超过了 ${maxMb}MB 的限制，未能添加。`,
        uploadFailedTitle: '上传失败',
        uploadFailedMessage: ({ count }: { count: number }) => count === 1
            ? '一张图片上传失败，未发送。'
            : `${count} 张图片上传失败，未发送。`,
        notSupportedTitle: '不支持图片',
        notSupportedMessage: '此代理不支持图片附件。图片未发送。',
    },

    feed: {
        // Feed notifications for friend requests and acceptances
    }
} as const;
