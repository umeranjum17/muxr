import type { TranslationStructure } from '../_default';

/**
 * Spanish plural helper function
 * Spanish has 2 plural forms: singular, plural
 * @param options - Object containing count, singular, and plural forms
 * @returns The appropriate form based on Spanish plural rules
 */
function plural({ count, singular, plural }: { count: number; singular: string; plural: string }): string {
    return count === 1 ? singular : plural;
}

/**
 * Spanish translations for the muxr app
 * Must match the exact structure of the English translations
 */
export const es: TranslationStructure = {
    tabs: {
        // Tab navigation labels
        sessions: 'Terminales',
        settings: 'Configuración',
    },

    inbox: {
        // Inbox screen: the sessions currently waiting on you
        reason: {
            waiting: 'esperando',
            blocked: 'bloqueado',
            failed: 'ha fallado',
            done: 'listo',
        },
    },

    plugins: {
        openFromHome: 'Abre un plugin desde Inicio.',
        unavailable: 'Este plugin está desactivado o no está disponible.',
        goBack: 'Volver',
        couldNotLoad: 'No se pudieron cargar los elementos',
        dataUnavailable: 'El plugin no está disponible ahora.',
        nothingHere: 'No hay nada aquí',
        newItems: 'Los elementos nuevos aparecerán aquí.',
        retry: 'Reintentar',
        retryItems: 'Reintentar la carga de elementos del plugin',
        stale: 'No se pudo actualizar. Se muestra el último resultado.',
        nothingToShow: 'Nada que mostrar.',
        treeUnavailable: 'El árbol no está disponible.',
        dictate: 'Dictar',
        unavailableSuffix: 'no disponible',
        showingStale: 'mostrando datos anteriores',
        settingsTitle: 'Plugins',
        enableAll: 'Activar todos',
        disableAll: 'Desactivar todos',
        installed: 'Instalados',
        herdrAndMuxr: 'Herdr + muxr',
        herdrAndMuxrFooter: 'Herdr ejecuta acciones, paneles o eventos para estos, y añaden interfaz de muxr.',
        muxrOnly: 'Solo muxr',
        muxrOnlyFooter: 'Herdr solo los registra; todo lo que hacen pasa por muxr.',
        herdrOnly: 'Solo Herdr',
        herdrOnlyFooter: 'Paquetes de backend sin interfaz de muxr. Gestiónalos con la CLI de herdr.',
        waitingHost: 'Esperando al host.',
        linkHost: 'Vincula un plugin mediante Herdr y vuelve a conectar.',
        enabled: 'activados',
        off: 'desact.',
        on: 'act.',
        unavailableLabel: 'No disponible',
        runsCode: 'Ejecuta código como tú',
        uiOnly: 'Solo interfaz',
        readsSessions: 'Lee resúmenes de sesiones',
        readsTree: 'Lee el árbol del espacio de trabajo',
        openFailed: 'No se pudo abrir',
        actionFailed: 'La acción falló',
        items: 'Elementos',
        openWebsite: '¿Abrir sitio web?',
        open: 'Abrir',
        realtimeConnecting: 'Conectando sesión de voz',
        realtimeListening: 'Escuchando',
        realtimeThinking: 'Pensando',
        realtimeSpeaking: 'Hablando',
        realtimeError: 'Error de sesión de voz',
        realtimeOff: 'Sesión de voz apagada',
        openConversation: 'Abrir conversación de voz',
        realtime: 'Voz',
    },

    common: {
        // Simple string constants
        cancel: 'Cancelar',
        save: 'Guardar',
        error: 'Error',
        success: 'Éxito',
        ok: 'OK',
        back: 'Atrás',
        create: 'Crear',
        rename: 'Renombrar',
        logout: 'Cerrar sesión',
        yes: 'Sí',
        no: 'No',
        version: 'Versión',
        copied: 'Copiado',
        copy: 'Copiar',
        scanning: 'Escaneando...',
        home: 'Inicio',
        message: 'Mensaje',
        files: 'Archivos',
        fileViewer: 'Visor de archivos',
        loading: 'Cargando...',
        delete: 'Eliminar',
    },

    profile: {
        details: 'Detalles',
        firstName: 'Nombre',
        lastName: 'Apellido',
        username: 'Nombre de usuario',
        status: 'Estado',
    },


    status: {
        connected: 'conectado',
        connecting: 'conectando',
        disconnected: 'desconectado',
        error: 'error',
        pairingIssue: 'problema de emparejamiento',
        online: 'en línea',
        offline: 'desconectado',
        lastSeen: ({ time }: { time: string }) => `visto por última vez ${time}`,
        permissionRequired: 'permiso requerido',
        activeNow: 'Activo ahora',
        unknown: 'desconocido',
        unread: 'nuevos resultados',
    },

    time: {
        justNow: 'ahora mismo',
        minutesAgo: ({ count }: { count: number }) => `hace ${count} minuto${count !== 1 ? 's' : ''}`,
        hoursAgo: ({ count }: { count: number }) => `hace ${count} hora${count !== 1 ? 's' : ''}`,
        daysAgo: ({ count }: { count: number }) => `hace ${count} día${count !== 1 ? 's' : ''}`,
    },

    connect: {
        restoreAccount: 'Restaurar cuenta',
        enterSecretKey: 'Ingresa tu clave secreta',
        invalidSecretKey: 'Clave secreta inválida. Verifica e intenta de nuevo.',
        qrInstructions: '1. Abre muxr en tu dispositivo móvil\n2. Ve a Configuración → Cuenta\n3. Toca "Vincular nuevo dispositivo"\n4. Escanea este código QR',
        restoreWithSecretKeyInstead: 'O restaurar con la clave secreta',
    },

    settings: {
        title: 'Configuración',
        github: 'GitHub',
        machines: 'Máquinas',
        showOfflineMachines: ({ count }: { count: number }) => count === 1 ? 'Mostrar 1 máquina sin conexión' : `Mostrar ${count} máquinas sin conexión`,
        hideOfflineMachines: 'Ocultar máquinas sin conexión',
        features: 'Características',
        social: 'Social',
        account: 'Cuenta',
        accountSubtitle: 'Gestiona los detalles de tu cuenta',
        appearance: 'Apariencia',
        appearanceSubtitle: 'Personaliza como se ve la app',
        featuresTitle: 'Características',
        featuresSubtitle: 'Habilitar o deshabilitar funciones de la aplicación',
        about: 'Acerca de',
        aboutFooter: 'muxr es un cliente móvil para Pi. El cifrado de extremo a extremo es opcional y está desactivado por defecto; tu cuenta se guarda solo en tu dispositivo. No está afiliado con Anthropic.',
        whatsNew: 'Novedades',
        whatsNewSubtitle: 'Ve las últimas actualizaciones y mejoras',
        reportIssue: 'Reportar un problema',
        eula: 'EULA',
        connection: 'Conexión',
        connectionSubtitle: 'URL del relay, máquina y token',
        pushNotifications: 'Notificaciones push',
        pushSubtitleSubscribed: 'Activadas — recibes un aviso cuando un agente necesita una respuesta',
        pushSubtitleDenied: 'Bloqueadas por el navegador — permite las notificaciones para activarlas',
        pushSubtitleUnsupported: 'No disponible en este navegador',
        pushSubtitleDefault: 'Toca para recibir un aviso cuando un agente necesite una respuesta',
        license: 'Licencia y avisos',
        // Dynamic settings messages
    },

    settingsAppearance: {
        // Appearance settings screen
        theme: 'Tema',
        themeDescription: 'Elige tu esquema de colores preferido',
        themeOptions: {
            adaptive: 'Adaptativo',
            light: 'Claro', 
            dark: 'Oscuro',
        },
        themeDescriptions: {
            adaptive: 'Seguir configuración del sistema',
            light: 'Usar siempre tema claro',
            dark: 'Usar siempre tema oscuro',
        },
        display: 'Pantalla',
        displayDescription: 'Controla diseño y espaciado',

        avatarStyle: 'Estilo de avatar',
        avatarStyleDescription: 'Elige la apariencia del avatar de sesión',
        avatarOptions: {
            pixelated: 'Pixelado',
            gradient: 'Gradiente',
            brutalist: 'Brutalista',
        },
        showFlavorIcons: 'Mostrar íconos de proveedor de IA',
        showFlavorIconsDescription: 'Mostrar íconos del proveedor de IA en los avatares de sesión',
    },

    settingsFeatures: {
        // Features settings screen
        experiments: 'Experimentos',
        experimentsDescription: 'Habilitar características experimentales que aún están en desarrollo. Estas características pueden ser inestables o cambiar sin aviso.',
        webFeatures: 'Características web',
        webFeaturesDescription: 'Características disponibles solo en la versión web de la aplicación.',
        commandPalette: 'Paleta de comandos',
        commandPaletteEnabled: 'Presione ⌘K para abrir',
        commandPaletteDisabled: 'Acceso rápido a comandos deshabilitado',
        markdownCopyV2: 'Markdown Copy v2',
        markdownCopyV2Subtitle: 'Pulsación larga abre modal de copiado',
        hideInactiveSessions: 'Ocultar sesiones inactivas',
        hideInactiveSessionsSubtitle: 'Muestra solo los chats activos en tu lista',
        imageUpload: 'Subida de imágenes',
        imageUploadSubtitle: 'Adjunta imágenes a los mensajes para que los agentes compatibles las analicen',
    },

    errors: {
        authenticationFailed: 'Falló la autenticación',
        failedToLoadProfile: 'No se pudo cargar el perfil de usuario',
        userNotFound: 'Usuario no encontrado',
        sessionDeleted: 'La sesión ha sido eliminada',
        sessionDeletedDescription: 'Esta sesión ha sido eliminada permanentemente',

        // Error functions with context
        failedToSendRequest: 'No se pudo enviar la solicitud de amistad',
    },

    newSession: {
        title: 'Iniciar nueva sesión',
        machineOffline: 'La máquina está desconectada',
        switchMachinesHint: '• Cambia de máquina haciendo clic en la máquina de arriba',
    },

    settingsConnection: {
        // Connection settings screen (relay URL, machine, token)
        status: ({ status }: { status: string }) => `Estado: ${status}`,
    },

    optionSheet: {
        // Model/mode picker bottom sheet
        all: 'todas',
        searchPlaceholder: ({ count }: { count: number }) => `Buscar ${count}`,
        useCustom: ({ value }: { value: string }) => `usar ${value}`,
        noResults: 'sin resultados',
    },

    homeDock: {
        // Home screen composer
        inputPlaceholder: 'Planifica, pregunta, construye…',
        runCommandPlaceholder: 'Ejecuta un comando',
        askPlaceholder: ({ name }: { name: string }) => `Pregunta a ${name}`,
    },

    liveTerminals: {
        // Live terminals strip on the home screen
        title: 'EN VIVO',
    },

    emptySessions: {
        // Empty state shown on tablets when no sessions are active
        noActiveSessions: 'No hay sesiones activas',
        startDescription: 'Inicia una nueva sesión en cualquiera de tus máquinas conectadas.',
        noMachinesDescription: 'Abre una nueva terminal en tu ordenador para iniciar una sesión.',
    },

    sessionHistory: {
        // Used by session history screen
        title: 'Historial de sesiones',
        empty: 'No se encontraron sesiones',
        today: 'Hoy',
        yesterday: 'Ayer',
        daysAgo: ({ count }: { count: number }) => `hace ${count} ${count === 1 ? 'día' : 'días'}`,
    },

    session: {
        inputPlaceholder: 'Escriba un mensaje ...',
        inactiveArchived: 'Esta sesión está inactiva.',
        resumeFromTerminal: 'Para reanudarla desde la terminal:',
        newChat: 'Chat nuevo',
        forkAction: 'Bifurcar sesión',
        forkSubtitle: 'Continuar en una nueva sesión con el mismo contexto',
        duplicateAction: 'Duplicar desde un mensaje…',
        duplicateSubtitle: 'Volver a un punto elegido e intentarlo de nuevo',
        duplicateSheetTitle: 'Elige un punto de retroceso',
        duplicateSheetSubtitle: 'La nueva sesión conservará el turno elegido completo (tu mensaje y la respuesta del agente) y descartará los siguientes mensajes.',
        duplicateSheetConfirm: 'Duplicar',
        duplicateSheetEmpty: 'Aún no hay mensajes elegibles para retroceder en esta sesión.',
        duplicateRowDisabled: 'Este mensaje no se puede usar como punto de retroceso.',
        forkedFromLabel: 'Bifurcado de',
        forkedFromSubtitle: 'Abrir la sesión de la que se bifurcó',
        forkErrorMissingMetadata: 'Faltan metadatos de la sesión necesarios para bifurcar.',
        forkErrorGeneric: 'No se pudo bifurcar la sesión.',
    },

    commandPalette: {
        placeholder: 'Escriba un comando o busque...',
    },


    sessionInfo: {
        // Used by Session Info screen (app/(app)/session/[id]/info.tsx)
        archiveSession: 'Archivar sesión',
        muxrSessionIdCopied: 'ID de sesión de muxr copiado al portapapeles',
        failedToCopySessionId: 'Falló al copiar ID de sesión de muxr',
        muxrSessionId: 'ID de sesión de muxr',
        claudeCodeSessionId: 'ID de sesión de Pi',
        claudeCodeSessionIdCopied: 'ID de sesión de Pi copiado al portapapeles',
        codexThreadId: 'ID del hilo de Pi',
        codexThreadIdCopied: 'ID del hilo de Pi copiado al portapapeles',
        aiProvider: 'Proveedor de IA',
        failedToCopyClaudeCodeSessionId: 'Falló al copiar ID de sesión de Pi',
        failedToCopyCodexThreadId: 'Falló al copiar ID del hilo de Pi',
        metadataCopied: 'Metadatos copiados al portapapeles',
        failedToCopyMetadata: 'Falló al copiar metadatos',
        failedToArchiveSession: 'Falló al archivar sesión',
        connectionStatus: 'Estado de conexión',
        created: 'Creado',
        lastUpdated: 'Última actualización',
        sequence: 'Secuencia',
        quickActions: 'Acciones rápidas',
        viewMachine: 'Ver máquina',
        viewMachineSubtitle: 'Ver detalles de máquina y sesiones',
        resumeSession: 'Resume Session',
        resumeSessionSubtitle: 'Resume this session on the same machine',
        resumeSessionSameMachineOnly: 'This session can only be resumed on the same machine it started on.',
        resumeSessionMachineOffline: 'This machine is offline. Resume is only available while it is online.',
        resumeSessionMissingMachine: 'This session is missing its machine metadata, so it cannot be resumed.',
        resumeSessionMissingBackendId: 'This session does not have a resumable Pi identifier.',
        resumeSessionUnexpectedDirectoryPrompt: 'Resume cannot create directories. Start the session manually from its original path.',
        archiveSessionSubtitle: 'Archivar esta sesión y detenerla',
        metadata: 'Metadatos',
        host: 'Host',
        path: 'Ruta',
        operatingSystem: 'Sistema operativo',
        processId: 'ID del proceso',
        muxrHome: 'Directorio de muxr',
        copyMetadata: 'Copiar metadatos',
        agentState: 'Estado del agente',
        controlledByUser: 'Controlado por el usuario',
        pendingRequests: 'Solicitudes pendientes',
        activity: 'Actividad',
        thinking: 'Pensando',
        thinkingSince: 'Pensando desde',
        cliVersion: 'Versión del CLI',
        deleteSession: 'Eliminar sesión',
        deleteSessionSubtitle: 'Eliminar permanentemente esta sesión',
        deleteSessionWarning: 'Esta acción no se puede deshacer. Todos los mensajes y datos asociados con esta sesión se eliminarán permanentemente.',
        failedToDeleteSession: 'Error al eliminar la sesión',
        worktreeCleanupTitle: '¿Eliminar Worktree?',
        worktreeCleanupMessage: 'El Worktree no tiene cambios sin confirmar. ¿Deseas eliminar los archivos del Worktree?',
        worktreeCleanupDelete: 'Eliminar Worktree',
        worktreeCleanupKeep: 'Conservar archivos',
        landWorktree: 'Land Worktree',
        landWorktreeSubtitle: 'Squash this worktree onto the base branch and remove it',
        landWorktreeMessage: 'Commit message for the squashed change',
        landWorktreeFailed: 'Failed to land worktree',
        landWorktreeDone: 'Landed on the base branch. The worktree is gone.',

    },

    archive: {
        select: 'Seleccionar',
        selectAll: 'Seleccionar todo',
        deselectAll: 'Deseleccionar todo',
        archiveCount: ({ count }: { count: number }) => plural({ count, singular: 'Archivar 1 sesión', plural: `Archivar ${count} sesiones` }),
        unarchiveCount: ({ count }: { count: number }) => plural({ count, singular: 'Desarchivar 1 sesión', plural: `Desarchivar ${count} sesiones` }),
        selectedCount: ({ count }: { count: number }) => `${count} seleccionadas`,
        archivedCount: ({ count }: { count: number }) => plural({ count, singular: '1 sesión archivada', plural: `${count} sesiones archivadas` }),
        undo: 'Deshacer',
    },

    components: {
        sessionStatusBar: {
            contextUsage: ({ used, total, percent }: { used: string; total: string; percent: number }) => `Contexto ${used} de ${total} tokens, ${percent}%`,
            limitFiveHour: 'Límite de 5 horas',
            limitSevenDay: 'Límite de 7 días',
            limitResets: ({ time }: { time: string }) => `se restablece ${time}`,
            limitAsOf: ({ age }: { age: string }) => `hace ${age}`,
            limitRemaining: ({ percent }: { percent: number }) => `${percent}% restante`,
        },
    },

    agentInput: {
        permissionMode: {
            title: 'MODO DE PERMISOS',
            default: 'Por defecto',
            acceptEdits: 'Aceptar ediciones',
            plan: 'Modo de planificación',
            dontAsk: 'No preguntar',
            bypassPermissions: 'Modo Yolo',
        },
        agent: {
            pi: 'Pi',
        },
        model: {
            title: 'MODELO',
            configureInCli: 'Configurar modelos en la configuración del CLI',
        },
        effort: {
            title: 'ESFUERZO',
        },
        codexPermissionMode: {
            title: 'MODO DE PERMISOS PI',
            default: 'Configuración del CLI',
            readOnly: 'Read Only Mode',
            safeYolo: 'Safe YOLO',
            yolo: 'YOLO',
            defaultDescription: 'preguntar antes de comandos no confiables',
            readOnlyDescription: 'sin escritura',
            safeYoloDescription: 'sin preguntas, sandbox del espacio de trabajo',
            yoloDescription: 'sin preguntas, acceso completo',
        },

        geminiPermissionMode: {
            title: 'MODO DE PERMISOS PI',
            default: 'Por defecto',
            autoEdit: 'Edición automática',
            yolo: 'YOLO',
            plan: 'Planificación',
        },
        context: {
            remaining: ({ percent }: { percent: number }) => `${percent}% restante`,
        },
        suggestion: {
            fileLabel: 'ARCHIVO',
            folderLabel: 'CARPETA',
        },
        noMachinesAvailable: 'Sin máquinas',
    },

    machineLauncher: {
        showLess: 'Mostrar menos',
        showAll: ({ count }: { count: number }) => `Mostrar todos (${count} rutas)`,
        enterCustomPath: 'Ingresar ruta personalizada',
    },

    sidebar: {
        sessionsTitle: 'muxr',
        showArchived: 'Mostrar archivadas',
        hideArchived: 'Ocultar archivadas',
        newSession: 'Nueva sesión',
    },

    zen: {
        toggle: 'Modo zen',
    },

    toolView: {
        input: 'Entrada',
        output: 'Salida',
    },

    thinking: {
        active: 'Thinking…',
        thought: 'Thought',
        thoughtFor: ({ duration }: { duration: string }) => `Thought for ${duration}`,
    },

    sessionAttachments: {
        title: ({ count }: { count: number }) => count === 1 ? '1 adjunto' : `${count} adjuntos`,
    },

    turnChanges: {
        filesChanged: ({ count }: { count: number }) => count === 1 ? 'Se modificó 1 archivo' : `Se modificaron ${count} archivos`,
    },

    tools: {
        fullView: {
            description: 'Descripción',
            inputParams: 'Parámetros de entrada',
            output: 'Salida',
            error: 'Error',
            completed: 'Herramienta completada exitosamente',
            noOutput: 'No se produjo salida',
            rawJsonDevMode: 'JSON crudo (modo desarrollador)',
        },


        names: {
            search: 'Buscar',
        },

        desc: {
        }
    },

    files: {
        changes: 'Cambios',
        searchPlaceholder: 'Buscar archivos...',
        detachedHead: 'HEAD separado',
        summary: ({ staged, unstaged }: { staged: number; unstaged: number }) => `${staged} preparados • ${unstaged} sin preparar`,
        notRepo: 'No es un repositorio git',
        notUnderGit: 'Este directorio no está bajo control de versiones git',
        searching: 'Buscando archivos...',
        noFilesFound: 'No se encontraron archivos',
        noFilesInProject: 'No hay archivos en el proyecto',
        tryDifferentTerm: 'Intente un término de búsqueda diferente',
        searchResults: ({ count }: { count: number }) => `Resultados de búsqueda (${count})`,
        projectRoot: 'Raíz del proyecto',
        stagedChanges: ({ count }: { count: number }) => `Cambios preparados (${count})`,
        unstagedChanges: ({ count }: { count: number }) => `Cambios sin preparar (${count})`,
        // File viewer strings
        loadingFile: ({ fileName }: { fileName: string }) => `Cargando ${fileName}...`,
        binaryFile: 'Archivo binario',
        cannotDisplayBinary: 'No se puede mostrar el contenido del archivo binario',
        diff: 'Diferencias',
        file: 'Archivo',
        fileEmpty: 'El archivo está vacío',
        fileDeleted: 'Este archivo ya no existe',
        previousDocument: 'Documento anterior',
        nextDocument: 'Documento siguiente',
        previousChange: 'Cambio anterior',
        nextChange: 'Cambio siguiente',
        toggleFileAndDiff: 'Alternar archivo y diferencias',
        wrapLines: 'Ajustar líneas largas',
        zoomIn: 'Acercar',
        zoomOut: 'Alejar',
        resetZoom: 'Restablecer zoom',
        previousFile: 'Archivo anterior',
        nextFile: 'Archivo siguiente',
        previousFileNamed: ({ title, ordinal, total }: { title: string; ordinal: number; total: number }) => `Archivo anterior, ${title}, ${ordinal} de ${total}`,
        nextFileNamed: ({ title, ordinal, total }: { title: string; ordinal: number; total: number }) => `Archivo siguiente, ${title}, ${ordinal} de ${total}`,
        filePosition: ({ current, total }: { current: number; total: number }) => `Archivo ${current} de ${total}`,
        diffUnavailable: 'Diferencias, no disponibles, no hay cambios para este archivo',
        previousChangeAt: ({ current, total }: { current: number; total: number }) => `Cambio anterior, ${current} de ${total}`,
        nextChangeAt: ({ current, total }: { current: number; total: number }) => `Cambio siguiente, ${current} de ${total}`,
        graphicsUnavailable: 'Gráficos no disponibles',
        folderNotFile: 'Esa ruta es una carpeta, no un archivo.',
        showFullPath: 'Mostrar ruta completa',
        pathShowFullPath: ({ label }: { label: string }) => `Ruta ${label}, mostrar ruta completa`,
        goToPath: ({ label }: { label: string }) => `Ir a ${label}`,
        fullPath: 'Ruta completa',
        noChanges: 'No hay cambios que mostrar',
        noChangesTitle: 'Sin cambios',
        noChangesSubtitle: 'El árbol de trabajo está limpio',
        deleted: 'Eliminado',
        changedFiles: ({ count }: { count: number }) => `${count} ${count === 1 ? 'archivo modificado' : 'archivos modificados'}`,
        allFiles: 'Todos los archivos',
        addPanel: 'Añadir panel',
        closePanel: 'Cerrar panel',
        editFile: 'Editar',
        saveFile: 'Guardar',
        failedToRead: 'Error al leer el archivo',
        failedToSave: 'Error al guardar el archivo',
        fileConflict: 'Conflicto de archivo',
        fileConflictDescription: 'Este archivo fue modificado en el dispositivo mientras lo editabas. Recarga para ver la última versión.',
        reload: 'Recargar',
        overwrite: 'Sobrescribir',
    },
    sideChat: {
        panelTitle: 'Chat lateral',
        emptyTitle: 'Inicia un chat lateral',
        emptySubtitle: 'Pregunta algo al agente por separado. Hereda el contexto de este chat pero permanece aislado — nada de aquí afecta a la conversación principal.',
        startButton: 'Iniciar chat lateral',
        creating: 'Iniciando chat lateral…',
        unavailable: 'Esta sesión aún no puede iniciar un chat lateral — espera a que el agente esté en línea.',
        expand: 'Abrir en pantalla completa',
        tabLabel: ({ index }: { index: number }) => `Chat lateral ${index}`,
        newChat: 'Nuevo chat lateral',
        close: 'Cerrar chat lateral',
    },


    settingsAccount: {
        // Account settings screen
        accountInformation: 'Información de la cuenta',
        status: 'Estado',
        statusActive: 'Activo',
        statusNotAuthenticated: 'No autenticado',
        anonymousId: 'ID anónimo',
        publicId: 'ID público',
        notAvailable: 'No disponible',
        linkNewDevice: 'Vincular nuevo dispositivo',
        linkNewDeviceSubtitle: 'Escanear código QR para vincular dispositivo',
        backup: 'Copia de seguridad',
        backupDescription: 'Tu clave secreta es la única forma de recuperar tu cuenta. Guárdala en un lugar seguro como un administrador de contraseñas.',
        secretKey: 'Clave secreta',
        tapToReveal: 'Toca para revelar',
        tapToHide: 'Toca para ocultar',
        secretKeyLabel: 'CLAVE SECRETA (TOCA PARA COPIAR)',
        secretKeyCopied: 'Clave secreta copiada al portapapeles. ¡Guárdala en un lugar seguro!',
        secretKeyCopyFailed: 'Falló al copiar la clave secreta',
        dangerZone: 'Zona peligrosa',
        logout: 'Cerrar sesión',
        logoutSubtitle: 'Cerrar sesión y limpiar datos locales',
        logoutConfirm: '¿Seguro que quieres cerrar sesión? ¡Asegúrate de haber guardado tu clave secreta!',
    },

    settingsLanguage: {
        // Language settings screen
        title: 'Idioma',
        description: 'Elige tu idioma preferido para la interfaz de la aplicación. Esto se sincronizará en todos tus dispositivos.',
        currentLanguage: 'Idioma actual',
        automatic: 'Automático',
        automaticSubtitle: 'Detectar desde configuración del dispositivo',
        needsRestart: 'Idioma cambiado',
        needsRestartMessage: 'La aplicación necesita reiniciarse para aplicar la nueva configuración de idioma.',
    },


    updateBanner: {
        updateAvailable: 'Actualización disponible',
        pressToApply: 'Presione para aplicar la actualización',
        whatsNew: 'Novedades',
        seeLatest: 'Ver las últimas actualizaciones y mejoras',
        nativeUpdateAvailable: 'Actualización de la aplicación disponible',
        tapToUpdateAppStore: 'Toque para actualizar en App Store',
        tapToUpdatePlayStore: 'Toque para actualizar en Play Store',
    },

    changelog: {
        // Used by the changelog screen
        noEntriesAvailable: 'No hay entradas de registro de cambios disponibles.',
    },

    terminal: {
        // Used by terminal connection screens
        webBrowserRequired: 'Se requiere navegador web',
        webBrowserRequiredDescription: 'Los enlaces de conexión de terminal solo pueden abrirse en un navegador web por razones de seguridad. Usa el escáner de código QR o abre este enlace en una computadora.',
        processingConnection: 'Procesando conexión...',
        invalidConnectionLink: 'Enlace de conexión inválido',
        invalidConnectionLinkDescription: 'El enlace de conexión falta o es inválido. Verifica la URL e intenta nuevamente.',
        connectTerminal: 'Conectar terminal',
        terminalRequestDescription: 'Un terminal está solicitando conectarse a tu cuenta de muxr. Esto permitirá al terminal enviar y recibir mensajes de forma segura.',
        connectionDetails: 'Detalles de conexión',
        publicKey: 'Clave pública',
        encryption: 'Cifrado',
        endToEndEncrypted: 'Cifrado de extremo a extremo',
        acceptConnection: 'Aceptar conexión',
        connecting: 'Conectando...',
        reject: 'Rechazar',
        security: 'Seguridad',
        securityFooter: 'Este enlace de conexión fue procesado de forma segura en tu navegador y nunca fue enviado a ningún servidor. Tus datos privados permanecerán seguros y solo tú puedes descifrar los mensajes.',
        securityFooterDevice: 'Esta conexión fue procesada de forma segura en tu dispositivo y nunca fue enviada a ningún servidor. Tus datos privados permanecerán seguros y solo tú puedes descifrar los mensajes.',
        clientSideProcessing: 'Procesamiento del lado del cliente',
        linkProcessedLocally: 'Enlace procesado localmente en el navegador',
        linkProcessedOnDevice: 'Enlace procesado localmente en el dispositivo',
    },

    modals: {
        // Used across connect flows and settings
        deviceLinkedSuccessfully: 'Dispositivo vinculado exitosamente',
        invalidAuthUrl: 'URL de autenticación inválida',
        developerMode: 'Modo desarrollador',
        developerModeEnabled: 'Modo desarrollador habilitado',
        developerModeDisabled: 'Modo desarrollador deshabilitado',
        failedToLinkDevice: 'Falló al vincular dispositivo',
        cameraPermissionsRequiredToScanQr: 'Se requieren permisos de cámara para escanear códigos QR'
    },

    navigation: {
        // Navigation titles and screen headers
        connectTerminal: 'Conectar terminal',
        linkNewDevice: 'Vincular nuevo dispositivo', 
        restoreWithSecretKey: 'Restaurar con clave secreta',
        browserTakeover: 'Control del navegador',
        whatsNew: 'Novedades',
        friends: 'Amigos',
    },

    welcome: {
        // Main welcome screen for unauthenticated users
        title: 'Cliente móvil de Pi',
        subtitle: 'Tu cuenta se guarda solo en tu dispositivo. El cifrado de extremo a extremo es opcional.',
        createAccount: 'Crear cuenta',
        linkOrRestoreAccount: 'Vincular o restaurar cuenta',
        loginWithMobileApp: 'Iniciar sesión con aplicación móvil',
    },

    review: {
        // Used by utils/requestReview.ts
        enjoyingApp: '¿Disfrutando la aplicación?',
        feedbackPrompt: '¡Nos encantaría escuchar tus comentarios!',
        yesILoveIt: '¡Sí, me encanta!',
        notReally: 'No realmente'
    },

    items: {
        // Used by Item component for copy toast
        copiedToClipboard: ({ label }: { label: string }) => `${label} copiado al portapapeles`
    },

    machine: {
        offlineUnableToSpawn: 'El lanzador está deshabilitado mientras la máquina está desconectada',
        launchNewSessionInDirectory: 'Iniciar nueva sesión en directorio',
        daemon: 'Daemon',
        status: 'Estado',
        stopDaemon: 'Detener daemon',
        lastKnownPid: 'Último PID conocido',
        lastKnownHttpPort: 'Último puerto HTTP conocido',
        startedAt: 'Iniciado en',
        cliVersion: 'Versión del CLI',
        daemonStateVersion: 'Versión del estado del daemon',
        stopDaemonConfirmTitle: '¿Detener el daemon?',
        stopDaemonConfirmMessage: 'No podrás iniciar nuevas sesiones en esta máquina hasta que reinicies el daemon en tu ordenador. Tus sesiones actuales seguirán activas.',
        daemonStopped: 'Daemon detenido',
        stopDaemonFailed: 'No se pudo detener el daemon. Es posible que no esté en ejecución.',
        machineGroup: 'Máquina',
        host: 'Host',
        machineId: 'ID de máquina',
        username: 'Nombre de usuario',
        homeDirectory: 'Directorio principal',
        platform: 'Plataforma',
        architecture: 'Arquitectura',
        lastSeen: 'Visto por última vez',
        never: 'Nunca',
        metadataVersion: 'Versión de metadatos',
        cliAvailability: 'Disponibilidad de CLI',
        cliInstalled: 'Instalado',
        cliNotFound: 'No encontrado',
        lastDetected: 'Última detección',
        back: 'Atrás',
        dangerZone: 'Zona de peligro',
        delete: 'Eliminar máquina',
        deleteFooter: 'Elimina esta máquina de tu cuenta. El historial de sesiones se conservará, pero no podrás iniciar nuevas sesiones en esta máquina.',
        deleteConfirmTitle: '¿Eliminar esta máquina?',
        deleteConfirmMessage: 'La máquina se eliminará de tu cuenta. El historial de sesiones se conservará, pero no podrás iniciar nuevas sesiones hasta que vuelvas a conectar el daemon.',
        deleteFailed: 'No se pudo eliminar la máquina.',
    },

    message: {
        switchedToMode: ({ mode }: { mode: string }) => `Cambiado al modo ${mode}`,
        unknownEvent: 'Evento desconocido',
        usageLimitUntil: ({ time }: { time: string }) => `Límite de uso alcanzado hasta ${time}`,
        sentAsGoal: 'Sent as goal',
        unknownTime: 'tiempo desconocido',
    },

    codex: {
        // Pi permission dialog buttons
        permissions: {
            yesForSession: 'Sí, y no preguntar por esta sesión',
            stopAndExplain: 'Detener, y explicar qué hacer',
        }
    },

    claude: {
        // Pi permission dialog buttons
        permissions: {
            yesAllowAllEdits: 'Sí, permitir todas las ediciones durante esta sesión',
            yesAllowEverything: 'Sí, permitir todo durante esta sesión',
            yesForTool: 'Sí, no volver a preguntar para esta herramienta',
            noTellClaude: 'No, proporcionar comentarios',
        }
    },

    textSelection: {
        // Text selection screen
        title: 'Seleccionar texto',
        noTextProvided: 'No se proporcionó texto',
        textNotFound: 'Texto no encontrado o expirado',
        textCopied: 'Texto copiado al portapapeles',
        failedToCopy: 'Error al copiar el texto al portapapeles',
        noTextToCopy: 'No hay texto disponible para copiar',
    },

    markdown: {
        // Markdown copy functionality
        codeCopied: 'Código copiado',
        copyFailed: 'Error al copiar',
        mermaidRenderFailed: 'Error al renderizar el diagrama mermaid',
    },

    artifacts: {
        // Artifacts feature
        title: 'Artefactos',
        empty: 'No hay artefactos aún',
        emptyDescription: 'Crea tu primer artefacto para comenzar',
        new: 'Nuevo artefacto',
        edit: 'Editar artefacto',
        delete: 'Eliminar',
        updateError: 'No se pudo actualizar el artefacto. Por favor, intenta de nuevo.',
        notFound: 'Artefacto no encontrado',
        deleteConfirm: '¿Eliminar artefacto?',
        deleteConfirmDescription: 'Esta acción no se puede deshacer',
        titleLabel: 'TÍTULO',
        titlePlaceholder: 'Ingresa un título para tu artefacto',
        bodyLabel: 'CONTENIDO',
        bodyPlaceholder: 'Escribe tu contenido aquí...',
        emptyFieldsError: 'Por favor, ingresa un título o contenido',
        createError: 'No se pudo crear el artefacto. Por favor, intenta de nuevo.',
        loading: 'Cargando artefactos...',
        error: 'Error al cargar el artefacto',
    },

    friends: {
        // Friends feature
        manageFriends: 'Administra tus amigos y conexiones',
        pendingRequests: 'Solicitudes de amistad',
        myFriends: 'Mis amigos',
        noFriendsYet: 'Aún no tienes amigos',
        remove: 'Eliminar',
        addFriend: 'Agregar amigo',
        alreadyFriends: 'Ya son amigos',
        requestPending: 'Solicitud pendiente',
        searchInstructions: 'Ingresa un nombre de usuario para buscar amigos',
        searchPlaceholder: 'Ingresa nombre de usuario...',
        searching: 'Buscando...',
        noUserFound: 'No se encontró ningún usuario con ese nombre',
        checkUsername: 'Por favor, verifica el nombre de usuario e intenta de nuevo',
        howToFind: 'Cómo encontrar amigos',
        findInstructions: 'Busca amigos por su nombre de usuario. Tanto tú como tu amigo deben tener GitHub conectado para enviar solicitudes de amistad.',
        requestSent: '¡Solicitud de amistad enviada!',
        confirmRemove: 'Eliminar amigo',
        confirmRemoveMessage: '¿Estás seguro de que quieres eliminar a este amigo?',
        cannotAddYourself: 'No puedes enviarte una solicitud de amistad a ti mismo',
        bothMustHaveGithub: 'Ambos usuarios deben tener GitHub conectado para ser amigos',
        status: {
            none: 'No conectado',
            requested: 'Solicitud enviada',
            pending: 'Solicitud pendiente',
            friend: 'Amigos',
            rejected: 'Rechazada',
        },
        acceptRequest: 'Aceptar solicitud',
        removeFriend: 'Eliminar de amigos',
        removeFriendConfirm: ({ name }: { name: string }) => `¿Estás seguro de que quieres eliminar a ${name} de tus amigos?`,
        requestFriendship: 'Solicitar amistad',
        cancelRequest: 'Cancelar solicitud de amistad',
        cancelRequestConfirm: ({ name }: { name: string }) => `¿Cancelar tu solicitud de amistad a ${name}?`,
        denyRequest: 'Rechazar solicitud',
    },

    usage: {
        // Usage panel strings
        today: 'Hoy',
        last7Days: 'Últimos 7 días',
        last30Days: 'Últimos 30 días',
        totalTokens: 'Tokens totales',
        totalCost: 'Costo total',
        tokens: 'Tokens',
        cost: 'Costo',
        usageOverTime: 'Uso a lo largo del tiempo',
        byModel: 'Por modelo',
    },

    imageUpload: {
        permissionTitle: 'Acceso a la biblioteca de fotos',
        permissionMessage: 'Permite el acceso a tu biblioteca de fotos para adjuntar imágenes a los mensajes.',
        limitTitle: 'Límite de imágenes alcanzado',
        limitMessage: ({ max }: { max: number }) => `Puedes adjuntar hasta ${max} imágenes por mensaje.`,
        fileTooLargeTitle: 'Archivo demasiado grande',
        fileTooLargeMessage: ({ name, maxMb }: { name: string; maxMb: number }) => `"${name}" supera el límite de ${maxMb}MB y no se añadió.`,
        uploadFailedTitle: 'Error al subir',
        uploadFailedMessage: ({ count }: { count: number }) => count === 1
            ? 'No se pudo subir una imagen y no se envió.'
            : `No se pudieron subir ${count} imágenes y no se enviaron.`,
        notSupportedTitle: 'Imágenes no compatibles',
        notSupportedMessage: 'Este agente no admite archivos adjuntos de imagen. Las imágenes no se enviaron.',
    },

    feed: {
        // Feed notifications for friend requests and acceptances
    },

} as const;

export type TranslationsEs = typeof es;
