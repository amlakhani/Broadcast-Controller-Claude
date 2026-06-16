import { useState, useEffect } from 'react';
import { AlertTriangle, Check, Clock, EyeOff, MessageSquare, Play, Plus, Save, Send, Square, Trash2 } from 'lucide-react';
import { deferUntilIdle, readLocalStorageArraySafe, useDebouncedLocalStorageEffect } from '../utils/performance';

const PRESETS_KEY = 'bc_timer_presets_v1';
const MESSAGES_KEY = 'bc_message_bank_v1';

const DEFAULT_PRESETS = [
    { h: 0, m: 1, s: 0, label: '1m' },
    { h: 0, m: 5, s: 0, label: '5m' },
    { h: 0, m: 7, s: 0, label: '7m' },
    { h: 0, m: 10, s: 0, label: '10m' },
    { h: 0, m: 15, s: 0, label: '15m' },
    { h: 0, m: 20, s: 0, label: '20m' },
    { h: 0, m: 30, s: 0, label: '30m' },
    { h: 0, m: 40, s: 0, label: '40m' }
];

const DEFAULT_MESSAGES = [
    { text: 'Wrap up now', format: { color: 'red', bold: true, upper: true, flash: true, sizeOffset: 0 } },
    { text: 'Live Aarti', format: { color: 'default', bold: true, upper: false, flash: false, sizeOffset: 2 } },
    { text: 'Live Dhun', format: { color: 'default', bold: true, upper: false, flash: false, sizeOffset: 2 } },
    { text: 'Speak closer to mic', format: { color: 'green', bold: false, upper: false, flash: false, sizeOffset: 0 } },
    { text: 'Speak Loudly', format: { color: 'red', bold: true, upper: false, flash: false, sizeOffset: 1 } },
    { text: '1 min remaining', format: { color: 'red', bold: true, upper: false, flash: true, sizeOffset: 0 } }
];

function ToggleControl({ label, checked, onChange, activeClass = 'peer-checked:bg-indigo-500' }) {
    return (
        <label className="surface flex items-center justify-between gap-3 rounded-lg px-3 py-2">
            <span className="text-[10px] font-bold uppercase tracking-widest text-slate-600 dark:text-slate-400">{label}</span>
            <span className="relative inline-flex items-center">
                <input type="checkbox" checked={checked} onChange={onChange} className="peer sr-only" />
                <span className={`h-5 w-9 rounded-full bg-slate-200 transition after:absolute after:left-[2px] after:top-[2px] after:h-4 after:w-4 after:rounded-full after:border after:border-slate-300 after:bg-white after:transition-all peer-checked:after:translate-x-full peer-checked:after:border-white dark:bg-slate-700 ${activeClass}`} />
            </span>
        </label>
    );
}

function StatusPill({ label, value, tone = 'slate' }) {
    const toneClass = {
        slate: 'surface text-slate-700 dark:text-slate-300',
        blue: 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300',
        green: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
        amber: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300',
        red: 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300'
    }[tone];

    return (
        <div className={`min-h-14 rounded-lg border px-3 py-2 ${toneClass}`}>
            <div className="text-[9px] font-bold uppercase tracking-widest opacity-70">{label}</div>
            <div className="mt-1 truncate text-sm font-bold">{value}</div>
        </div>
    );
}

