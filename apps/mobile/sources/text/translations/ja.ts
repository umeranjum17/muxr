/**
 * Japanese translations for the muxr app
 * Values can be:
 * - String constants for static text
 * - Functions with typed object parameters for dynamic text
 */

import { TranslationStructure } from "../_default";

/**
 * Japanese plural helper function
 * Japanese doesn't have grammatical plurals, so this just returns the appropriate form
 * @param options - Object containing count, singular, and plural forms
 * @returns The appropriate form based on count
 */
function plural({ count, singular, plural }: { count: number; singular: string; plural: string }): string {
    return count === 1 ? singular : plural;
}

export const ja: TranslationStructure = {
    tabs: {
        // Tab navigation labels
        sessions: 'ターミナル',
        settings: '設定',
    },

    inbox: {
        // Inbox screen: the sessions currently waiting on you
        reason: {
            waiting: '待機中',
            blocked: '停止',
            failed: '失敗',
            done: '完了',
        },
    },

    plugins: {
        openFromHome: 'ホームからプラグインを開いてください。',
        unavailable: 'このプラグインは無効か利用できません。',
        goBack: '戻る',
        couldNotLoad: '項目を読み込めませんでした',
        dataUnavailable: 'プラグインは現在利用できません。',
        nothingHere: 'ここには何もありません',
        newItems: '新しい項目がここに表示されます。',
        retry: '再試行',
        retryItems: 'プラグイン項目を再読み込み',
        stale: '更新できませんでした。前回の結果を表示しています。',
        nothingToShow: '表示するものがありません。',
        treeUnavailable: 'ツリーを利用できません。',
        dictate: '音声入力',
        unavailableSuffix: '利用不可',
        showingStale: '古いデータを表示中',
        settingsTitle: 'プラグイン',
        enableAll: 'すべて有効化',
        disableAll: 'すべて無効化',
        installed: 'インストール済み',
        herdrAndMuxr: 'Herdr + muxr',
        herdrAndMuxrFooter: 'Herdr がアクション、ペイン、イベントを実行し、muxr の UI も追加します。',
        muxrOnly: 'muxr のみ',
        muxrOnlyFooter: 'Herdr は登録するだけで、動作はすべて muxr を通ります。',
        herdrOnly: 'Herdr のみ',
        herdrOnlyFooter: 'muxr UI を持たないバックエンドです。herdr CLI で管理します。',
        waitingHost: 'ホストを待機しています。',
        linkHost: 'Herdr でプラグインをリンクして再接続してください。',
        enabled: '有効',
        off: 'オフ',
        on: 'オン',
        unavailableLabel: '利用不可',
        runsCode: 'あなたとしてコードを実行',
        uiOnly: 'UI のみ',
        readsSessions: 'セッション概要を読み取り',
        readsTree: 'ワークスペースツリーを読み取り',
        openFailed: '開けませんでした',
        actionFailed: '操作に失敗しました',
        items: '項目',
        openWebsite: 'ウェブサイトを開きますか？',
        open: '開く',
        realtimeConnecting: '音声セッションに接続中',
        realtimeListening: '聞いています',
        realtimeThinking: '考えています',
        realtimeSpeaking: '話しています',
        realtimeError: '音声セッションエラー',
        realtimeOff: '音声セッションはオフです',
        openConversation: '音声会話を開く',
        realtime: '音声',
    },

    common: {
        // Simple string constants
        cancel: 'キャンセル',
        save: '保存',
        error: 'エラー',
        success: '成功',
        ok: 'OK',
        back: '戻る',
        create: '作成',
        rename: '名前を変更',
        logout: 'ログアウト',
        yes: 'はい',
        no: 'いいえ',
        version: 'バージョン',
        copied: 'コピーしました',
        copy: 'コピー',
        scanning: 'スキャン中...',
        home: 'ホーム',
        message: 'メッセージ',
        files: 'ファイル',
        fileViewer: 'ファイルビューアー',
        loading: '読み込み中...',
        delete: '削除',
    },

    profile: {
        details: '詳細',
        firstName: '名',
        lastName: '姓',
        username: 'ユーザー名',
        status: 'ステータス',
    },

    status: {
        connected: '接続済み',
        connecting: '接続中',
        disconnected: '切断済み',
        error: 'エラー',
        pairingIssue: 'ペアリングの問題',
        online: 'オンライン',
        offline: 'オフライン',
        lastSeen: ({ time }: { time: string }) => `最終アクセス: ${time}`,
        permissionRequired: '権限が必要です',
        activeNow: 'アクティブ',
        unknown: '不明',
        unread: '新しい結果',
    },

    time: {
        justNow: 'たった今',
        minutesAgo: ({ count }: { count: number }) => `${count}分前`,
        hoursAgo: ({ count }: { count: number }) => `${count}時間前`,
        daysAgo: ({ count }: { count: number }) => `${count}日前`,
    },

    connect: {
        restoreAccount: 'アカウントを復元',
        enterSecretKey: 'シークレットキーを入力してください',
        invalidSecretKey: 'シークレットキーが無効です。確認して再試行してください。',
        qrInstructions: '1. モバイルデバイスでmuxrを開く\n2. 設定 → アカウントに移動\n3. 「新しいデバイスをリンク」をタップ\n4. このQRコードをスキャン',
        restoreWithSecretKeyInstead: 'シークレットキーで復元する',
    },

    settings: {
        title: '設定',
        github: 'GitHub',
        machines: 'マシン',
        showOfflineMachines: ({ count }: { count: number }) => `${count} 台のオフラインマシンを表示`,
        hideOfflineMachines: 'オフラインマシンを非表示',
        features: '機能',
        social: 'ソーシャル',
        account: 'アカウント',
        accountSubtitle: 'アカウントの詳細を管理',
        appearance: '外観',
        appearanceSubtitle: 'アプリの見た目をカスタマイズ',
        featuresTitle: '機能',
        featuresSubtitle: 'アプリ機能の有効/無効を切り替え',
        about: 'このアプリについて',
        aboutFooter: 'muxrはPiのモバイルクライアントです。エンドツーエンド暗号化は任意で、デフォルトでは無効です。アカウントはデバイスにのみ保存されます。Anthropicとは提携していません。',
        whatsNew: '新機能',
        whatsNewSubtitle: '最新のアップデートと改善を確認',
        reportIssue: '問題を報告',
        eula: 'EULA',
        connection: '接続',
        connectionSubtitle: 'リレーURL、マシン、トークン',
        pushNotifications: 'プッシュ通知',
        pushSubtitleSubscribed: 'オン — エージェントが回答を必要とするときに通知',
        pushSubtitleDenied: 'ブラウザにブロックされています — 有効にするには通知を許可してください',
        pushSubtitleUnsupported: 'このブラウザでは利用できません',
        pushSubtitleDefault: 'タップするとエージェントが回答を必要としたときに通知されます',
        license: 'ライセンスと通知',
        // Dynamic settings messages
    },

    settingsAppearance: {
        // Appearance settings screen
        theme: 'テーマ',
        themeDescription: 'お好みの配色を選択',
        themeOptions: {
            adaptive: '自動',
            light: 'ライト',
            dark: 'ダーク',
        },
        themeDescriptions: {
            adaptive: 'システム設定に合わせる',
            light: '常にライトテーマを使用',
            dark: '常にダークテーマを使用',
        },
        display: '表示',
        displayDescription: 'レイアウトと間隔を調整',

        avatarStyle: 'アバタースタイル',
        avatarStyleDescription: 'セッションアバターの外観を選択',
        avatarOptions: {
            pixelated: 'ピクセル',
            gradient: 'グラデーション',
            brutalist: 'ブルータリスト',
        },
        showFlavorIcons: 'AIプロバイダーアイコンを表示',
        showFlavorIconsDescription: 'セッションアバターにAIプロバイダーアイコンを表示',
    },

    settingsFeatures: {
        // Features settings screen
        experiments: '実験的機能',
        experimentsDescription: '開発中の実験的機能を有効にします。これらの機能は不安定であったり、予告なく変更される場合があります。',
        webFeatures: 'Web機能',
        webFeaturesDescription: 'Webバージョンでのみ利用可能な機能。',
        commandPalette: 'コマンドパレット',
        commandPaletteEnabled: '⌘Kで開く',
        commandPaletteDisabled: 'クイックコマンドアクセスは無効',
        markdownCopyV2: 'Markdownコピー v2',
        markdownCopyV2Subtitle: '長押しでコピーモーダルを開く',
        hideInactiveSessions: '非アクティブセッションを非表示',
        hideInactiveSessionsSubtitle: 'アクティブなチャットのみをリストに表示',
        imageUpload: '画像アップロード',
        imageUploadSubtitle: '対応エージェントに分析させるため、メッセージに画像を添付する',
    },

    errors: {
        authenticationFailed: '認証に失敗しました',
        failedToLoadProfile: 'ユーザープロフィールの読み込みに失敗しました',
        userNotFound: 'ユーザーが見つかりません',
        sessionDeleted: 'セッションは削除されました',
        sessionDeletedDescription: 'このセッションは完全に削除されました',

        // Error functions with context
        failedToSendRequest: '友達リクエストの送信に失敗しました',
    },

    newSession: {
        title: '新しいセッションを開始',
        machineOffline: 'マシンがオフラインです',
        switchMachinesHint: '• 上のマシンをクリックしてマシンを切り替えてください',
    },

    settingsConnection: {
        // Connection settings screen (relay URL, machine, token)
        status: ({ status }: { status: string }) => `ステータス: ${status}`,
    },

    optionSheet: {
        // Model/mode picker bottom sheet
        all: 'すべて',
        searchPlaceholder: ({ count }: { count: number }) => `検索 ${count}`,
        useCustom: ({ value }: { value: string }) => `${value} を使用`,
        noResults: '結果なし',
    },

    homeDock: {
        // Home screen composer
        inputPlaceholder: '計画、質問、構築…',
        runCommandPlaceholder: 'コマンドを実行',
        askPlaceholder: ({ name }: { name: string }) => `${name} に質問`,
    },

    liveTerminals: {
        // Live terminals strip on the home screen
        title: 'ライブ',
    },

    emptySessions: {
        // Empty state shown on tablets when no sessions are active
        noActiveSessions: 'アクティブなセッションがありません',
        startDescription: '接続されているマシンのいずれかで新しいセッションを開始してください。',
        noMachinesDescription: 'コンピューターで新しいターミナルを開いてセッションを開始してください。',
    },

    sessionHistory: {
        // Used by session history screen
        title: 'セッション履歴',
        empty: 'セッションが見つかりません',
        today: '今日',
        yesterday: '昨日',
        daysAgo: ({ count }: { count: number }) => `${count}日前`,
    },

    session: {
        inputPlaceholder: 'メッセージを入力...',
        inactiveArchived: 'このセッションは非アクティブです。',
        resumeFromTerminal: 'ターミナルから再開するには:',
        newChat: '新規チャット',
        forkAction: 'セッションをフォーク',
        forkSubtitle: '同じコンテキストで新しいセッションを続行',
        duplicateAction: 'メッセージから複製…',
        duplicateSubtitle: '選んだ地点まで巻き戻してやり直す',
        duplicateSheetTitle: '巻き戻しポイントを選択',
        duplicateSheetSubtitle: '新しいセッションは選んだターン全体（あなたのメッセージとエージェントの応答）を保持し、それ以降のメッセージは破棄します。',
        duplicateSheetConfirm: '複製',
        duplicateSheetEmpty: 'このセッションには巻き戻し可能なメッセージがまだありません。',
        duplicateRowDisabled: 'このメッセージは巻き戻しポイントに使えません。',
        forkedFromLabel: 'フォーク元',
        forkedFromSubtitle: 'フォーク元のセッションを開く',
        forkErrorMissingMetadata: 'フォークに必要なセッションのメタデータがありません。',
        forkErrorGeneric: 'セッションのフォークに失敗しました。',
    },

    commandPalette: {
        placeholder: 'コマンドを入力または検索...',
    },


    sessionInfo: {
        // Used by Session Info screen (app/(app)/session/[id]/info.tsx)
        archiveSession: 'セッションをアーカイブ',
        muxrSessionIdCopied: 'muxr Session IDがクリップボードにコピーされました',
        failedToCopySessionId: 'muxr Session IDのコピーに失敗しました',
        muxrSessionId: 'muxr Session ID',
        claudeCodeSessionId: 'Pi Session ID',
        claudeCodeSessionIdCopied: 'Pi Session IDがクリップボードにコピーされました',
        codexThreadId: 'Pi Thread ID',
        codexThreadIdCopied: 'Pi Thread IDがクリップボードにコピーされました',
        aiProvider: 'AIプロバイダー',
        failedToCopyClaudeCodeSessionId: 'Pi Session IDのコピーに失敗しました',
        failedToCopyCodexThreadId: 'Pi Thread IDのコピーに失敗しました',
        metadataCopied: 'メタデータがクリップボードにコピーされました',
        failedToCopyMetadata: 'メタデータのコピーに失敗しました',
        failedToArchiveSession: 'セッションのアーカイブに失敗しました',
        connectionStatus: '接続状態',
        created: '作成日時',
        lastUpdated: '最終更新',
        sequence: 'シーケンス',
        quickActions: 'クイックアクション',
        viewMachine: 'マシンを表示',
        viewMachineSubtitle: 'マシンの詳細とセッションを表示',
        resumeSession: 'Resume Session',
        resumeSessionSubtitle: 'Resume this session on the same machine',
        resumeSessionSameMachineOnly: 'This session can only be resumed on the same machine it started on.',
        resumeSessionMachineOffline: 'This machine is offline. Resume is only available while it is online.',
        resumeSessionMissingMachine: 'This session is missing its machine metadata, so it cannot be resumed.',
        resumeSessionMissingBackendId: 'This session does not have a resumable Pi identifier.',
        resumeSessionUnexpectedDirectoryPrompt: 'Resume cannot create directories. Start the session manually from its original path.',
        archiveSessionSubtitle: 'このセッションをアーカイブして停止',
        metadata: 'メタデータ',
        host: 'ホスト',
        path: 'パス',
        operatingSystem: 'オペレーティングシステム',
        processId: 'プロセスID',
        muxrHome: 'muxr Home',
        copyMetadata: 'メタデータをコピー',
        agentState: 'エージェント状態',
        controlledByUser: 'ユーザーによる制御',
        pendingRequests: '保留中のリクエスト',
        activity: 'アクティビティ',
        thinking: '思考中',
        thinkingSince: '思考開始時刻',
        cliVersion: 'CLIバージョン',
        deleteSession: 'セッションを削除',
        deleteSessionSubtitle: 'このセッションを完全に削除',
        deleteSessionWarning: 'この操作は取り消せません。このセッションに関連するすべてのメッセージとデータが完全に削除されます。',
        failedToDeleteSession: 'セッションの削除に失敗しました',
        worktreeCleanupTitle: 'Worktreeを削除しますか？',
        worktreeCleanupMessage: 'Worktreeにコミットされていない変更はありません。Worktreeのファイルを削除しますか？',
        worktreeCleanupDelete: 'Worktreeを削除',
        worktreeCleanupKeep: 'ファイルを保持',
        landWorktree: 'Land Worktree',
        landWorktreeSubtitle: 'Squash this worktree onto the base branch and remove it',
        landWorktreeMessage: 'Commit message for the squashed change',
        landWorktreeFailed: 'Failed to land worktree',
        landWorktreeDone: 'Landed on the base branch. The worktree is gone.',

    },

    archive: {
        select: '選択',
        selectAll: 'すべて選択',
        deselectAll: 'すべて選択解除',
        archiveCount: ({ count }: { count: number }) => plural({ count, singular: '1件のセッションをアーカイブ', plural: `${count}件のセッションをアーカイブ` }),
        unarchiveCount: ({ count }: { count: number }) => plural({ count, singular: '1件のセッションを復元', plural: `${count}件のセッションを復元` }),
        selectedCount: ({ count }: { count: number }) => `${count}件選択中`,
        archivedCount: ({ count }: { count: number }) => plural({ count, singular: '1件のセッションをアーカイブしました', plural: `${count}件のセッションをアーカイブしました` }),
        undo: '元に戻す',
    },

    components: {
        sessionStatusBar: {
            contextUsage: ({ used, total, percent }: { used: string; total: string; percent: number }) => `コンテキスト ${total}トークン中${used}、${percent}%`,
            limitFiveHour: '5時間の上限',
            limitSevenDay: '7日間の上限',
            limitResets: ({ time }: { time: string }) => `${time} リセット`,
            limitAsOf: ({ age }: { age: string }) => `${age}前のデータ`,
            limitRemaining: ({ percent }: { percent: number }) => `残り ${percent}%`,
        },
    },

    agentInput: {
        permissionMode: {
            title: '権限モード',
            default: 'デフォルト',
            acceptEdits: '編集を許可',
            plan: 'プランモード',
            dontAsk: '確認しない',
            bypassPermissions: 'Yoloモード',
        },
        agent: {
            pi: 'Pi',
        },
        model: {
            title: 'モデル',
            configureInCli: 'CLIの設定でモデルを構成',
        },
        effort: {
            title: 'エフォート',
        },
        codexPermissionMode: {
            title: 'PI権限モード',
            default: 'CLI設定',
            readOnly: '読み取り専用モード',
            safeYolo: 'セーフYOLO',
            yolo: 'YOLO',
            defaultDescription: '信頼されていないコマンドの前に確認',
            readOnlyDescription: '書き込みなし',
            safeYoloDescription: '確認なし、ワークスペースサンドボックス',
            yoloDescription: '確認なし、フルアクセス',
        },

        geminiPermissionMode: {
            title: 'PI権限モード',
            default: 'デフォルト',
            autoEdit: '自動編集',
            yolo: 'YOLO',
            plan: 'プラン',
        },
        context: {
            remaining: ({ percent }: { percent: number }) => `残り ${percent}%`,
        },
        suggestion: {
            fileLabel: 'ファイル',
            folderLabel: 'フォルダ',
        },
        noMachinesAvailable: 'マシンなし',
    },

    machineLauncher: {
        showLess: '折りたたむ',
        showAll: ({ count }: { count: number }) => `すべて表示 (${count}パス)`,
        enterCustomPath: 'カスタムパスを入力',
    },

    sidebar: {
        sessionsTitle: 'muxr',
        showArchived: 'アーカイブを表示',
        hideArchived: 'アーカイブを非表示',
        newSession: '新しいセッション',
    },

    zen: {
        toggle: 'Zenモード',
    },

    toolView: {
        input: '入力',
        output: '出力',
    },

    thinking: {
        active: 'Thinking…',
        thought: 'Thought',
        thoughtFor: ({ duration }: { duration: string }) => `Thought for ${duration}`,
    },

    sessionAttachments: {
        title: ({ count }: { count: number }) => count === 1 ? '1件の添付ファイル' : `${count}件の添付ファイル`,
    },

    turnChanges: {
        filesChanged: ({ count }: { count: number }) => `${count}件のファイルを変更`,
    },

    tools: {
        fullView: {
            description: '説明',
            inputParams: '入力パラメータ',
            output: '出力',
            error: 'エラー',
            completed: 'ツールが正常に完了しました',
            noOutput: '出力がありません',
            rawJsonDevMode: 'Raw JSON (開発モード)',
        },



        names: {
            search: '検索',
        },
        desc: {
        }
    },

    files: {
        changes: '変更',
        searchPlaceholder: 'ファイルを検索...',
        detachedHead: 'detached HEAD',
        summary: ({ staged, unstaged }: { staged: number; unstaged: number }) => `ステージ済み ${staged} • 未ステージ ${unstaged}`,
        notRepo: 'Gitリポジトリではありません',
        notUnderGit: 'このディレクトリはGitバージョン管理下にありません',
        searching: 'ファイルを検索中...',
        noFilesFound: 'ファイルが見つかりません',
        noFilesInProject: 'プロジェクトにファイルがありません',
        tryDifferentTerm: '別の検索語を試してください',
        searchResults: ({ count }: { count: number }) => `検索結果 (${count})`,
        projectRoot: 'プロジェクトルート',
        stagedChanges: ({ count }: { count: number }) => `ステージ済みの変更 (${count})`,
        unstagedChanges: ({ count }: { count: number }) => `未ステージの変更 (${count})`,
        // File viewer strings
        loadingFile: ({ fileName }: { fileName: string }) => `${fileName}を読み込み中...`,
        binaryFile: 'バイナリファイル',
        cannotDisplayBinary: 'バイナリファイルの内容を表示できません',
        diff: '差分',
        file: 'ファイル',
        fileEmpty: 'ファイルは空です',
        fileDeleted: 'このファイルはもう存在しません',
        previousDocument: '前のドキュメント',
        nextDocument: '次のドキュメント',
        previousChange: '前の変更',
        nextChange: '次の変更',
        toggleFileAndDiff: 'ファイルと差分を切り替え',
        wrapLines: '長い行を折り返す',
        zoomIn: '拡大',
        zoomOut: '縮小',
        resetZoom: 'ズームをリセット',
        previousFile: '前のファイル',
        nextFile: '次のファイル',
        previousFileNamed: ({ title, ordinal, total }: { title: string; ordinal: number; total: number }) => `前のファイル、${title}、${ordinal} / ${total}`,
        nextFileNamed: ({ title, ordinal, total }: { title: string; ordinal: number; total: number }) => `次のファイル、${title}、${ordinal} / ${total}`,
        filePosition: ({ current, total }: { current: number; total: number }) => `ファイル ${current} / ${total}`,
        diffUnavailable: '差分、利用不可、このファイルに変更はありません',
        previousChangeAt: ({ current, total }: { current: number; total: number }) => `前の変更、${current} / ${total}`,
        nextChangeAt: ({ current, total }: { current: number; total: number }) => `次の変更、${current} / ${total}`,
        graphicsUnavailable: 'グラフィックを利用できません',
        folderNotFile: 'そのパスはフォルダーであり、ファイルではありません。',
        showFullPath: 'フルパスを表示',
        pathShowFullPath: ({ label }: { label: string }) => `パス ${label}、フルパスを表示`,
        goToPath: ({ label }: { label: string }) => `${label} へ移動`,
        fullPath: 'フルパス',
        noChanges: '表示する変更はありません',
        noChangesTitle: '変更なし',
        noChangesSubtitle: 'ワーキングツリーはクリーンです',
        deleted: '削除済み',
        changedFiles: ({ count }: { count: number }) => `${count}件の変更ファイル`,
        allFiles: 'すべてのファイル',
        addPanel: 'パネルを追加',
        closePanel: 'パネルを閉じる',
        editFile: '編集',
        saveFile: '保存',
        failedToRead: 'ファイルの読み取りに失敗しました',
        failedToSave: 'ファイルの保存に失敗しました',
        fileConflict: 'ファイルの競合',
        fileConflictDescription: '編集中にデバイス上でファイルが変更されました。最新版を表示するには再読み込みしてください。',
        reload: '再読み込み',
        overwrite: '上書き',
    },
    sideChat: {
        panelTitle: 'サイドチャット',
        emptyTitle: 'サイドチャットを始める',
        emptySubtitle: 'エージェントに脇で質問しましょう。このチャットのコンテキストを引き継ぎますが独立しており — ここでの操作はメインの会話に影響しません。',
        startButton: 'サイドチャットを開始',
        creating: 'サイドチャットを開始しています…',
        unavailable: 'このセッションではまだサイドチャットを開始できません — エージェントがオンラインになるまでお待ちください。',
        expand: '全画面で開く',
        tabLabel: ({ index }: { index: number }) => `サイドチャット ${index}`,
        newChat: '新しいサイドチャット',
        close: 'サイドチャットを閉じる',
    },


    settingsAccount: {
        // Account settings screen
        accountInformation: 'アカウント情報',
        status: 'ステータス',
        statusActive: 'アクティブ',
        statusNotAuthenticated: '未認証',
        anonymousId: '匿名ID',
        publicId: '公開ID',
        notAvailable: '利用不可',
        linkNewDevice: '新しいデバイスをリンク',
        linkNewDeviceSubtitle: 'QRコードをスキャンしてデバイスをリンク',
        backup: 'バックアップ',
        backupDescription: 'シークレットキーはアカウントを復元する唯一の方法です。パスワードマネージャーなどの安全な場所に保存してください。',
        secretKey: 'シークレットキー',
        tapToReveal: 'タップして表示',
        tapToHide: 'タップして非表示',
        secretKeyLabel: 'シークレットキー (タップでコピー)',
        secretKeyCopied: 'シークレットキーがクリップボードにコピーされました。安全な場所に保管してください！',
        secretKeyCopyFailed: 'シークレットキーのコピーに失敗しました',
        dangerZone: '危険ゾーン',
        logout: 'ログアウト',
        logoutSubtitle: 'サインアウトしてローカルデータを消去',
        logoutConfirm: 'ログアウトしてもよろしいですか？シークレットキーのバックアップを取っていることを確認してください！',
    },

    settingsLanguage: {
        // Language settings screen
        title: '言語',
        description: 'アプリインターフェースの言語を選択します。この設定はすべてのデバイスで同期されます。',
        currentLanguage: '現在の言語',
        automatic: '自動',
        automaticSubtitle: 'デバイス設定から検出',
        needsRestart: '言語が変更されました',
        needsRestartMessage: '新しい言語設定を適用するにはアプリの再起動が必要です。',
    },


    updateBanner: {
        updateAvailable: 'アップデートが利用可能',
        pressToApply: 'タップしてアップデートを適用',
        whatsNew: "新機能",
        seeLatest: '最新のアップデートと改善を確認',
        nativeUpdateAvailable: 'アプリのアップデートが利用可能',
        tapToUpdateAppStore: 'タップしてApp Storeで更新',
        tapToUpdatePlayStore: 'タップしてPlay Storeで更新',
    },

    changelog: {
        // Used by the changelog screen
        noEntriesAvailable: '変更履歴はありません。',
    },

    terminal: {
        // Used by terminal connection screens
        webBrowserRequired: 'Webブラウザが必要です',
        webBrowserRequiredDescription: 'ターミナル接続リンクはセキュリティ上の理由からWebブラウザでのみ開くことができます。QRコードスキャナーを使用するか、コンピューターでこのリンクを開いてください。',
        processingConnection: '接続を処理中...',
        invalidConnectionLink: '無効な接続リンク',
        invalidConnectionLinkDescription: '接続リンクが見つからないか無効です。URLを確認して再試行してください。',
        connectTerminal: 'ターミナルを接続',
        terminalRequestDescription: 'ターミナルがmuxrアカウントへの接続を要求しています。これにより、ターミナルは安全にメッセージを送受信できるようになります。',
        connectionDetails: '接続の詳細',
        publicKey: '公開鍵',
        encryption: '暗号化',
        endToEndEncrypted: 'エンドツーエンド暗号化',
        acceptConnection: '接続を承認',
        connecting: '接続中...',
        reject: '拒否',
        security: 'セキュリティ',
        securityFooter: 'この接続リンクはブラウザ内で安全に処理され、サーバーには送信されませんでした。あなたのプライベートデータは安全に保たれ、メッセージを復号できるのはあなただけです。',
        securityFooterDevice: 'この接続はデバイス上で安全に処理され、サーバーには送信されませんでした。あなたのプライベートデータは安全に保たれ、メッセージを復号できるのはあなただけです。',
        clientSideProcessing: 'クライアントサイド処理',
        linkProcessedLocally: 'リンクはブラウザ内でローカルに処理されました',
        linkProcessedOnDevice: 'リンクはデバイス上でローカルに処理されました',
    },

    modals: {
        // Used across connect flows and settings
        deviceLinkedSuccessfully: 'デバイスが正常にリンクされました',
        invalidAuthUrl: '無効な認証URL',
        developerMode: '開発者モード',
        developerModeEnabled: '開発者モードが有効になりました',
        developerModeDisabled: '開発者モードが無効になりました',
        failedToLinkDevice: 'デバイスのリンクに失敗しました',
        cameraPermissionsRequiredToScanQr: 'QRコードのスキャンにはカメラの権限が必要です'
    },

    navigation: {
        // Navigation titles and screen headers
        connectTerminal: 'ターミナルを接続',
        linkNewDevice: '新しいデバイスをリンク',
        restoreWithSecretKey: 'シークレットキーで復元',
        browserTakeover: 'ブラウザ引き継ぎ',
        whatsNew: "新機能",
        friends: '友達',
    },

    welcome: {
        // Main welcome screen for unauthenticated users
        title: 'Piのモバイルクライアント',
        subtitle: 'アカウントはデバイスにのみ保存されます。エンドツーエンド暗号化は任意です。',
        createAccount: 'アカウントを作成',
        linkOrRestoreAccount: 'アカウントをリンクまたは復元',
        loginWithMobileApp: 'モバイルアプリでログイン',
    },

    review: {
        // Used by utils/requestReview.ts
        enjoyingApp: 'アプリを気に入っていただけましたか？',
        feedbackPrompt: "ご意見をお聞かせください！",
        yesILoveIt: 'はい、気に入りました！',
        notReally: 'あまり...'
    },

    items: {
        // Used by Item component for copy toast
        copiedToClipboard: ({ label }: { label: string }) => `${label}がクリップボードにコピーされました`
    },

    machine: {
        launchNewSessionInDirectory: 'ディレクトリで新しいセッションを起動',
        offlineUnableToSpawn: 'マシンがオフラインのためランチャーは無効です',
        daemon: 'デーモン',
        status: 'ステータス',
        stopDaemon: 'デーモンを停止',
        lastKnownPid: '最後に確認されたPID',
        lastKnownHttpPort: '最後に確認されたHTTPポート',
        startedAt: '開始時刻',
        cliVersion: 'CLIバージョン',
        daemonStateVersion: 'デーモン状態バージョン',
        stopDaemonConfirmTitle: 'デーモンを停止しますか？',
        stopDaemonConfirmMessage: 'コンピューターでデーモンを再起動するまで、このマシンで新しいセッションを開始できなくなります。現在のセッションは維持されます。',
        daemonStopped: 'デーモンを停止しました',
        stopDaemonFailed: 'デーモンを停止できませんでした。実行されていない可能性があります。',
        machineGroup: 'マシン',
        host: 'ホスト',
        machineId: 'マシンID',
        username: 'ユーザー名',
        homeDirectory: 'ホームディレクトリ',
        platform: 'プラットフォーム',
        architecture: 'アーキテクチャ',
        lastSeen: '最終確認',
        never: 'なし',
        metadataVersion: 'メタデータバージョン',
        cliAvailability: 'CLI利用可否',
        cliInstalled: 'インストール済み',
        cliNotFound: '未検出',
        lastDetected: '最終検出',
        back: '戻る',
        dangerZone: '危険ゾーン',
        delete: 'マシンを削除',
        deleteFooter: 'このマシンをアカウントから削除します。セッション履歴は保持されますが、このマシンで新しいセッションを起動できなくなります。',
        deleteConfirmTitle: 'このマシンを削除しますか？',
        deleteConfirmMessage: 'マシンがアカウントから削除されます。セッション履歴は保持されますが、デーモンを再接続するまで新しいセッションを起動できません。',
        deleteFailed: 'マシンの削除に失敗しました。',
    },

    message: {
        switchedToMode: ({ mode }: { mode: string }) => `${mode}モードに切り替えました`,
        unknownEvent: '不明なイベント',
        usageLimitUntil: ({ time }: { time: string }) => `${time}まで使用制限中`,
        sentAsGoal: 'Sent as goal',
        unknownTime: '不明な時間',
    },

    codex: {
        // Pi permission dialog buttons
        permissions: {
            yesForSession: "はい、このセッションでは確認しない",
            stopAndExplain: '停止して、何をすべきか説明',
        }
    },

    claude: {
        // Pi permission dialog buttons
        permissions: {
            yesAllowAllEdits: 'はい、このセッション中のすべての編集を許可',
            yesAllowEverything: 'はい、このセッション中のすべてを許可',
            yesForTool: "はい、このツールについては確認しない",
            noTellClaude: 'いいえ、フィードバックを提供',
        }
    },

    textSelection: {
        // Text selection screen
        title: 'テキストを選択',
        noTextProvided: 'テキストが提供されていません',
        textNotFound: 'テキストが見つからないか期限切れです',
        textCopied: 'テキストがクリップボードにコピーされました',
        failedToCopy: 'テキストのクリップボードへのコピーに失敗しました',
        noTextToCopy: 'コピーできるテキストがありません',
    },

    markdown: {
        // Markdown copy functionality
        codeCopied: 'コードをコピーしました',
        copyFailed: 'コピーに失敗しました',
        mermaidRenderFailed: 'Mermaidダイアグラムのレンダリングに失敗しました',
    },

    artifacts: {
        // Artifacts feature
        title: 'アーティファクト',
        empty: 'アーティファクトはまだありません',
        emptyDescription: '最初のアーティファクトを作成して始めましょう',
        new: '新規アーティファクト',
        edit: 'アーティファクトを編集',
        delete: '削除',
        updateError: 'アーティファクトの更新に失敗しました。再試行してください。',
        notFound: 'アーティファクトが見つかりません',
        deleteConfirm: 'アーティファクトを削除しますか？',
        deleteConfirmDescription: 'この操作は取り消せません',
        titleLabel: 'タイトル',
        titlePlaceholder: 'アーティファクトのタイトルを入力',
        bodyLabel: 'コンテンツ',
        bodyPlaceholder: 'ここにコンテンツを書いてください...',
        emptyFieldsError: 'タイトルまたはコンテンツを入力してください',
        createError: 'アーティファクトの作成に失敗しました。再試行してください。',
        loading: 'アーティファクトを読み込み中...',
        error: 'アーティファクトの読み込みに失敗しました',
    },

    friends: {
        // Friends feature
        manageFriends: '友達とつながりを管理',
        pendingRequests: '友達リクエスト',
        myFriends: 'マイフレンド',
        noFriendsYet: "まだ友達がいません",
        remove: '削除',
        addFriend: '友達を追加',
        alreadyFriends: '既に友達です',
        requestPending: 'リクエスト保留中',
        searchInstructions: '友達を検索するにはユーザー名を入力してください',
        searchPlaceholder: 'ユーザー名を入力...',
        searching: '検索中...',
        noUserFound: 'そのユーザー名のユーザーが見つかりません',
        checkUsername: 'ユーザー名を確認して再試行してください',
        howToFind: '友達を見つける方法',
        findInstructions: 'ユーザー名で友達を検索します。友達リクエストを送信するには、両方のユーザーがGitHubを接続している必要があります。',
        requestSent: '友達リクエストが送信されました！',
        confirmRemove: '友達を削除',
        confirmRemoveMessage: 'この友達を削除してもよろしいですか？',
        cannotAddYourself: '自分自身に友達リクエストを送信することはできません',
        bothMustHaveGithub: '友達になるには、両方のユーザーがGitHubを接続している必要があります',
        status: {
            none: '未接続',
            requested: 'リクエスト送信済み',
            pending: 'リクエスト保留中',
            friend: '友達',
            rejected: '拒否済み',
        },
        acceptRequest: 'リクエストを承認',
        removeFriend: '友達を削除',
        removeFriendConfirm: ({ name }: { name: string }) => `${name}さんを友達から削除してもよろしいですか？`,
        requestFriendship: '友達リクエストを送信',
        cancelRequest: '友達リクエストをキャンセル',
        cancelRequestConfirm: ({ name }: { name: string }) => `${name}さんへの友達リクエストをキャンセルしますか？`,
        denyRequest: '友達リクエストを拒否',
    },

    usage: {
        // Usage panel strings
        today: '今日',
        last7Days: '過去7日間',
        last30Days: '過去30日間',
        totalTokens: '合計トークン',
        totalCost: '合計コスト',
        tokens: 'トークン',
        cost: 'コスト',
        usageOverTime: '使用量の推移',
        byModel: 'モデル別',
    },

    imageUpload: {
        permissionTitle: 'フォトライブラリへのアクセス',
        permissionMessage: 'メッセージに画像を添付するには、フォトライブラリへのアクセスを許可してください。',
        limitTitle: '画像の上限に達しました',
        limitMessage: ({ max }: { max: number }) => `1メッセージに添付できる画像は最大${max}枚です。`,
        fileTooLargeTitle: 'ファイルが大きすぎます',
        fileTooLargeMessage: ({ name, maxMb }: { name: string; maxMb: number }) => `"${name}"は${maxMb}MBの制限を超えているため追加されませんでした。`,
        uploadFailedTitle: 'アップロードに失敗しました',
        uploadFailedMessage: ({ count }: { count: number }) => count === 1
            ? '1枚の画像をアップロードできず、送信されませんでした。'
            : `${count}枚の画像をアップロードできず、送信されませんでした。`,
        notSupportedTitle: '画像はサポートされていません',
        notSupportedMessage: 'このエージェントは画像の添付に対応していません。画像は送信されませんでした。',
    },

    feed: {
        // Feed notifications for friend requests and acceptances
    }
} as const;
