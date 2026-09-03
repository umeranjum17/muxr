/**
 * Deterministic herd the host can snapshot. Ids follow the live Herdr
 * `workspace:pane` shape (`w1:p1`) so Agent Routes and close-guards bind.
 */

const KINDS = ['pi', 'claude', 'codex', 'gemini'];
const KIND_LABEL = { pi: 'Pi', claude: 'Claude', codex: 'Codex', gemini: 'Gemini' };
const TAB_LABELS = ['main', 'review', 'shell', 'scratch'];
const PANES_PER_TAB = 4;
const COLS = 80;
const ROWS = 24;

export function createWorld({
    panes = 8,
    agents = 4,
    cwd = '/tmp/fake-herdr',
    terminalBytesPerSecond = 4096,
} = {}) {
    const paneCount = Math.max(0, Number(panes) || 0);
    const agentCount = Math.min(paneCount, Math.max(0, Number(agents) || 0));
    const workspace = {
        workspace_id: 'w1',
        label: cwd,
        focused: true,
        worktree: {
            repo_key: 'fake-herdr',
            repo_name: 'fake-herdr',
            repo_root: cwd,
            checkout_path: cwd,
            is_linked_worktree: false,
        },
    };

    const tabs = [];
    const paneRecords = [];
    const agentRecords = [];
    const tabCount = paneCount === 0 ? 1 : Math.ceil(paneCount / PANES_PER_TAB);
    for (let tabIndex = 0; tabIndex < tabCount; tabIndex += 1) {
        tabs.push({
            tab_id: `w1:t${tabIndex + 1}`,
            workspace_id: 'w1',
            label: TAB_LABELS[tabIndex % TAB_LABELS.length],
        });
    }

    for (let index = 0; index < paneCount; index += 1) {
        const paneNum = index + 1;
        const tabIndex = Math.floor(index / PANES_PER_TAB);
        const tab = tabs[tabIndex];
        const indexInTab = index % PANES_PER_TAB;
        const panesInTab = Math.min(PANES_PER_TAB, paneCount - tabIndex * PANES_PER_TAB);
        const isAgent = index < agentCount;
        const kind = KINDS[index % KINDS.length];
        const name = isAgent
            ? `${KIND_LABEL[kind]} ${Math.floor(index / KINDS.length) + 1}`
            : 'zsh';
        const title = isAgent ? `${kind} · ${name}` : `zsh · ${basenameLabel(cwd)}`;
        paneRecords.push({
            pane_id: `w1:p${paneNum}`,
            tab_id: tab.tab_id,
            workspace_id: 'w1',
            cwd,
            foreground_cwd: cwd,
            ...(isAgent ? { agent_status: 'idle' } : {}),
            terminal_title: title,
            terminal_title_stripped: title,
            label: name,
            focused: index === 0,
            tokens: {},
            rect: paneRect(indexInTab, panesInTab),
        });
        if (isAgent) {
            agentRecords.push(agentRecord({
                paneId: `w1:p${paneNum}`,
                tabId: tab.tab_id,
                workspaceId: 'w1',
                cwd,
                name,
                kind,
                value: `gen-${paneNum}`,
                title,
            }));
        }
    }

    return {
        workspaceId: 'w1',
        cwd,
        terminalBytesPerSecond,
        workspaces: [workspace],
        tabs,
        panes: paneRecords,
        agents: agentRecords,
    };
}

export function agentRecord({ paneId, tabId, workspaceId, cwd, name, kind, value, title, status = 'idle' }) {
    return {
        pane_id: paneId,
        tab_id: tabId,
        workspace_id: workspaceId,
        cwd,
        foreground_cwd: cwd,
        name,
        agent: kind,
        display_agent: name,
        agent_status: status,
        interactive_ready: true,
        launch_pending: false,
        title,
        terminal_title: title,
        terminal_title_stripped: title,
        agent_session: {
            source: `herdr:${kind}`,
            agent: kind,
            kind: 'id',
            value,
        },
    };
}

export function paneRect(indexInTab, panesInTab) {
    const height = Math.max(1, Math.floor(ROWS / panesInTab));
    const y = indexInTab * height;
    return {
        x: 0,
        y,
        width: COLS,
        height: indexInTab === panesInTab - 1 ? ROWS - y : height,
    };
}

export function relayoutTab(world, tabId) {
    const panes = world.panes.filter((pane) => pane.tab_id === tabId);
    panes.forEach((pane, index) => {
        pane.rect = paneRect(index, panes.length);
    });
}

export function freezeWorld(world) {
    return freezeDeep(structuredClone(world));
}

export function displayName(kind, requested) {
    if (typeof requested === 'string' && requested.length > 0 && !/^pph?_/i.test(requested)) {
        return requested;
    }
    return KIND_LABEL[kind] ?? kind ?? 'Agent';
}

function basenameLabel(cwd) {
    const parts = cwd.replace(/\/+$/, '').split('/');
    return parts[parts.length - 1] || cwd;
}

function freezeDeep(value) {
    if (Array.isArray(value)) {
        for (const item of value) freezeDeep(item);
        return Object.freeze(value);
    }
    if (value !== null && typeof value === 'object') {
        for (const key of Object.keys(value)) freezeDeep(value[key]);
        return Object.freeze(value);
    }
    return value;
}