export default function StageDisplayPanel({ socket }) {
    const [showSlides, setShowSlides] = useState(false);
    const [negFlash, setNegFlash] = useState(true);
    const [negWhite, setNegWhite] = useState(false);

    const [hh, setHh] = useState('00');
    const [mm, setMm] = useState('05');
    const [ss, setSs] = useState('00');
    const [timerState, setTimerState] = useState('idle');
    const [timerEndTime, setTimerEndTime] = useState(0);
    const [timerTotalSeconds, setTimerTotalSeconds] = useState(0);
    const [timerMsRemaining, setTimerMsRemaining] = useState(0);
    const [timerMode, setTimerMode] = useState('down');
    const [progressPct, setProgressPct] = useState(100);
    const [progressColor, setProgressColor] = useState('rgb(59, 130, 246)');
    const [timerPresets, setTimerPresets] = useState(DEFAULT_PRESETS);
    const [isPresetEditMode, setIsPresetEditMode] = useState(false);
    const [savePresetBtnState, setSavePresetBtnState] = useState('SAVE CURRENT');

    const [messageText, setMessageText] = useState('');
    const [lastSentMessage, setLastSentMessage] = useState('');
    const [msgFormat, setMsgFormat] = useState({
        color: 'default',
        bold: false,
        upper: false,
        sizeOffset: 0,
        flash: false
    });
    const [messageBank, setMessageBank] = useState(DEFAULT_MESSAGES);
    const [isMsgEditMode, setIsMsgEditMode] = useState(false);
    const [saveMsgBtnState, setSaveMsgBtnState] = useState('SAVE CURRENT');

    useEffect(() => {
        let interval;
        if (timerState === 'running' && timerMode !== 'clock') {
            interval = setInterval(() => {
                const now = Date.now();

                if (timerMode === 'up') {
                    const startTime = timerEndTime - (timerTotalSeconds * 1000);
                    const elapsedMs = now - startTime;
                    if (timerTotalSeconds > 0) {
                        const pct = Math.min(1, elapsedMs / (timerTotalSeconds * 1000));
                        setProgressPct(pct * 100);
                        setProgressColor(`rgb(${Math.round(59 + (239 - 59) * pct)}, ${Math.round(130 + (68 - 130) * pct)}, ${Math.round(246 + (68 - 246) * pct)})`);
                    }
                    return;
                }

                const msLeft = Math.max(0, timerEndTime - now);
                if (timerTotalSeconds > 0) {
                    const pct = msLeft / (timerTotalSeconds * 1000);
                    const inverted = 1 - pct;
                    setProgressPct(pct * 100);
                    setProgressColor(`rgb(${Math.round(59 + (239 - 59) * inverted)}, ${Math.round(130 + (68 - 130) * inverted)}, ${Math.round(246 + (68 - 246) * inverted)})`);
                }
                if (msLeft <= 0) {
                    setTimerState('idle');
                    setProgressPct(0);
                    clearInterval(interval);
                }
            }, 100);
        } else if (timerState === 'idle' || timerMode === 'clock') {
            setProgressPct(100);
            setProgressColor('rgb(59, 130, 246)');
        }
        return () => clearInterval(interval);
    }, [timerState, timerEndTime, timerTotalSeconds, timerMode]);

    useEffect(() => {
        if (!socket) return;

        const handlePresToggle = (state) => setShowSlides(state);
        const handleNegFlash = (state) => setNegFlash(state);
        const handleNegWhite = (state) => setNegWhite(state);
        const handleMessageUpdate = (data) => {
            const text = typeof data === 'string' ? data : data?.text || '';
            setLastSentMessage(text);
        };

        socket.on('stage_pres_toggle_update', handlePresToggle);
        socket.on('stage_neg_flash_update', handleNegFlash);
        socket.on('stage_neg_white_update', handleNegWhite);
        socket.on('stage_message_update', handleMessageUpdate);
        socket.emit('request_stage_state');

        return () => {
            socket.off('stage_pres_toggle_update', handlePresToggle);
            socket.off('stage_neg_flash_update', handleNegFlash);
            socket.off('stage_neg_white_update', handleNegWhite);
            socket.off('stage_message_update', handleMessageUpdate);
        };
    }, [socket]);

    useEffect(() => deferUntilIdle(() => {
        setTimerPresets(readLocalStorageArraySafe(PRESETS_KEY, DEFAULT_PRESETS));
        setMessageBank(readLocalStorageArraySafe(MESSAGES_KEY, DEFAULT_MESSAGES));
    }), []);

    useDebouncedLocalStorageEffect(PRESETS_KEY, timerPresets);
    useDebouncedLocalStorageEffect(MESSAGES_KEY, messageBank);

    const setTimerModeAndClear = (mode) => {
        setTimerMode(mode);
        handleTimerStop();
    };

    const handleTimerStartPauseResume = () => {
        if (timerMode === 'clock') {
            if (timerState === 'running') {
                handleTimerStop();
                return;
            }
            setTimerState('idle');
            setProgressPct(100);
            socket?.emit('stop_stage_timer');
            setTimeout(() => {
                socket?.emit('set_stage_timer', { mode: 'clock' });
                setTimerState('running');
            }, 50);
            return;
        }

        if (timerState === 'idle') {
            const h = parseInt(hh) || 0;
            const m = parseInt(mm) || 0;
            const s = parseInt(ss) || 0;
            const total = (h * 3600) + (m * 60) + s;
            if (total <= 0) return;

            const now = Date.now();
            const endTime = now + total * 1000;
            setTimerTotalSeconds(total);
            setTimerEndTime(endTime);
            setTimerState('running');
            socket?.emit('set_stage_timer', { endTime, totalSeconds: total, mode: timerMode, startTime: now });
        } else if (timerState === 'running') {
            setTimerMsRemaining(timerEndTime - Date.now());
            setTimerState('paused');
            socket?.emit('pause_stage_timer');
        } else if (timerState === 'paused') {
            const endTime = Date.now() + timerMsRemaining;
            setTimerEndTime(endTime);
            setTimerState('running');
            socket?.emit('resume_stage_timer', { endTime, totalSeconds: timerTotalSeconds, mode: timerMode });
        }
    };

    function handleTimerStop() {
        setTimerState('idle');
        setProgressPct(100);
        socket?.emit('stop_stage_timer');
    }

    const handleSavePreset = () => {
        const h = parseInt(hh) || 0;
        const m = parseInt(mm) || 0;
        const s = parseInt(ss) || 0;
        if (h === 0 && m === 0 && s === 0) {
            alert('Please set a time greater than zero.');
            return;
        }

        if (!timerPresets.some(p => p.h === h && p.m === m && p.s === s)) {
            setTimerPresets([...timerPresets, { h, m, s, label: '' }]);
        }
        setSavePresetBtnState('SAVED');
        setTimeout(() => setSavePresetBtnState('SAVE CURRENT'), 1500);
    };

    const deletePreset = (idx, e) => {
        e.stopPropagation();
        setTimerPresets(timerPresets.filter((_, i) => i !== idx));
    };

    const applyPreset = (preset) => {
        if (isPresetEditMode) return;
        setHh(String(preset.h).padStart(2, '0'));
        setMm(String(preset.m).padStart(2, '0'));
        setSs(String(preset.s).padStart(2, '0'));
    };

    const emitMessage = (text = messageText, format = msgFormat) => {
        setLastSentMessage(text.trim());
        socket?.emit('set_stage_message', { text, format });
    };

    const handleFormatChange = (field, value) => {
        setMsgFormat(prev => {
            const next = { ...prev, [field]: value };
            emitMessage(messageText, next);
            return next;
        });
    };

    const toggleFormat = (field) => {
        setMsgFormat(prev => {
            const next = { ...prev, [field]: !prev[field] };
            emitMessage(messageText, next);
            return next;
        });
    };

    const handleClearMsg = () => {
        setMessageText('');
        emitMessage('', msgFormat);
    };

    const handleSaveMessage = () => {
        const text = messageText.trim();
        if (!text) return;

        setMessageBank(prev => {
            const next = [...prev];
            const existing = next.find(m => m.text === text);
            if (existing) existing.format = { ...msgFormat };
            else next.push({ text, format: { ...msgFormat } });
            return next;
        });
        setSaveMsgBtnState('SAVED');
        setTimeout(() => setSaveMsgBtnState('SAVE CURRENT'), 1500);
    };

    const deleteMessage = (idx, e) => {
        e.stopPropagation();
        setMessageBank(messageBank.filter((_, i) => i !== idx));
    };

    const applyMessage = (msg) => {
        if (isMsgEditMode) return;
        setMessageText(msg.text);
        if (msg.format) setMsgFormat({ ...msg.format });
    };

    const renderFormatBtnClass = (isActive, extraClass = '') => {
        return `h-9 w-9 rounded-lg border text-sm font-bold transition active:scale-95 ${isActive
            ? `border-white/40 bg-slate-800 text-white shadow-sm dark:bg-slate-700 ${extraClass}`
            : `control-button text-slate-700 dark:text-slate-200 ${extraClass}`}`;
    };

    const modeButtonClass = (mode, activeClass) => `h-10 rounded-lg text-xs font-bold uppercase tracking-wider transition ${timerMode === mode ? `${activeClass} text-white shadow-sm` : 'text-slate-600 hover:bg-white dark:text-slate-400 dark:hover:bg-slate-900'}`;
    const actionLabel = timerState === 'idle' ? (timerMode === 'clock' ? 'Show Clock' : `Start ${timerMode}`) : timerState === 'running' ? (timerMode === 'clock' ? 'Hide Clock' : 'Pause Timer') : 'Resume Timer';
    const timerTone = timerState === 'running' ? 'green' : timerState === 'paused' ? 'amber' : 'slate';

    return (
        <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 xl:grid-cols-3">
                <StatusPill label="Timer" value={`${timerMode.toUpperCase()} / ${timerState.toUpperCase()}`} tone={timerTone} />
                <StatusPill label="Slides" value={showSlides ? 'Stage slides on' : 'Timer only'} tone={showSlides ? 'blue' : 'slate'} />
                <StatusPill label="Message" value={lastSentMessage || 'Clear'} tone={lastSentMessage ? 'red' : 'slate'} />
            </div>

            <div className="grid grid-cols-1 gap-4 2xl:grid-cols-[minmax(380px,0.85fr)_minmax(520px,1.15fr)]">
                <section className="surface space-y-4 rounded-lg p-4">
                    <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-2">
                            <Clock className="h-4 w-4 text-blue-500" />
                            <h4 className="text-sm font-bold text-slate-900 dark:text-white">Timer Controls</h4>
                        </div>
                        <div className="grid grid-cols-3 gap-2">
                            <ToggleControl label="Slides" checked={showSlides} onChange={e => { setShowSlides(e.target.checked); socket?.emit('set_stage_pres_toggle', e.target.checked); }} />
                            <ToggleControl label="Flash" checked={negFlash} onChange={e => { setNegFlash(e.target.checked); socket?.emit('set_stage_neg_flash', e.target.checked); }} activeClass="peer-checked:bg-red-500" />
                            <ToggleControl label="White" checked={negWhite} onChange={e => { setNegWhite(e.target.checked); socket?.emit('set_stage_neg_white', e.target.checked); }} activeClass="peer-checked:bg-slate-400" />
                        </div>
                    </div>

                    <div className="surface-muted grid grid-cols-3 gap-1 rounded-lg p-1.5">
                        <button onClick={() => setTimerModeAndClear('down')} className={modeButtonClass('down', 'bg-blue-600')}>Down</button>
                        <button onClick={() => setTimerModeAndClear('up')} className={modeButtonClass('up', 'bg-indigo-600')}>Up</button>
                        <button onClick={() => setTimerModeAndClear('clock')} className={modeButtonClass('clock', 'bg-emerald-600')}>Clock</button>
                    </div>

                    {timerMode !== 'clock' && (
                        <div className="grid grid-cols-3 gap-3">
                            {[
                                ['Hours', hh, setHh, 3, 999],
                                ['Minutes', mm, setMm, 2, 59],
                                ['Seconds', ss, setSs, 2, 59]
                            ].map(([label, value, setter, maxLen, max]) => (
                                <label key={label} className="space-y-1.5">
                                    <span className="block text-xs font-semibold text-slate-600 dark:text-slate-400">{label}</span>
                                    <input
                                        type="text"
                                        inputMode="numeric"
                                        value={value}
                                        onChange={e => setter(e.target.value.replace(/[^0-9]/g, '').slice(0, maxLen))}
                                        onBlur={e => setter(String(Math.min(max, Math.max(0, parseInt(e.target.value) || 0))).padStart(2, '0'))}
                                        disabled={timerState !== 'idle'}
                                        className="control-field h-12 px-3 text-center font-mono text-xl font-bold disabled:opacity-50"
                                    />
                                </label>
                            ))}
                        </div>
                    )}

                    <div className="grid grid-cols-[1fr_auto] gap-3">
                        <button onClick={handleTimerStartPauseResume} className={`flex h-12 items-center justify-center gap-2 rounded-xl px-4 text-sm font-bold uppercase tracking-wider text-white transition active:scale-95 ${timerState === 'idle' ? 'bg-blue-600 hover:bg-blue-500' : timerState === 'running' ? 'bg-amber-600 hover:bg-amber-500' : 'bg-emerald-600 hover:bg-emerald-500'}`}>
                            <Play className="h-4 w-4" />
                            {actionLabel}
                        </button>
                        <button onClick={handleTimerStop} className="flex h-12 w-12 items-center justify-center rounded-xl border border-red-600/30 bg-red-600/10 text-red-600 transition hover:bg-red-600 hover:text-white active:scale-95" title="Stop and clear timer">
                            <Square className="h-4 w-4" />
                        </button>
                    </div>

                    <div className="surface h-4 overflow-hidden rounded-full">
                        <div className="h-full transition-all duration-100 ease-linear" style={{ width: `${progressPct}%`, backgroundColor: progressColor }} />
                    </div>

                    <div className="space-y-3">
                        <div className="flex items-center justify-between">
                            <h4 className="text-xs font-bold uppercase tracking-widest text-slate-500">Quick Presets</h4>
                            <div className="flex items-center gap-2">
                                <button onClick={() => setIsPresetEditMode(!isPresetEditMode)} className={`text-[10px] font-bold uppercase tracking-wider ${isPresetEditMode ? 'text-emerald-500' : 'text-slate-500 hover:text-slate-900 dark:hover:text-white'}`}>{isPresetEditMode ? 'Done' : 'Edit'}</button>
                                <button onClick={handleSavePreset} className="inline-flex h-8 items-center gap-1 rounded-lg border border-indigo-500/30 bg-indigo-600/10 px-2 text-[10px] font-bold uppercase tracking-wider text-indigo-500">
                                    {savePresetBtnState === 'SAVED' ? <Check className="h-3 w-3" /> : <Plus className="h-3 w-3" />}
                                    {savePresetBtnState}
                                </button>
                            </div>
                        </div>
                        <div className="grid grid-cols-4 gap-2">
                            {timerPresets.map((p, idx) => {
                                const timeLabel = p.label || [p.h > 0 ? `${p.h}h` : '', p.m > 0 || (p.h === 0 && p.s === 0) ? `${p.m}m` : '', p.s > 0 ? `${p.s}s` : ''].filter(Boolean).join(' ');
                                return (
                                    <button key={`${timeLabel}-${idx}`} onClick={() => applyPreset(p)} className={`control-button-muted relative flex min-h-11 items-center justify-center text-sm font-bold text-slate-700 hover:border-indigo-500 hover:bg-indigo-600 hover:text-white dark:text-slate-200 ${isPresetEditMode ? 'border-indigo-500/60' : ''}`}>
                                        {timeLabel}
                                        {idx >= DEFAULT_PRESETS.length && isPresetEditMode && (
                                            <span onClick={(e) => deletePreset(idx, e)} className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded bg-red-500/20 text-red-500 hover:bg-red-500 hover:text-white">
                                                <Trash2 className="h-3 w-3" />
                                            </span>
                                        )}
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                </section>

                <section>
                    <div className="surface space-y-4 rounded-lg p-4">
                        <div className="flex items-center gap-2">
                            <MessageSquare className="h-4 w-4 text-emerald-500" />
                            <h4 className="text-sm font-bold text-slate-900 dark:text-white">Stage Message</h4>
                        </div>
                        <textarea value={messageText} onChange={e => setMessageText(e.target.value)} rows="4" className="control-field w-full resize-none px-3 py-2 text-sm" placeholder="Urgent message for the speaker..." />

                        <div className="flex flex-wrap items-center gap-2">
                            <button onClick={() => handleFormatChange('color', 'default')} className={renderFormatBtnClass(msgFormat.color === 'default')}>A</button>
                            <button onClick={() => handleFormatChange('color', 'green')} className={renderFormatBtnClass(msgFormat.color === 'green', 'text-emerald-500')}>A</button>
                            <button onClick={() => handleFormatChange('color', 'red')} className={renderFormatBtnClass(msgFormat.color === 'red', 'text-red-500')}>A</button>
                            <button onClick={() => toggleFormat('bold')} className={renderFormatBtnClass(msgFormat.bold)}>B</button>
                            <button onClick={() => toggleFormat('upper')} className={renderFormatBtnClass(msgFormat.upper)}>aA</button>
                            <button onClick={() => toggleFormat('flash')} className={renderFormatBtnClass(msgFormat.flash, 'text-amber-500')} title="Flash attention">
                                <AlertTriangle className="mx-auto h-4 w-4" />
                            </button>
                            <label className="surface ml-0 flex min-w-40 flex-1 items-center gap-2 rounded-lg px-3 py-2">
                                <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Size</span>
                                <input type="range" min="-10" max="10" value={msgFormat.sizeOffset} onChange={e => handleFormatChange('sizeOffset', parseInt(e.target.value))} className="h-2 w-full cursor-pointer appearance-none rounded-lg bg-slate-200 dark:bg-slate-700 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-indigo-500" />
                            </label>
                        </div>

                        <div className="grid grid-cols-[1fr_auto_auto] gap-2">
                            <button onClick={() => emitMessage()} className="flex h-11 items-center justify-center gap-2 rounded-xl bg-emerald-600 px-3 text-sm font-bold uppercase tracking-wider text-white transition hover:bg-emerald-500 active:scale-95">
                                <Send className="h-4 w-4" />
                                Send Message
                            </button>
                            <button onClick={handleSaveMessage} className="flex h-11 w-11 items-center justify-center rounded-xl border border-indigo-500/30 bg-indigo-600/10 text-indigo-600 transition hover:bg-indigo-600 hover:text-white" title={saveMsgBtnState}>
                                {saveMsgBtnState === 'SAVED' ? <Check className="h-4 w-4" /> : <Save className="h-4 w-4" />}
                            </button>
                            <button onClick={handleClearMsg} className="flex h-11 w-11 items-center justify-center rounded-xl border border-red-500/30 bg-red-600/10 text-red-600 transition hover:bg-red-600 hover:text-white" title="Clear message">
                                <EyeOff className="h-4 w-4" />
                            </button>
                        </div>
                    </div>
                </section>
            </div>

            <div>
                <section className="surface space-y-3 rounded-lg p-4">
                    <div className="flex items-center justify-between">
                        <h4 className="text-xs font-bold uppercase tracking-widest text-slate-500">Message Bank</h4>
                        <button onClick={() => setIsMsgEditMode(!isMsgEditMode)} className={`text-[10px] font-bold uppercase tracking-wider ${isMsgEditMode ? 'text-emerald-500' : 'text-slate-500 hover:text-slate-900 dark:hover:text-white'}`}>{isMsgEditMode ? 'Done' : 'Edit'}</button>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                        {messageBank.map((m, idx) => (
                            <button key={`${m.text}-${idx}`} onClick={() => applyMessage(m)} className={`control-button-muted relative flex min-h-14 items-center justify-center px-3 py-2 text-center text-xs font-semibold text-slate-700 hover:border-emerald-500 hover:bg-emerald-600 hover:text-white dark:text-slate-200 ${isMsgEditMode ? 'border-emerald-500/60' : ''}`}>
                                <span className="line-clamp-2">{m.text}</span>
                                {idx >= DEFAULT_MESSAGES.length && isMsgEditMode && (
                                    <span onClick={(e) => deleteMessage(idx, e)} className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded bg-red-500/20 text-red-500 hover:bg-red-500 hover:text-white">
                                        <Trash2 className="h-3 w-3" />
                                    </span>
                                )}
                            </button>
                        ))}
                    </div>
                </section>
            </div>
        </div>
    );
}
