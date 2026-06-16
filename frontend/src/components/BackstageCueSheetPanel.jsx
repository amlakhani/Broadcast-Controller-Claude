import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle, Clock, ExternalLink, Link as LinkIcon, MessageSquare, Pause, Play, Plus, Radio, RefreshCw, RotateCcw, Send, SkipBack, SkipForward, Timer, Trash2, X } from 'lucide-react';
import { authUrl } from '../auth';
import {
    BACKSTAGE_DISPLAY_MODES,
    TEMPLATE_SHEET_URL,
    driftLabel,
    elapsedForTiming,
    formatDuration,
    getSegmentTitle,
    normalizeCueSheet,
    remainingForTiming
} from '../utils/backstageCueSheet';

const SHEET_URL_KEY = 'bc_backstage_sheet_url_v1';
const DISPLAY_MODE_KEY = 'bc_backstage_display_mode_v1';
const MESSAGE_PRESETS_KEY = 'bc_backstage_message_presets_v1';
const normalizedDisplayMode = (mode) => BACKSTAGE_DISPLAY_MODES.some(item => item.id === mode) ? mode : 'currentNext';

function loadMessagePresets() {
    try {
        const saved = JSON.parse(localStorage.getItem(MESSAGE_PRESETS_KEY) || 'null');
        if (Array.isArray(saved)) {
            return saved.map(item => String(item || '').trim()).filter(Boolean);
        }
    } catch {
        // Fall through to an empty preset list if saved data is malformed.
    }
    return [];
}

function useNow(interval = 500) {
    const [now, setNow] = useState(Date.now());
    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), interval);
        return () => clearInterval(timer);
    }, [interval]);
    return now;
}

function StatCard({ icon: Icon, label, value, tone = 'slate' }) {
    const tones = {
        slate: 'surface text-slate-900 dark:text-white',
        green: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
        blue: 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300',
        red: 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300',
        amber: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300'
    };
    return (
        <div className={`rounded-xl border p-3 ${tones[tone] || tones.slate}`}>
            <div className="flex items-center gap-2 text-[9px] font-bold uppercase tracking-[0.2em] opacity-70">
                <Icon className="h-4 w-4" />
                {label}
            </div>
            <div className="mt-2 truncate text-2xl font-black">{value}</div>
        </div>
    );
}

function ActionButton({ icon: Icon, label, onClick, disabled, tone = 'slate' }) {
    const tones = {
        slate: 'control-button-muted text-slate-700 dark:text-slate-200',
        blue: 'border-blue-600 bg-blue-600 text-white hover:bg-blue-500',
        green: 'border-emerald-600 bg-emerald-600 text-white hover:bg-emerald-500',
        red: 'border-red-600 bg-red-600 text-white hover:bg-red-500',
        amber: 'border-amber-500 bg-amber-500 text-slate-950 hover:bg-amber-400'
    };
    return (
        <button
            onClick={onClick}
            disabled={disabled}
            className={`flex min-h-10 items-center justify-center gap-2 rounded-lg border px-3 py-2 text-[10px] font-bold uppercase tracking-wider transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-45 ${tones[tone]}`}
        >
            <Icon className="h-4 w-4" />
            {label}
        </button>
    );
}

function normalizeBackstageMessage(text, tone = 'normal', flash = false) {
    return {
        text: String(text || '').trim().slice(0, 120),
        tone,
        flash: Boolean(flash),
        updatedAt: Date.now()
    };
}

