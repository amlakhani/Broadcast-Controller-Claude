import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Check, CopyPlus, ExternalLink, Film, Image as ImageIcon, Layers, ListChecks, Play, Plus, RefreshCw, Save, SkipForward, Trash2, Upload } from 'lucide-react';
import { deferUntilIdle, readLocalStorageArraySafe, readLocalStorageObjectSafe, useDebouncedLocalStorageEffect } from '../utils/performance';
import { DEFAULT_GUJ_FONT } from '../utils/lyricsFonts';

const RUN_OF_SHOW_KEY = 'bc_run_of_show_v1';
const LYRICS_STYLE_KEY = 'bc_lyrics_style_v1';
const MEDIA_PLAYLIST_KEY = 'bc_media_playlist_v1';
const PHOTO_PLAYLIST_KEY = 'bc_photo_playlist_v1';
const STATUSES = ['pending', 'armed', 'fired', 'skipped', 'done'];

const ACTION_TYPES = [
    { id: 'note', label: 'Note', tab: 'runshow' },
    { id: 'media', label: 'Media / Video', tab: 'media' },
    { id: 'photo', label: 'Photo', tab: 'media' },
    { id: 'sabha_timer', label: 'Sabha Timer', tab: 'sabha' },
    { id: 'stage_timer', label: 'Stage Timer', tab: 'stage' },
    { id: 'stage_message', label: 'Stage Message', tab: 'stage' },
    { id: 'lyrics', label: 'Lyrics', tab: 'lyrics' },
    { id: 'lower_third', label: 'Lower Third', tab: 'lt' },
    { id: 'presentation', label: 'Presentation', tab: 'pres' },
    { id: 'translation', label: 'Translation', tab: 'translation' },
    { id: 'clear', label: 'Clear All', tab: 'runshow' },
    { id: 'blackout', label: 'Blackout', tab: 'runshow' }
];

const actionTypeById = Object.fromEntries(ACTION_TYPES.map(type => [type.id, type]));

const inputClass = 'control-field px-3 py-2 text-xs';
const buttonClass = 'control-button px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-slate-600 dark:text-slate-300';

const readStoredArray = (key) => {
    return readLocalStorageArraySafe(key);
};

const fileName = (path = '') => path.split(/[/\\]/).pop() || path || '';

const defaultPayload = (type) => {
    if (type === 'media') return { mediaType: 'local', name: '', path: '', id: '' };
    if (type === 'photo') return { name: '', path: '' };
    if (type === 'sabha_timer') return { timeStr: '16:00', message: 'Sabha Starts In' };
    if (type === 'stage_timer') return { minutes: 5, label: 'Segment Timer', mode: 'down' };
    if (type === 'stage_message') return { text: 'Wrap up now', color: 'default', bold: true, upper: false, flash: false, sizeOffset: 0 };
    if (type === 'lyrics') return { engText: '', gujText: '', langOpt: 'both' };
    if (type === 'lower_third') return { name: '', title: '', subtitle2: '' };
    if (type === 'presentation') return { mode: 'none', baseUrl: '', slideId: '', totalSlides: 1, currentIdx: 0, isCanva: false, showing: true };
    if (type === 'translation') return { action: 'clear' };
    return {};
};

const makeAction = (type = 'note') => ({
    id: `action-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    type,
    label: actionTypeById[type]?.label || 'Action',
    payload: defaultPayload(type)
});

const normalizeAction = (action = {}) => {
    const type = actionTypeById[action.type] ? action.type : 'note';
    return {
        id: action.id || `action-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        type,
        label: action.label || actionTypeById[type]?.label || 'Action',
        payload: { ...defaultPayload(type), ...(action.payload || {}) }
    };
};

