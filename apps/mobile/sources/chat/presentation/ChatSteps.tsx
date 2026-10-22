import * as React from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, Text, View, useColorScheme, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { UnistylesRuntime, useUnistyles } from 'react-native-unistyles';
import { Ionicons, Octicons } from '@expo/vector-icons';
import type { ChatTool, ChatToolKind } from '@trymuxr/contract';
import { Typography } from '@/constants/Typography';
import { loadThemePreference } from '@/catalog';

/** A peek shows this many diff lines; Full diff shows the rest the host sent. */
const PEEK_LINES = 8;
/** Below this width a group shows one icon and the rail tightens. */
const NARROW = 340;

const GLYPH: Record<ChatToolKind, React.ComponentProps<typeof Octicons>['name']> = {
    edit: 'file-diff', write: 'file-added', read: 'file-code', list: 'file-directory', search: 'search', run: 'terminal',
    fetch: 'globe', web: 'telescope', helper: 'rocket', plan: 'tasklist', ask: 'question', tool: 'plug',
};
const VERB: Record<ChatToolKind, string> = {
    edit: 'Edited', write: 'Created', read: 'Read', list: 'Listed', search: 'Searched', run: 'Ran',
    fetch: 'Opened', web: 'Searched the web', helper: 'Helper', plan: 'Plan', ask: 'Asked you', tool: 'Used',
};
/**
 * The theme a reply mounted in. A row or peek opened later mounts after the
 * screen's `ScopedTheme` has closed, so its own `useUnistyles` would read the
 * app's theme: dark text on the dark chat in the light app theme.
 */
const MountTheme = React.createContext<ReturnType<typeof useUnistyles>['theme'] | null>(null);

function useChatTheme(): ReturnType<typeof useUnistyles>['theme'] {
    const mounted = React.useContext(MountTheme);
    const { theme } = useUnistyles();
    return mounted ?? theme;
}

const PATH_KINDS = new Set<ChatToolKind | undefined>(['edit', 'write', 'read', 'list']);
const MONO_KINDS = new Set<ChatToolKind | undefined>(['edit', 'write', 'read', 'list', 'search', 'run']);

/** What the row names: the file, command or query; a plan its progress; an older host's step its own words. */
function targetOf(tool: ChatTool): string {
    if (tool.kind === 'plan') return tool.note ?? 'Updated';
    if (tool.kind === 'tool') return tool.detail ?? tool.verb.replace(/^Used /, '');
    return tool.detail ?? (tool.kind === undefined ? '' : tool.verb);
}

function verbOf(tool: ChatTool): string {
    return tool.kind === undefined ? tool.verb : VERB[tool.kind];
}

function Glyph({ kind }: { kind: ChatToolKind | undefined }): React.JSX.Element {
    const theme = useChatTheme();
    return (
        // Decorative: the row's label already says what the step was.
        <View aria-hidden style={{ width: 26, height: 26, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.surfaceHigh, borderWidth: 1, borderColor: theme.colors.divider }}>
            <Octicons name={kind === undefined ? 'gear' : GLYPH[kind]} size={14} color={theme.colors.textSecondary} />
        </View>
    );
}

/** IBM Plex Mono advances every glyph by 0.6 em, so a mono line's room is a character count. */
const MONO_ADVANCE = 0.6;
const TARGET_SIZE = 13.5;

/**
 * Cut in the middle so the end stays: a file keeps its name down to its
 * extensions (`shipping….test.ts`), a command its last word when short.
 */
function cutMiddle(text: string, room: number, path: boolean): string {
    if (text.length <= room) return text;
    const space = text.lastIndexOf(' ');
    const dot = text.split('').findIndex((char, index) => char === '.' && index > 0 && text.length - index <= 12);
    let preferred = text.slice(-10);
    if (path && dot > 0) preferred = text.slice(dot);
    else if (!path && space > 0 && text.length - space <= 18) preferred = text.slice(space);
    // At least three characters of the head show before the ellipsis.
    const tail = preferred.length <= room - 4 ? preferred : text.slice(-(Math.max(1, room - 4)));
    return `${text.slice(0, Math.max(0, room - tail.length - 1))}…${tail}`;
}