export default function BackstageCueSheetPanel({
    socket,
    displays,
    backstageDisplay,
    setBackstageDisplay,
    isBackstageOpen,
    onOpenBackstage,
    onCloseBackstage
}) {
    const now = useNow();
    const [sheetUrl, setSheetUrl] = useState(() => localStorage.getItem(SHEET_URL_KEY) || '');
    const [title, setTitle] = useState('Backstage Monitor');
    const [rows, setRows] = useState([]);
    const [currentIndex, setCurrentIndex] = useState(-1);
    const [completedRows, setCompletedRows] = useState({});
    const [timing, setTiming] = useState(null);
    const [totalPlannedSeconds, setTotalPlannedSeconds] = useState(0);
    const [totalActualSeconds, setTotalActualSeconds] = useState(0);
    const [serviceStartedAt, setServiceStartedAt] = useState(null);
    const [displayMode, setDisplayMode] = useState(() => normalizedDisplayMode(localStorage.getItem(DISPLAY_MODE_KEY)));
    const [messageText, setMessageText] = useState('');
    const [messageTone, setMessageTone] = useState('normal');
    const [messageFlash, setMessageFlash] = useState(false);
    const [backstageMessage, setBackstageMessage] = useState(null);
    const [messagePresets, setMessagePresets] = useState(loadMessagePresets);
    const [newPresetText, setNewPresetText] = useState('');
    const [messageFeedback, setMessageFeedback] = useState(null);
    const [isLoading, setIsLoading] = useState(false);
    const [loadStatus, setLoadStatus] = useState(null);

    const currentRow = rows[currentIndex] || null;
    const nextRow = rows[currentIndex + 1] || null;
    const currentElapsed = elapsedForTiming(timing, now);
    const currentRemaining = remainingForTiming(timing, now);
    const programDriftSeconds = totalActualSeconds - totalPlannedSeconds;
    const programDrift = driftLabel(programDriftSeconds);
    const segmentOverBy = currentRow ? Math.max(0, currentElapsed - (currentRow.durationSeconds || 0)) : 0;
    const serviceElapsed = serviceStartedAt ? Math.round((now - serviceStartedAt) / 1000) : 0;
    const customLabels = useMemo(() => Array.from(new Set(rows.flatMap(row => row.customFields?.map(field => field.label) || []))), [rows]);

    const backstageState = useMemo(() => ({
        title,
        rows,
        currentIndex,
        completedRows,
        displayMode,
        message: backstageMessage,
        timing,
        programDriftSeconds,
        serviceStartedAt,
        updatedAt: Date.now()
    }), [title, rows, currentIndex, completedRows, displayMode, backstageMessage, timing, programDriftSeconds, serviceStartedAt]);

    useEffect(() => {
        localStorage.setItem(SHEET_URL_KEY, sheetUrl);
    }, [sheetUrl]);

    useEffect(() => {
        localStorage.setItem(DISPLAY_MODE_KEY, displayMode);
    }, [displayMode]);

    useEffect(() => {
        localStorage.setItem(MESSAGE_PRESETS_KEY, JSON.stringify(messagePresets));
    }, [messagePresets]);

    useEffect(() => {
        if (!messageFeedback) return undefined;
        const timer = setTimeout(() => setMessageFeedback(null), 3000);
        return () => clearTimeout(timer);
    }, [messageFeedback]);

    useEffect(() => {
        socket?.emit('backstage_state_update', backstageState);
    }, [socket, backstageState]);

    useEffect(() => {
        if (!socket) return;
        const handleRequest = () => socket.emit('backstage_state_update', backstageState);
        socket.on('request_backstage_state', handleRequest);
        return () => socket.off('request_backstage_state', handleRequest);
    }, [socket, backstageState]);

    const loadSheet = useCallback(async () => {
        const url = sheetUrl.trim();
        if (!url) return;
        setIsLoading(true);
        setLoadStatus(null);
        try {
            const response = await fetch(authUrl('/fetch-google-sheet', { url }));
            if (!response.ok) {
                const text = await response.text();
                throw new Error(text || `HTTP ${response.status}`);
            }
            const csv = await response.text();
            const parsed = normalizeCueSheet(csv);
            if (parsed.rows.length === 0) {
                throw new Error('No cue rows found. Open the actual cue-sheet tab in Google Sheets, copy that URL, and make sure it includes the right sheet tab.');
            }
            setTitle(parsed.title || 'Backstage Monitor');
            setRows(parsed.rows);
            setCurrentIndex(parsed.rows.length ? 0 : -1);
            setCompletedRows({});
            setTiming(null);
            setTotalPlannedSeconds(0);
            setTotalActualSeconds(0);
            setServiceStartedAt(null);
            setLoadStatus({ ok: true, text: `Loaded ${parsed.rows.length} cue row${parsed.rows.length === 1 ? '' : 's'}.` });
        } catch (err) {
            setLoadStatus({ ok: false, text: err.message || 'Could not load sheet.' });
        } finally {
            setIsLoading(false);
        }
    }, [sheetUrl]);

    const startRow = (index) => {
        const row = rows[index];
        if (!row) return;
        const startedAt = Date.now();
        setCurrentIndex(index);
        setTiming({
            rowId: row.id,
            status: 'running',
            startedAt,
            durationSeconds: row.durationSeconds || 0,
            pausedAt: null,
            pausedAccumulatedMs: 0
        });
        setServiceStartedAt(prev => prev || startedAt);
    };

    const finalizeCurrent = () => {
        if (!currentRow || !timing) return;
        const actualSeconds = elapsedForTiming(timing, Date.now());
        setTotalPlannedSeconds(prev => prev + (currentRow.durationSeconds || 0));
        setTotalActualSeconds(prev => prev + actualSeconds);
        setCompletedRows(prev => ({
            ...prev,
            [currentRow.id]: {
                plannedSeconds: currentRow.durationSeconds || 0,
                actualSeconds,
                driftSeconds: actualSeconds - (currentRow.durationSeconds || 0),
                completedAt: Date.now()
            }
        }));
    };

    const goNext = () => {
        if (currentIndex < 0) {
            startRow(0);
            return;
        }
        finalizeCurrent();
        if (currentIndex + 1 < rows.length) startRow(currentIndex + 1);
        else {
            setTiming(null);
            setCurrentIndex(rows.length - 1);
        }
    };

    const goPrevious = () => {
        if (currentIndex > 0) startRow(currentIndex - 1);
    };

    const pauseResume = () => {
        if (!timing) return;
        if (timing.status === 'paused') {
            const resumedAt = Date.now();
            setTiming(prev => ({
                ...prev,
                status: 'running',
                pausedAccumulatedMs: (prev.pausedAccumulatedMs || 0) + (resumedAt - (prev.pausedAt || resumedAt)),
                pausedAt: null
            }));
        } else {
            setTiming(prev => ({ ...prev, status: 'paused', pausedAt: Date.now() }));
        }
    };

    const resetSegment = () => {
        if (currentIndex >= 0) startRow(currentIndex);
    };

    const resetProgram = () => {
        setCompletedRows({});
        setTotalPlannedSeconds(0);
        setTotalActualSeconds(0);
        setServiceStartedAt(null);
        if (currentIndex >= 0) startRow(currentIndex);
    };

    const sendMessage = (text = messageText, source = 'Message') => {
        const next = normalizeBackstageMessage(text, messageTone, messageFlash);
        if (!next.text) return;
        setBackstageMessage(next);
        setMessageText('');
        setMessageFeedback({ text: `${source} sent: ${next.text}`, sentAt: next.updatedAt });
    };

    const clearMessage = () => setBackstageMessage(null);

    const updatePreset = (index, value) => {
        setMessagePresets(prev => prev.map((preset, idx) => idx === index ? value : preset));
    };

    const deletePreset = (index) => {
        setMessagePresets(prev => prev.filter((_, idx) => idx !== index));
    };

    const addPreset = () => {
        const next = newPresetText.trim();
        if (!next) return;
        setMessagePresets(prev => [...prev, next]);
        setNewPresetText('');
    };

    return (
        <div className="space-y-4">
            <div className="grid grid-cols-1 gap-3 xl:grid-cols-[1.25fr_0.75fr]">
                <section className="surface rounded-lg p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                            <div className="text-[9px] font-bold uppercase tracking-[0.25em] text-slate-500">Google Sheet Source</div>
                            <h2 className="mt-1 text-2xl font-black text-slate-900 dark:text-white">Backstage Monitor</h2>
                        </div>
                        <a
                            href={TEMPLATE_SHEET_URL}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-2 rounded-lg border border-blue-500/30 bg-blue-500/10 px-3 py-2 text-xs font-bold uppercase tracking-wider text-blue-700 transition hover:bg-blue-500 hover:text-white dark:text-blue-300"
                        >
                            <ExternalLink className="h-4 w-4" />
                            Open Template
                        </a>
                    </div>

                    <div className="mt-4 flex flex-col gap-2 lg:flex-row">
                        <div className="relative flex-1">
                            <LinkIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                            <input
                                value={sheetUrl}
                                onChange={e => setSheetUrl(e.target.value)}
                                placeholder="Paste Google Sheet link"
                                className="control-field w-full py-2 pl-9 pr-3 text-sm"
                            />
                        </div>
                        <ActionButton icon={RefreshCw} label={isLoading ? 'Loading' : 'Load / Refresh'} onClick={loadSheet} disabled={isLoading} tone="blue" />
                    </div>

                    {loadStatus && (
                        <div className={`mt-3 flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-bold ${loadStatus.ok ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300'}`}>
                            {loadStatus.ok ? <CheckCircle className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
                            {loadStatus.text}
                        </div>
                    )}

                    <div className="surface-muted mt-4 rounded-lg p-3 text-xs text-slate-600 dark:text-slate-400">
                        <div className="font-bold uppercase tracking-wider text-slate-700 dark:text-slate-300">Sharing Instructions</div>
                        <div className="mt-2 grid gap-1 md:grid-cols-2">
                            <div>1. Make a copy of the template cue sheet.</div>
                            <div>2. Fill out your service or session rundown.</div>
                            <div>3. Open the actual cue-sheet tab before copying the link.</div>
                            <div>4. Click Share in Google Sheets.</div>
                            <div>5. Set General access to Anyone with the link / Viewer.</div>
                            <div>6. Copy that tab link and paste it here.</div>
                        </div>
                    </div>
                </section>

                <section className="surface rounded-lg p-4">
                    <div className="text-[9px] font-bold uppercase tracking-[0.25em] text-slate-500">Backstage Output</div>
                    <div className="mt-3 grid grid-cols-2 gap-2">
                        <ActionButton icon={Radio} label={isBackstageOpen ? 'Output Open' : 'Open Output'} onClick={onOpenBackstage} tone={isBackstageOpen ? 'green' : 'blue'} />
                        <ActionButton icon={X} label="Close Output" onClick={onCloseBackstage} tone="red" />
                    </div>
                    <select
                        value={backstageDisplay}
                        onChange={e => setBackstageDisplay(e.target.value)}
                        className="control-field mt-3 w-full px-3 py-2 text-xs"
                    >
                        <option value="">Backstage Monitor Output...</option>
                        {displays.map(d => <option key={d.id} value={d.id}>{d.label}</option>)}
                    </select>
                    <div className="mt-3 grid grid-cols-2 gap-2">
                        {BACKSTAGE_DISPLAY_MODES.map(mode => (
                            <button
                                key={mode.id}
                                onClick={() => setDisplayMode(mode.id)}
                                className={`rounded-lg border px-2 py-2 text-[10px] font-bold uppercase tracking-wider transition ${displayMode === mode.id ? 'border-indigo-600 bg-indigo-600 text-white' : 'control-button-muted text-slate-600 dark:text-slate-300'}`}
                            >
                                {mode.label}
                            </button>
                        ))}
                    </div>
                </section>
            </div>

            <div className="grid grid-cols-2 gap-3 xl:grid-cols-5">
                <StatCard icon={Clock} label="Live Clock" value={new Date(now).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })} />
                <StatCard icon={Timer} label="Segment Left" value={currentRow ? formatDuration(currentRemaining) : '0:00'} tone={segmentOverBy > 0 ? 'red' : 'green'} />
                <StatCard icon={Play} label="Segment Elapsed" value={currentRow ? formatDuration(currentElapsed) : '0:00'} />
                <StatCard icon={Clock} label="Service Elapsed" value={formatDuration(serviceElapsed)} />
                <StatCard icon={AlertTriangle} label="Program Status" value={programDrift.label} tone={programDrift.tone} />
            </div>

            <div className="grid grid-cols-1 gap-3 xl:grid-cols-[1fr_360px]">
                <section className="surface overflow-hidden rounded-lg">
                    <div className="flex flex-wrap items-center justify-between gap-3 border-b section-rule p-3">
                        <div>
                            <div className="text-[9px] font-bold uppercase tracking-[0.25em] text-slate-500">Cue Preview</div>
                            <div className="mt-1 text-lg font-black text-slate-900 dark:text-white">{title}</div>
                        </div>
                        <div className="flex flex-wrap gap-2">
                            <ActionButton icon={SkipBack} label="Previous" onClick={goPrevious} disabled={currentIndex <= 0} />
                            <ActionButton icon={Play} label="Set Current" onClick={() => startRow(Math.max(0, currentIndex))} disabled={!rows.length} tone="green" />
                            <ActionButton icon={timing?.status === 'paused' ? Play : Pause} label={timing?.status === 'paused' ? 'Resume' : 'Pause'} onClick={pauseResume} disabled={!timing} tone="amber" />
                            <ActionButton icon={RotateCcw} label="Reset Segment" onClick={resetSegment} disabled={currentIndex < 0} />
                            <ActionButton icon={SkipForward} label="Next" onClick={goNext} disabled={!rows.length} tone="blue" />
                        </div>
                    </div>
                    <div className="max-h-[560px] overflow-auto">
                        <table className="w-full border-collapse text-left text-xs">
                            <thead className="surface-muted sticky top-0 z-10 text-[9px] font-bold uppercase tracking-wider text-slate-500">
                                <tr>
                                    {['Cue', 'Start', 'End', 'Duration', 'Segment', 'Description', 'Presenter', 'Audio', 'Playback', 'GFX', 'Lights', ...customLabels].map(label => (
                                        <th key={label} className="border-b section-rule px-3 py-2">{label}</th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {rows.length === 0 ? (
                                    <tr>
                                        <td colSpan={11 + customLabels.length} className="px-3 py-10 text-center text-sm text-slate-500">Load a Google Sheet to preview the backstage rundown.</td>
                                    </tr>
                                ) : rows.map((row, index) => {
                                    const isCurrent = index === currentIndex;
                                    const isDone = Boolean(completedRows[row.id]);
                                    const isNext = index === currentIndex + 1;
                                    return (
                                        <tr
                                            key={row.id}
                                            onClick={() => setCurrentIndex(index)}
                                            className={`cursor-pointer border-b section-rule transition ${isCurrent ? 'bg-emerald-500/15' : isNext ? 'bg-blue-500/10' : isDone ? 'surface-muted text-slate-400' : 'hover:bg-slate-500/10'}`}
                                        >
                                            <td className="px-3 py-2 font-black">{row.cueNo}</td>
                                            <td className="px-3 py-2 whitespace-nowrap">{row.start}</td>
                                            <td className="px-3 py-2 whitespace-nowrap">{row.end}</td>
                                            <td className="px-3 py-2 whitespace-nowrap">{row.duration}</td>
                                            <td className="px-3 py-2 min-w-32 font-bold">{row.segment}</td>
                                            <td className="px-3 py-2 min-w-56">{row.description}</td>
                                            <td className="px-3 py-2 min-w-32">{row.presenter}</td>
                                            <td className="px-3 py-2 min-w-40">{[row.audioBoard, row.audioPb].filter(Boolean).join(' / ')}</td>
                                            <td className="px-3 py-2 min-w-48">{[row.sideScreen, row.centerScreen].filter(Boolean).join(' / ')}</td>
                                            <td className="px-3 py-2 min-w-28">{row.gfx}</td>
                                            <td className="px-3 py-2 min-w-40">{[row.stage, row.house].filter(Boolean).join(' / ')}</td>
                                            {customLabels.map(label => (
                                                <td key={`${row.id}-${label}`} className="px-3 py-2 min-w-32">{row.customFields?.find(field => field.label === label)?.value || ''}</td>
                                            ))}
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                </section>

                <aside className="space-y-3">
                    <section className="surface rounded-lg p-3">
                        <div className="text-[9px] font-bold uppercase tracking-[0.25em] text-slate-500">Current / Next</div>
                        <div className="mt-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3">
                            <div className="text-[10px] font-bold uppercase tracking-wider text-emerald-700 dark:text-emerald-300">Current</div>
                            <div className="mt-1 text-lg font-black text-slate-900 dark:text-white">{currentRow ? getSegmentTitle(currentRow) : 'No current row'}</div>
                            <div className="mt-1 text-xs text-slate-500">{currentRow?.presenter || currentRow?.description || ''}</div>
                        </div>
                        <div className="mt-2 rounded-lg border border-blue-500/30 bg-blue-500/10 p-3">
                            <div className="text-[10px] font-bold uppercase tracking-wider text-blue-700 dark:text-blue-300">Next</div>
                            <div className="mt-1 text-lg font-black text-slate-900 dark:text-white">{nextRow ? getSegmentTitle(nextRow) : 'End of rundown'}</div>
                            <div className="mt-1 text-xs text-slate-500">{nextRow?.presenter || nextRow?.description || ''}</div>
                        </div>
                        <button onClick={resetProgram} className="control-button-muted mt-3 w-full px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-slate-600 dark:text-slate-300">
                            Reset Program Timing
                        </button>
                    </section>

                    <section className="surface rounded-lg p-3">
                        <div className="mb-3 flex items-center gap-2 text-[9px] font-bold uppercase tracking-[0.25em] text-slate-500">
                            <MessageSquare className="h-4 w-4" />
                            Send Message To Backstage
                        </div>
                        <textarea
                            value={messageText}
                            onChange={e => setMessageText(e.target.value)}
                            placeholder="Type a backstage-only message"
                            className="control-field min-h-24 w-full resize-y px-3 py-2 text-sm"
                        />
                        <div className="mt-2 grid grid-cols-2 gap-2">
                            <select
                                value={messageTone}
                                onChange={e => setMessageTone(e.target.value)}
                                className="control-field px-3 py-2 text-xs"
                            >
                                <option value="normal">Normal</option>
                                <option value="info">Info</option>
                                <option value="warning">Warning</option>
                                <option value="urgent">Urgent</option>
                            </select>
                            <label className="control-field flex items-center justify-between px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-slate-600 dark:text-slate-300">
                                Flash
                                <input type="checkbox" checked={messageFlash} onChange={e => setMessageFlash(e.target.checked)} />
                            </label>
                        </div>
                        <div className="mt-2 grid grid-cols-2 gap-2">
                            <ActionButton icon={Send} label="Send" onClick={() => sendMessage()} tone="blue" />
                            <ActionButton icon={X} label="Clear" onClick={clearMessage} tone="red" />
                        </div>
                        {messageFeedback && (
                            <div className="mt-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-[10px] font-bold text-emerald-700 dark:text-emerald-300">
                                {messageFeedback.text}
                            </div>
                        )}
                        <div className="mt-3 space-y-1.5">
                            <div className="text-[9px] font-bold uppercase tracking-[0.25em] text-slate-500">Editable Presets</div>
                            {messagePresets.length === 0 && (
                                <div className="surface-muted rounded-lg border-dashed px-3 py-3 text-center text-[10px] font-bold text-slate-500">
                                    No presets yet. Add your own below.
                                </div>
                            )}
                            {messagePresets.map((preset, index) => {
                                const trimmedPreset = preset.trim();
                                const isLastSent = backstageMessage?.text === trimmedPreset && messageFeedback?.text?.includes(trimmedPreset);
                                return (
                                    <div key={`preset-${index}`} className={`grid grid-cols-[1fr_34px_34px] gap-1.5 rounded-lg border p-1.5 transition ${isLastSent ? 'border-emerald-500/50 bg-emerald-500/10' : 'surface-muted'}`}>
                                        <input
                                            value={preset}
                                            onChange={e => updatePreset(index, e.target.value)}
                                            className="control-field min-w-0 px-2 py-1.5 text-xs font-bold"
                                        />
                                        <button
                                            onClick={() => sendMessage(trimmedPreset, 'Preset')}
                                            disabled={!trimmedPreset}
                                            title="Send preset"
                                            className="flex items-center justify-center rounded-md border border-blue-600 bg-blue-600 text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
                                        >
                                            <Send className="h-3.5 w-3.5" />
                                        </button>
                                        <button
                                            onClick={() => deletePreset(index)}
                                            title="Delete preset"
                                            className="flex items-center justify-center rounded-md border border-red-600 bg-red-600 text-white transition hover:bg-red-500"
                                        >
                                            <Trash2 className="h-3.5 w-3.5" />
                                        </button>
                                    </div>
                                );
                            })}
                            <div className="grid grid-cols-[1fr_78px] gap-1.5 pt-1">
                                <input
                                    value={newPresetText}
                                    onChange={e => setNewPresetText(e.target.value)}
                                    onKeyDown={e => {
                                        if (e.key === 'Enter') addPreset();
                                    }}
                                    placeholder="Add preset"
                                    className="control-field min-w-0 px-3 py-2 text-xs"
                                />
                                <button
                                    onClick={addPreset}
                                    disabled={!newPresetText.trim()}
                                    className="flex items-center justify-center gap-1.5 rounded-lg border border-emerald-600 bg-emerald-600 px-2 py-2 text-[10px] font-bold uppercase tracking-wider text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
                                >
                                    <Plus className="h-3.5 w-3.5" />
                                    Add
                                </button>
                            </div>
                        </div>
                    </section>
                </aside>
            </div>
        </div>
    );
}
