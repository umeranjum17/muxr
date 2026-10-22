import * as React from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Ionicons, Octicons } from '@expo/vector-icons';
import type { ChatTool, ChatToolKind } from '@trymuxr/contract';
import { Typography } from '@/constants/Typography';

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
    const { theme } = useUnistyles();
    return (
        <View style={{ width: 26, height: 26, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.surfaceHigh, borderWidth: 1, borderColor: theme.colors.divider }}>
            <Octicons name={kind === undefined ? 'gear' : GLYPH[kind]} size={14} color={theme.colors.textSecondary} />
        </View>
    );
}

/**
 * Mono text cut in the middle: the head gives way first, so a file's name
 * and a command's last words stay in view. Two texts, because only the tail
 * mode of `ellipsizeMode` works on the web.
 */
function MiddleText({ text, path, color }: { text: string; path: boolean; color: string }): React.JSX.Element {
    const split = path ? text.lastIndexOf('/') + 1 : Math.max(0, text.length - 12);
    const style = { color, fontSize: 13.5, ...Typography.mono() };
    if (split === 0) return <Text numberOfLines={1} style={[style, { flexShrink: 1, minWidth: 0 }]}>{text}</Text>;
    return (
        <View style={{ flexDirection: 'row', flexShrink: 1, minWidth: 0 }}>
            <Text numberOfLines={1} style={[style, { flexShrink: 1000, minWidth: 0 }]}>{text.slice(0, split)}</Text>
            <Text numberOfLines={1} style={[style, { flexShrink: 1, minWidth: 0 }]}>{text.slice(split)}</Text>
        </View>
    );
}

/** Colour only where it means something: lines added and removed, a failure, a step still running. */
function Meta({ tool, running }: { tool: ChatTool; running: boolean }): React.JSX.Element | null {
    const { theme } = useUnistyles();
    const small = { fontSize: 12.5 };
    if (running) return <ActivityIndicator size="small" color={theme.colors.textSecondary} style={{ transform: [{ scale: 0.75 }] }} />;
    if (tool.outcome === 'failed') return <Text style={[small, { color: theme.colors.diff.error }]}>failed</Text>;
    if (tool.added !== undefined) return <Stat added={tool.added} removed={tool.removed ?? 0} />;
    if (tool.kind === 'run' && tool.outcome === 'ok') return <Ionicons name="checkmark" size={16} color={theme.colors.diff.success} />;
    if (tool.note !== undefined && tool.kind !== 'plan') return <Text numberOfLines={1} style={[small, { color: theme.colors.textSecondary }]}>{tool.note}</Text>;
    return null;
}

function Stat({ added, removed }: { added: number; removed: number }): React.JSX.Element {
    const { theme } = useUnistyles();
    return (
        <View style={{ flexDirection: 'row', gap: 5 }}>
            <Text style={{ fontSize: 12.5, color: theme.colors.diff.success }}>+{added}</Text>
            {removed > 0 && <Text style={{ fontSize: 12.5, color: theme.colors.diff.error }}>−{removed}</Text>}
        </View>
    );
}

/** A tappable row: 44 dp tall, its chevron turning as it opens. */
function Row({ open, onPress, label, children }: { open: boolean; onPress: () => void; label: string; children: React.ReactNode }): React.JSX.Element {
    const { theme } = useUnistyles();
    return (
        <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ expanded: open }}
            style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44, paddingHorizontal: 2, borderRadius: 10, backgroundColor: pressed ? theme.colors.surfaceHigh : 'transparent' })}>
            {children}
            <Ionicons name="chevron-forward" size={13} color={theme.colors.textSecondary} style={{ transform: [{ rotate: open ? '90deg' : '0deg' }] }} />
        </Pressable>
    );
}

/** Diff lines in the code panel's colours, numbered from the hunk headers Claude's own patch carries. */
export function DiffLines({ lines }: { lines: string[] }): React.JSX.Element {
    const { theme } = useUnistyles();
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
                    const mark = line.charAt(0);
                    const numbered = oldLine > 0;
                    const number = mark === '-' ? oldLine++ : mark === '+' ? newLine++ : (oldLine++, newLine++);
                    return (
                        <View key={index} style={{ flexDirection: 'row', paddingRight: 10, backgroundColor: mark === '+' ? code.addedBg : mark === '-' ? code.removedBg : 'transparent' }}>
                            {numbered && <Text style={[text, { width: 34, textAlign: 'right', paddingRight: 6, color: code.dim }]}>{number}</Text>}
                            <Text style={[text, { width: 16, textAlign: 'center', color: mark === '+' ? code.addedMark : mark === '-' ? code.removedMark : code.dim }]}>{mark === '-' ? '−' : mark === '+' ? '+' : ''}</Text>
                            <Text style={text}>{line.slice(1)}</Text>
                        </View>
                    );
                })}
            </View>
        </ScrollView>
    );
}

function Panel({ caption, footer, children }: { caption?: React.ReactNode; footer?: React.ReactNode; children: React.ReactNode }): React.JSX.Element {
    const { theme } = useUnistyles();
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
    const { theme } = useUnistyles();
    return (
        <Pressable onPress={onPress} accessibilityRole="button" hitSlop={4} style={({ pressed }) => ({ minHeight: 44, justifyContent: 'center', paddingHorizontal: 10, opacity: pressed ? 0.6 : 1 })}>
            <Text style={{ color: theme.colors.code.number, fontSize: 13 }}>{label} ›</Text>
        </Pressable>
    );
}

