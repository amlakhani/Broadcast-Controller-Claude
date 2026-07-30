import { useEffect, useRef, useState } from 'react';
import {
    AlertOctagon, Cable, ImagePlus, ListVideo, Plug, RefreshCw, SunDim, Type,
} from 'lucide-react';
import SavedConnections from './SavedConnections';
import { useThrottledCallback } from '../utils/performance';
import {
    clampBrightness, screenLabelFor, DEFAULT_TEXT_OSD_FIELDS,
    hexToArgb, argbToHex, MAX_IMAGE_OSD_BASE64_LENGTH,
} from './novaStarModel';

const inputClass = 'control-field px-3 py-2 text-sm';
const DEFAULT_SETTINGS = {
    address: '', port: 80, pId: '', secretKey: '',
    autoConnect: false, connections: [], activeConnectionId: null, selectedScreenId: null,
};

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

const Placeholder = ({ children }) => (
    <p className="text-[11px] text-slate-500 dark:text-slate-500 italic">{children}</p>
);

// Downscales/re-encodes an uploaded image client-side before it gets base64'd
// into the writeImageOSD request body — the OpenAPI has no upload endpoint,
// the whole file rides inline in JSON, so an un-downscaled photo could send
// a multi-tens-of-MB POST to LAN hardware.
function downscaleImageFile(file, maxDim = 1024, quality = 0.85) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        const objectUrl = URL.createObjectURL(file);
        img.onload = () => {
            const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
            const width = Math.max(1, Math.round(img.width * scale));
            const height = Math.max(1, Math.round(img.height * scale));
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            canvas.getContext('2d').drawImage(img, 0, 0, width, height);
            URL.revokeObjectURL(objectUrl);
            const dataUrl = canvas.toDataURL('image/jpeg', quality);
            const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
            resolve({ base64, width, height, fileLength: Math.ceil(base64.length * 0.75) });
        };
        img.onerror = () => {
            URL.revokeObjectURL(objectUrl);
            reject(new Error('Could not read that image file.'));
        };
        img.src = objectUrl;
    });
}