/**
 * Mono text cut in the middle, from the room it measures: `ellipsizeMode`
 * cuts only the tail on the web, and two texts sharing a row did not give way
 * in order there. A file shows its name (the peek's caption has the whole path).
 */
function MiddleText({ text, path, color }: { text: string; path: boolean; color: string }): React.JSX.Element {
    const [width, setWidth] = React.useState(0);
    const shown = path ? text.slice(text.lastIndexOf('/') + 1) : text;
    const room = width === 0 ? shown.length : Math.max(4, Math.floor(width / (TARGET_SIZE * MONO_ADVANCE)) - 1);
    return (
        <View style={{ flex: 1, minWidth: 0 }} onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
            <Text numberOfLines={1} style={{ color, fontSize: TARGET_SIZE, ...Typography.mono() }}>{cutMiddle(shown, room, path)}</Text>
        </View>
    );
}

/** Colour only where it means something: lines added and removed, a failure, a step still running. */
function Meta({ tool, running }: { tool: ChatTool; running: boolean }): React.JSX.Element | null {
    const theme = useChatTheme();
    const small = { fontSize: 12.5 };
    if (running) return <ActivityIndicator size="small" color={theme.colors.textSecondary} style={{ transform: [{ scale: 0.75 }] }} />;
    if (tool.outcome === 'failed') return <Text style={[small, { color: theme.colors.diff.error }]}>failed</Text>;
    if (tool.added !== undefined) return <Stat added={tool.added} removed={tool.removed ?? 0} />;
    if (tool.kind === 'run' && tool.outcome === 'ok') return <Ionicons name="checkmark" size={16} color={theme.colors.diff.success} />;
    if (tool.note !== undefined && tool.kind !== 'plan') return <Text numberOfLines={1} style={[small, { color: theme.colors.textSecondary }]}>{tool.note}</Text>;
    return null;
}

function Stat({ added, removed }: { added: number; removed: number }): React.JSX.Element {
    const theme = useChatTheme();
    return (
        <View style={{ flexDirection: 'row', gap: 5 }}>
            <Text style={{ fontSize: 12.5, color: theme.colors.diff.success }}>+{added}</Text>
            {removed > 0 && <Text style={{ fontSize: 12.5, color: theme.colors.diff.error }}>−{removed}</Text>}
        </View>
    );
}

/** A tappable row: 44 dp tall, its chevron turning as it opens. */
function Row({ open, onPress, label, children }: { open: boolean; onPress: () => void; label: string; children: React.ReactNode }): React.JSX.Element {
    const theme = useChatTheme();
    return (
        <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ expanded: open }}
            style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44, paddingHorizontal: 2, borderRadius: 10, backgroundColor: pressed ? theme.colors.surfaceHigh : 'transparent' })}>
            {children}
            <Ionicons name="chevron-forward" size={13} color={theme.colors.textSecondary} style={{ transform: [{ rotate: open ? '90deg' : '0deg' }] }} />
        </Pressable>
    );
}

type CodeColors = ReturnType<typeof useUnistyles>['theme']['colors']['code'];
const MARKS: Record<string, { sign: string; background: (code: CodeColors) => string; mark: (code: CodeColors) => string }> = {
    '+': { sign: '+', background: (code) => code.addedBg, mark: (code) => code.addedMark },
    '-': { sign: '−', background: (code) => code.removedBg, mark: (code) => code.removedMark },
    ' ': { sign: '', background: () => 'transparent', mark: (code) => code.dim },
};

