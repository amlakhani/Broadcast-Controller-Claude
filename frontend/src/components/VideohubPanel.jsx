import { useEffect, useState } from 'react';
import { ArrowRightLeft, Cable, Lock, Plug, Undo2, Unlock, Waypoints } from 'lucide-react';
import SavedConnections from './SavedConnections';
import { computeStagedDiff, labelFor, normalizeLabel } from './videohubModel';

const inputClass = 'control-field px-3 py-2 text-sm';

const SectionHeader = ({ icon: Icon, title, detail, action }) => (
    <div className="flex items-center justify-between gap-3">
        <div>
            <h3 className="text-[10px] font-bold text-slate-600 dark:text-slate-400 uppercase tracking-[0.2em] flex items-center gap-2">
                {Icon && <Icon className="w-3.5 h-3.5 text-indigo-400" />}
                {title}
            </h3>
            {detail && <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-500">{detail}</p>}
        </div>
        {action}
    </div>
);

const FieldLabel = ({ children }) => (
    <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-wider">{children}</label>
);

// Click to reveal an inline text input; Enter/blur commits, Escape cancels.
// Used for both input and output labels, which the device persists itself.
const EditableLabel = ({ value, onSave, className }) => {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(value);

    if (!editing) {
        return (
            <button
                type="button"
                onClick={e => { e.stopPropagation(); setDraft(value); setEditing(true); }}
                title="Rename"
                className={`text-left truncate hover:underline decoration-dotted decoration-slate-400 ${className || ''}`}
            >
                {value}
            </button>
        );
    }

    const commit = () => {
        setEditing(false);
        const next = normalizeLabel(draft);
        if (next && next !== value) onSave(next);
    };

    return (
        <input
            autoFocus
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onClick={e => e.stopPropagation()}
            onBlur={commit}
            onKeyDown={e => {
                if (e.key === 'Enter') commit();
                if (e.key === 'Escape') setEditing(false);
            }}
            maxLength={20}
            className="control-field px-1.5 py-0.5 text-[11px] w-full"
        />
    );
};

export default function VideohubPanel({ socket }) {
    const [status, setStatus] = useState(null);
    const [settings, setSettings] = useState({ address: '', port: 9990, autoConnect: false, connections: [], activeConnectionId: null });
    const [busy, setBusy] = useState(false);
    const [selectedDest, setSelectedDest] = useState(null);
    const [staged, setStaged] = useState({});
    const [canUndo, setCanUndo] = useState(false);

    useEffect(() => {
        if (!socket) return undefined;
        const handleStatus = (next) => setStatus(next);
        const handleSettings = (next) => setSettings(prev => ({ ...prev, ...next }));

        socket.on('videohub_status_update', handleStatus);
        socket.on('videohub_settings_update', handleSettings);
        socket.emit('videohub_status_request');
        socket.emit('videohub_settings_request', () => {});

        return () => {
            socket.off('videohub_status_update', handleStatus);
            socket.off('videohub_settings_update', handleSettings);
        };
    }, [socket]);

    // Staged-but-uncommitted picks and undo availability don't survive a
    // disconnect — the routing they'd apply to is no longer trustworthy.
    useEffect(() => {
        if (status?.connectionState !== 'connected') {
            setStaged({});
            setSelectedDest(null);
            setCanUndo(false);
        }
    }, [status?.connectionState]);

    const emitAck = (event, payload) => new Promise(resolve => socket?.emit(event, payload, resolve));

    const handleConnect = async (overrides = {}) => {
        const next = { ...settings, ...overrides };
        setSettings(next);
        setBusy(true);
        const saved = await emitAck('videohub_settings_save', next);
        if (!saved?.ok) {
            setBusy(false);
            window.alert(saved?.error || 'Could not save the Videohub address.');
            return;
        }
        await emitAck('videohub_connect', { ...next, connectionId: next.activeConnectionId });
        setBusy(false);
    };

    const handleSelectConnection = (conn) => {
        handleConnect({ address: conn.address, port: conn.port, activeConnectionId: conn.id });
    };

    const handleSaveConnection = async (name) => {
        const newConn = { id: crypto.randomUUID(), name, address: settings.address, port: settings.port };
        const next = { ...settings, connections: [...(settings.connections || []), newConn], activeConnectionId: newConn.id };
        setSettings(next);
        await emitAck('videohub_settings_save', next);
    };

    const handleDeleteConnection = async (id) => {
        const next = {
            ...settings,
            connections: (settings.connections || []).filter(c => c.id !== id),
            activeConnectionId: settings.activeConnectionId === id ? null : settings.activeConnectionId,
        };
        setSettings(next);
        await emitAck('videohub_settings_save', next);
    };

    const handleStageSource = (srcIndex) => {
        if (selectedDest == null) return;
        if (status?.outputs?.[selectedDest]?.locked) return;
        setStaged(prev => ({ ...prev, [selectedDest]: srcIndex }));
    };

    const stagedPairs = computeStagedDiff(status?.outputs || [], staged);

    const handleTake = async () => {
        if (stagedPairs.length === 0) return;
        const result = await emitAck('videohub_take', { pairs: stagedPairs });
        if (!result?.ok) {
            window.alert(result?.error || 'Could not take the route.');
            return;
        }
        setStaged({});
        setCanUndo(true);
    };

    const handleUndo = async () => {
        const result = await emitAck('videohub_undo');
        if (!result?.ok) {
            window.alert(result?.error || 'Nothing to undo.');
            return;
        }
        setCanUndo(false);
    };

    const isConnected = status?.connectionState === 'connected';

    const connectionLabel = {
        idle: 'Not connected',
        connecting: 'Connecting…',
        connected: 'Connected',
        reconnecting: 'Reconnecting…',
        error: 'Connection error',
    }[status?.connectionState || 'idle'];

    const connectionDotClass = {
        idle: 'bg-slate-400',
        connecting: 'bg-amber-400 animate-pulse',
        connected: 'bg-emerald-500',
        reconnecting: 'bg-amber-400 animate-pulse',
        error: 'bg-red-500',
    }[status?.connectionState || 'idle'];

    return (
        <div className="space-y-4">
            {/* Videohub connection */}
            <div className="surface p-3 space-y-3">
                <SectionHeader
                    icon={Plug}
                    title="Blackmagic Videohub Connection"
                    detail="Connects over IP to any Blackmagic Videohub — 20x20, 40x40, or larger."
                    action={(
                        <span className="flex items-center gap-1.5 text-[11px] font-bold text-slate-600 dark:text-slate-300">
                            <span className={`w-2 h-2 rounded-full ${connectionDotClass}`} />
                            {connectionLabel}
                        </span>
                    )}
                />

                <div className="grid grid-cols-1 sm:grid-cols-[1fr_100px] gap-2">
                    <div className="space-y-1">
                        <FieldLabel>Hub address</FieldLabel>
                        <input
                            value={settings.address}
                            onChange={e => setSettings(prev => ({ ...prev, address: e.target.value, activeConnectionId: null }))}
                            placeholder="192.168.1.250"
                            className={inputClass}
                        />
                    </div>
                    <div className="space-y-1">
                        <FieldLabel>Port</FieldLabel>
                        <input
                            type="number"
                            value={settings.port}
                            onChange={e => setSettings(prev => ({ ...prev, port: Number(e.target.value), activeConnectionId: null }))}
                            className={inputClass}
                        />
                    </div>
                </div>

                <SavedConnections
                    connections={settings.connections}
                    activeConnectionId={settings.activeConnectionId}
                    onSelect={handleSelectConnection}
                    onSave={handleSaveConnection}
                    onDelete={handleDeleteConnection}
                />

                <div className="flex flex-wrap items-center gap-2">
                    <button onClick={() => handleConnect()} disabled={busy || !settings.address} className="control-button px-3 py-1.5 text-[11px] font-bold flex items-center gap-1.5 disabled:opacity-40">
                        <Cable className="w-3.5 h-3.5" /> {isConnected ? 'Reconnect' : 'Connect'}
                    </button>
                    <button
                        onClick={() => emitAck('videohub_disconnect')}
                        disabled={!status || status.connectionState === 'idle'}
                        className="control-button-muted px-3 py-1.5 text-[11px] font-bold disabled:opacity-40"
                    >
                        Disconnect
                    </button>
                </div>

                {status?.error && (
                    <p className="text-[11px] text-red-500">{status.error}</p>
                )}
                {isConnected && (
                    <p className="text-[10px] text-slate-500">
                        {status.device?.modelName || 'Videohub'} · {status.device?.videoInputs} inputs · {status.device?.videoOutputs} outputs
                    </p>
                )}
            </div>

            {/* Router */}
            {isConnected && (
                <div className="surface p-3 space-y-3">
                    <SectionHeader
                        icon={Waypoints}
                        title="Crosspoint Router"
                        detail="Select a destination, click a source to stage it, then TAKE to commit."
                        action={(
                            <div className="flex items-center gap-2">
                                <button
                                    onClick={handleUndo}
                                    disabled={!canUndo}
                                    className="control-button-muted px-2.5 py-1.5 text-[11px] font-bold flex items-center gap-1.5 disabled:opacity-40"
                                >
                                    <Undo2 className="w-3.5 h-3.5" /> Undo
                                </button>
                                <button
                                    onClick={handleTake}
                                    disabled={stagedPairs.length === 0}
                                    className="control-button px-3 py-1.5 text-[11px] font-bold flex items-center gap-1.5 disabled:opacity-40"
                                >
                                    <ArrowRightLeft className="w-3.5 h-3.5" /> Take{stagedPairs.length > 0 ? ` (${stagedPairs.length})` : ''}
                                </button>
                            </div>
                        )}
                    />

                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                        {/* Destinations */}
                        <div className="space-y-1.5">
                            <FieldLabel>Destinations</FieldLabel>
                            <div className="space-y-1 max-h-[420px] overflow-y-auto pr-1">
                                {(status.outputs || []).map((out, i) => {
                                    const stagedSrc = staged[i];
                                    const isStaged = stagedSrc !== undefined;
                                    const isSelected = selectedDest === i;
                                    return (
                                        <div
                                            key={out.id}
                                            onClick={() => setSelectedDest(i)}
                                            className={`flex items-center gap-2 rounded-lg border px-2.5 py-2 cursor-pointer transition ${
                                                isSelected ? 'border-blue-500 bg-blue-500/5' : 'border-slate-200 dark:border-slate-700 hover:border-blue-400'
                                            }`}
                                        >
                                            <span className="text-[10px] font-bold text-slate-400 w-6 shrink-0">{i + 1}</span>
                                            <div className="flex-1 min-w-0">
                                                <EditableLabel
                                                    value={out.label}
                                                    onSave={label => emitAck('videohub_rename_output', { index: i, label })}
                                                    className="text-[11px] font-bold text-slate-700 dark:text-slate-200"
                                                />
                                                <div className="text-[10px] text-slate-500 truncate">
                                                    {labelFor(status.inputs, out.source)}
                                                    {isStaged && (
                                                        <span className="text-amber-500 font-bold"> → {labelFor(status.inputs, stagedSrc)}</span>
                                                    )}
                                                </div>
                                            </div>
                                            <button
                                                onClick={e => { e.stopPropagation(); emitAck('videohub_set_lock', { destIndex: i, locked: !out.locked }); }}
                                                title={out.locked ? 'Unlock this output' : 'Lock this output'}
                                                className={`p-1 rounded ${out.locked ? 'text-red-500' : 'text-slate-400 hover:text-slate-600 dark:hover:text-slate-300'}`}
                                            >
                                                {out.locked ? <Lock className="w-3.5 h-3.5" /> : <Unlock className="w-3.5 h-3.5" />}
                                            </button>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>

                        {/* Sources */}
                        <div className="space-y-1.5">
                            <FieldLabel>
                                {selectedDest == null
                                    ? 'Sources — select a destination first'
                                    : `Sources — staging for output ${selectedDest + 1}`}
                            </FieldLabel>
                            <div className="space-y-1 max-h-[420px] overflow-y-auto pr-1">
                                {(status.inputs || []).map((inp, i) => {
                                    const disabled = selectedDest == null || status.outputs?.[selectedDest]?.locked;
                                    const routedTo = (status.outputs || []).filter(o => o.source === i).map(o => o.label);
                                    return (
                                        <div
                                            key={inp.id}
                                            onClick={() => !disabled && handleStageSource(i)}
                                            className={`flex items-center gap-2 rounded-lg border px-2.5 py-2 transition ${
                                                disabled
                                                    ? 'opacity-40 cursor-not-allowed border-slate-200 dark:border-slate-700'
                                                    : 'cursor-pointer border-slate-200 dark:border-slate-700 hover:border-blue-400'
                                            }`}
                                        >
                                            <span className="text-[10px] font-bold text-slate-400 w-6 shrink-0">{i + 1}</span>
                                            <div className="flex-1 min-w-0">
                                                <EditableLabel
                                                    value={inp.label}
                                                    onSave={label => emitAck('videohub_rename_input', { index: i, label })}
                                                    className="text-[11px] font-bold text-slate-700 dark:text-slate-200"
                                                />
                                                <div className="text-[10px] text-slate-500 truncate">
                                                    {routedTo.length > 0 ? `→ ${routedTo.join(', ')}` : 'Not routed'}
                                                </div>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