const normalizeCue = (cue = {}) => {
    const legacyType = actionTypeById[cue.type] ? cue.type : 'note';
    const actions = Array.isArray(cue.actions) && cue.actions.length > 0
        ? cue.actions.map(normalizeAction)
        : [normalizeAction({ type: legacyType, label: actionTypeById[legacyType]?.label, payload: cue.payload || {} })];

    return {
        id: cue.id || `cue-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        title: cue.title || actions[0]?.label || 'Cue',
        notes: cue.notes || '',
        status: STATUSES.includes(cue.status) ? cue.status : 'pending',
        actions
    };
};

const loadRunOfShow = () => readStoredArray(RUN_OF_SHOW_KEY).map(normalizeCue);

const makeCue = (type = 'note') => {
    const action = makeAction(type);
    return {
        id: `cue-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        title: action.label,
        notes: '',
        status: 'pending',
        actions: [action]
    };
};

function Field({ label, children }) {
    return (
        <label className="block space-y-1">
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{label}</span>
            {children}
        </label>
    );
}

function parseMediaItem(value) {
    if (!value) return null;
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

export default function RunOfShowPanel({ socket, onNavigate, onBlackout }) {
    const [cues, setCues] = useState([]);
    const [selectedId, setSelectedId] = useState(() => cues[0]?.id || null);
    const [selectedActionId, setSelectedActionId] = useState(null);
    const [mediaLibrary, setMediaLibrary] = useState([]);
    const [photoLibrary, setPhotoLibrary] = useState([]);
    const [lastFiredCueId, setLastFiredCueId] = useState(null);

    const selectedCue = cues.find(cue => cue.id === selectedId) || cues[0] || null;
    const selectedIndex = selectedCue ? cues.findIndex(cue => cue.id === selectedCue.id) : -1;
    const selectedAction = selectedCue?.actions.find(action => action.id === selectedActionId) || selectedCue?.actions[0] || null;
    const activeCount = useMemo(() => cues.filter(cue => cue.status !== 'done' && cue.status !== 'skipped').length, [cues]);

    useEffect(() => deferUntilIdle(() => {
        const savedCues = loadRunOfShow();
        setCues(savedCues);
        setSelectedId(savedCues[0]?.id || null);
        setSelectedActionId(savedCues[0]?.actions?.[0]?.id || null);
        setMediaLibrary(readStoredArray(MEDIA_PLAYLIST_KEY));
        setPhotoLibrary(readStoredArray(PHOTO_PLAYLIST_KEY));
    }), []);

    useDebouncedLocalStorageEffect(RUN_OF_SHOW_KEY, cues);

    useEffect(() => {
        if (!selectedId && cues[0]) setSelectedId(cues[0].id);
    }, [cues, selectedId]);

    useEffect(() => {
        if (selectedCue && !selectedCue.actions.some(action => action.id === selectedActionId)) {
            setSelectedActionId(selectedCue.actions[0]?.id || null);
        }
    }, [selectedCue, selectedActionId]);

    const refreshLibraries = () => {
        setMediaLibrary(readStoredArray(MEDIA_PLAYLIST_KEY));
        setPhotoLibrary(readStoredArray(PHOTO_PLAYLIST_KEY));
    };

    const updateCue = (id, patch) => {
        setCues(prev => prev.map(cue => cue.id === id ? { ...cue, ...patch } : cue));
    };

    const updateAction = (cueId, actionId, patch) => {
        setCues(prev => prev.map(cue => cue.id === cueId ? {
            ...cue,
            actions: cue.actions.map(action => action.id === actionId ? { ...action, ...patch } : action)
        } : cue));
    };

    const updatePayload = (cueId, actionId, patch) => {
        setCues(prev => prev.map(cue => cue.id === cueId ? {
            ...cue,
            actions: cue.actions.map(action => action.id === actionId ? { ...action, payload: { ...action.payload, ...patch } } : action)
        } : cue));
    };

    const addCue = (type = 'note') => {
        const cue = makeCue(type);
        setCues(prev => [...prev, cue]);
        setSelectedId(cue.id);
        setSelectedActionId(cue.actions[0].id);
    };

    const deleteCue = (id) => {
        setCues(prev => prev.filter(cue => cue.id !== id));
        if (selectedId === id) setSelectedId(null);
        if (lastFiredCueId === id) setLastFiredCueId(null);
    };

    const duplicateCue = (cue) => {
        const copy = {
            ...cue,
            id: `cue-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            title: `${cue.title} Copy`,
            status: 'pending',
            actions: cue.actions.map(action => ({
                ...action,
                id: `action-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                payload: { ...action.payload }
            }))
        };
        setCues(prev => {
            const index = prev.findIndex(item => item.id === cue.id);
            const next = [...prev];
            next.splice(index + 1, 0, copy);
            return next;
        });
        setSelectedId(copy.id);
        setSelectedActionId(copy.actions[0]?.id || null);
    };

    const moveCue = (id, direction) => {
        setCues(prev => {
            const index = prev.findIndex(cue => cue.id === id);
            const nextIndex = index + direction;
            if (index < 0 || nextIndex < 0 || nextIndex >= prev.length) return prev;
            const next = [...prev];
            [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
            return next;
        });
    };

    const setStatus = (cue, status) => updateCue(cue.id, { status });

    const addAction = (cue, type = 'note') => {
        const action = makeAction(type);
        updateCue(cue.id, { actions: [...cue.actions, action] });
        setSelectedActionId(action.id);
    };

    const deleteAction = (cue, actionId) => {
        const nextActions = cue.actions.filter(action => action.id !== actionId);
        updateCue(cue.id, { actions: nextActions.length ? nextActions : [makeAction('note')] });
        if (selectedActionId === actionId) setSelectedActionId(nextActions[0]?.id || null);
    };

    const moveAction = (cue, actionId, direction) => {
        const index = cue.actions.findIndex(action => action.id === actionId);
        const nextIndex = index + direction;
        if (index < 0 || nextIndex < 0 || nextIndex >= cue.actions.length) return;
        const next = [...cue.actions];
        [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
        updateCue(cue.id, { actions: next });
    };

    const clearActionOutput = (action) => {
        if (!action) return;
        if (action.type === 'media') socket?.emit('stop_media');
        else if (action.type === 'photo') socket?.emit('photo_stop');
        else if (action.type === 'sabha_timer') socket?.emit('sabha_timer_update', { showing: false });
        else if (action.type === 'stage_timer') socket?.emit('stop_stage_timer');
        else if (action.type === 'stage_message') socket?.emit('set_stage_message', { text: '', format: {} });
        else if (action.type === 'lyrics') socket?.emit('hide_lyrics');
        else if (action.type === 'lower_third') socket?.emit('hide_lower_third');
        else if (action.type === 'presentation') socket?.emit('pres_update', { mode: 'none', baseUrl: '', slideId: '', currentIdx: 0, totalSlides: 0, images: [], isCanva: false, showing: false });
        else if (action.type === 'translation') socket?.emit('clear_translation_display');
    };

    const clearCueOutput = (cue) => {
        cue?.actions?.forEach(clearActionOutput);
    };

    const fireAction = (action, cue) => {
        const payload = action.payload || {};
        if (action.type === 'note') return;
        if (action.type === 'media') {
            const media = payload.mediaType === 'youtube'
                ? { type: 'youtube', id: payload.id, name: payload.name || payload.id }
                : { type: payload.mediaType || 'local', path: payload.path, name: payload.name || payload.path };
            socket?.emit('play_media', { ...media, ts: Date.now() });
        } else if (action.type === 'photo') {
            socket?.emit('photo_play', { type: 'photo', path: payload.path, name: payload.name || payload.path });
        } else if (action.type === 'sabha_timer') {
            socket?.emit('sabha_timer_update', { timeStr: payload.timeStr || '16:00', message: payload.message || 'Sabha Starts In', showing: true });
        } else if (action.type === 'stage_timer') {
            const totalSeconds = Math.max(0, Number(payload.minutes || 0) * 60);
            const now = Date.now();
            socket?.emit('set_stage_timer', {
                mode: payload.mode || 'down',
                label: payload.label || cue.title,
                totalSeconds,
                startTime: now,
                endTime: now + totalSeconds * 1000
            });
        } else if (action.type === 'stage_message') {
            socket?.emit('set_stage_message', {
                text: payload.text || cue.title,
                format: {
                    color: payload.color || 'default',
                    bold: Boolean(payload.bold),
                    upper: Boolean(payload.upper),
                    flash: Boolean(payload.flash),
                    sizeOffset: Number(payload.sizeOffset || 0)
                }
            });
        } else if (action.type === 'lyrics') {
            socket?.emit('show_lyrics', {
                engText: payload.engText || '',
                gujText: payload.gujText || '',
                langOpt: payload.langOpt || 'both',
                animation: 'fade',
                bgStyle: 'default',
                posX: 50,
                posY: 80,
                autoClear: 0,
                style: {
                    fontFamily: "'Outfit', sans-serif",
                    // Without this a fired cue would silently reset Gujarati back to Rasa.
                    gujFontFamily: readLocalStorageObjectSafe(LYRICS_STYLE_KEY).gujFontFamily || DEFAULT_GUJ_FONT,
                    fontWeight: '400', fontSize: '64', color: '#ffffff', letterSpacing: '0'
                }
            });
        } else if (action.type === 'lower_third') {
            socket?.emit('show_lower_third', {
                name: payload.name || cue.title,
                title: payload.title || '',
                subtitle2: payload.subtitle2 || '',
                autoClear: 0,
                // 'slide' is not a real animation id — it silently fell back to elastic.
                animation: 'elastic'
            });
        } else if (action.type === 'presentation') {
            socket?.emit('pres_update', {
                mode: payload.mode || 'none',
                baseUrl: payload.baseUrl || '',
                slideId: payload.slideId || '',
                currentIdx: Number(payload.currentIdx || 0),
                totalSlides: Number(payload.totalSlides || 0),
                images: [],
                isCanva: Boolean(payload.isCanva),
                showing: payload.showing !== false
            });
        } else if (action.type === 'translation') {
            if (payload.action === 'stop') socket?.emit('stop_translation');
            else if (payload.action === 'start') window.dispatchEvent(new CustomEvent('bc_runshow_start_translation'));
            else socket?.emit('clear_translation_display');
        } else if (action.type === 'clear') {
            socket?.emit('clear_all');
        } else if (action.type === 'blackout') {
            onBlackout?.();
        }
    };

    const fireCue = (cue, { advance = false } = {}) => {
        const previousCue = cues.find(item => item.id === lastFiredCueId);
        if (previousCue && previousCue.id !== cue.id) clearCueOutput(previousCue);
        cue.actions.forEach(action => fireAction(action, cue));
        setStatus(cue, 'fired');
        setLastFiredCueId(cue.id);

        if (advance) {
            const nextCue = cues[selectedIndex + 1];
            if (nextCue) {
                setSelectedId(nextCue.id);
                setSelectedActionId(nextCue.actions[0]?.id || null);
            }
        }
    };

    const browseVideo = async (cueId, actionId) => {
        const filePath = await window.broadcastAPI?.selectLocalVideo?.();
        if (!filePath) return;
        updatePayload(cueId, actionId, { mediaType: 'local', path: filePath, name: fileName(filePath) });
    };

    const browsePhoto = async (cueId, actionId) => {
        const selected = await window.broadcastAPI?.selectLocalPhoto?.();
        const filePath = Array.isArray(selected) ? selected[0] : selected;
        if (!filePath) return;
        updatePayload(cueId, actionId, { path: filePath, name: fileName(filePath) });
    };

    const applyMediaLibraryItem = (cueId, actionId, value) => {
        const item = parseMediaItem(value);
        if (!item) return;
        if (item.type === 'youtube') {
            updatePayload(cueId, actionId, { mediaType: 'youtube', id: item.id || '', path: '', name: item.name || item.id || 'YouTube Video' });
        } else {
            updatePayload(cueId, actionId, { mediaType: item.type || 'local', path: item.path || '', id: item.id || '', name: item.name || fileName(item.path) });
        }
    };

    const applyPhotoLibraryItem = (cueId, actionId, value) => {
        const item = parseMediaItem(value);
        if (!item) return;
        updatePayload(cueId, actionId, { path: item.path || '', name: item.name || fileName(item.path) });
    };

    const renderPayloadEditor = (cue, action) => {
        if (!cue || !action) return null;
        const payload = action.payload || {};
        if (action.type === 'media') return (
            <div className="space-y-3">
                <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_auto_auto]">
                    <Field label="Choose Existing Media">
                        <select value="" onChange={e => applyMediaLibraryItem(cue.id, action.id, e.target.value)} className={inputClass}>
                            <option value="">Select from Media tab library...</option>
                            {mediaLibrary.map((item, index) => (
                                <option key={`${item.type}-${item.path || item.id}-${index}`} value={JSON.stringify(item)}>
                                    {item.name || item.path || item.id || `Media ${index + 1}`}
                                </option>
                            ))}
                        </select>
                    </Field>
                    <button onClick={() => browseVideo(cue.id, action.id)} className={`${buttonClass} mt-5 flex items-center gap-2`}><Upload className="h-3.5 w-3.5" /> Browse Video</button>
                    <button onClick={refreshLibraries} className={`${buttonClass} mt-5 flex items-center gap-2`}><RefreshCw className="h-3.5 w-3.5" /> Refresh</button>
                </div>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                    <Field label="Media Type"><select value={payload.mediaType || 'local'} onChange={e => updatePayload(cue.id, action.id, { mediaType: e.target.value })} className={inputClass}><option value="local">Local file</option><option value="youtube">YouTube</option><option value="webpage">Webpage</option></select></Field>
                    <Field label="Name"><input value={payload.name || ''} onChange={e => updatePayload(cue.id, action.id, { name: e.target.value })} className={inputClass} /></Field>
                    <Field label="Path / URL"><input value={payload.path || ''} onChange={e => updatePayload(cue.id, action.id, { path: e.target.value })} className={inputClass} /></Field>
                    <Field label="YouTube ID"><input value={payload.id || ''} onChange={e => updatePayload(cue.id, action.id, { id: e.target.value })} className={inputClass} /></Field>
                </div>
            </div>
        );
        if (action.type === 'photo') return (
            <div className="space-y-3">
                <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_auto_auto]">
                    <Field label="Choose Existing Photo">
                        <select value="" onChange={e => applyPhotoLibraryItem(cue.id, action.id, e.target.value)} className={inputClass}>
                            <option value="">Select from Media tab photo library...</option>
                            {photoLibrary.map((item, index) => (
                                <option key={`${item.path}-${index}`} value={JSON.stringify(item)}>
                                    {item.name || item.path || `Photo ${index + 1}`}
                                </option>
                            ))}
                        </select>
                    </Field>
                    <button onClick={() => browsePhoto(cue.id, action.id)} className={`${buttonClass} mt-5 flex items-center gap-2`}><Upload className="h-3.5 w-3.5" /> Browse Photo</button>
                    <button onClick={refreshLibraries} className={`${buttonClass} mt-5 flex items-center gap-2`}><RefreshCw className="h-3.5 w-3.5" /> Refresh</button>
                </div>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                    <Field label="Name"><input value={payload.name || ''} onChange={e => updatePayload(cue.id, action.id, { name: e.target.value })} className={inputClass} /></Field>
                    <Field label="Photo Path"><input value={payload.path || ''} onChange={e => updatePayload(cue.id, action.id, { path: e.target.value, name: payload.name || fileName(e.target.value) })} className={inputClass} /></Field>
                </div>
            </div>
        );
        if (action.type === 'sabha_timer') return (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <Field label="Target Time"><input value={payload.timeStr || ''} onChange={e => updatePayload(cue.id, action.id, { timeStr: e.target.value })} className={inputClass} /></Field>
                <Field label="Message"><input value={payload.message || ''} onChange={e => updatePayload(cue.id, action.id, { message: e.target.value })} className={inputClass} /></Field>
            </div>
        );
        if (action.type === 'stage_timer') return (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                <Field label="Minutes"><input type="number" value={payload.minutes || 5} onChange={e => updatePayload(cue.id, action.id, { minutes: e.target.value })} className={inputClass} /></Field>
                <Field label="Label"><input value={payload.label || ''} onChange={e => updatePayload(cue.id, action.id, { label: e.target.value })} className={inputClass} /></Field>
                <Field label="Mode"><select value={payload.mode || 'down'} onChange={e => updatePayload(cue.id, action.id, { mode: e.target.value })} className={inputClass}><option value="down">Count down</option><option value="up">Count up</option><option value="clock">Clock</option></select></Field>
            </div>
        );
        if (action.type === 'stage_message') return (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_160px]">
                <Field label="Message"><textarea value={payload.text || ''} onChange={e => updatePayload(cue.id, action.id, { text: e.target.value })} className={`${inputClass} min-h-24`} /></Field>
                <Field label="Color"><select value={payload.color || 'default'} onChange={e => updatePayload(cue.id, action.id, { color: e.target.value })} className={inputClass}><option value="default">Default</option><option value="red">Red</option><option value="green">Green</option></select></Field>
            </div>
        );
        if (action.type === 'lyrics') return (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <Field label="Gujarati"><textarea value={payload.gujText || ''} onChange={e => updatePayload(cue.id, action.id, { gujText: e.target.value })} className={`${inputClass} min-h-28`} /></Field>
                <Field label="English"><textarea value={payload.engText || ''} onChange={e => updatePayload(cue.id, action.id, { engText: e.target.value })} className={`${inputClass} min-h-28`} /></Field>
            </div>
        );
        if (action.type === 'lower_third') return (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                <Field label="Name"><input value={payload.name || ''} onChange={e => updatePayload(cue.id, action.id, { name: e.target.value })} className={inputClass} /></Field>
                <Field label="Title"><input value={payload.title || ''} onChange={e => updatePayload(cue.id, action.id, { title: e.target.value })} className={inputClass} /></Field>
                <Field label="Subtitle"><input value={payload.subtitle2 || ''} onChange={e => updatePayload(cue.id, action.id, { subtitle2: e.target.value })} className={inputClass} /></Field>
            </div>
        );
        if (action.type === 'presentation') return (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <Field label="Mode"><select value={payload.mode || 'none'} onChange={e => updatePayload(cue.id, action.id, { mode: e.target.value })} className={inputClass}><option value="none">None</option><option value="url">URL</option><option value="images">Images</option></select></Field>
                <Field label="Total Slides"><input type="number" value={payload.totalSlides || 1} onChange={e => updatePayload(cue.id, action.id, { totalSlides: e.target.value })} className={inputClass} /></Field>
                <Field label="Base URL"><input value={payload.baseUrl || ''} onChange={e => updatePayload(cue.id, action.id, { baseUrl: e.target.value })} className={inputClass} /></Field>
                <Field label="Slide ID"><input value={payload.slideId || ''} onChange={e => updatePayload(cue.id, action.id, { slideId: e.target.value })} className={inputClass} /></Field>
            </div>
        );
        if (action.type === 'translation') return <Field label="Action"><select value={payload.action || 'clear'} onChange={e => updatePayload(cue.id, action.id, { action: e.target.value })} className={inputClass}><option value="clear">Clear display</option><option value="stop">Stop translation</option><option value="start">Start using Translation panel settings</option></select></Field>;
        return <div className="surface-muted rounded-lg p-3 text-xs text-slate-500">This action has no extra payload fields.</div>;
    };

    return (
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-[390px_1fr]">
            <div className="surface rounded-lg p-3">
                <div className="mb-3 flex items-center justify-between gap-3">
                    <div>
                        <div className="text-[9px] font-bold uppercase tracking-[0.25em] text-slate-500">Run of Show</div>
                        <div className="text-sm font-bold text-slate-900 dark:text-white">{cues.length} cues / {activeCount} active</div>
                    </div>
                    <select onChange={e => addCue(e.target.value)} value="" className="control-field px-2 py-2 text-xs font-bold">
                        <option value="" disabled>Add Cue</option>
                        {ACTION_TYPES.map(type => <option key={type.id} value={type.id}>{type.label}</option>)}
                    </select>
                </div>

                <div className="max-h-[620px] space-y-2 overflow-y-auto pr-1">
                    {cues.length === 0 ? (
                        <button onClick={() => addCue('note')} className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-slate-300 px-3 py-10 text-sm font-bold text-slate-500 transition hover:border-indigo-400 hover:text-indigo-500 dark:border-slate-700">
                            <Plus className="h-4 w-4" /> Add first cue
                        </button>
                    ) : cues.map((cue, index) => (
                        <button key={cue.id} onClick={() => { setSelectedId(cue.id); setSelectedActionId(cue.actions[0]?.id || null); }} className={`w-full rounded-lg border p-3 text-left transition ${selectedCue?.id === cue.id ? 'border-indigo-500 bg-indigo-500/10' : 'surface-muted hover:border-slate-300'}`}>
                            <div className="flex items-center justify-between gap-2">
                                <div className="min-w-0">
                                    <div className="truncate text-sm font-bold text-slate-900 dark:text-white">{index + 1}. {cue.title}</div>
                                    <div className="mt-1 flex flex-wrap items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-slate-500">
                                        <span>{cue.status}</span>
                                        <span>/</span>
                                        <span>{cue.actions.length} action{cue.actions.length === 1 ? '' : 's'}</span>
                                    </div>
                                </div>
                                <ListChecks className="h-4 w-4 shrink-0 text-slate-400" />
                            </div>
                            <div className="mt-2 flex flex-wrap gap-1">
                                {cue.actions.slice(0, 4).map(action => (
                                    <span key={action.id} className="rounded-md bg-slate-200 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-slate-600 dark:bg-slate-800 dark:text-slate-400">
                                        {actionTypeById[action.type]?.label || action.type}
                                    </span>
                                ))}
                            </div>
                        </button>
                    ))}
                </div>
            </div>

            <div className="surface rounded-lg p-4">
                {!selectedCue ? (
                    <div className="flex min-h-80 items-center justify-center text-sm text-slate-500">Add a cue to start building the program timeline.</div>
                ) : (
                    <div className="space-y-4">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex flex-wrap items-center gap-2">
                                <button onClick={() => fireCue(selectedCue)} className="flex h-10 items-center gap-2 rounded-lg bg-emerald-600 px-4 text-xs font-bold uppercase tracking-wider text-white transition hover:bg-emerald-500 active:scale-95"><Play className="h-4 w-4" /> Fire Cue</button>
                                <button onClick={() => fireCue(selectedCue, { advance: true })} className="flex h-10 items-center gap-2 rounded-lg bg-blue-600 px-4 text-xs font-bold uppercase tracking-wider text-white transition hover:bg-blue-500 active:scale-95"><SkipForward className="h-4 w-4" /> Fire + Next</button>
                                <button onClick={() => setStatus(selectedCue, 'done')} className={buttonClass}><Check className="inline h-4 w-4" /> Done</button>
                                <button onClick={() => setStatus(selectedCue, 'skipped')} className={buttonClass}><SkipForward className="inline h-4 w-4" /> Skip</button>
                            </div>
                            <div className="flex items-center gap-1">
                                <button onClick={() => moveCue(selectedCue.id, -1)} disabled={selectedIndex <= 0} className="control-button-muted h-9 w-9 text-slate-500 disabled:opacity-30"><ArrowUp className="mx-auto h-4 w-4" /></button>
                                <button onClick={() => moveCue(selectedCue.id, 1)} disabled={selectedIndex >= cues.length - 1} className="control-button-muted h-9 w-9 text-slate-500 disabled:opacity-30"><ArrowDown className="mx-auto h-4 w-4" /></button>
                                <button onClick={() => duplicateCue(selectedCue)} className="control-button-muted h-9 w-9 text-slate-500"><CopyPlus className="mx-auto h-4 w-4" /></button>
                                <button onClick={() => onNavigate?.(actionTypeById[selectedAction?.type]?.tab || 'runshow')} className="control-button-muted h-9 w-9 text-slate-500"><ExternalLink className="mx-auto h-4 w-4" /></button>
                                <button onClick={() => deleteCue(selectedCue.id)} className="h-9 w-9 rounded-lg border border-red-500/30 text-red-500"><Trash2 className="mx-auto h-4 w-4" /></button>
                            </div>
                        </div>

                        <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_160px]">
                            <Field label="Cue Title"><input value={selectedCue.title} onChange={e => updateCue(selectedCue.id, { title: e.target.value })} className={inputClass} /></Field>
                            <Field label="Status"><select value={selectedCue.status} onChange={e => setStatus(selectedCue, e.target.value)} className={inputClass}>{STATUSES.map(status => <option key={status} value={status}>{status}</option>)}</select></Field>
                        </div>

                        <Field label="Notes"><textarea value={selectedCue.notes || ''} onChange={e => updateCue(selectedCue.id, { notes: e.target.value })} className={`${inputClass} min-h-16`} /></Field>

                        <div className="grid grid-cols-1 gap-3 lg:grid-cols-[300px_1fr]">
                            <div className="surface-muted rounded-lg p-3">
                                <div className="mb-3 flex items-center justify-between gap-2">
                                    <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-slate-500">Cue Actions</div>
                                    <select onChange={e => addAction(selectedCue, e.target.value)} value="" className="control-field px-2 py-1.5 text-[10px] font-bold">
                                        <option value="" disabled>Add Action</option>
                                        {ACTION_TYPES.map(type => <option key={type.id} value={type.id}>{type.label}</option>)}
                                    </select>
                                </div>
                                <div className="space-y-2">
                                    {selectedCue.actions.map((action, index) => (
                                        <button key={action.id} onClick={() => setSelectedActionId(action.id)} className={`w-full rounded-lg border p-2 text-left transition ${selectedAction?.id === action.id ? 'border-blue-500 bg-blue-500/10' : 'surface'}`}>
                                            <div className="flex items-center justify-between gap-2">
                                                <div className="min-w-0">
                                                    <div className="truncate text-xs font-bold text-slate-900 dark:text-white">{index + 1}. {action.label || actionTypeById[action.type]?.label}</div>
                                                    <div className="text-[9px] font-bold uppercase tracking-wider text-slate-500">{actionTypeById[action.type]?.label || action.type}</div>
                                                </div>
                                                {action.type === 'media' ? <Film className="h-3.5 w-3.5 text-slate-400" /> : action.type === 'photo' ? <ImageIcon className="h-3.5 w-3.5 text-slate-400" /> : <Layers className="h-3.5 w-3.5 text-slate-400" />}
                                            </div>
                                        </button>
                                    ))}
                                </div>
                            </div>

                            <div className="surface rounded-lg p-3">
                                {selectedAction && (
                                    <div className="space-y-3">
                                        <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_180px_auto]">
                                            <Field label="Action Label"><input value={selectedAction.label || ''} onChange={e => updateAction(selectedCue.id, selectedAction.id, { label: e.target.value })} className={inputClass} /></Field>
                                            <Field label="Action Type"><select value={selectedAction.type} onChange={e => updateAction(selectedCue.id, selectedAction.id, { type: e.target.value, label: actionTypeById[e.target.value]?.label || 'Action', payload: defaultPayload(e.target.value) })} className={inputClass}>{ACTION_TYPES.map(type => <option key={type.id} value={type.id}>{type.label}</option>)}</select></Field>
                                            <div className="mt-5 flex gap-1">
                                                <button onClick={() => moveAction(selectedCue, selectedAction.id, -1)} className="control-button-muted h-9 w-9 text-slate-500"><ArrowUp className="mx-auto h-4 w-4" /></button>
                                                <button onClick={() => moveAction(selectedCue, selectedAction.id, 1)} className="control-button-muted h-9 w-9 text-slate-500"><ArrowDown className="mx-auto h-4 w-4" /></button>
                                                <button onClick={() => deleteAction(selectedCue, selectedAction.id)} className="h-9 w-9 rounded-lg border border-red-500/30 text-red-500"><Trash2 className="mx-auto h-4 w-4" /></button>
                                            </div>
                                        </div>
                                        {renderPayloadEditor(selectedCue, selectedAction)}
                                    </div>
                                )}
                            </div>
                        </div>

                        <div className="surface-muted flex flex-wrap items-center justify-between gap-2 rounded-lg p-3 text-xs text-slate-500">
                            <div className="flex items-center gap-2"><Save className="h-4 w-4" /> Saved automatically. Firing a different cue clears the previously fired cue outputs first.</div>
                            <button onClick={refreshLibraries} className={buttonClass}><RefreshCw className="inline h-4 w-4" /> Refresh Media Lists</button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
