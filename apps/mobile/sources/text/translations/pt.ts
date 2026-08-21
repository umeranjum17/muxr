import type { TranslationStructure } from '../_default';

/**
 * Portuguese plural helper function
 * Portuguese (Brazilian) has 2 plural forms: singular, plural
 * @param options - Object containing count, singular, and plural forms
 * @returns The appropriate form based on Portuguese plural rules
 */
function plural({ count, singular, plural }: { count: number; singular: string; plural: string }): string {
    return count === 1 ? singular : plural;
}

/**
 * Portuguese (Brazilian) translations for the muxr app
 * Must match the exact structure of the English translations
 */
export const pt: TranslationStructure = {
    tabs: {
        // Tab navigation labels
        sessions: 'Terminais',
        settings: 'Configurações',
    },

    inbox: {
        // Inbox screen: the sessions currently waiting on you
        reason: {
            waiting: 'aguardando',
            blocked: 'bloqueada',
            failed: 'falhou',
            done: 'concluída',
        },
    },

    plugins: {
        openFromHome: 'Abra um plugin a partir do Início.',
        unavailable: 'Este plugin está desativado ou indisponível.',
        goBack: 'Voltar',
        couldNotLoad: 'Não foi possível carregar os itens',
        dataUnavailable: 'O plugin está indisponível agora.',
        nothingHere: 'Não há nada aqui',
        newItems: 'Novos itens aparecerão aqui.',
        retry: 'Tentar novamente',
        retryItems: 'Tentar carregar os itens do plugin novamente',
        stale: 'Não foi possível atualizar. Mostrando o último resultado.',
        nothingToShow: 'Nada para mostrar.',
        treeUnavailable: 'Árvore indisponível.',
        dictate: 'Ditar',
        unavailableSuffix: 'indisponível',
        showingStale: 'mostrando dados antigos',
        settingsTitle: 'Plugins',
        enableAll: 'Ativar todos',
        disableAll: 'Desativar todos',
        installed: 'Instalados',
        waitingHost: 'Aguardando o host.',
        linkHost: 'Vincule um plugin pelo Herdr e reconecte.',
        enabled: 'ativados',
        off: 'desat.',
        on: 'at.',
        unavailableLabel: 'Indisponível',
        updateAvailable: 'Atualização disponível',
        runsCode: 'Executa código como você',
        uiOnly: 'Somente interface',
        readsSessions: 'Lê resumos de sessões',
        readsTree: 'Lê a árvore do espaço de trabalho',
        openFailed: 'Não foi possível abrir',
        actionFailed: 'A ação falhou',
        items: 'Itens',
        openWebsite: 'Abrir site?',
        open: 'Abrir',
        realtimeConnecting: 'Conectando sessão de voz',
        realtimeListening: 'Ouvindo',
        realtimeThinking: 'Pensando',
        realtimeSpeaking: 'Falando',
        realtimeError: 'Erro na sessão de voz',
        realtimeOff: 'Sessão de voz desligada',
        openConversation: 'Abrir conversa por voz',
        realtime: 'Voz',
    },

    common: {
        // Simple string constants
        cancel: 'Cancelar',
        save: 'Salvar',
        error: 'Erro',
        success: 'Sucesso',
        ok: 'OK',
        back: 'Voltar',
        create: 'Criar',
        rename: 'Renomear',
        logout: 'Sair',
        yes: 'Sim',
        no: 'Não',
        version: 'Versão',
        copied: 'Copiado',
        copy: 'Copiar',
        scanning: 'Escaneando...',
        home: 'Início',
        message: 'Mensagem',
        files: 'Arquivos',
        fileViewer: 'Visualizador de arquivos',
        loading: 'Carregando...',
        delete: 'Excluir',
    },

    profile: {
        details: 'Detalhes',
        firstName: 'Nome',
        lastName: 'Sobrenome',
        username: 'Nome de usuário',
        status: 'Status',
    },


    status: {
        connected: 'conectado',
        connecting: 'conectando',
        disconnected: 'desconectado',
        error: 'erro',
        pairingIssue: 'problema de emparelhamento',
        online: 'online',
        offline: 'offline',
        lastSeen: ({ time }: { time: string }) => `visto por último ${time}`,
        permissionRequired: 'permissão necessária',
        activeNow: 'Ativo agora',
        unknown: 'desconhecido',
        unread: 'novos resultados',
    },

    time: {
        justNow: 'agora mesmo',
        minutesAgo: ({ count }: { count: number }) => `há ${count} minuto${count !== 1 ? 's' : ''}`,
        hoursAgo: ({ count }: { count: number }) => `há ${count} hora${count !== 1 ? 's' : ''}`,
        daysAgo: ({ count }: { count: number }) => `há ${count} dia${count !== 1 ? 's' : ''}`,
    },

    connect: {
        restoreAccount: 'Restaurar conta',
        enterSecretKey: 'Por favor, insira uma chave secreta',
        invalidSecretKey: 'Chave secreta inválida. Verifique e tente novamente.',
        qrInstructions: '1. Abra o muxr no seu dispositivo móvel\n2. Vá em Configurações → Conta\n3. Toque em "Vincular novo dispositivo"\n4. Escaneie este código QR',
        restoreWithSecretKeyInstead: 'Ou restaurar com a chave secreta',
    },

    settings: {
        title: 'Configurações',
        github: 'GitHub',
        machines: 'Máquinas',
        showOfflineMachines: ({ count }: { count: number }) => count === 1 ? 'Mostrar 1 máquina offline' : `Mostrar ${count} máquinas offline`,
        hideOfflineMachines: 'Ocultar máquinas offline',
        features: 'Recursos',
        social: 'Social',
        account: 'Conta',
        accountSubtitle: 'Gerencie os detalhes da sua conta',
        appearance: 'Aparência',
        appearanceSubtitle: 'Personalize a aparência do aplicativo',
        featuresTitle: 'Recursos',
        featuresSubtitle: 'Ativar ou desativar recursos do aplicativo',
        about: 'Sobre',
        aboutFooter: 'muxr é um cliente móvel para Pi. A criptografia ponta a ponta é opcional e desativada por padrão; sua conta é armazenada apenas no seu dispositivo. Não é afiliado à Anthropic.',
        whatsNew: 'Novidades',
        whatsNewSubtitle: 'Veja as atualizações e melhorias mais recentes',
        reportIssue: 'Relatar um problema',
        eula: 'EULA',
        connection: 'Conexão',
        connectionSubtitle: 'URL do relay, máquina e token',
        pushNotifications: 'Notificações push',
        pushSubtitleSubscribed: 'Ativadas — você é avisado quando um agente precisa de uma resposta',
        pushSubtitleDenied: 'Bloqueadas pelo navegador — permita as notificações para ativar',
        pushSubtitleUnsupported: 'Não disponível neste navegador',
        pushSubtitleDefault: 'Toque para ser avisado quando um agente precisar de uma resposta',
        license: 'Licença e avisos',
        // Dynamic settings messages
    },

    settingsAppearance: {
        // Appearance settings screen
        theme: 'Tema',
        themeDescription: 'Escolha seu esquema de cores preferido',
        themeOptions: {
            adaptive: 'Adaptativo',
            light: 'Claro', 
            dark: 'Escuro',
        },
        themeDescriptions: {
            adaptive: 'Usar configurações do sistema',
            light: 'Sempre usar tema claro',
            dark: 'Sempre usar tema escuro',
        },
        display: 'Exibição',
        displayDescription: 'Controle layout e espaçamento',

        avatarStyle: 'Estilo do avatar',
        avatarStyleDescription: 'Escolha a aparência do avatar da sessão',
        avatarOptions: {
            pixelated: 'Pixelizado',
            gradient: 'Gradiente',
            brutalist: 'Brutalista',
        },
        showFlavorIcons: 'Mostrar ícones de provedores de IA',
        showFlavorIconsDescription: 'Exibir ícones do provedor de IA nos avatares de sessão',
    },

    settingsFeatures: {
        // Features settings screen
        experiments: 'Experimentos',
        experimentsDescription: 'Ative recursos experimentais que ainda estão em desenvolvimento. Estes recursos podem ser instáveis ou mudar sem aviso.',
        webFeatures: 'Recursos web',
        webFeaturesDescription: 'Recursos disponíveis apenas na versão web do aplicativo.',
        commandPalette: 'Paleta de comandos',
        commandPaletteEnabled: 'Pressione ⌘K para abrir',
        commandPaletteDisabled: 'Acesso rápido a comandos desativado',
        markdownCopyV2: 'Markdown Copy v2',
        markdownCopyV2Subtitle: 'Pressione e segure para abrir modal de cópia',
        hideInactiveSessions: 'Ocultar sessões inativas',
        hideInactiveSessionsSubtitle: 'Mostre apenas os chats ativos na sua lista',
        imageUpload: 'Upload de imagens',
        imageUploadSubtitle: 'Anexe imagens às mensagens para que agentes compatíveis as analisem',
    },

    errors: {
        authenticationFailed: 'Falha na autenticação',
        failedToLoadProfile: 'Falha ao carregar o perfil do usuário',
        userNotFound: 'Usuário não encontrado',
        sessionDeleted: 'A sessão foi excluída',
        sessionDeletedDescription: 'Esta sessão foi removida permanentemente',

        // Error functions with context
        failedToSendRequest: 'Falha ao enviar solicitação de amizade',
    },

    newSession: {
        title: 'Iniciar nova sessão',
        machineOffline: 'A máquina está offline',
        switchMachinesHint: '• Troque de máquina clicando na máquina acima',
    },

    settingsConnection: {
        // Connection settings screen (relay URL, machine, token)
        status: ({ status }: { status: string }) => `Status: ${status}`,
    },

    optionSheet: {
        // Model/mode picker bottom sheet
        all: 'todas',
        searchPlaceholder: ({ count }: { count: number }) => `Pesquisar ${count}`,
        useCustom: ({ value }: { value: string }) => `usar ${value}`,
        noResults: 'sem resultados',
    },

    homeDock: {
        // Home screen composer
        inputPlaceholder: 'Planeje, pergunte, construa…',
        runCommandPlaceholder: 'Execute um comando',
        askPlaceholder: ({ name }: { name: string }) => `Pergunte ao ${name}`,
    },

    liveTerminals: {
        // Live terminals strip on the home screen
        title: 'AO VIVO',
    },

    emptySessions: {
        // Empty state shown on tablets when no sessions are active
        noActiveSessions: 'Nenhuma sessão ativa',
        startDescription: 'Inicie uma nova sessão em qualquer uma das suas máquinas conectadas.',
        noMachinesDescription: 'Abra um novo terminal no seu computador para iniciar uma sessão.',
    },

    sessionHistory: {
        // Used by session history screen
        title: 'Histórico de sessões',
        empty: 'Nenhuma sessão encontrada',
        today: 'Hoje',
        yesterday: 'Ontem',
        daysAgo: ({ count }: { count: number }) => `há ${count} ${count === 1 ? 'dia' : 'dias'}`,
    },

    session: {
        inputPlaceholder: 'Digite uma mensagem ...',
        inactiveArchived: 'Esta sessão está inativa.',
        resumeFromTerminal: 'Para retomá-la pelo terminal:',
        newChat: 'Novo chat',
        forkAction: 'Bifurcar sessão',
        forkSubtitle: 'Continuar em uma nova sessão com o mesmo contexto',
        duplicateAction: 'Duplicar a partir da mensagem…',
        duplicateSubtitle: 'Voltar a um ponto escolhido e tentar de novo',
        duplicateSheetTitle: 'Escolha um ponto de retrocesso',
        duplicateSheetSubtitle: 'A nova sessão manterá o turno escolhido completo (sua mensagem e a resposta do agente) e descartará as mensagens seguintes.',
        duplicateSheetConfirm: 'Duplicar',
        duplicateSheetEmpty: 'Ainda não há mensagens elegíveis para retrocesso nesta sessão.',
        duplicateRowDisabled: 'Esta mensagem não pode ser usada como ponto de retrocesso.',
        forkedFromLabel: 'Bifurcado de',
        forkedFromSubtitle: 'Abrir a sessão da qual foi bifurcada',
        forkErrorMissingMetadata: 'Faltam metadados da sessão necessários para bifurcar.',
        forkErrorGeneric: 'Não foi possível bifurcar a sessão.',
    },

    commandPalette: {
        placeholder: 'Digite um comando ou pesquise...',
    },


    sessionInfo: {
        // Used by Session Info screen (app/(app)/session/[id]/info.tsx)
        archiveSession: 'Arquivar sessão',
        muxrSessionIdCopied: 'ID da sessão muxr copiado para a área de transferência',
        failedToCopySessionId: 'Falha ao copiar ID da sessão muxr',
        muxrSessionId: 'ID da sessão muxr',
        claudeCodeSessionId: 'ID da sessão Pi',
        claudeCodeSessionIdCopied: 'ID da sessão Pi copiado para a área de transferência',
        codexThreadId: 'ID da thread do Pi',
        codexThreadIdCopied: 'ID da thread do Pi copiado para a área de transferência',
        aiProvider: 'Provedor de IA',
        failedToCopyClaudeCodeSessionId: 'Falha ao copiar ID da sessão Pi',
        failedToCopyCodexThreadId: 'Falha ao copiar ID da thread do Pi',
        metadataCopied: 'Metadados copiados para a área de transferência',
        failedToCopyMetadata: 'Falha ao copiar metadados',
        failedToArchiveSession: 'Falha ao arquivar sessão',
        connectionStatus: 'Status da conexão',
        created: 'Criado',
        lastUpdated: 'Última atualização',
        sequence: 'Sequência',
        quickActions: 'Ações rápidas',
        viewMachine: 'Ver máquina',
        viewMachineSubtitle: 'Ver detalhes da máquina e sessões',
        resumeSession: 'Resume Session',
        resumeSessionSubtitle: 'Resume this session on the same machine',
        resumeSessionSameMachineOnly: 'This session can only be resumed on the same machine it started on.',
        resumeSessionMachineOffline: 'This machine is offline. Resume is only available while it is online.',
        resumeSessionMissingMachine: 'This session is missing its machine metadata, so it cannot be resumed.',
        resumeSessionMissingBackendId: 'This session does not have a resumable Pi identifier.',
        resumeSessionUnexpectedDirectoryPrompt: 'Resume cannot create directories. Start the session manually from its original path.',
        archiveSessionSubtitle: 'Arquivar esta sessão e pará-la',
        metadata: 'Metadados',
        host: 'Host',
        path: 'Caminho',
        operatingSystem: 'Sistema operacional',
        processId: 'ID do processo',
        muxrHome: 'Diretório muxr',
        copyMetadata: 'Copiar metadados',
        agentState: 'Estado do agente',
        controlledByUser: 'Controlado pelo usuário',
        pendingRequests: 'Solicitações pendentes',
        activity: 'Atividade',
        thinking: 'Pensando',
        thinkingSince: 'Pensando desde',
        cliVersion: 'Versão do CLI',
        deleteSession: 'Excluir sessão',
        deleteSessionSubtitle: 'Remover permanentemente esta sessão',
        deleteSessionWarning: 'Esta ação não pode ser desfeita. Todas as mensagens e dados associados a esta sessão serão excluídos permanentemente.',
        failedToDeleteSession: 'Falha ao excluir sessão',
        worktreeCleanupTitle: 'Excluir Worktree?',
        worktreeCleanupMessage: 'O Worktree não tem alterações não confirmadas. Deseja excluir os arquivos do Worktree?',
        worktreeCleanupDelete: 'Excluir Worktree',
        worktreeCleanupKeep: 'Manter arquivos',
        landWorktree: 'Land Worktree',
        landWorktreeSubtitle: 'Squash this worktree onto the base branch and remove it',
        landWorktreeMessage: 'Commit message for the squashed change',
        landWorktreeFailed: 'Failed to land worktree',
        landWorktreeDone: 'Landed on the base branch. The worktree is gone.',

    },

    archive: {
        select: 'Selecionar',
        selectAll: 'Selecionar tudo',
        deselectAll: 'Desmarcar tudo',
        archiveCount: ({ count }: { count: number }) => plural({ count, singular: 'Arquivar 1 sessão', plural: `Arquivar ${count} sessões` }),
        unarchiveCount: ({ count }: { count: number }) => plural({ count, singular: 'Desarquivar 1 sessão', plural: `Desarquivar ${count} sessões` }),
        selectedCount: ({ count }: { count: number }) => `${count} selecionadas`,
        archivedCount: ({ count }: { count: number }) => plural({ count, singular: '1 sessão arquivada', plural: `${count} sessões arquivadas` }),
        undo: 'Desfazer',
    },

    components: {
        sessionStatusBar: {
            contextUsage: ({ used, total, percent }: { used: string; total: string; percent: number }) => `Contexto ${used} de ${total} tokens, ${percent}%`,
            limitFiveHour: 'Limite de 5 horas',
            limitSevenDay: 'Limite de 7 dias',
            limitResets: ({ time }: { time: string }) => `redefine ${time}`,
            limitAsOf: ({ age }: { age: string }) => `há ${age}`,
            limitRemaining: ({ percent }: { percent: number }) => `${percent}% restante`,
        },
    },

    agentInput: {
        permissionMode: {
            title: 'MODO DE PERMISSÃO',
            default: 'Padrão',
            acceptEdits: 'Aceitar edições',
            plan: 'Modo de planejamento',
            dontAsk: 'Não perguntar',
            bypassPermissions: 'Modo Yolo',
        },
        agent: {
            pi: 'Pi',
        },
        model: {
            title: 'MODELO',
            configureInCli: 'Configurar modelos nas configurações do CLI',
        },
        effort: {
            title: 'ESFORÇO',
        },
        codexPermissionMode: {
            title: 'MODO DE PERMISSÃO PI',
            default: 'Configurações do CLI',
            readOnly: 'Read Only Mode',
            safeYolo: 'Safe YOLO',
            yolo: 'YOLO',
            defaultDescription: 'perguntar antes de comandos não confiáveis',
            readOnlyDescription: 'sem escrita',
            safeYoloDescription: 'sem perguntas, sandbox do espaço de trabalho',
            yoloDescription: 'sem perguntas, acesso total',
        },

        geminiPermissionMode: {
            title: 'MODO DE PERMISSÃO PI',
            default: 'Padrão',
            autoEdit: 'Edição automática',
            yolo: 'YOLO',
            plan: 'Planejamento',
        },
        context: {
            remaining: ({ percent }: { percent: number }) => `${percent}% restante`,
        },
        suggestion: {
            fileLabel: 'ARQUIVO',
            folderLabel: 'PASTA',
        },
        noMachinesAvailable: 'Sem máquinas',
    },

    machineLauncher: {
        showLess: 'Mostrar menos',
        showAll: ({ count }: { count: number }) => `Mostrar todos (${count} caminhos)`,
        enterCustomPath: 'Inserir caminho personalizado',
    },

    sidebar: {
        sessionsTitle: 'muxr',
        showArchived: 'Mostrar arquivadas',
        hideArchived: 'Ocultar arquivadas',
        newSession: 'Nova sessão',
    },

    zen: {
        toggle: 'Modo zen',
    },

    toolView: {
        input: 'Entrada',
        output: 'Saída',
    },

    thinking: {
        active: 'Thinking…',
        thought: 'Thought',
        thoughtFor: ({ duration }: { duration: string }) => `Thought for ${duration}`,
    },

    sessionAttachments: {
        title: ({ count }: { count: number }) => count === 1 ? '1 anexo' : `${count} anexos`,
    },

    turnChanges: {
        filesChanged: ({ count }: { count: number }) => count === 1 ? '1 arquivo modificado' : `${count} arquivos modificados`,
    },

    tools: {
        fullView: {
            description: 'Descrição',
            inputParams: 'Parâmetros de entrada',
            output: 'Saída',
            error: 'Erro',
            completed: 'Ferramenta concluída com sucesso',
            noOutput: 'Nenhuma saída foi produzida',
            rawJsonDevMode: 'JSON bruto (modo desenvolvedor)',
        },


        names: {
            search: 'Buscar',
        },

        desc: {
        }
    },

    files: {
        changes: 'Alterações',
        searchPlaceholder: 'Buscar arquivos...',
        detachedHead: 'HEAD desanexado',
        summary: ({ staged, unstaged }: { staged: number; unstaged: number }) => `${staged} preparados • ${unstaged} não preparados`,
        notRepo: 'Não é um repositório git',
        notUnderGit: 'Este diretório não está sob controle de versão git',
        searching: 'Buscando arquivos...',
        noFilesFound: 'Nenhum arquivo encontrado',
        noFilesInProject: 'Nenhum arquivo no projeto',
        tryDifferentTerm: 'Tente um termo de busca diferente',
        searchResults: ({ count }: { count: number }) => `Resultados da busca (${count})`,
        projectRoot: 'Raiz do projeto',
        stagedChanges: ({ count }: { count: number }) => `Alterações preparadas (${count})`,
        unstagedChanges: ({ count }: { count: number }) => `Alterações não preparadas (${count})`,
        // File viewer strings
        loadingFile: ({ fileName }: { fileName: string }) => `Carregando ${fileName}...`,
        binaryFile: 'Arquivo binário',
        cannotDisplayBinary: 'Não é possível exibir o conteúdo do arquivo binário',
        diff: 'Diff',
        file: 'Arquivo',
        fileEmpty: 'Arquivo está vazio',
        noChanges: 'Nenhuma alteração para exibir',
        noChangesTitle: 'Sem alterações',
        noChangesSubtitle: 'A árvore de trabalho está limpa',
        deleted: 'Excluído',
        changedFiles: ({ count }: { count: number }) => `${count} ${count === 1 ? 'arquivo modificado' : 'arquivos modificados'}`,
        allFiles: 'Todos os arquivos',
        addPanel: 'Adicionar painel',
        closePanel: 'Fechar painel',
        editFile: 'Editar',
        saveFile: 'Salvar',
        failedToRead: 'Falha ao ler arquivo',
        failedToSave: 'Falha ao salvar arquivo',
        fileConflict: 'Conflito de arquivo',
        fileConflictDescription: 'Este arquivo foi modificado no dispositivo enquanto você o editava. Recarregue para ver a versão mais recente.',
        reload: 'Recarregar',
        overwrite: 'Sobrescrever',
    },
    sideChat: {
        panelTitle: 'Chat lateral',
        emptyTitle: 'Inicie um chat lateral',
        emptySubtitle: 'Pergunte algo ao agente à parte. Ele herda o contexto deste chat, mas permanece isolado — nada aqui afeta a conversa principal.',
        startButton: 'Iniciar chat lateral',
        creating: 'Iniciando chat lateral…',
        unavailable: 'Esta sessão ainda não pode iniciar um chat lateral — aguarde o agente ficar online.',
        expand: 'Abrir em tela cheia',
        tabLabel: ({ index }: { index: number }) => `Chat lateral ${index}`,
        newChat: 'Novo chat lateral',
        close: 'Fechar chat lateral',
    },


    settingsAccount: {
        // Account settings screen
        accountInformation: 'Informações da conta',
        status: 'Status',
        statusActive: 'Ativo',
        statusNotAuthenticated: 'Não autenticado',
        anonymousId: 'ID anônimo',
        publicId: 'ID público',
        notAvailable: 'Não disponível',
        linkNewDevice: 'Vincular novo dispositivo',
        linkNewDeviceSubtitle: 'Escanear código QR para vincular dispositivo',
        backup: 'Backup',
        backupDescription: 'Sua chave secreta é a única forma de recuperar sua conta. Salve-a em um local seguro como um gerenciador de senhas.',
        secretKey: 'Chave secreta',
        tapToReveal: 'Toque para revelar',
        tapToHide: 'Toque para ocultar',
        secretKeyLabel: 'CHAVE SECRETA (TOQUE PARA COPIAR)',
        secretKeyCopied: 'Chave secreta copiada para a área de transferência. Guarde-a em um local seguro!',
        secretKeyCopyFailed: 'Falha ao copiar chave secreta',
        dangerZone: 'Zona perigosa',
        logout: 'Sair',
        logoutSubtitle: 'Sair e limpar dados locais',
        logoutConfirm: 'Tem certeza de que quer sair? Certifique-se de ter feito backup da sua chave secreta!',
    },

    settingsLanguage: {
        // Language settings screen
        title: 'Idioma',
        description: 'Escolher o idioma preferido para a interface do aplicativo. Isso vai ser sincronizado em todos os seus dispositivos.',
        currentLanguage: 'Idioma atual',
        automatic: 'Automático',
        automaticSubtitle: 'Detectar das configurações do dispositivo',
        needsRestart: 'Idioma alterado',
        needsRestartMessage: 'O aplicativo precisa ser reiniciado para aplicar a nova configuração de idioma.',
    },


    updateBanner: {
        updateAvailable: 'Atualização disponível',
        pressToApply: 'Pressione para aplicar a atualização',
        whatsNew: 'Novidades',
        seeLatest: 'Veja as atualizações e melhorias mais recentes',
        nativeUpdateAvailable: 'Atualização do aplicativo disponível',
        tapToUpdateAppStore: 'Toque para atualizar na App Store',
        tapToUpdatePlayStore: 'Toque para atualizar na Play Store',
    },

    changelog: {
        // Used by the changelog screen
        noEntriesAvailable: 'Nenhuma entrada de changelog disponível.',
    },

    terminal: {
        // Used by terminal connection screens
        webBrowserRequired: 'Navegador web necessário',
        webBrowserRequiredDescription: 'Links de conexão de terminal só podem ser abertos em um navegador web por questões de segurança. Use o leitor de código QR ou abra este link num computador.',
        processingConnection: 'Processando conexão...',
        invalidConnectionLink: 'Link de conexão inválido',
        invalidConnectionLinkDescription: 'O link de conexão está ausente ou inválido. Verifique a URL e tente novamente.',
        connectTerminal: 'Conectar terminal',
        terminalRequestDescription: 'Um terminal está solicitando conexão à sua conta muxr. Isso permitirá que o terminal envie e receba mensagens com segurança.',
        connectionDetails: 'Detalhes da conexão',
        publicKey: 'Chave pública',
        encryption: 'Criptografia',
        endToEndEncrypted: 'Criptografia ponta a ponta',
        acceptConnection: 'Aceitar conexão',
        connecting: 'Conectando...',
        reject: 'Rejeitar',
        security: 'Segurança',
        securityFooter: 'Este link de conexão foi processado com segurança no seu navegador e nunca foi enviado para nenhum servidor. Seus dados privados permanecerão seguros e apenas você pode descriptografar as mensagens.',
        securityFooterDevice: 'Esta conexão foi processada com segurança no seu dispositivo e nunca foi enviada para nenhum servidor. Seus dados privados permanecerão seguros e apenas você pode descriptografar as mensagens.',
        clientSideProcessing: 'Processamento do lado cliente',
        linkProcessedLocally: 'Link processado localmente no navegador',
        linkProcessedOnDevice: 'Link processado localmente no dispositivo',
    },

    modals: {
        // Used across connect flows and settings
        deviceLinkedSuccessfully: 'Dispositivo vinculado com sucesso',
        invalidAuthUrl: 'URL de autenticação inválida',
        developerMode: 'Modo desenvolvedor',
        developerModeEnabled: 'Modo desenvolvedor ativado',
        developerModeDisabled: 'Modo desenvolvedor desativado',
        failedToLinkDevice: 'Falha ao vincular dispositivo',
        cameraPermissionsRequiredToScanQr: 'Permissões de câmera são necessárias para escanear códigos QR'
    },

    navigation: {
        // Navigation titles and screen headers
        connectTerminal: 'Conectar terminal',
        linkNewDevice: 'Vincular novo dispositivo', 
        restoreWithSecretKey: 'Restaurar com chave secreta',
        browserPreview: 'Pré-visualização do navegador',
        browserTakeover: 'Controlo do navegador',
        whatsNew: 'Novidades',
        friends: 'Amigos',
    },

    welcome: {
        // Main welcome screen for unauthenticated users
        title: 'Cliente móvel Pi',
        subtitle: 'Criptografado ponta a ponta e sua conta é armazenada apenas no seu dispositivo.',
        createAccount: 'Criar conta',
        linkOrRestoreAccount: 'Vincular ou restaurar conta',
        loginWithMobileApp: 'Fazer login com aplicativo móvel',
    },

    review: {
        // Used by utils/requestReview.ts
        enjoyingApp: 'Curtindo o aplicativo?',
        feedbackPrompt: 'Adoraríamos ouvir seu feedback!',
        yesILoveIt: 'Sim, eu amo!',
        notReally: 'Não muito'
    },

    items: {
        // Used by Item component for copy toast
        copiedToClipboard: ({ label }: { label: string }) => `${label} copiado para a área de transferência`
    },

    machine: {
        offlineUnableToSpawn: 'Inicializador desativado enquanto a máquina está offline',
        launchNewSessionInDirectory: 'Iniciar nova sessão no diretório',
        daemon: 'Daemon',
        status: 'Status',
        stopDaemon: 'Parar daemon',
        lastKnownPid: 'Último PID conhecido',
        lastKnownHttpPort: 'Última porta HTTP conhecida',
        startedAt: 'Iniciado em',
        cliVersion: 'Versão do CLI',
        daemonStateVersion: 'Versão do estado do daemon',
        stopDaemonConfirmTitle: 'Parar o daemon?',
        stopDaemonConfirmMessage: 'Você não poderá iniciar novas sessões nesta máquina até reiniciar o daemon no seu computador. Suas sessões atuais continuarão ativas.',
        daemonStopped: 'Daemon parado',
        stopDaemonFailed: 'Falha ao parar o daemon. Ele pode não estar em execução.',
        machineGroup: 'Máquina',
        host: 'Host',
        machineId: 'ID da máquina',
        username: 'Nome de usuário',
        homeDirectory: 'Diretório home',
        platform: 'Plataforma',
        architecture: 'Arquitetura',
        lastSeen: 'Visto pela última vez',
        never: 'Nunca',
        metadataVersion: 'Versão dos metadados',
        cliAvailability: 'Disponibilidade de CLI',
        cliInstalled: 'Instalado',
        cliNotFound: 'Não encontrado',
        lastDetected: 'Última detecção',
        back: 'Voltar',
        dangerZone: 'Zona de perigo',
        delete: 'Excluir máquina',
        deleteFooter: 'Remove esta máquina da sua conta. O histórico de sessões será preservado, mas você não poderá iniciar novas sessões nesta máquina.',
        deleteConfirmTitle: 'Excluir esta máquina?',
        deleteConfirmMessage: 'A máquina será removida da sua conta. O histórico de sessões será preservado, mas você não poderá iniciar novas sessões até reconectar o daemon.',
        deleteFailed: 'Falha ao excluir a máquina.',
    },

    message: {
        switchedToMode: ({ mode }: { mode: string }) => `Mudou para o modo ${mode}`,
        unknownEvent: 'Evento desconhecido',
        usageLimitUntil: ({ time }: { time: string }) => `Limite de uso atingido até ${time}`,
        sentAsGoal: 'Sent as goal',
        unknownTime: 'horário desconhecido',
    },

    codex: {
        // Pi permission dialog buttons
        permissions: {
            yesForSession: 'Sim, e não perguntar para esta sessão',
            stopAndExplain: 'Parar, e explicar o que fazer',
        }
    },

    claude: {
        // Pi permission dialog buttons
        permissions: {
            yesAllowAllEdits: 'Sim, permitir todas as edições durante esta sessão',
            yesAllowEverything: 'Sim, permitir tudo durante esta sessão',
            yesForTool: 'Sim, não perguntar novamente para esta ferramenta',
            noTellClaude: 'Não, fornecer feedback',
        }
    },

    textSelection: {
        // Text selection screen
        title: 'Selecionar texto',
        noTextProvided: 'Nenhum texto fornecido',
        textNotFound: 'Texto não encontrado ou expirado',
        textCopied: 'Texto copiado para a área de transferência',
        failedToCopy: 'Falha ao copiar o texto para a área de transferência',
        noTextToCopy: 'Nenhum texto disponível para copiar',
    },

    markdown: {
        // Markdown copy functionality
        codeCopied: 'Código copiado',
        copyFailed: 'Falha ao copiar',
        mermaidRenderFailed: 'Falha ao renderizar diagrama mermaid',
    },

    artifacts: {
        title: 'Artefatos',
        empty: 'Ainda não há artefatos',
        emptyDescription: 'Crie seu primeiro artefato para salvar e organizar conteúdo',
        new: 'Novo artefato',
        edit: 'Editar artefato',
        delete: 'Excluir',
        updateError: 'Falha ao atualizar artefato. Por favor, tente novamente.',
        notFound: 'Artefato não encontrado',
        deleteConfirm: 'Excluir artefato?',
        deleteConfirmDescription: 'Este artefato será excluído permanentemente.',
        titlePlaceholder: 'Título do artefato',
        bodyPlaceholder: 'Digite o conteúdo aqui...',
        loading: 'Carregando...',
        error: 'Falha ao carregar artefatos',
        titleLabel: 'TÍTULO',
        bodyLabel: 'CONTEÚDO',
        emptyFieldsError: 'Por favor, insira um título ou conteúdo',
        createError: 'Falha ao criar artefato. Por favor, tente novamente.',
    },

    friends: {
        // Friends feature
        manageFriends: 'Gerencie seus amigos e conexões',
        pendingRequests: 'Solicitações de amizade',
        myFriends: 'Meus amigos',
        noFriendsYet: 'Você ainda não tem amigos',
        remove: 'Remover',
        addFriend: 'Adicionar amigo',
        alreadyFriends: 'Já são amigos',
        requestPending: 'Solicitação pendente',
        searchInstructions: 'Digite um nome de usuário para buscar amigos',
        searchPlaceholder: 'Digite o nome de usuário...',
        searching: 'Buscando...',
        noUserFound: 'Nenhum usuário encontrado com esse nome',
        checkUsername: 'Por favor, verifique o nome de usuário e tente novamente',
        howToFind: 'Como encontrar amigos',
        findInstructions: 'Procure amigos pelo nome de usuário. Tanto você quanto seu amigo precisam ter o GitHub conectado para enviar solicitações de amizade.',
        requestSent: 'Solicitação de amizade enviada!',
        confirmRemove: 'Remover amigo',
        confirmRemoveMessage: 'Tem certeza de que deseja remover este amigo?',
        cannotAddYourself: 'Você não pode enviar uma solicitação de amizade para si mesmo',
        bothMustHaveGithub: 'Ambos os usuários devem ter o GitHub conectado para serem amigos',
        status: {
            none: 'Não conectado',
            requested: 'Solicitação enviada',
            pending: 'Solicitação pendente',
            friend: 'Amigos',
            rejected: 'Rejeitada',
        },
        acceptRequest: 'Aceitar solicitação',
        removeFriend: 'Remover dos amigos',
        removeFriendConfirm: ({ name }: { name: string }) => `Tem certeza de que deseja remover ${name} dos seus amigos?`,
        requestFriendship: 'Solicitar amizade',
        cancelRequest: 'Cancelar solicitação de amizade',
        cancelRequestConfirm: ({ name }: { name: string }) => `Cancelar sua solicitação de amizade para ${name}?`,
        denyRequest: 'Recusar solicitação',
    },

    usage: {
        // Usage panel strings
        today: 'Hoje',
        last7Days: 'Últimos 7 dias',
        last30Days: 'Últimos 30 dias',
        totalTokens: 'Tokens totais',
        totalCost: 'Custo total',
        tokens: 'Tokens',
        cost: 'Custo',
        usageOverTime: 'Uso ao longo do tempo',
        byModel: 'Por modelo',
    },

    imageUpload: {
        permissionTitle: 'Acesso à biblioteca de fotos',
        permissionMessage: 'Permita o acesso à sua biblioteca de fotos para anexar imagens às mensagens.',
        limitTitle: 'Limite de imagens atingido',
        limitMessage: ({ max }: { max: number }) => `Você pode anexar até ${max} imagens por mensagem.`,
        fileTooLargeTitle: 'Arquivo muito grande',
        fileTooLargeMessage: ({ name, maxMb }: { name: string; maxMb: number }) => `"${name}" excede o limite de ${maxMb}MB e não foi adicionado.`,
        uploadFailedTitle: 'Falha no envio',
        uploadFailedMessage: ({ count }: { count: number }) => count === 1
            ? 'Não foi possível enviar uma imagem e não foi enviada.'
            : `Não foi possível enviar ${count} imagens e não foram enviadas.`,
        notSupportedTitle: 'Imagens não suportadas',
        notSupportedMessage: 'Este agente não suporta anexos de imagem. As imagens não foram enviadas.',
    },

    feed: {
        // Feed notifications for friend requests and acceptances
    }
} as const;

export type TranslationsPt = typeof pt;
