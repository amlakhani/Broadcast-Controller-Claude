import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Box, Cable, Crop, LayoutGrid, Paintbrush, Plug, RotateCcw, Save, Trash2 } from 'lucide-react';
import {
    ART_OPTIONS,
    ASPECT_PRESETS,
    ATEM_BOX_LIMITS,
    BOX_COUNT,
    DEFAULT_SUPERSOURCE_DOC,
    STAGE_HEIGHT,
    STAGE_WIDTH,
    SUPERSOURCE_DOC_KEY,
    SUPERSOURCE_PRESETS,
    SUPERSOURCE_PRESETS_KEY,
    applyPreset,
    atemBoxToDoc,
    boxToStageRect,
    boxToVisibleRect,
    createPresetFromDoc,
    cropForAspect,
    diffBoxesForAtem,
    interpolateDoc,
    matchAspectPreset,
    normalizeSuperSourceDoc,
    stageRectToBox,
} from './superSourceModel';
import { ATEM_MODEL_PROFILES } from './atemModels';
import SavedConnections from './SavedConnections';
import {
    deferUntilIdle,
    readLocalStorageArraySafe,
    readLocalStorageObjectSafe,
    useDebouncedLocalStorageEffect,
} from '../utils/performance';

const SNAP_PX = 12;
const ASPECT = STAGE_HEIGHT / STAGE_WIDTH;

// Hardware does an instant cut on box changes — there's no tween in the protocol.
// This is how long the app spends streaming interpolated keyframes to fake a
// smooth move, both in the local preview and (once armed) on the real switcher.
const PRESET_TRANSITION_MS = 450;

function docReducer(state, action) {
    switch (action.type) {
        case 'patch_box':
            return normalizeSuperSourceDoc({
                ...state,
                boxes: state.boxes.map((box, i) => (i === action.index ? { ...box, ...action.values } : box)),
            });
        case 'patch_background':
            return normalizeSuperSourceDoc({ ...state, background: { ...state.background, ...action.values } });
        case 'load':
            return normalizeSuperSourceDoc(action.doc);
        default:
            return state;
    }
}

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

const inputClass = 'control-field px-3 py-2 text-sm';
const compactInputClass = 'control-field px-2 py-1.5 text-xs';

const Slider = ({ label, hint, value, min, max, step = 1, format, onChange }) => (
    <div className="space-y-1">
        <div className="flex items-baseline justify-between gap-2">
            <FieldLabel hint={hint}>{label}</FieldLabel>
            <span className="text-[11px] font-mono text-slate-500 tabular-nums">{format ? format(value) : value}</span>
        </div>
        <input
            type="range"
            min={min}
            max={max}
            step={step}
            value={value}
            onChange={e => onChange(Number(e.target.value))}
            className="w-full accent-blue-600"
        />
    </div>
);

const Toggle = ({ label, checked, onChange }) => (
    <label className="flex items-center gap-2 text-xs font-semibold text-slate-600 dark:text-slate-300 cursor-pointer">
        <input type="checkbox" checked={!!checked} onChange={e => onChange(e.target.checked)} className="accent-blue-600" />
        <span>{label}</span>
    </label>
);

// Plain labelled rectangle — no shape, no video preview. This app doesn't render
// SuperSource; the switcher does. The canvas exists purely so the operator can
// see where a box sits while dragging/resizing/cropping it.
const BoxRect = ({ rect, label, selected, onPointerDown }) => (
    <div
        onPointerDown={onPointerDown}
        className={`absolute flex items-end justify-start p-1 cursor-move ${
            selected ? 'bg-blue-500/25 ring-2 ring-blue-400' : 'bg-blue-500/10 ring-1 ring-white/40 hover:ring-white/70'
        }`}
        style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
    >
        <span className="text-[10px] font-bold text-white/90 drop-shadow px-1 bg-black/50 rounded truncate max-w-full">
            {label}
        </span>
    </div>
);