/** Diff lines in the code panel's colours, numbered from the hunk headers Claude's own patch carries. */
function DiffLines({ lines }: { lines: string[] }): React.JSX.Element {
    const theme = useChatTheme();
    const code = theme.colors.code;
    let oldLine = 0;
    let newLine = 0;
    const text = { fontSize: 12, lineHeight: 18, color: code.text, ...Typography.mono() };
    return (
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View style={{ minWidth: '100%', paddingVertical: 4 }}>
                {lines.map((line, index) => {
                    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
                    if (hunk !== null) {
                        oldLine = Number(hunk[1]);
                        newLine = Number(hunk[2]);
                        return index === 0 ? null : <Text key={index} style={[text, { color: code.dim, paddingLeft: 10 }]}>⋯</Text>;
                    }
                    const kind = MARKS[line.charAt(0)] ?? MARKS[' '];
                    const numbered = oldLine > 0;
                    let number = newLine;
                    if (kind.sign === '−') number = oldLine++;
                    else { if (kind.sign === '') oldLine++; newLine++; }
                    return (
                        <View key={index} style={{ flexDirection: 'row', paddingRight: 10, backgroundColor: kind.background(code) }}>
                            {numbered && <Text style={[text, { width: 34, textAlign: 'right', paddingRight: 6, color: code.dim }]}>{number}</Text>}
                            <Text style={[text, { width: 16, textAlign: 'center', color: kind.mark(code) }]}>{kind.sign}</Text>
                            <Text style={text}>{line.slice(1)}</Text>
                        </View>
                    );
                })}
            </View>
        </ScrollView>
    );
}

function Panel({ caption, footer, children }: { caption?: React.ReactNode; footer?: React.ReactNode; children: React.ReactNode }): React.JSX.Element {
    const theme = useChatTheme();
    const code = theme.colors.code;
    return (
        <View style={{ backgroundColor: code.surface, borderWidth: 1, borderColor: code.hairline, borderRadius: 10, overflow: 'hidden' }}>
            {caption !== undefined && <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 10, paddingVertical: 7, backgroundColor: code.surfaceRaised, borderBottomWidth: 1, borderBottomColor: code.hairline }}>{caption}</View>}
            {children}
            {footer !== undefined && <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingLeft: 10, borderTopWidth: 1, borderTopColor: code.hairline, minHeight: 36 }}>{footer}</View>}
        </View>
    );
}

function FooterLink({ label, onPress }: { label: string; onPress: () => void }): React.JSX.Element {
    const theme = useChatTheme();
    return (
        <Pressable onPress={onPress} accessibilityRole="button" hitSlop={4} style={({ pressed }) => ({ minHeight: 44, justifyContent: 'center', paddingHorizontal: 10, opacity: pressed ? 0.6 : 1 })}>
            <Text style={{ color: theme.colors.code.number, fontSize: 13 }}>{label} ›</Text>
        </Pressable>
    );
}

