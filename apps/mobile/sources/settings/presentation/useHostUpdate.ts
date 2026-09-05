import * as React from 'react';
import { MMKV } from 'react-native-mmkv';
import type { RequestResult } from '@muxr/contract';
import { sync } from '@/catalog/sync';
import { getCachedConnectionSettings } from '@/connection';
import { Modal } from '@/modal';

const saved = new MMKV();
const pending = new Set(['queued', 'updating', 'rolling-back']);
/** Persist the plan before applying: the host may restart before its reply arrives. */
export function useHostUpdate(appVersion: string) {
    const machine = getCachedConnectionSettings().machineId;
    const key = `host-update-plan:${machine}`;
    const [result, setResult] = React.useState<RequestResult<'host.update'>>();
    const [message, setMessage] = React.useState<string>();
    const [busy, setBusy] = React.useState(false);
    const operating = React.useRef(false);
    const refreshing = React.useRef(false);
    const current = React.useRef(machine); current.current = machine;
    const alive = React.useRef(true);
    React.useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
    const relevant = () => alive.current && current.current === machine && getCachedConnectionSettings().machineId === machine;
    const refresh = React.useCallback(async () => {
        const planId = saved.getString(key);
        if (!planId || operating.current || refreshing.current) return;
        refreshing.current = true;
        try {
            const next = await sync.request('host.update', { action: 'status', planId });
            if (!relevant()) return;
            setResult(next); setMessage(next.message);
            if (!pending.has(next.status)) saved.delete(key);
        } catch { if (relevant()) setMessage('Waiting for the host. Your update record is saved; check again after it reconnects.'); }
        finally { refreshing.current = false; }
    }, [machine, key]);
    React.useEffect(() => {
        setResult(undefined); setMessage(undefined); setBusy(false);
        void refresh();
        const timer = setInterval(() => { if (saved.getString(key)) void refresh(); }, 5000);
        return () => clearInterval(timer);
    }, [key, refresh]);
    const check = async () => {
        if (busy) return;
        if (saved.getString(key)) { await refresh(); return; }
        setBusy(true); operating.current = true;
        try {
            const plan = await sync.request('host.update', { action: 'plan', appVersion, protocol: 1 });
            if (!relevant()) return;
            setResult(plan); setMessage(plan.message);
            if (!plan.canApply || !plan.planId) return;
            const confirmed = await Modal.confirm('Keep this app and align the host?',
                `${plan.message}\n\nHost ${plan.currentVersion} → ${plan.targetVersion}. The host retains a private state snapshot and tries to restore the previous package if startup fails.`,
                { confirmText: 'Align host', destructive: false });
            if (!confirmed || !relevant()) return;
            saved.set(key, plan.planId);
            setMessage('Aligning host. The connection may pause while it restarts.');
            const next = await sync.request('host.update', { action: 'apply', planId: plan.planId });
            if (relevant()) { setResult(next); setMessage(next.message); }
        } catch (error) {
            if (relevant()) setMessage(saved.getString(key) ? 'Update requested. Waiting for the host to reconnect; check its saved result shortly.'
                : error instanceof Error ? error.message : 'Host compatibility could not be checked. Try again.');
        } finally { operating.current = false; if (relevant()) setBusy(false); }
    };
    return { check, busy: busy || !!result && pending.has(result.status), message, compatible: result?.compatible };
}