export default function SuperSourcePanel({ socket, isActive }) {
    const [doc, dispatch] = useReducer(docReducer, undefined, () => normalizeSuperSourceDoc(DEFAULT_SUPERSOURCE_DOC));
    const [selectedBox, setSelectedBox] = useState(0);
    const [canvasScale, setCanvasScale] = useState(0);
    const [guides, setGuides] = useState({ x: null, y: null });
    const [customPresets, setCustomPresets] = useState([]);
    const [presetNameInput, setPresetNameInput] = useState('');
    const [atemStatus, setAtemStatus] = useState(null);
    const [atemSettings, setAtemSettings] = useState({ address: '', port: 9910, autoConnect: false, connections: [], activeConnectionId: null });
    const [atemBusy, setAtemBusy] = useState(false);

    const lastPushedRef = useRef(null);
    const transitionTokenRef = useRef(0);

    const canvasRef = useRef(null);
    const dragRef = useRef(null);
    const hydratedRef = useRef(false);

    const box = doc.boxes[selectedBox];

    // Restore the last layout, then keep persisting it. Deferred so opening the
    // app doesn't pay for it on the critical path. Lives purely in localStorage —
    // there is nothing else in the app for this document to sync to.
    useEffect(() => deferUntilIdle(() => {
        const stored = readLocalStorageObjectSafe(SUPERSOURCE_DOC_KEY, null);
        if (stored) dispatch({ type: 'load', doc: stored });
        setCustomPresets(readLocalStorageArraySafe(SUPERSOURCE_PRESETS_KEY));
        hydratedRef.current = true;
    }), []);

    useDebouncedLocalStorageEffect(SUPERSOURCE_DOC_KEY, doc);
    useDebouncedLocalStorageEffect(SUPERSOURCE_PRESETS_KEY, customPresets);

    // Measure the canvas so stage px can be converted to screen px and back.
    useEffect(() => {
        const el = canvasRef.current;
        if (!el || !isActive) return undefined;
        const measure = () => setCanvasScale(el.clientWidth / STAGE_WIDTH);
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(el);
        return () => observer.disconnect();
    }, [isActive]);

    // ATEM status + persisted connection settings.
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

    // The only place this document goes: straight to the switcher, when armed.
    // diffBoxesForAtem does the field diff; atem_service does the time coalescing.
    useEffect(() => {
        if (!socket || !atemStatus?.armed || atemStatus.connectionState !== 'connected') return;
        const patches = diffBoxesForAtem(lastPushedRef.current, doc, {
            boxCount: atemStatus.device?.boxCounts?.[doc.ssrcId] ?? 4,
        });
        lastPushedRef.current = doc;
        if (patches.length === 0) return;
        socket.emit('atem_push_boxes', { patches, ssrcId: doc.ssrcId });
    }, [socket, doc, atemStatus]);

    // Disarming, or losing the connection, invalidates the "what the switcher last
    // saw" baseline — the next arm must re-send everything.
    useEffect(() => {
        if (!atemStatus?.armed || atemStatus.connectionState !== 'connected') lastPushedRef.current = null;
    }, [atemStatus?.armed, atemStatus?.connectionState]);

    // Live capabilities always win once connected — the static model matrix is for
    // offline design only.
    useEffect(() => {
        if (atemStatus?.connectionState === 'connected' && doc.device.designSource !== 'live') {
            dispatch({ type: 'load', doc: { ...doc, device: { ...doc.device, designSource: 'live' } } });
        } else if (atemStatus?.connectionState !== 'connected' && doc.device.designSource === 'live') {
            dispatch({ type: 'load', doc: { ...doc, device: { ...doc.device, designSource: 'manual' } } });
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [atemStatus?.connectionState]);

    const patchBox = useCallback((index, values) => dispatch({ type: 'patch_box', index, values }), []);

    // --- Drag / resize -----------------------------------------------------
    // Snap targets: frame edges, frame centre, and the centre lines. Enough to
    // build a tidy layout without a full alignment engine.
    const snapTargets = useMemo(() => ({
        x: [0, STAGE_WIDTH / 2, STAGE_WIDTH],
        y: [0, STAGE_HEIGHT / 2, STAGE_HEIGHT],
    }), []);

    const snap = useCallback((rect) => {
        let { left, top } = rect;
        let guideX = null;
        let guideY = null;
        const edgesX = [[left, 0], [left + rect.width / 2, rect.width / 2], [left + rect.width, rect.width]];
        const edgesY = [[top, 0], [top + rect.height / 2, rect.height / 2], [top + rect.height, rect.height]];

        for (const [edge, offset] of edgesX) {
            for (const target of snapTargets.x) {
                if (Math.abs(edge - target) <= SNAP_PX) { left = target - offset; guideX = target; break; }
            }
            if (guideX !== null) break;
        }
        for (const [edge, offset] of edgesY) {
            for (const target of snapTargets.y) {
                if (Math.abs(edge - target) <= SNAP_PX) { top = target - offset; guideY = target; break; }
            }
            if (guideY !== null) break;
        }
        return { rect: { ...rect, left, top }, guideX, guideY };
    }, [snapTargets]);

    const handlePointerDown = (event, index, handle) => {
        if (!canvasScale) return;
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        setSelectedBox(index);
        dragRef.current = {
            index,
            handle,
            startX: event.clientX,
            startY: event.clientY,
            startRect: boxToStageRect(doc.boxes[index]),
        };
    };

    const handlePointerMove = (event) => {
        const drag = dragRef.current;
        if (!drag || !canvasScale) return;
        const dx = (event.clientX - drag.startX) / canvasScale;
        const dy = (event.clientY - drag.startY) / canvasScale;
        const start = drag.startRect;

        let rect;
        if (drag.handle === 'move') {
            rect = { ...start, left: start.left + dx, top: start.top + dy };
        } else {
            // Corner resize: the opposite corner stays pinned and the aspect stays
            // 16:9, because an ATEM box is always a 16:9 window on a 16:9 source.
            const signX = drag.handle.includes('e') ? 1 : -1;
            const anchorX = drag.handle.includes('e') ? start.left : start.left + start.width;
            const anchorY = drag.handle.includes('s') ? start.top : start.top + start.height;

            const width = Math.max(STAGE_WIDTH * (ATEM_BOX_LIMITS.size.min / 1000), start.width + signX * dx);
            const height = width * ASPECT;
            rect = {
                left: drag.handle.includes('e') ? anchorX : anchorX - width,
                top: drag.handle.includes('s') ? anchorY : anchorY - height,
                width,
                height,
            };
        }

        const snapped = snap(rect);
        setGuides({ x: snapped.guideX, y: snapped.guideY });
        patchBox(drag.index, stageRectToBox(snapped.rect));
    };

    const endDrag = (event) => {
        if (!dragRef.current) return;
        event.currentTarget.releasePointerCapture?.(event.pointerId);
        dragRef.current = null;
        setGuides({ x: null, y: null });
    };

    // Arrow keys nudge the selected box — the only way to hit an exact value.
    const handleKeyDown = (event) => {
        const step = event.shiftKey ? 50 : 5;
        const deltas = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
        const delta = deltas[event.key];
        if (!delta) return;
        event.preventDefault();
        patchBox(selectedBox, { x: box.x + delta[0], y: box.y + delta[1] });
    };

    // Streams interpolated keyframes from the current layout to `target` over
    // PRESET_TRANSITION_MS, updating local state every frame. That drives the
    // canvas preview directly, and — via the ATEM push effect above, which fires
    // on every doc change — feeds the same interpolated positions through to the
    // switcher's own service-side coalescer once armed. Same wire traffic a
    // recorded ATEM macro would produce, just generated live instead of stored on
    // the device (see the note on interpolateDoc in superSourceModel.js).
    const animateToDoc = useCallback((target) => {
        const start = doc;
        const token = ++transitionTokenRef.current;
        const startTime = performance.now();

        // setTimeout rather than requestAnimationFrame: rAF is fully suspended on a
        // hidden/backgrounded window, which would leave a transition frozen halfway
        // and the switcher stuck mid-move if the operator alt-tabs away right after
        // clicking. setTimeout is only throttled when hidden, not stopped, so the
        // push to the switcher always eventually reaches its final state.
        const step = () => {
            if (transitionTokenRef.current !== token) return; // superseded by a newer click
            const t = Math.min(1, (performance.now() - startTime) / PRESET_TRANSITION_MS);
            dispatch({ type: 'load', doc: interpolateDoc(start, target, t) });
            if (t < 1) setTimeout(step, 16);
        };
        step();
    }, [doc]);

    const allPresets = useMemo(() => [...SUPERSOURCE_PRESETS, ...customPresets], [customPresets]);

    const activePreset = allPresets.find(preset => (
        preset.boxes?.every((patch, i) => (
            patch.enabled === false
                ? !doc.boxes[i].enabled
                : doc.boxes[i].enabled && doc.boxes[i].x === patch.x && doc.boxes[i].y === patch.y && doc.boxes[i].size === patch.size
        ))
    ));

    const handleSavePreset = () => {
        const name = presetNameInput.trim();
        if (!name) return;
        const preset = createPresetFromDoc(doc, name);
        // Same name overwrites, so iterating on a look doesn't litter the rail.
        setCustomPresets(prev => [...prev.filter(p => p.name !== name), preset]);
        setPresetNameInput('');
    };

    const atemInputs = atemStatus?.inputs || [];
    const isConnected = atemStatus?.connectionState === 'connected';
    const deviceBoxCount = atemStatus?.device?.boxCounts?.[doc.ssrcId] ?? BOX_COUNT;

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

    const handleSelectAtemConnection = (conn) => {
        handleAtemConnect({ address: conn.address, port: conn.port, activeConnectionId: conn.id });
    };

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

    const handleAtemPull = async () => {
        const result = await emitAck('atem_pull_state', { ssrcId: doc.ssrcId });
        if (!result?.ok || !Array.isArray(result.boxes)) {
            window.alert('Could not read the SuperSource state from the switcher.');
            return;
        }
        dispatch({
            type: 'load',
            doc: {
                ...doc,
                boxes: doc.boxes.map((b, i) => (result.boxes[i] ? atemBoxToDoc(result.boxes[i]) : b)),
            },
        });
        lastPushedRef.current = null;
    };

    const handlePushBackground = async () => {
        const result = await emitAck('atem_push_properties', {
            props: { artFillSource: doc.background.artFillSource, artOption: doc.background.artOption },
            ssrcId: doc.ssrcId,
        });
        if (!result?.ok) window.alert(result?.error || 'Could not push the background to the switcher.');
    };

    const connectionLabel = {
        idle: 'Not connected',
        connecting: 'Connecting…',
        connected: 'Connected',
        reconnecting: 'Reconnecting…',
        error: 'Connection error',
    }[atemStatus?.connectionState || 'idle'];

    const connectionDotClass = {
        idle: 'bg-slate-400',
        connecting: 'bg-amber-400 animate-pulse',
        connected: 'bg-emerald-500',
        reconnecting: 'bg-amber-400 animate-pulse',
        error: 'bg-red-500',
    }[atemStatus?.connectionState || 'idle'];

    return (
        <div className="space-y-4">
            {/* ATEM connection */}
            <div className="surface p-3 space-y-3">
                <SectionHeader
                    icon={Plug}
                    title="Blackmagic ATEM Connection"
                    detail="Connects over IP to fetch input names and, once armed, push this layout live."
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

                <div className="space-y-1">
                    <FieldLabel hint="offline design, or a fallback if capabilities can't be read">Model (used until connected)</FieldLabel>
                    <select
                        value={doc.device.designModel}
                        onChange={e => dispatch({ type: 'load', doc: { ...doc, device: { ...doc.device, designModel: e.target.value } } })}
                        className={compactInputClass}
                        disabled={isConnected}
                    >
                        {ATEM_MODEL_PROFILES.map(profile => <option key={profile.id} value={profile.id}>{profile.label}</option>)}
                    </select>
                </div>

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
                    <button onClick={handleAtemPull} disabled={!isConnected} className="control-button-muted px-3 py-1.5 text-[11px] font-bold disabled:opacity-40">
                        Pull layout from switcher
                    </button>

                    <label className="flex items-center gap-2 ml-auto text-xs font-bold cursor-pointer">
                        <input
                            type="checkbox"
                            checked={!!atemStatus?.armed}
                            onChange={e => emitAck('atem_set_armed', e.target.checked)}
                            className="accent-red-600"
                        />
                        <span className={atemStatus?.armed ? 'text-red-600 dark:text-red-400' : 'text-slate-500'}>
                            {atemStatus?.armed ? '● ARMED — pushing live to switcher' : 'Arm push to ATEM'}
                        </span>
                    </label>
                </div>

                {atemStatus?.error && (
                    <p className="text-[11px] text-red-500">{atemStatus.error}</p>
                )}
                {isConnected && (
                    <p className="text-[10px] text-slate-500">
                        {atemStatus.device?.hasSuperSource
                            ? `${atemStatus.device.superSourceCount} SuperSource unit(s), ${deviceBoxCount} boxes · ${atemInputs.length} inputs${atemStatus.lastPushRoundTripMs != null ? ` · last push ${atemStatus.lastPushRoundTripMs}ms` : ''}`
                            : 'This switcher reports no SuperSource — this device cannot be used for PiP.'}
                    </p>
                )}
            </div>

            {/* Preset rail */}
            <div className="surface p-3 space-y-3">
                <SectionHeader
                    icon={LayoutGrid}
                    title="Layout Presets"
                    detail="Geometry only — your input assignments are preserved."
                    action={(
                        <button onClick={() => animateToDoc(normalizeSuperSourceDoc(DEFAULT_SUPERSOURCE_DOC))} className="control-button-muted px-2.5 py-1.5 text-[11px] font-bold flex items-center gap-1.5">
                            <RotateCcw className="w-3 h-3" /> Reset
                        </button>
                    )}
                />
                <div className="flex flex-wrap gap-2">
                    {allPresets.map(preset => (
                        <div
                            key={preset.id}
                            className={`relative group rounded-lg border p-2 transition w-[132px] ${
                                activePreset?.id === preset.id
                                    ? 'border-blue-500 bg-blue-500/10'
                                    : 'border-slate-200 dark:border-slate-700 hover:border-blue-400'
                            }`}
                        >
                            <button
                                onClick={() => animateToDoc(applyPreset(doc, preset.id, customPresets))}
                                title={preset.description}
                                className="w-full text-left"
                            >
                                {/* The thumbnail uses the same boxToStageRect the push math does,
                                    which makes this rail a continuous self-test of the mapping. */}
                                <div className="relative w-full aspect-video rounded bg-slate-900 overflow-hidden mb-1.5">
                                    {applyPreset(doc, preset.id, customPresets).boxes.map((b, i) => {
                                        if (!b.enabled) return null;
                                        const rect = boxToStageRect(b);
                                        return (
                                            <div
                                                key={i}
                                                className="absolute bg-blue-500/70 border border-blue-300/60"
                                                style={{
                                                    left: `${(rect.left / STAGE_WIDTH) * 100}%`,
                                                    top: `${(rect.top / STAGE_HEIGHT) * 100}%`,
                                                    width: `${(rect.width / STAGE_WIDTH) * 100}%`,
                                                    height: `${(rect.height / STAGE_HEIGHT) * 100}%`,
                                                }}
                                            />
                                        );
                                    })}
                                </div>
                                <div className="text-[11px] font-bold text-slate-700 dark:text-slate-200 truncate">{preset.name}</div>
                            </button>
                            {preset.custom && (
                                <button
                                    onClick={() => setCustomPresets(prev => prev.filter(p => p.id !== preset.id))}
                                    title={`Delete "${preset.name}"`}
                                    className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 transition rounded bg-slate-900/80 p-1 text-slate-300 hover:text-red-400"
                                >
                                    <Trash2 className="w-3 h-3" />
                                </button>
                            )}
                        </div>
                    ))}
                </div>

                <div className="flex items-center gap-2 pt-1">
                    <input
                        value={presetNameInput}
                        onChange={e => setPresetNameInput(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') handleSavePreset(); }}
                        placeholder="Save current layout as…"
                        className={`${compactInputClass} flex-1`}
                    />
                    <button
                        onClick={handleSavePreset}
                        disabled={!presetNameInput.trim()}
                        className="control-button px-2.5 py-1.5 text-[11px] font-bold flex items-center gap-1.5 disabled:opacity-40"
                    >
                        <Save className="w-3 h-3" /> Save
                    </button>
                </div>
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_340px] gap-4">
                {/* Designer canvas */}
                <div className="surface p-3 space-y-3">
                    <SectionHeader
                        icon={Box}
                        title="Live Preview Stage"
                        detail="Drag to move, corners to scale. Arrow keys nudge; hold Shift for coarse steps. Shows box geometry only — the switcher renders the actual picture."
                    />

                    <div
                        ref={canvasRef}
                        className="relative w-full aspect-video rounded-lg overflow-hidden bg-slate-950 border section-rule select-none touch-none"
                        onPointerMove={handlePointerMove}
                        onPointerUp={endDrag}
                        onPointerCancel={endDrag}
                        onKeyDown={handleKeyDown}
                        tabIndex={0}
                    >
                        {canvasScale > 0 && (
                            <div
                                style={{
                                    position: 'absolute',
                                    top: 0,
                                    left: 0,
                                    width: STAGE_WIDTH,
                                    height: STAGE_HEIGHT,
                                    transform: `scale(${canvasScale})`,
                                    transformOrigin: 'top left',
                                }}
                            >
                                {/* Alignment guides */}
                                {guides.x !== null && (
                                    <div className="absolute top-0 bottom-0 w-px bg-fuchsia-400/90 pointer-events-none" style={{ left: guides.x }} />
                                )}
                                {guides.y !== null && (
                                    <div className="absolute left-0 right-0 h-px bg-fuchsia-400/90 pointer-events-none" style={{ top: guides.y }} />
                                )}

                                {doc.boxes.map((b, i) => {
                                    if (!b.enabled) return null;
                                    // The FULL (uncropped) box — this is what x/y/size actually describe,
                                    // and what the resize handles operate on.
                                    const rect = boxToStageRect(b);
                                    // What the switcher actually shows once crop is applied. These differ
                                    // whenever cropped is on — showing only `rect` was the bug: crop values
                                    // updated correctly and still reached the switcher, but the canvas gave
                                    // zero visual feedback that anything had changed.
                                    const visible = boxToVisibleRect(b);
                                    const isSelected = i === selectedBox;
                                    const inputName = atemInputs.find(input => input.id === b.source);
                                    const label = `${i + 1} · ${inputName?.longName || inputName?.shortName || `Input ${b.source}`}`;

                                    return (
                                        <div key={i}>
                                            {/* Drag/resize surface, spanning the full box. Dashed outline shows
                                                how much is being cropped away outside the solid visible area. */}
                                            <div
                                                onPointerDown={e => handlePointerDown(e, i, 'move')}
                                                className={`absolute cursor-move ${b.cropped ? 'border border-dashed border-white/40' : ''}`}
                                                style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
                                            >
                                                {isSelected && ['nw', 'ne', 'sw', 'se'].map(handle => (
                                                    <div
                                                        key={handle}
                                                        onPointerDown={e => handlePointerDown(e, i, handle)}
                                                        className="absolute w-2.5 h-2.5 bg-blue-500 border border-white rounded-sm"
                                                        style={{
                                                            cursor: `${handle}-resize`,
                                                            left: handle.includes('w') ? -5 : undefined,
                                                            right: handle.includes('e') ? -5 : undefined,
                                                            top: handle.includes('n') ? -5 : undefined,
                                                            bottom: handle.includes('s') ? -5 : undefined,
                                                        }}
                                                    />
                                                ))}
                                            </div>

                                            {/* Visible (post-crop) area — what's actually on air. */}
                                            <BoxRect
                                                rect={visible}
                                                selected={isSelected}
                                                label={label}
                                                onPointerDown={e => handlePointerDown(e, i, 'move')}
                                            />
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </div>

                    {/* Box enable / select strip */}
                    <div className="grid grid-cols-4 gap-2">
                        {doc.boxes.map((b, i) => (
                            <div
                                key={i}
                                className={`rounded-lg border p-2 space-y-1.5 cursor-pointer transition ${
                                    i === selectedBox ? 'border-blue-500 bg-blue-500/5' : 'border-slate-200 dark:border-slate-700'
                                }`}
                                onClick={() => setSelectedBox(i)}
                            >
                                <div className="flex items-center justify-between">
                                    <span className="text-[11px] font-bold text-slate-700 dark:text-slate-200">Box {i + 1}</span>
                                    <input
                                        type="checkbox"
                                        checked={b.enabled}
                                        onChange={e => patchBox(i, { enabled: e.target.checked })}
                                        onClick={e => e.stopPropagation()}
                                        className="accent-blue-600"
                                    />
                                </div>
                                <div className="text-[10px] text-slate-500 truncate">
                                    {b.enabled ? `Input ${b.source} · ${(b.size / 1000).toFixed(2)}x` : 'Disabled'}
                                </div>
                            </div>
                        ))}
                    </div>
                </div>

                {/* Inspector */}
                <div className="space-y-4">
                    <div className="surface p-3 space-y-3">
                        <SectionHeader icon={Box} title={`Box ${selectedBox + 1} — Geometry`} detail="Matches the switcher exactly." />

                        <div className="space-y-2">
                            <FieldLabel hint={isConnected ? 'from the switcher' : 'ATEM input id'}>Video source</FieldLabel>
                            {isConnected && atemInputs.length > 0 ? (
                                <select
                                    value={box.source}
                                    onChange={e => patchBox(selectedBox, { source: Number(e.target.value) })}
                                    className={inputClass}
                                >
                                    {atemInputs.map(input => (
                                        <option key={input.id} value={input.id}>{input.longName || input.shortName || `Input ${input.id}`}</option>
                                    ))}
                                </select>
                            ) : (
                                <>
                                    <input
                                        type="number"
                                        min="0"
                                        value={box.source}
                                        onChange={e => patchBox(selectedBox, { source: Number(e.target.value) })}
                                        className={inputClass}
                                    />
                                    <p className="text-[10px] text-slate-500">Replaced by a live input list once a switcher is connected.</p>
                                </>
                            )}
                        </div>
                        {selectedBox >= deviceBoxCount && isConnected && (
                            <p className="text-[10px] text-amber-600 dark:text-amber-400">
                                The connected switcher only has {deviceBoxCount} SuperSource boxes — this box will not be pushed.
                            </p>
                        )}

                        <Slider label="Size" value={box.size} min={ATEM_BOX_LIMITS.size.min} max={ATEM_BOX_LIMITS.size.max}
                            format={v => (v / 1000).toFixed(3)} onChange={v => patchBox(selectedBox, { size: v })} />
                        <Slider label="Position X" value={box.x} min={ATEM_BOX_LIMITS.x.min} max={ATEM_BOX_LIMITS.x.max}
                            format={v => (v / 100).toFixed(2)} onChange={v => patchBox(selectedBox, { x: v })} />
                        <Slider label="Position Y" hint="+ is up" value={box.y} min={ATEM_BOX_LIMITS.y.min} max={ATEM_BOX_LIMITS.y.max}
                            format={v => (v / 100).toFixed(2)} onChange={v => patchBox(selectedBox, { y: v })} />
                    </div>

                    <div className="surface p-3 space-y-3">
                        <SectionHeader icon={Crop} title="Crop" detail="A box is always a 16:9 window — shape presets get square/portrait by cropping it symmetrically." />

                        <div className="space-y-1">
                            <FieldLabel>Shape</FieldLabel>
                            <select
                                value={matchAspectPreset(box)}
                                onChange={(e) => {
                                    const preset = ASPECT_PRESETS.find(p => p.id === e.target.value);
                                    if (!preset || preset.id === 'custom') return;
                                    const crop = cropForAspect(preset.ratio);
                                    animateToDoc({
                                        ...doc,
                                        boxes: doc.boxes.map((b, i) => (i === selectedBox ? { ...b, ...crop } : b)),
                                    });
                                }}
                                className={inputClass}
                            >
                                {ASPECT_PRESETS.map(preset => <option key={preset.id} value={preset.id}>{preset.label}</option>)}
                            </select>
                        </div>

                        <Toggle label="Enable crop" checked={box.cropped} onChange={v => patchBox(selectedBox, { cropped: v })} />
                        {box.cropped && (
                            <div className="space-y-2">
                                <Slider label="Top" value={box.cropTop} min={0} max={ATEM_BOX_LIMITS.cropTop.max} format={v => (v / 1000).toFixed(2)} onChange={v => patchBox(selectedBox, { cropTop: v })} />
                                <Slider label="Bottom" value={box.cropBottom} min={0} max={ATEM_BOX_LIMITS.cropBottom.max} format={v => (v / 1000).toFixed(2)} onChange={v => patchBox(selectedBox, { cropBottom: v })} />
                                <Slider label="Left" value={box.cropLeft} min={0} max={ATEM_BOX_LIMITS.cropLeft.max} format={v => (v / 1000).toFixed(2)} onChange={v => patchBox(selectedBox, { cropLeft: v })} />
                                <Slider label="Right" value={box.cropRight} min={0} max={ATEM_BOX_LIMITS.cropRight.max} format={v => (v / 1000).toFixed(2)} onChange={v => patchBox(selectedBox, { cropRight: v })} />
                            </div>
                        )}
                    </div>

                    <div className="surface p-3 space-y-3">
                        <SectionHeader icon={Paintbrush} title="Background (Art)" detail="The switcher's SuperSource Art layer — sits behind or in front of the boxes." />

                        <div className="space-y-1">
                            <FieldLabel hint={isConnected ? 'from the switcher' : 'ATEM input id'}>Fill source</FieldLabel>
                            {isConnected && atemInputs.length > 0 ? (
                                <select
                                    value={doc.background.artFillSource}
                                    onChange={e => dispatch({ type: 'patch_background', values: { artFillSource: Number(e.target.value) } })}
                                    className={inputClass}
                                >
                                    {atemInputs.map(input => (
                                        <option key={input.id} value={input.id}>{input.longName || input.shortName || `Input ${input.id}`}</option>
                                    ))}
                                </select>
                            ) : (
                                <input
                                    type="number"
                                    min="0"
                                    value={doc.background.artFillSource}
                                    onChange={e => dispatch({ type: 'patch_background', values: { artFillSource: Number(e.target.value) } })}
                                    className={inputClass}
                                />
                            )}
                        </div>

                        <div className="space-y-1">
                            <FieldLabel>Layer order</FieldLabel>
                            <select
                                value={doc.background.artOption}
                                onChange={e => dispatch({ type: 'patch_background', values: { artOption: e.target.value } })}
                                className={compactInputClass}
                            >
                                {ART_OPTIONS.map(opt => <option key={opt.id} value={opt.id}>{opt.label}</option>)}
                            </select>
                        </div>

                        <button onClick={handlePushBackground} disabled={!isConnected || !atemStatus?.armed} className="control-button px-2.5 py-1.5 text-[11px] font-bold w-full disabled:opacity-40">
                            Push background to switcher
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