export default function NovaStarPanel({ socket }) {
    const [status, setStatus] = useState(null);
    const [settings, setSettings] = useState(DEFAULT_SETTINGS);
    const [busy, setBusy] = useState(false);
    const [testing, setTesting] = useState(false);
    const [testResult, setTestResult] = useState(null);
    const [ftbTime, setFtbTime] = useState(0);
    const [brightness, setBrightness] = useState(0);
    const [osd, setOsd] = useState(DEFAULT_TEXT_OSD_FIELDS);
    const [imageBusy, setImageBusy] = useState(false);
    const [imageError, setImageError] = useState(null);
    const fileInputRef = useRef(null);

    useEffect(() => {
        if (!socket) return undefined;
        const handleStatus = (next) => setStatus(next);
        const handleSettings = (next) => setSettings(prev => ({ ...prev, ...next }));

        socket.on('novastar_status_update', handleStatus);
        socket.on('novastar_settings_update', handleSettings);
        socket.emit('novastar_status_request');
        socket.emit('novastar_settings_request', () => {});

        return () => {
            socket.off('novastar_status_update', handleStatus);
            socket.off('novastar_settings_update', handleSettings);
        };
    }, [socket]);

    useEffect(() => {
        if (typeof status?.brightness === 'number') setBrightness(status.brightness);
    }, [status?.brightness]);

    const emitAck = (event, payload) => new Promise(resolve => socket?.emit(event, payload, resolve));

    const handleConnect = async (overrides = {}) => {
        const next = { ...settings, ...overrides };
        setSettings(next);
        setBusy(true);
        setTestResult(null);
        const saved = await emitAck('novastar_settings_save', next);
        if (!saved?.ok) {
            setBusy(false);
            window.alert(saved?.error || 'Could not save the NovaStar connection settings.');
            return;
        }
        await emitAck('novastar_connect', { ...next, connectionId: next.activeConnectionId });
        setBusy(false);
    };

    const handleTest = () => {
        setTesting(true);
        setTestResult(null);
        socket?.emit('novastar_test', {
            address: settings.address, port: settings.port, pId: settings.pId, secretKey: settings.secretKey,
        }, (result) => {
            setTesting(false);
            setTestResult(result || { ok: false, error: 'Test did not return a result.' });
        });
    };

    const handleSelectConnection = (conn) => {
        handleConnect({
            address: conn.address, port: conn.port, pId: conn.pId, secretKey: conn.secretKey,
            activeConnectionId: conn.id, selectedScreenId: conn.screenId ?? null,
        });
    };

    const handleSaveConnection = async (name) => {
        const newConn = {
            id: crypto.randomUUID(), name,
            address: settings.address, port: settings.port,
            pId: settings.pId, secretKey: settings.secretKey,
            screenId: status?.selectedScreenId ?? null,
        };
        const next = { ...settings, connections: [...(settings.connections || []), newConn], activeConnectionId: newConn.id };
        setSettings(next);
        await emitAck('novastar_settings_save', next);
    };

    const handleDeleteConnection = async (id) => {
        const next = {
            ...settings,
            connections: (settings.connections || []).filter(c => c.id !== id),
            activeConnectionId: settings.activeConnectionId === id ? null : settings.activeConnectionId,
        };
        setSettings(next);
        await emitAck('novastar_settings_save', next);
    };

    const handleSelectScreen = (e) => {
        const screenId = Number(e.target.value);
        emitAck('novastar_select_screen', { screenId });
    };

    const throttledSetBrightness = useThrottledCallback((value) => {
        emitAck('novastar_set_brightness', { brightness: value });
    }, 150);

    const handleBrightnessChange = (e) => {
        const value = clampBrightness(e.target.value);
        setBrightness(value);
        throttledSetBrightness(value);
    };

    const handleSaveBrightnessDefault = async () => {
        const result = await emitAck('novastar_save_brightness', { brightness });
        if (!result?.ok) window.alert(result?.error || 'Could not save the default brightness.');
    };

    const handleBlackout = async (turnOn) => {
        // type: 0 = blackout, 1 = screen on.
        const result = await emitAck('novastar_ftb', { type: turnOn ? 0 : 1, time: ftbTime });
        if (!result?.ok) window.alert(result?.error || 'Could not change blackout state.');
    };

    const handleFreeze = async (enable) => {
        const result = await emitAck('novastar_freeze', { enable });
        if (!result?.ok) window.alert(result?.error || 'Could not change freeze state.');
    };

    const handleReadPresets = async () => {
        const result = await emitAck('novastar_read_presets');
        if (!result?.ok) window.alert(result?.error || 'Could not read presets.');
    };

    const handleLoadPreset = async (presetId) => {
        const result = await emitAck('novastar_load_preset', { presetId });
        if (!result?.ok) window.alert(result?.error || 'Could not load that preset.');
    };

    const handleSendTextOsd = async (enable) => {
        const result = await emitAck('novastar_set_text_osd', { ...osd, enable });
        if (!result?.ok) window.alert(result?.error || 'Could not update the text overlay.');
    };

    const handleImageFile = async (e) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (!file) return;
        setImageError(null);
        setImageBusy(true);
        try {
            const { base64, width, height, fileLength } = await downscaleImageFile(file);
            if (base64.length > MAX_IMAGE_OSD_BASE64_LENGTH) {
                setImageError('That image is still too large after downscaling — try a smaller source image.');
                setImageBusy(false);
                return;
            }
            const result = await emitAck('novastar_set_image_osd', {
                enable: true, x: 0, y: 0, width, height,
                file: base64, fileName: file.name.replace(/\.[^.]+$/, '') + '.jpg', fileLength, opacity: 100,
            });
            if (!result?.ok) window.alert(result?.error || 'Could not push the image overlay.');
        } catch (err) {
            setImageError(err?.message || 'Could not process that image.');
        } finally {
            setImageBusy(false);
        }
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

    const screens = status?.screens || [];
    const selectedScreenId = status?.selectedScreenId ?? '';

    return (
        <div className="space-y-4">
            {/* Connection */}
            <div className="surface p-3 space-y-3">
                <SectionHeader
                    icon={Plug}
                    title="NovaStar Connection"
                    detail="Connects over the H Series OpenAPI (HTTP) to the LED wall processor."
                    action={(
                        <span className="flex items-center gap-1.5 text-[11px] font-bold text-slate-600 dark:text-slate-300">
                            <span className={`w-2 h-2 rounded-full ${connectionDotClass}`} />
                            {connectionLabel}
                        </span>
                    )}
                />

                <div className="grid grid-cols-1 sm:grid-cols-[1fr_100px] gap-2">
                    <div className="space-y-1">
                        <FieldLabel>Processor address</FieldLabel>
                        <input
                            value={settings.address}
                            onChange={e => setSettings(prev => ({ ...prev, address: e.target.value, activeConnectionId: null }))}
                            placeholder="192.168.1.50"
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

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <div className="space-y-1">
                        <FieldLabel>Requestor ID (pId)</FieldLabel>
                        <input
                            value={settings.pId}
                            onChange={e => setSettings(prev => ({ ...prev, pId: e.target.value, activeConnectionId: null }))}
                            placeholder="From Settings → OpenAPI Management"
                            className={inputClass}
                        />
                    </div>
                    <div className="space-y-1">
                        <FieldLabel>Secret key</FieldLabel>
                        <input
                            type="password"
                            value={settings.secretKey}
                            onChange={e => setSettings(prev => ({ ...prev, secretKey: e.target.value, activeConnectionId: null }))}
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
                    <button onClick={() => handleConnect()} disabled={busy || !settings.address || !settings.pId} className="control-button px-3 py-1.5 text-[11px] font-bold flex items-center gap-1.5 disabled:opacity-40">
                        <Cable className="w-3.5 h-3.5" /> {isConnected ? 'Reconnect' : 'Connect'}
                    </button>
                    <button
                        onClick={handleTest}
                        disabled={testing || !settings.address || !settings.pId}
                        className="control-button-muted px-3 py-1.5 text-[11px] font-bold disabled:opacity-40"
                    >
                        {testing ? 'Testing…' : 'Test'}
                    </button>
                    <button
                        onClick={() => emitAck('novastar_disconnect')}
                        disabled={!status || status.connectionState === 'idle'}
                        className="control-button-muted px-3 py-1.5 text-[11px] font-bold disabled:opacity-40"
                    >
                        Disconnect
                    </button>
                </div>

                {testResult && (
                    <p className={`text-[11px] ${testResult.ok ? 'text-emerald-500' : 'text-red-500'}`}>
                        {testResult.ok ? `Reachable — ${testResult.screens?.length ?? 0} screen${testResult.screens?.length === 1 ? '' : 's'} found.` : (testResult.error || 'Test failed.')}
                    </p>
                )}
                {status?.error && (
                    <p className="text-[11px] text-red-500">{status.error}</p>
                )}
                {isConnected && (
                    <p className="text-[10px] text-slate-500">
                        {status.device?.name || 'NovaStar processor'} · {screens.length} screen{screens.length === 1 ? '' : 's'}
                    </p>
                )}

                {isConnected && screens.length > 0 && (
                    <div className="space-y-1 pt-1">
                        <FieldLabel>Target screen</FieldLabel>
                        <select value={selectedScreenId} onChange={handleSelectScreen} className={inputClass}>
                            {screens.map(s => (
                                <option key={s.screenId} value={s.screenId}>{screenLabelFor(screens, s.screenId)}</option>
                            ))}
                        </select>
                    </div>
                )}
            </div>

            {!isConnected && <Placeholder>Connect to the NovaStar processor to control the LED wall.</Placeholder>}

            {isConnected && (
                <>
                    {/* Blackout / Freeze */}
                    <div className="surface p-3 space-y-3">
                        <SectionHeader icon={AlertOctagon} title="Blackout / Freeze" detail="Panic controls — blank or freeze the wall instantly." />
                        <div className="flex flex-wrap items-end gap-2">
                            <div className="space-y-1">
                                <FieldLabel>Transition (sec)</FieldLabel>
                                <input
                                    type="number" min="0" max="60" value={ftbTime}
                                    onChange={e => setFtbTime(Number(e.target.value))}
                                    className={`${inputClass} w-24`}
                                />
                            </div>
                            <button
                                onClick={() => handleBlackout(!status.blackout)}
                                className={`px-4 py-1.5 text-[11px] font-bold rounded-lg border ${
                                    status.blackout
                                        ? 'bg-red-500 text-white border-red-500'
                                        : 'control-button-muted'
                                }`}
                            >
                                {status.blackout ? 'Screen On' : 'Blackout'}
                            </button>
                            <button
                                onClick={() => handleFreeze(!status.frozen)}
                                className={`px-3 py-1.5 text-[11px] font-bold rounded-lg border ${
                                    status.frozen
                                        ? 'bg-amber-500 text-white border-amber-500'
                                        : 'control-button-muted'
                                }`}
                            >
                                {status.frozen ? 'Unfreeze' : 'Freeze'}
                            </button>
                        </div>
                    </div>

                    {/* Brightness */}
                    <div className="surface p-3 space-y-3">
                        <SectionHeader
                            icon={SunDim}
                            title="Brightness"
                            detail="Only supported on H_16xRJ45+2xfiber, H_20xRJ45, H_4xfiber, and H_4xfiber (enhanced) sending cards — may silently no-op on other hardware."
                        />
                        <div className="flex items-center gap-3">
                            <input
                                type="range" min="0" max="100" value={brightness}
                                onChange={handleBrightnessChange}
                                className="flex-1"
                            />
                            <span className="text-[11px] font-bold text-slate-600 dark:text-slate-300 w-10 text-right">{brightness}%</span>
                            <button onClick={handleSaveBrightnessDefault} className="control-button-muted px-3 py-1.5 text-[11px] font-bold whitespace-nowrap">
                                Save as Default
                            </button>
                        </div>
                    </div>

                    {/* Presets */}
                    <div className="surface p-3 space-y-3">
                        <SectionHeader
                            icon={ListVideo}
                            title="Presets"
                            action={(
                                <button onClick={handleReadPresets} className="control-button-muted px-2.5 py-1.5 text-[11px] font-bold flex items-center gap-1.5">
                                    <RefreshCw className="w-3.5 h-3.5" /> Refresh
                                </button>
                            )}
                        />
                        {(status.presets || []).length === 0 ? (
                            <Placeholder>No presets loaded yet — click Refresh.</Placeholder>
                        ) : (
                            <div className="flex flex-wrap gap-2">
                                {status.presets.map(p => (
                                    <button
                                        key={p.presetId}
                                        onClick={() => handleLoadPreset(p.presetId)}
                                        className="control-button px-3 py-1.5 text-[11px] font-bold"
                                    >
                                        {p.name}
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>

                    {/* Text OSD */}
                    <div className="surface p-3 space-y-3">
                        <SectionHeader
                            icon={Type}
                            title="Text Overlay (OSD)"
                            detail="Burns text directly onto the wall from the processor, independent of the video chain. Font choice, scroll direction/speed, and letter-spacing are not yet exposed here."
                        />
                        <div className="space-y-1">
                            <FieldLabel>Text</FieldLabel>
                            <input
                                value={osd.chars}
                                onChange={e => setOsd(prev => ({ ...prev, chars: e.target.value }))}
                                className={inputClass}
                            />
                        </div>
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                            <div className="space-y-1">
                                <FieldLabel>X</FieldLabel>
                                <input type="number" value={osd.x} onChange={e => setOsd(prev => ({ ...prev, x: Number(e.target.value) }))} className={inputClass} />
                            </div>
                            <div className="space-y-1">
                                <FieldLabel>Y</FieldLabel>
                                <input type="number" value={osd.y} onChange={e => setOsd(prev => ({ ...prev, y: Number(e.target.value) }))} className={inputClass} />
                            </div>
                            <div className="space-y-1">
                                <FieldLabel>Width</FieldLabel>
                                <input type="number" value={osd.width} onChange={e => setOsd(prev => ({ ...prev, width: Number(e.target.value) }))} className={inputClass} />
                            </div>
                            <div className="space-y-1">
                                <FieldLabel>Height</FieldLabel>
                                <input type="number" value={osd.height} onChange={e => setOsd(prev => ({ ...prev, height: Number(e.target.value) }))} className={inputClass} />
                            </div>
                        </div>
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 items-end">
                            <div className="space-y-1">
                                <FieldLabel>Font size</FieldLabel>
                                <input type="number" value={osd.fontPercent} onChange={e => setOsd(prev => ({ ...prev, fontPercent: Number(e.target.value) }))} className={inputClass} />
                            </div>
                            <div className="space-y-1">
                                <FieldLabel>Text color</FieldLabel>
                                <input
                                    type="color" value={argbToHex(osd.fontColor)}
                                    onChange={e => setOsd(prev => ({ ...prev, fontColor: hexToArgb(e.target.value, prev.fontColor.A) }))}
                                    className="control-field h-9 w-full"
                                />
                            </div>
                            <div className="space-y-1">
                                <label className="flex items-center gap-1.5 text-[10px] font-bold text-slate-500 uppercase tracking-wider">
                                    <input type="checkbox" checked={osd.backgroundEnable} onChange={e => setOsd(prev => ({ ...prev, backgroundEnable: e.target.checked }))} />
                                    Background
                                </label>
                                <input
                                    type="color" value={argbToHex(osd.backgroundColor)}
                                    onChange={e => setOsd(prev => ({ ...prev, backgroundColor: hexToArgb(e.target.value, 100) }))}
                                    disabled={!osd.backgroundEnable}
                                    className="control-field h-9 w-full disabled:opacity-40"
                                />
                            </div>
                        </div>
                        <div className="flex items-center gap-2">
                            <button onClick={() => handleSendTextOsd(true)} className="control-button px-3 py-1.5 text-[11px] font-bold">Show</button>
                            <button onClick={() => handleSendTextOsd(false)} className="control-button-muted px-3 py-1.5 text-[11px] font-bold">Hide</button>
                        </div>
                    </div>

                    {/* Image OSD */}
                    <div className="surface p-3 space-y-3">
                        <SectionHeader icon={ImagePlus} title="Image Overlay (OSD)" detail="Uploads and downscales an image, then pushes it straight to the processor." />
                        <div className="flex items-center gap-2">
                            <input ref={fileInputRef} type="file" accept="image/*" onChange={handleImageFile} className="text-[11px]" disabled={imageBusy} />
                            {imageBusy && <span className="text-[11px] text-slate-500">Processing…</span>}
                        </div>
                        {imageError && <p className="text-[11px] text-red-500">{imageError}</p>}
                    </div>
                </>
            )}
        </div>
    );
}
