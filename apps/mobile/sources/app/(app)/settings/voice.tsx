import * as React from 'react';
import { ActivityIndicator, AppState, Platform, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Switch } from '@/components/Switch';
import { OptionSheet, type ModelMode } from '@/components/OptionSheet';
import { Modal } from '@/modal';
import { callPlugin, pluginHref } from '@/plugins';
import { pluginCatalogSnapshot, refreshPlugins } from '@/plugins';
import { voicePluginFromCatalog } from '@/plugins/application/voicePluginAccess';
import { useLocalSetting, useLocalSettingMutable, useSocketStatus } from '@/catalog/store';
import { useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import { configureVadStandby } from '@/conversation/session';
import { ensureRealtimeProviderConfigured, requestRealtimePermission } from '@/conversation';
import { Meter } from '@/components/ui';
import {
    BUNDLED_DICTATION_MODEL_ID,
    DICTATION_MODELS,
    downloadDictationModel,
    getInstalledDictationModelIds,
    removeDownloadedDictationModel,
    type DictationDownloadProgress,
} from '@/utils/dictationModels';

type ProviderOption = { id: string; name: string; description?: string; selected: boolean; configurationContributionId: string };
type ProviderList = { selected: string; providers: ProviderOption[] };
type WordReplacement = { from: string; to: string };

const DICTATION_LANGUAGE_OPTIONS: ModelMode[] = [
    { key: 'auto', name: 'Automatic', description: 'Detect the spoken language for each recording' },
    { key: 'en', name: 'English' },
    { key: 'ar', name: 'Arabic' },
    { key: 'ur', name: 'Urdu' },
    { key: 'zh', name: 'Chinese' },
    { key: 'fr', name: 'French' },
    { key: 'de', name: 'German' },
    { key: 'hi', name: 'Hindi' },
    { key: 'it', name: 'Italian' },
    { key: 'ja', name: 'Japanese' },
    { key: 'ko', name: 'Korean' },
    { key: 'pl', name: 'Polish' },
    { key: 'pt', name: 'Portuguese' },
    { key: 'ru', name: 'Russian' },
    { key: 'es', name: 'Spanish' },
    { key: 'tr', name: 'Turkish' },
];

const DICTATION_LANGUAGE_NAMES = new Map(
    DICTATION_LANGUAGE_OPTIONS.map((option) => [option.key, option.name]),
);

function formatModelSize(bytes: number): string {
    return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

function modelProgressText(progress: DictationDownloadProgress): string {
    const ratio = progress.totalBytes > 0 ? Math.min(1, progress.bytesWritten / progress.totalBytes) : 0;
    return `Downloading ${Math.round(ratio * 100)}% · ${formatModelSize(progress.bytesWritten)} of ${formatModelSize(progress.totalBytes)}`;
}

async function loadVoicePlugin() {
    await refreshPlugins();
    return voicePluginFromCatalog(pluginCatalogSnapshot());
}

export default function VoiceProviderScreen() {
    const router = useRouter();
    const { theme } = useUnistyles();
    const { status } = useSocketStatus();
    const [providers, setProviders] = React.useState<ProviderOption[]>([]);
    const [voicePluginId, setVoicePluginId] = React.useState<string>();
    const [busy, setBusy] = React.useState<string>();
    const [loaded, setLoaded] = React.useState(false);
    const [error, setError] = React.useState<string>();
    const [disabled, setDisabled] = React.useState(false);
    const busyRef = React.useRef(false);
    const vadStandbyEnabled = useLocalSetting('vadStandbyEnabled');
    const [dictationLanguage, setDictationLanguage] = useLocalSettingMutable('dictationLanguage');
    const [dictationModel, setDictationModel] = useLocalSettingMutable('dictationModel');
    const [dictationWordReplacements, setDictationWordReplacements] = useLocalSettingMutable('dictationWordReplacements');
    const [dictationSheet, setDictationSheet] = React.useState<'language' | null>(null);
    const [installedModelIds, setInstalledModelIds] = React.useState<Set<string>>(() => new Set([BUNDLED_DICTATION_MODEL_ID]));
    const [modelBusy, setModelBusy] = React.useState<string>();
    const [modelProgress, setModelProgress] = React.useState<DictationDownloadProgress>();
    const [modelError, setModelError] = React.useState<string>();

    const load = React.useCallback(async () => {
        if (status !== 'connected') { setLoaded(true); return; }
        setLoaded(false);
        try {
            const access = await loadVoicePlugin();
            if (access.status !== 'ready') {
                setDisabled(access.status === 'disabled');
                setProviders([]);
                setVoicePluginId(undefined);
                setError(access.status === 'missing' ? 'No voice plugin is available on this machine.' : undefined);
                return;
            }
            setDisabled(false);
            setVoicePluginId(access.plugin?.summary.pluginId);
            setProviders((await callPlugin<ProviderList>('voice.provider.list')).providers);
            setError(undefined);
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
            setLoaded(true);
        }
    }, [status]);

    React.useEffect(() => { void load(); }, [load]);

    const refreshModels = React.useCallback(() => {
        const next = new Set(getInstalledDictationModelIds());
        setInstalledModelIds(next);
        if (dictationModel !== BUNDLED_DICTATION_MODEL_ID && !next.has(dictationModel)) {
            setDictationModel(BUNDLED_DICTATION_MODEL_ID);
        }
    }, [dictationModel, setDictationModel]);

    React.useEffect(() => {
        refreshModels();
        const subscription = AppState.addEventListener('change', (nextState) => {
            if (nextState === 'active') refreshModels();
        });
        return () => subscription.remove();
    }, [refreshModels]);

    const selectModel = React.useCallback(async (model: (typeof DICTATION_MODELS)[number]) => {
        if (modelBusy !== undefined) return;
        setModelError(undefined);
        if (installedModelIds.has(model.id)) {
            setDictationModel(model.id);
            return;
        }
        if (Platform.OS === 'web') {
            setModelError('Model downloads are available in the Android and iOS apps.');
            return;
        }
        setModelBusy(model.id);
        setModelProgress(undefined);
        try {
            await downloadDictationModel(model.id, setModelProgress);
            refreshModels();
            setDictationModel(model.id);
        } catch (cause) {
            const message = cause instanceof Error ? cause.message : String(cause);
            setModelError(`Could not download ${model.name}. ${message}`);
            Modal.alert('Could not download dictation model', message);
        } finally {
            setModelBusy(undefined);
            setModelProgress(undefined);
        }
    }, [installedModelIds, modelBusy, refreshModels, setDictationModel]);

    const removeModel = React.useCallback(async (model: (typeof DICTATION_MODELS)[number]) => {
        if (model.bundled || modelBusy !== undefined) return;
        if (!await Modal.confirm(
            `Remove ${model.name}?`,
            `${formatModelSize(model.sizeBytes)} will be freed. English stays available as the fallback.`,
            { confirmText: 'Remove', destructive: true },
        )) return;
        if (dictationModel === model.id) setDictationModel(BUNDLED_DICTATION_MODEL_ID);
        try {
            removeDownloadedDictationModel(model.id);
            refreshModels();
            setModelError(undefined);
        } catch (cause) {
            Modal.alert('Could not remove dictation model', cause instanceof Error ? cause.message : String(cause));
        }
    }, [dictationModel, modelBusy, refreshModels, setDictationModel]);

    const select = React.useCallback(async (provider: ProviderOption) => {
        if (provider.selected || busyRef.current) return;
        busyRef.current = true;
        setBusy(provider.id);
        try {
            setProviders((await callPlugin<ProviderList>('voice.provider.set', { providerId: provider.id })).providers);
            setError(undefined);
        } catch (cause) {
            const message = cause instanceof Error ? cause.message : String(cause);
            setError(message);
            Modal.alert('Could not switch voice provider', message);
            await load();
        } finally {
            busyRef.current = false;
            setBusy(undefined);
        }
    }, [load]);

    const selected = providers.find((provider) => provider.selected);
    const wakeBlocked = status !== 'connected'
        ? 'Connect to a computer first.'
        : disabled
            ? 'Enable the voice plugin first.'
            : error !== undefined
                ? 'Realtime voice is unavailable on this computer.'
                : selected === undefined ? 'Choose a voice provider first.' : undefined;
    const configure = React.useCallback(async () => {
        if (selected === undefined || busyRef.current) return;
        busyRef.current = true;
        setBusy(selected.id);
        try {
            const access = await loadVoicePlugin();
            if (access.status === 'disabled') {
                router.push('/settings/plugins' as any);
                return;
            }
            const plugin = access.plugin;
            const settings = plugin?.manifest?.contributions.find((contribution) => contribution.slot === 'navigation.content' && contribution.type === 'screen' && contribution.id === selected.configurationContributionId);
            if (settings === undefined) throw new Error('This provider has no configuration screen.');
            router.push(pluginHref(plugin!.summary.pluginId, settings.id) as any);
        } catch (cause) {
            Modal.alert('Provider settings unavailable', cause instanceof Error ? cause.message : String(cause));
        } finally {
            busyRef.current = false;
            setBusy(undefined);
        }
    }, [router, selected]);

    const editWordReplacement = React.useCallback(async (existing: WordReplacement | undefined, index: number | undefined) => {
        const from = await Modal.prompt(
            existing === undefined ? 'Word to fix' : 'Edit word to fix',
            'Enter the word or phrase the engine hears wrong.',
            { defaultValue: existing?.from, placeholder: 'e.g. muxer' },
        );
        if (from === null || !from.trim()) return;

        const to = await Modal.prompt(
            'Replace with',
            `Use this text instead of “${from.trim()}”.`,
            { defaultValue: existing?.to, placeholder: 'e.g. muxr' },
        );
        if (to === null || !to.trim()) return;

        const replacement = { from: from.trim(), to: to.trim() };
        const next = [...dictationWordReplacements];
        const targetIndex = index;
        const duplicateIndex = next.findIndex((entry, entryIndex) =>
            entryIndex !== targetIndex && entry.from.toLocaleLowerCase() === replacement.from.toLocaleLowerCase());
        if (duplicateIndex >= 0) {
            next.splice(duplicateIndex, 1);
            if (targetIndex !== undefined && duplicateIndex < targetIndex) {
                next[targetIndex - 1] = replacement;
                setDictationWordReplacements(next);
                return;
            }
        }
        if (targetIndex === undefined) next.push(replacement);
        else next[targetIndex] = replacement;
        setDictationWordReplacements(next);
    }, [dictationWordReplacements, setDictationWordReplacements]);

    const removeWordReplacement = React.useCallback(async (replacement: WordReplacement, index: number) => {
        if (!await Modal.confirm(
            'Delete word replacement?',
            `“${replacement.from}” will no longer be corrected to “${replacement.to}”.`,
            { confirmText: 'Delete', destructive: true },
        )) return;
        setDictationWordReplacements(dictationWordReplacements.filter((_, entryIndex) => entryIndex !== index));
    }, [dictationWordReplacements, setDictationWordReplacements]);

    const setVadStandby = React.useCallback(async (enabled: boolean) => {
        if (!enabled) return void configureVadStandby(false);
        if (!(await requestRealtimePermission()) || !(await ensureRealtimeProviderConfigured())) return;
        if (!(await configureVadStandby(true))) {
            Modal.alert('Wake on speech unavailable', 'Start or connect an agent first, then try again.');
        }
    }, []);

    if (status === 'connected' && !loaded) return <ActivityIndicator style={{ flex: 1 }} />;

    const providerFooter = error
        ?? (disabled ? 'Realtime voice is turned off for this device. Enable it from Plugins if you want it back.' : undefined)
        ?? (status === 'connected' ? 'One provider runs on this machine at a time.' : 'Connect to a machine to choose its voice provider.');
    const activeDictationModelId = installedModelIds.has(dictationModel) ? dictationModel : BUNDLED_DICTATION_MODEL_ID;
    const languageNeedsMultilingual = dictationLanguage !== null && dictationLanguage !== 'en' && activeDictationModelId === BUNDLED_DICTATION_MODEL_ID;
    const modelFooter = modelError
        ?? (languageNeedsMultilingual
            ? 'This pinned language needs the multilingual model. Download it above; English remains the current fallback.'
            : Platform.OS === 'web'
                ? 'Dictation models run on-device. Download another model from the Android or iOS app.'
                : 'Dictation stays on this device. Downloads continue in the background where supported. Tap to use an installed model; hold a downloaded model to remove it.');

    return (
        <ItemList>
            <ItemGroup title="Provider" footer={providerFooter}>
                {disabled ? (
                    <Item
                        title="Voice plugin disabled"
                        subtitle="Open Plugins to enable it"
                        icon={<Ionicons name="settings-outline" size={28} color={theme.colors.textSecondary} />}
                        onPress={() => router.push('/settings/plugins' as any)}
                    />
                ) : providers.map((provider) => (
                    <Item
                        key={provider.id}
                        title={provider.name}
                        subtitle={[provider.description, provider.selected ? 'In use' : 'Tap to use'].filter((part) => part !== undefined && part !== '').join(' · ')}
                        subtitleLines={2}
                        selected={provider.selected}
                        loading={busy === provider.id}
                        showChevron={false}
                        onPress={() => void select(provider)}
                        rightElement={provider.selected ? <Ionicons name="checkmark-circle" size={24} color={theme.colors.textLink} /> : undefined}
                    />
                ))}
                {voicePluginId !== undefined && (
                    <Item
                        title="Voice engines"
                        subtitle="What each one is, and talk to hear it"
                        icon={<Ionicons name="information-circle-outline" size={28} color={theme.colors.textSecondary} />}
                        onPress={() => router.push(pluginHref(voicePluginId, 'engines-screen') as any)}
                    />
                )}
            </ItemGroup>
            {selected !== undefined && (
                <ItemGroup title="Setup">
                    <Item
                        title={`Configure ${selected.name}`}
                        subtitle="Open the provider's settings on the connected machine"
                        icon={<Ionicons name="settings-outline" size={28} color={theme.colors.textSecondary} />}
                        loading={busy === selected.id}
                        onPress={() => void configure()}
                    />
                </ItemGroup>
            )}
            <ItemGroup title="Models" footer={modelFooter}>
                {DICTATION_MODELS.map((model) => {
                    const installed = installedModelIds.has(model.id);
                    const selectedModel = activeDictationModelId === model.id;
                    const progress = modelBusy === model.id ? modelProgress : undefined;
                    const ratio = progress === undefined || progress.totalBytes <= 0 ? 0 : progress.bytesWritten / progress.totalBytes;
                    const detail = selectedModel
                        ? `${model.bundled ? 'Bundled' : 'Installed'} · In use`
                        : model.bundled
                            ? 'Bundled'
                            : installed ? 'Installed' : `Download · ${formatModelSize(model.sizeBytes)}`;
                    return (
                        <Item
                            key={model.id}
                            title={model.name}
                            subtitle={progress === undefined ? model.description : modelProgressText(progress)}
                            subtitleLines={2}
                            detail={progress === undefined ? detail : undefined}
                            icon={<Ionicons name={model.bundled ? 'phone-portrait-outline' : 'cloud-download-outline'} size={28} color={theme.colors.textSecondary} />}
                            selected={selectedModel}
                            loading={modelBusy === model.id && progress === undefined}
                            disabled={modelBusy !== undefined && modelBusy !== model.id}
                            showChevron={progress === undefined}
                            accessibilityLabel={`${model.name}, ${detail}`}
                            rightElement={progress !== undefined ? (
                                <View style={{ width: 78, gap: 4 }}>
                                    <Text style={{ color: theme.colors.textSecondary, fontSize: 12, textAlign: 'right' }}>{`${Math.round(Math.min(1, ratio) * 100)}%`}</Text>
                                    <Meter ratio={ratio} />
                                </View>
                            ) : selectedModel ? <Ionicons name="checkmark-circle" size={24} color={theme.colors.textLink} /> : undefined}
                            onPress={() => void selectModel(model)}
                            onLongPress={() => void removeModel(model)}
                        />
                    );
                })}
            </ItemGroup>
            <ItemGroup
                title="Dictation"
                footer="Transcription stays on this device. Automatic detects the language; pin one when you know what you will speak. Tap a replacement to edit it, or hold it to delete it."
            >
                <Item
                    title="Spoken language"
                    subtitle={languageNeedsMultilingual
                        ? 'Pin a language; the multilingual model is needed for non-English speech'
                        : 'Choose automatic detection or pin one language'}
                    detail={DICTATION_LANGUAGE_NAMES.get(dictationLanguage ?? 'auto') ?? 'Automatic'}
                    icon={<Ionicons name="language-outline" size={28} color={theme.colors.textSecondary} />}
                    onPress={() => setDictationSheet('language')}
                />
                <Item
                    title="Word replacements"
                    subtitle={dictationWordReplacements.length === 0
                        ? 'No replacements yet. Add one to fix a word the engine keeps getting wrong.'
                        : `${dictationWordReplacements.length} saved correction${dictationWordReplacements.length === 1 ? '' : 's'}`}
                    icon={<Ionicons name="text-outline" size={28} color={theme.colors.textSecondary} />}
                    showChevron={false}
                />
                {dictationWordReplacements.map((replacement, index) => (
                    <Item
                        key={`${replacement.from}-${index}`}
                        title={`${replacement.from} → ${replacement.to}`}
                        subtitle="Tap to edit · hold to delete"
                        icon={<Ionicons name="create-outline" size={24} color={theme.colors.textSecondary} />}
                        accessibilityLabel={`Replace ${replacement.from} with ${replacement.to}`}
                        onPress={() => { void editWordReplacement(replacement, index); }}
                        onLongPress={() => { void removeWordReplacement(replacement, index); }}
                    />
                ))}
                <Item
                    title="Add replacement"
                    subtitle="Correct a name, jargon term, or command"
                    icon={<Ionicons name="add-circle-outline" size={28} color={theme.colors.textLink} />}
                    onPress={() => { void editWordReplacement(undefined, undefined); }}
                />
            </ItemGroup>
            <OptionSheet
                visible={dictationSheet === 'language'}
                title="Spoken language"
                options={DICTATION_LANGUAGE_OPTIONS}
                selectedKey={dictationLanguage ?? 'auto'}
                onSelect={(option) => setDictationLanguage(option.key === 'auto' ? null : option.key)}
                onClose={() => setDictationSheet(null)}
            />
            <ItemGroup title="Hands-free" footer="Listens only on this device until speech is detected. The setting stays enabled until you disable it and uses additional battery.">
                <Item
                    title="Wake on speech"
                    subtitle={`${wakeBlocked === undefined ? 'Reconnect realtime voice when someone starts talking' : `Reconnect realtime voice when someone starts talking. ${wakeBlocked}`}${vadStandbyEnabled ? ' · On' : ' · Off'}`}
                    subtitleLines={0}
                    icon={<Ionicons name="ear-outline" size={28} color={theme.colors.textSecondary} />}
                    showChevron={false}
                    rightElement={<Switch value={vadStandbyEnabled} disabled={wakeBlocked !== undefined && !vadStandbyEnabled} accessibilityLabel="Wake on speech" onValueChange={(value) => void setVadStandby(value)} />}
                />
            </ItemGroup>
        </ItemList>
    );
}
