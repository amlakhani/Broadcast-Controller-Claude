import { useEffect, useState } from 'react';
import { ArrowRightLeft, Cable, Plug, Waypoints } from 'lucide-react';
import SavedConnections from './SavedConnections';
import { computeStagedDiff } from './videohubModel';
import { auxLabel } from './atemSwitcherModel';

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

const FieldLabel = ({ children, hint }) => (
    <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-wider">
        {children}
        {hint && <span className="ml-1.5 normal-case tracking-normal font-medium text-slate-400">{hint}</span>}
    </label>
);

const Placeholder = ({ children }) => (
    <div className="surface p-6 text-center text-[12px] text-slate-500">{children}</div>
);

export default function AtemSwitcherPanel({ socket }) {
    const [atemStatus, setAtemStatus] = useState(null);
    const [atemSettings, setAtemSettings] = useState({ address: '', port: 9910, autoConnect: false, connections: [], activeConnectionId: null });
    const [atemBusy, setAtemBusy] = useState(false);

    const [selectedAuxBus, setSelectedAuxBus] = useState(null);
    const [stagedAux, setStagedAux] = useState({});

    useEffect(() => {
        if (!socket) return undefined;
        const handleStatus = (status) => setAtemStatus(status);
        const handleSettings = (settings) => setAtemSettings(prev => ({ ...prev, ...settings }));

        socket.on('atem_status_update', handleStatus);
        socket.on('atem_settings_update', handleSettings);
        socket.emit('atem_status_request');
        socket.emit('atem_settings_request', () => {});

        return () => {
            socket.off('atem_status_update', handleStatus);
            socket.off('atem_settings_update', handleSettings);
        };
    }, [socket]);

    // Staged-but-uncommitted aux picks don't survive a disconnect.
    useEffect(() => {
        if (atemStatus?.connectionState !== 'connected') {
            setStagedAux({});
            setSelectedAuxBus(null);
        }
    }, [atemStatus?.connectionState]);

    const emitAck = (event, payload) => new Promise(resolve => socket?.emit(event, payload, resolve));

    const handleAtemConnect = async (overrides = {}) => {
        const next = { ...atemSettings, ...overrides };
        setAtemSettings(next);
        setAtemBusy(true);
        const saved = await emitAck('atem_settings_save', next);
        if (!saved?.ok) {
            setAtemBusy(false);
            window.alert(saved?.error || 'Could not save the switcher address.');
            return;
        }
        await emitAck('atem_connect', { ...next, connectionId: next.activeConnectionId });
        setAtemBusy(false);
    };

    const handleSelectAtemConnection = (conn) => handleAtemConnect({ address: conn.address, port: conn.port, activeConnectionId: conn.id });

    const handleSaveAtemConnection = async (name) => {
        const newConn = { id: crypto.randomUUID(), name, address: atemSettings.address, port: atemSettings.port };
        const next = { ...atemSettings, connections: [...(atemSettings.connections || []), newConn], activeConnectionId: newConn.id };
        setAtemSettings(next);
        await emitAck('atem_settings_save', next);
    };

    const handleDeleteAtemConnection = async (id) => {
        const next = {
            ...atemSettings,
            connections: (atemSettings.connections || []).filter(c => c.id !== id),
            activeConnectionId: atemSettings.activeConnectionId === id ? null : atemSettings.activeConnectionId,
        };
        setAtemSettings(next);
        await emitAck('atem_settings_save', next);
    };

    const isConnected = atemStatus?.connectionState === 'connected';
    // Aux-availability-filtered — includes ME outputs, monitor feeds, etc. that
    // the SuperSource-box-filtered `inputs` list (used elsewhere) excludes.
    const auxSources = atemStatus?.auxSources || [];
    // ATEM source ids are protocol ids (1, 2, ... 1000=Color Bars, 2001=Media Player 1, ...),
    // not contiguous array indices — always look sources up by id, never by position.
    const sourceLabelById = (id) => {
        if (id == null) return '—';
        const source = auxSources.find(s => s.id === id);
        return source?.longName || source?.shortName || `Input ${id}`;
    };
    const auxCount = atemStatus?.device?.auxCount || 0;
    // The device's own (renameable) name for the bus, e.g. "Confidence Monitor" —
    // falls back to a generic "AUX N" only when the device hasn't reported one.
    const auxBusLabel = (i) => atemStatus?.auxBusNames?.[i] || auxLabel(i);

    const connectionLabel = {
        idle: 'Not connected', connecting: 'Connecting…', connected: 'Connected',
        reconnecting: 'Reconnecting…', error: 'Connection error',
    }[atemStatus?.connectionState || 'idle'];

    const connectionDotClass = {
        idle: 'bg-slate-400', connecting: 'bg-amber-400 animate-pulse', connected: 'bg-emerald-500',
        reconnecting: 'bg-amber-400 animate-pulse', error: 'bg-red-500',
    }[atemStatus?.connectionState || 'idle'];

    // --- Router (BM Constellation Router) -----------------------------------
    const auxOutputs = (atemStatus?.auxiliaries || []).map(source => ({ source }));
    const stagedPairsRaw = computeStagedDiff(auxOutputs, stagedAux);
    const handleStageAuxSource = (srcIndex) => {
        if (selectedAuxBus == null) return;
        setStagedAux(prev => ({ ...prev, [selectedAuxBus]: srcIndex }));
    };
    const handleTakeAux = async () => {
        if (stagedPairsRaw.length === 0) return;
        const failures = [];
        for (const { destIndex, srcIndex } of stagedPairsRaw) {
            const result = await emitAck('atem_set_aux', { source: srcIndex, bus: destIndex });
            if (!result?.ok) failures.push(`${auxBusLabel(destIndex)}: ${result?.error || 'unknown error'}`);
        }
        // Leave everything staged on any failure (surfaced via the alert above)
        // instead of clearing and silently reverting to whatever the switcher
        // already had — the previous bug was exactly that silent revert.
        if (failures.length > 0) {
            window.alert(`Could not take ${failures.length} route(s):\n${failures.join('\n')}`);
        } else {
            setStagedAux({});
        }
    };

    return (
        <div className="space-y-4">
            {/* Connection */}
            <div className="surface p-3 space-y-3">
                <SectionHeader
                    icon={Plug}
                    title="Blackmagic ATEM Connection"
                    detail="Same switcher as SuperSource Designer — PiP box layout lives there; this page is the built-in router."
                    action={(
                        <span className="flex items-center gap-1.5 text-[11px] font-bold text-slate-600 dark:text-slate-300">
                            <span className={`w-2 h-2 rounded-full ${connectionDotClass}`} />
                            {connectionLabel}
                        </span>
                    )}
                />

                <div className="grid grid-cols-1 sm:grid-cols-[1fr_100px] gap-2">
                    <div className="space-y-1">
                        <FieldLabel>Switcher address</FieldLabel>
                        <input
                            value={atemSettings.address}
                            onChange={e => setAtemSettings(prev => ({ ...prev, address: e.target.value, activeConnectionId: null }))}
                            placeholder="192.168.1.240"
                            className={inputClass}
                        />
                    </div>
                    <div className="space-y-1">
                        <FieldLabel>Port</FieldLabel>
                        <input
                            type="number"
                            value={atemSettings.port}
                            onChange={e => setAtemSettings(prev => ({ ...prev, port: Number(e.target.value), activeConnectionId: null }))}
                            className={inputClass}
                        />
                    </div>
                </div>

                <SavedConnections
                    connections={atemSettings.connections}
                    activeConnectionId={atemSettings.activeConnectionId}
                    onSelect={handleSelectAtemConnection}
                    onSave={handleSaveAtemConnection}
                    onDelete={handleDeleteAtemConnection}
                />

                <div className="flex flex-wrap items-center gap-2">
                    <button onClick={() => handleAtemConnect()} disabled={atemBusy || !atemSettings.address} className="control-button px-3 py-1.5 text-[11px] font-bold flex items-center gap-1.5 disabled:opacity-40">
                        <Cable className="w-3.5 h-3.5" /> {isConnected ? 'Reconnect' : 'Connect'}
                    </button>
                    <button
                        onClick={() => emitAck('atem_disconnect')}
                        disabled={!atemStatus || atemStatus.connectionState === 'idle'}
                        className="control-button-muted px-3 py-1.5 text-[11px] font-bold disabled:opacity-40"
                    >
                        Disconnect
                    </button>
                </div>

                {atemStatus?.error && <p className="text-[11px] text-red-500">{atemStatus.error}</p>}
                {isConnected && (
                    <p className="text-[10px] text-slate-500">
                        {atemStatus.device?.productName || atemStatus.device?.model} · {auxCount} AUX · {auxSources.length} sources
                    </p>
                )}
            </div>

            {!isConnected && <Placeholder>Connect to a switcher to control the router.</Placeholder>}

            {isConnected && auxCount > 0 && (
                <div className="surface p-3 space-y-3">
                    <SectionHeader
                        icon={Waypoints}
                        title="BM Constellation Router"
                        detail="Select an AUX bus, click a source to stage it, then TAKE to commit."
                        action={(
                            <button
                                onClick={handleTakeAux}
                                disabled={stagedPairsRaw.length === 0}
                                className="control-button px-3 py-1.5 text-[11px] font-bold flex items-center gap-1.5 disabled:opacity-40"
                            >
                                <ArrowRightLeft className="w-3.5 h-3.5" /> Take{stagedPairsRaw.length > 0 ? ` (${stagedPairsRaw.length})` : ''}
                            </button>
                        )}
                    />

                    <div className="flex flex-wrap items-center gap-3 text-[10px] font-bold text-slate-500">
                        <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-blue-500" /> Selected</span>
                        <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-emerald-500" /> Current</span>
                        <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-amber-500" /> Staged</span>
                    </div>

                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                        {/* Destinations */}
                        <div className="space-y-1.5">
                            <FieldLabel>AUX buses (destinations)</FieldLabel>
                            <div className="grid grid-cols-2 xl:grid-cols-3 gap-2 max-h-[420px] overflow-y-auto pr-1 content-start">
                                {Array.from({ length: auxCount }).map((_, i) => {
                                    const stagedSrc = stagedAux[i];
                                    const isStaged = stagedSrc !== undefined;
                                    const isSelected = selectedAuxBus === i;
                                    return (
                                        <button
                                            key={i}
                                            type="button"
                                            onClick={() => setSelectedAuxBus(i)}
                                            className={`relative text-left rounded-lg border p-2.5 transition ${
                                                isSelected
                                                    ? 'border-blue-500 ring-2 ring-blue-500 bg-blue-500/10'
                                                    : isStaged
                                                        ? 'border-amber-400/70 hover:border-amber-400 bg-amber-500/5'
                                                        : 'border-slate-200 dark:border-slate-700 hover:border-blue-400'
                                            }`}
                                        >
                                            {isStaged && !isSelected && <span className="absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full bg-amber-500" />}
                                            <div className="text-[10px] font-bold text-slate-400">{i + 1}</div>
                                            <div className="text-[11px] font-bold text-slate-700 dark:text-slate-200 truncate">{auxBusLabel(i)}</div>
                                            <div className="text-[10px] text-slate-500 truncate mt-0.5">
                                                {sourceLabelById(atemStatus.auxiliaries?.[i])}
                                            </div>
                                            {isStaged && (
                                                <div className="text-[10px] text-amber-600 dark:text-amber-400 font-bold truncate">
                                                    → {sourceLabelById(stagedSrc)}
                                                </div>
                                            )}
                                        </button>
                                    );
                                })}
                            </div>
                        </div>

                        {/* Sources */}
                        <div className="space-y-1.5">
                            <FieldLabel>{selectedAuxBus == null ? 'Sources — select an AUX bus first' : `Sources — staging for ${auxBusLabel(selectedAuxBus)}`}</FieldLabel>
                            <div className="grid grid-cols-2 xl:grid-cols-3 gap-2 max-h-[420px] overflow-y-auto pr-1 content-start">
                                {auxSources.map((source) => {
                                    const disabled = selectedAuxBus == null;
                                    const isCurrent = !disabled && atemStatus.auxiliaries?.[selectedAuxBus] === source.id;
                                    const isStaged = !disabled && stagedAux[selectedAuxBus] === source.id;
                                    return (
                                        <button
                                            key={source.id}
                                            type="button"
                                            disabled={disabled}
                                            onClick={() => handleStageAuxSource(source.id)}
                                            className={`relative text-left rounded-lg border p-2.5 transition ${
                                                disabled
                                                    ? 'opacity-40 cursor-not-allowed border-slate-200 dark:border-slate-700'
                                                    : isStaged
                                                        ? 'border-amber-500 ring-2 ring-amber-500 bg-amber-500/10 cursor-pointer'
                                                        : isCurrent
                                                            ? 'border-emerald-500 ring-2 ring-emerald-500 bg-emerald-500/10 cursor-pointer'
                                                            : 'border-slate-200 dark:border-slate-700 hover:border-blue-400 cursor-pointer'
                                            }`}
                                        >
                                            <div className="text-[11px] font-bold text-slate-700 dark:text-slate-200 truncate pr-4">
                                                {source.longName || source.shortName || `Input ${source.id}`}
                                            </div>
                                            {(isCurrent || isStaged) && (
                                                <div className={`text-[9px] font-bold uppercase tracking-wider mt-0.5 ${isStaged ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
                                                    {isStaged ? 'Staged' : 'Current'}
                                                </div>
                                            )}
                                        </button>
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