/** What a step opens to, in place: its diff, its output, its checklist, or its whole target. */
function Peek({ tool, onFullDiff, onOpenTerminal }: { tool: ChatTool; onFullDiff: (tool: ChatTool) => void; onOpenTerminal: () => void }): React.JSX.Element {
    const theme = useChatTheme();
    const code = theme.colors.code;
    const dim = { color: code.dim, fontSize: 12.5 };
    if (tool.diff !== undefined && tool.diff.length > 0) {
        const changed = (tool.added ?? 0) + (tool.removed ?? 0);
        return (
            <Panel
                caption={<>
                    <Text numberOfLines={1} style={[dim, { flex: 1, ...Typography.mono() }]}>{tool.detail ?? ''}</Text>
                    <Stat added={tool.added ?? 0} removed={tool.removed ?? 0} />
                </>}
                footer={<>
                    <Text style={dim}>{tool.kind === 'write' ? 'New file' : `${plural(changed, 'line')} changed`}</Text>
                    <FooterLink label="Full diff" onPress={() => onFullDiff(tool)} />
                </>}>
                <DiffLines lines={tool.diff.slice(0, PEEK_LINES + (tool.diff[0]?.startsWith('@@') ? 1 : 0))} />
            </Panel>
        );
    }
    if (tool.kind === 'plan' && tool.output !== undefined) {
        return (
            <View style={{ gap: 2 }}>
                {tool.output.map((item, index) => {
                    const done = item.startsWith('✓');
                    return (
                        <View key={index} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 26 }}>
                            <Ionicons name={done ? 'checkmark-circle' : 'ellipse-outline'} size={16} color={done ? theme.colors.diff.success : theme.colors.textSecondary} />
                            <Text style={{ flex: 1, fontSize: 14, color: done ? theme.colors.textSecondary : theme.colors.text, textDecorationLine: done ? 'line-through' : 'none' }}>{item.slice(2)}</Text>
                        </View>
                    );
                })}
            </View>
        );
    }
    if (tool.output !== undefined && (tool.output.length > 0 || tool.kind === 'run')) {
        const text = { fontSize: 12, lineHeight: 18, ...Typography.mono() };
        return (
            <Panel footer={tool.kind === 'run' ? <>
                <Text style={dim}>{endOf(tool)}</Text>
                <FooterLink label="Open terminal" onPress={onOpenTerminal} />
            </> : undefined}>
                <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                    <View style={{ padding: 10, paddingVertical: 8 }}>
                        {tool.kind === 'run' && <Text style={[text, { color: code.text }]}>$ {tool.detail}</Text>}
                        {tool.output.map((line, index) => <Text key={index} style={[text, { color: code.dim }]}>{line}</Text>)}
                    </View>
                </ScrollView>
            </Panel>
        );
    }
    return <Text selectable style={{ color: theme.colors.textSecondary, fontSize: 13.5, lineHeight: 20, ...(MONO_KINDS.has(tool.kind) ? Typography.mono() : {}) }}>{tool.detail ?? 'Nothing more to show for this step.'}</Text>;
}

function Step({ tool, running, onFullDiff, onOpenTerminal }: { tool: ChatTool; running: boolean; onFullDiff: (tool: ChatTool) => void; onOpenTerminal: () => void }): React.JSX.Element {
    const theme = useChatTheme();
    const narrow = useWindowDimensions().width < NARROW;
    const [open, setOpen] = React.useState(false);
    const target = targetOf(tool);
    const mono = MONO_KINDS.has(tool.kind);
    return (
        <View>
            <Row open={open} onPress={() => setOpen(!open)} label={`${verbOf(tool)} ${target}${stateWords(tool, running)}`}>
                <Glyph kind={tool.kind} />
                <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
                    {/* Narrow, a file or command needs the room: its icon already says the kind. */}
                    {!(narrow && mono) && <Text numberOfLines={1} style={{ flexShrink: 0, color: theme.colors.textSecondary, fontSize: 14.5 }}>{verbOf(tool)}</Text>}
                    {mono
                        ? <MiddleText text={target} path={PATH_KINDS.has(tool.kind)} color={theme.colors.text} />
                        : <Text numberOfLines={1} style={{ flexShrink: 1, minWidth: 0, color: theme.colors.text, fontSize: 14.5 }}>{target}</Text>}
                </View>
                <Meta tool={tool} running={running} />
            </Row>
            {open && <View style={{ marginLeft: narrow ? 0 : 36, marginBottom: 8 }}><Peek tool={tool} onFullDiff={onFullDiff} onOpenTerminal={onOpenTerminal} /></View>}
        </View>
    );
}