/** What a step opens to, in place: its diff, its output, its checklist, or its whole target. */
function Peek({ tool, onFullDiff, onOpenTerminal }: { tool: ChatTool; onFullDiff: (tool: ChatTool) => void; onOpenTerminal: () => void }): React.JSX.Element {
    const { theme } = useUnistyles();
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
                    <Text style={dim}>{tool.kind === 'write' ? 'New file' : `${changed} line${changed === 1 ? '' : 's'} changed`}</Text>
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
                <Text style={dim}>{tool.exit === undefined ? (tool.outcome === 'failed' ? 'Failed' : 'Done') : `Exit ${tool.exit}`}</Text>
                <FooterLink label="Open terminal" onPress={onOpenTerminal} />
            </> : undefined}>
                <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                    <View style={{ padding: 10, paddingVertical: 8 }}>
                        {tool.kind === 'run' && <Text style={[text, { color: code.text }]}>$ {tool.detail}</Text>}
                        {tool.output.map((line, index) => <Text key={index} style={[text, { color: tool.outcome === 'failed' ? code.removedMark : code.dim }]}>{line}</Text>)}
                    </View>
                </ScrollView>
            </Panel>
        );
    }
    return <Text selectable style={{ color: theme.colors.textSecondary, fontSize: 13.5, lineHeight: 20, ...(MONO_KINDS.has(tool.kind) ? Typography.mono() : {}) }}>{tool.detail ?? 'Nothing more to show for this step.'}</Text>;
}

function Step({ tool, running, onFullDiff, onOpenTerminal }: { tool: ChatTool; running: boolean; onFullDiff: (tool: ChatTool) => void; onOpenTerminal: () => void }): React.JSX.Element {
    const { theme } = useUnistyles();
    const narrow = useWindowDimensions().width < NARROW;
    const [open, setOpen] = React.useState(false);
    const target = targetOf(tool);
    const mono = MONO_KINDS.has(tool.kind);
    return (
        <View>
            <Row open={open} onPress={() => setOpen(!open)} label={`${verbOf(tool)} ${target}${running ? ', running' : tool.outcome === 'failed' ? ', failed' : ''}`}>
                <Glyph kind={tool.kind} />
                <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
                    <Text numberOfLines={1} style={{ flexShrink: 0, color: theme.colors.textSecondary, fontSize: 14.5 }}>{verbOf(tool)}</Text>
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

/** "Edited 2 files, read 1 file, ran 1 command": the three kinds that matter most, in that order. */
function summaryOf(tools: ChatTool[]): string {
    const count = (kinds: Array<ChatToolKind | undefined>) => tools.filter((tool) => kinds.includes(tool.kind)).length;
    const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
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
    const shown = parts.slice(0, 3).join(', ') + (parts.length > 3 ? ` +${parts.length - 3}` : '');
    return shown.charAt(0).toUpperCase() + shown.slice(1);
}

/**
 * A reply's tool calls. One call is its own row; several fold into one row
 * that opens in place. `live` is the newest reply of an agent still working:
 * its unanswered calls are the ones running.
 */
export function ChatSteps({ tools, live, ink, onFullDiff, onOpenTerminal }: { tools: ChatTool[]; live: boolean; ink: string; onFullDiff: (tool: ChatTool) => void; onOpenTerminal: () => void }): React.JSX.Element {
    const { theme } = useUnistyles();
    const narrow = useWindowDimensions().width < NARROW;
    const [open, setOpen] = React.useState(false);
    const running = (tool: ChatTool) => live && tool.outcome === undefined;
    if (tools.length === 1) return <Step tool={tools[0]} running={running(tools[0])} onFullDiff={onFullDiff} onOpenTerminal={onOpenTerminal} />;

    const current = tools.findLast(running);
    const kinds = [...new Set([...(current === undefined ? [] : [current]), ...tools].map((tool) => tool.kind))].slice(0, narrow ? 1 : 3);
    const added = tools.reduce((sum, tool) => sum + (tool.added ?? 0), 0);
    const removed = tools.reduce((sum, tool) => sum + (tool.removed ?? 0), 0);
    const failed = tools.some((tool) => tool.outcome === 'failed');
    const summary = current === undefined ? summaryOf(tools) : `${current.kind === 'run' ? 'Running' : verbOf(current)} ${targetOf(current)}`;
    return (
        <View>
            <Row open={open} onPress={() => setOpen(!open)} label={`${tools.length} steps. ${summary}`}>
                <View style={{ flexDirection: 'row' }}>
                    {kinds.map((kind, index) => (
                    // The chat's own ink rings each icon so the overlap reads as a stack.
                    <View key={index} style={{ marginLeft: index === 0 ? -2 : -11, zIndex: kinds.length - index, padding: 2, borderRadius: 10, backgroundColor: ink }}><Glyph kind={kind} /></View>
                ))}
                </View>
                <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, color: theme.colors.text, fontSize: 14.5 }}>{summary}</Text>
                {current !== undefined
                    ? <ActivityIndicator size="small" color={theme.colors.textSecondary} style={{ transform: [{ scale: 0.75 }] }} />
                    : failed
                        ? <Text style={{ fontSize: 12.5, color: theme.colors.diff.error }}>failed</Text>
                        : added + removed > 0
                            ? <Stat added={added} removed={removed} />
                            : <Text style={{ fontSize: 12.5, color: theme.colors.textSecondary }}>{tools.length} steps</Text>}
            </Row>
            {open && (
                <View style={{ marginLeft: narrow ? 4 : 12, paddingLeft: narrow ? 8 : 12, borderLeftWidth: 1, borderLeftColor: theme.colors.divider }}>
                    {tools.map((tool, index) => <Step key={index} tool={tool} running={running(tool)} onFullDiff={onFullDiff} onOpenTerminal={onOpenTerminal} />)}
                </View>
            )}
        </View>
    );
}