function plural(n: number, word: string): string {
    return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** How a command ended, for its peek's footer. */
function endOf(tool: ChatTool): string {
    if (tool.exit !== undefined) return `Exit ${tool.exit}`;
    return tool.outcome === 'failed' ? 'Failed' : 'Done';
}

function stateWords(tool: ChatTool, running: boolean): string {
    if (running) return ', running';
    return tool.outcome === 'failed' ? ', failed' : '';
}

function runningVerb(tool: ChatTool): string {
    return tool.kind === 'run' ? 'Running' : verbOf(tool);
}

function GroupMeta({ running, failed, added, removed, count }: { running: boolean; failed: boolean; added: number; removed: number; count: number }): React.JSX.Element {
    const theme = useChatTheme();
    if (running) return <ActivityIndicator size="small" color={theme.colors.textSecondary} style={{ transform: [{ scale: 0.75 }] }} />;
    if (failed) return <Text style={{ fontSize: 12.5, color: theme.colors.diff.error }}>failed</Text>;
    if (added + removed > 0) return <Stat added={added} removed={removed} />;
    return <Text style={{ fontSize: 12.5, color: theme.colors.textSecondary }}>{plural(count, 'step')}</Text>;
}

/** "Edited 2 files, read 1 file, ran 1 command": the three kinds that matter most, in that order. */
function summaryOf(tools: ChatTool[]): string {
    const count = (kinds: Array<ChatToolKind | undefined>) => tools.filter((tool) => kinds.includes(tool.kind)).length;
    const parts: string[] = [];
    const edits = count(['edit', 'write']);
    if (edits > 0) parts.push(`edited ${plural(edits, 'file')}`);
    const reads = count(['read', 'list']);
    if (reads > 0) parts.push(`read ${plural(reads, 'file')}`);
    if (count(['search', 'web']) > 0) parts.push('searched');
    const runs = count(['run']);
    if (runs > 0) parts.push(`ran ${plural(runs, 'command')}`);
    if (count(['fetch']) > 0) parts.push('opened a page');
    if (count(['helper']) > 0) parts.push('used a helper');
    const rest = tools.length - count(['edit', 'write', 'read', 'list', 'search', 'web', 'run', 'fetch', 'helper']);
    if (rest > 0) parts.push(plural(rest, 'other step'));
    const shown = parts.slice(0, 3).join(', ') + (parts.length > 3 ? `, ${parts.length - 3} more` : '');
    return shown.charAt(0).toUpperCase() + shown.slice(1);
}

/**
 * A reply's tool calls. One call is its own row; several fold into one row
 * that opens in place. `live` is the newest reply of an agent still working:
 * its unanswered calls are the ones running.
 */
export function ChatSteps(props: { tools: ChatTool[]; live: boolean; ink: string; onFullDiff: (tool: ChatTool) => void; onOpenTerminal: () => void }): React.JSX.Element {
    // Read here, where the reply mounts inside the screen's dark scope.
    const { theme } = useUnistyles();
    return <MountTheme.Provider value={theme}><Steps {...props} /></MountTheme.Provider>;
}

function Steps({ tools, live, ink, onFullDiff, onOpenTerminal }: { tools: ChatTool[]; live: boolean; ink: string; onFullDiff: (tool: ChatTool) => void; onOpenTerminal: () => void }): React.JSX.Element {
    const theme = useChatTheme();
    const narrow = useWindowDimensions().width < NARROW;
    const [open, setOpen] = React.useState(false);
    const running = (tool: ChatTool) => live && tool.outcome === undefined;
    if (tools.length === 1) return <Step tool={tools[0]} running={running(tools[0])} onFullDiff={onFullDiff} onOpenTerminal={onOpenTerminal} />;

    const current = tools.findLast(running);
    const kinds = [...new Set([...(current === undefined ? [] : [current]), ...tools].map((tool) => tool.kind))].slice(0, narrow ? 1 : 3);
    const added = tools.reduce((sum, tool) => sum + (tool.added ?? 0), 0);
    const removed = tools.reduce((sum, tool) => sum + (tool.removed ?? 0), 0);
    const failed = tools.some((tool) => tool.outcome === 'failed');
    const summary = current === undefined ? summaryOf(tools) : `${runningVerb(current)} ${targetOf(current)}`;
    return (
        <View>
            <Row open={open} onPress={() => setOpen(!open)} label={`${tools.length} steps. ${summary}`}>
                <View aria-hidden style={{ flexDirection: 'row' }}>
                    {kinds.map((kind, index) => (
                    // The chat's own ink rings each icon so the overlap reads as a stack.
                    <View key={index} style={{ marginLeft: index === 0 ? -2 : -11, zIndex: kinds.length - index, padding: 2, borderRadius: 10, backgroundColor: ink }}><Glyph kind={kind} /></View>
                ))}
                </View>
                <Text numberOfLines={3} style={{ flex: 1, minWidth: 0, color: theme.colors.text, fontSize: 14.5, lineHeight: 20 }}>{summary}</Text>
                <GroupMeta running={current !== undefined} failed={failed} added={added} removed={removed} count={tools.length} />
            </Row>
            {open && (
                <View style={{ marginLeft: narrow ? 4 : 12, paddingLeft: narrow ? 8 : 12, borderLeftWidth: 1, borderLeftColor: theme.colors.divider }}>
                    {tools.map((tool, index) => <Step key={index} tool={tool} running={running(tool)} onFullDiff={onFullDiff} onOpenTerminal={onOpenTerminal} />)}
                </View>
            )}
        </View>
    );
}

/** The changed lines the host sent; a long edit is capped there. */
function shownChanges(tool: ChatTool): number {
    return (tool.diff ?? []).filter((line) => line.startsWith('+') || line.startsWith('-')).length;
}

/**
 * An edit's whole diff, as far as the host sent it, in a sheet over the chat.
 * It follows the app theme, like every other sheet, though the chat under it
 * stays dark. The theme is resolved the way `unistyles.ts` picks it (the saved
 * preference, else the system's): inside the chat's dark scope both
 * `useUnistyles` and the runtime's theme name answer dark.
 */
export function DiffSheet({ tool, onClose }: { tool: ChatTool | null; onClose: () => void }): React.JSX.Element {
    const insets = useSafeAreaInsets();
    const system = useColorScheme() === 'dark' ? 'dark' : 'light';
    const preference = loadThemePreference();
    const theme = UnistylesRuntime.getTheme(preference === 'adaptive' ? system : preference);
    const changed = tool === null ? 0 : (tool.added ?? 0) + (tool.removed ?? 0);
    return (
        <Modal visible={tool !== null} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
            <View style={{ flex: 1, justifyContent: 'flex-end' }}>
                <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={onClose} style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0, 0, 0, 0.45)' }} />
                {tool !== null && (
                    <MountTheme.Provider value={theme}>
                        <View style={{ width: '100%', maxWidth: 560, maxHeight: '80%', alignSelf: 'center', backgroundColor: theme.colors.groupped.background, borderTopLeftRadius: 24, borderTopRightRadius: 24, overflow: 'hidden', paddingBottom: Math.max(12, insets.bottom) }}>
                            <View style={{ alignItems: 'center', paddingTop: 8 }}>
                                <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: theme.colors.textSecondary, opacity: 0.5 }} />
                            </View>
                            <Text style={{ fontSize: 24, color: theme.colors.text, marginHorizontal: 20, paddingVertical: 12, ...Typography.default('semiBold') }}>{tool.detail?.split('/').pop() ?? tool.verb}</Text>
                            <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 12, gap: 8 }}>
                                {tool.detail !== undefined && <Text selectable style={{ color: theme.colors.textSecondary, fontSize: 13, ...Typography.mono() }}>{tool.detail}</Text>}
                                <View style={{ backgroundColor: theme.colors.code.surface, borderWidth: 1, borderColor: theme.colors.code.hairline, borderRadius: 10, overflow: 'hidden' }}>
                                    <DiffLines lines={tool.diff ?? []} />
                                </View>
                                {shownChanges(tool) < changed && <Text style={{ color: theme.colors.textSecondary, fontSize: 13 }}>
                                    {`Showing ${shownChanges(tool)} of ${changed} changed lines. The rest is in the terminal.`}
                                </Text>}
                            </ScrollView>
                        </View>
                    </MountTheme.Provider>
                )}
            </View>
        </Modal>
    );
}
