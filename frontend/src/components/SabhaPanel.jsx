import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, ChevronDown, Clock3, Minus, Palette, Play, Plus, SlidersHorizontal, Square, Type } from 'lucide-react';

const TIME_PRESETS = [
    { time: '15:45', label: '3:45 PM' },
    { time: '15:50', label: '3:50 PM' },
    { time: '16:00', label: '4:00 PM' },
    { time: '16:10', label: '4:10 PM' },
    { time: '16:15', label: '4:15 PM' },
    { time: '16:30', label: '4:30 PM' },
    { time: '17:00', label: '5:00 PM' }
];

const FONT_OPTIONS = [
    { value: "'Outfit', sans-serif", label: 'Outfit' },
    { value: "'Inter', sans-serif", label: 'Inter' },
    { value: "'Roboto', sans-serif", label: 'Roboto' },
    { value: "'Playfair Display', serif", label: 'Playfair' },
    { value: "'Montserrat', sans-serif", label: 'Montserrat' }
];

const MESSAGE_FONT_OPTIONS = [
    ...FONT_OPTIONS,
    { value: "'Rasa', serif", label: 'Rasa' }
];

const WEIGHT_OPTIONS = [
    { value: '300', label: 'Light' },
    { value: '400', label: 'Regular' },
    { value: '500', label: 'Medium' },
    { value: '600', label: 'SemiBold' },
    { value: '700', label: 'Bold' },
    { value: '800', label: 'ExtraBold' }
];

const fieldClass = 'control-field px-3 py-2 text-sm';
const labelClass = 'text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400';

const clampNumber = (value, min, max, fallback) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
};

const formatTime12Hour = (timeStr) => {
    const [h, m] = timeStr.split(':');
    let hours = parseInt(h, 10);
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours %= 12;
    hours = hours || 12;
    return `${hours}:${m} ${ampm}`;
};

const getSecondsUntil = (timeStr, now = new Date()) => {
    if (!timeStr) return 0;
    const [h, m] = timeStr.split(':').map(Number);
    const target = new Date(now);
    target.setHours(h, m, 0, 0);
    if (target <= now) target.setDate(target.getDate() + 1);
    return Math.max(0, Math.floor((target - now) / 1000));
};

const formatDuration = (seconds) => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
    return `${minutes}m ${String(secs).padStart(2, '0')}s`;
};

const formatTimer = (seconds) => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
};

const previewGradient = ({ enabled, bgIntensity, bgHeight, bgSoftness }) => {
    if (!enabled) return null;
    const intensity = clampNumber(bgIntensity, 0, 100, 95) / 100;
    const height = clampNumber(bgHeight, 0, 100, 100);
    const softness = clampNumber(bgSoftness, 0, 100, 75) / 100;
    if (intensity <= 0 || height <= 0) return null;
    const maxAlpha = Math.pow(intensity, 0.86) * 0.96;
    const reachStop = 18 + height * 0.82;
    const holdStop = Math.max(2, reachStop * (0.12 - softness * 0.06));
    const midStop = reachStop * (0.36 + softness * 0.1);
    const featherStop = reachStop * (0.68 + softness * 0.18);
    return `linear-gradient(to top, rgba(0,0,0,${maxAlpha}) 0%, rgba(0,0,0,${maxAlpha * 0.86}) ${holdStop}%, rgba(0,0,0,${maxAlpha * 0.52}) ${midStop}%, rgba(0,0,0,${maxAlpha * 0.16}) ${featherStop}%, transparent ${reachStop}%, transparent 100%)`;
};

function Section({ icon: Icon, title, children, defaultOpen = false }) {
    return (
        <details className="surface group rounded-lg" open={defaultOpen}>
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3">
                <div className="flex items-center gap-2">
                    <span className="surface-muted flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 dark:text-slate-300">
                        <Icon className="h-4 w-4" />
                    </span>
                    <h4 className="text-xs font-bold uppercase tracking-widest text-slate-600 dark:text-slate-300">{title}</h4>
                </div>
                <ChevronDown className="h-4 w-4 text-slate-400 transition group-open:rotate-180" />
            </summary>
            <div className="border-t section-rule px-4 py-4">
                {children}
            </div>
        </details>
    );
}

function ColorField({ label, value, onChange }) {
    return (
        <label className="space-y-1.5">
            <span className={labelClass}>{label}</span>
            <div className="control-field flex items-center gap-2 p-1.5">
                <input
                    type="color"
                    value={value}
                    onChange={e => onChange(e.target.value)}
                    className="h-7 w-9 shrink-0 cursor-pointer rounded border-0 bg-transparent p-0"
                />
                <input
                    type="text"
                    value={value}
                    onChange={e => onChange(e.target.value)}
                    className="min-w-0 flex-1 bg-transparent text-xs font-bold uppercase text-slate-700 outline-none dark:text-slate-200"
                />
            </div>
        </label>
    );
}

function NumberStepper({ label, value, onChange, min = 0, step = 1 }) {
    const numericValue = clampNumber(value, min, 999, min);
    const apply = (next) => onChange(String(Math.max(min, next)));

    return (
        <label className="space-y-1.5">
            <span className={labelClass}>{label}</span>
            <div className="control-field grid h-10 grid-cols-[36px_1fr_36px] overflow-hidden p-0">
                <button type="button" onClick={() => apply(numericValue - step)} className="flex items-center justify-center text-slate-500 transition hover:bg-slate-100 dark:hover:bg-slate-800" title={`Decrease ${label}`}>
                    <Minus className="h-3.5 w-3.5" />
                </button>
                <input
                    type="number"
                    value={value}
                    onChange={e => onChange(e.target.value)}
                    className="min-w-0 border-x section-rule bg-transparent text-center text-sm font-bold text-slate-900 outline-none [appearance:textfield] dark:text-white [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                />
                <button type="button" onClick={() => apply(numericValue + step)} className="flex items-center justify-center text-slate-500 transition hover:bg-slate-100 dark:hover:bg-slate-800" title={`Increase ${label}`}>
                    <Plus className="h-3.5 w-3.5" />
                </button>
            </div>
        </label>
    );
}

function RangeField({ label, value, onChange, lowLabel, highLabel }) {
    return (
        <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
                <label className="text-[11px] font-semibold text-slate-600 dark:text-slate-300">{label}</label>
                <span className="rounded-md bg-indigo-500/10 px-2 py-0.5 text-[10px] font-bold text-indigo-500">{value}%</span>
            </div>
            <input type="range" min="0" max="100" value={value} onChange={e => onChange(Number(e.target.value))} className="h-1.5 w-full cursor-pointer appearance-none rounded-lg bg-slate-200 accent-indigo-500 dark:bg-slate-700" />
            <div className="flex justify-between text-[9px] font-bold uppercase tracking-wider text-slate-400">
                <span>{lowLabel}</span>
                <span>{highLabel}</span>
            </div>
        </div>
    );
}

export default function SabhaPanel({ socket }) {
    const [targetTime, setTargetTime] = useState('16:00');
    const [customH, setCustomH] = useState('');
    const [customM, setCustomM] = useState('');
    const [customAmPm, setCustomAmPm] = useState('PM');
    const [now, setNow] = useState(() => new Date());

    const [message, setMessage] = useState('Sabha Starts In');
    const [showing, setShowing] = useState(false);
    const [overlayMedia] = useState(false);

    const [msgFont, setMsgFont] = useState("'Outfit', sans-serif");
    const [msgWeight, setMsgWeight] = useState('700');
    const [msgSize, setMsgSize] = useState('36');
    const [msgSpacing, setMsgSpacing] = useState('5');
    const [msgColor, setMsgColor] = useState('#ffffff');

    const [timerFont, setTimerFont] = useState("'Outfit', sans-serif");
    const [timerWeight, setTimerWeight] = useState('700');
    const [timerSize, setTimerSize] = useState('130');
    const [timerSpacing, setTimerSpacing] = useState('0');
    const [timerColor, setTimerColor] = useState('#ffffff');

    const [bgIntensity, setBgIntensity] = useState(95);
    const [bgHeight, setBgHeight] = useState(100);
    const [bgSoftness, setBgSoftness] = useState(75);
    const [isGradEnabled, setIsGradEnabled] = useState(true);

    const secondsUntil = useMemo(() => getSecondsUntil(targetTime, now), [targetTime, now]);
    const previewTimer = useMemo(() => formatTimer(secondsUntil), [secondsUntil]);
    const selectedPreset = TIME_PRESETS.find(preset => preset.time === targetTime);
    const gradientPreview = previewGradient({ enabled: isGradEnabled, bgIntensity, bgHeight, bgSoftness });

    const emitState = useCallback(() => {
        if (!socket) return;
        if (showing) {
            socket.emit('sabha_timer_update', {
                timeStr: targetTime,
                showing: true,
                message,
                overlayMedia,
                style: {
                    msg: { fontFamily: msgFont, fontWeight: msgWeight, fontSize: msgSize, letterSpacing: msgSpacing, color: msgColor },
                    timer: { fontFamily: timerFont, fontWeight: timerWeight, fontSize: timerSize, letterSpacing: timerSpacing, color: timerColor },
                    gradient: { enabled: isGradEnabled, bgIntensity, bgHeight, bgSoftness }
                }
            });
        } else {
            socket.emit('sabha_timer_update', { timeStr: targetTime, showing: false });
        }
    }, [bgHeight, bgIntensity, bgSoftness, isGradEnabled, message, msgColor, msgFont, msgSize, msgSpacing, msgWeight, overlayMedia, showing, socket, targetTime, timerColor, timerFont, timerSize, timerSpacing, timerWeight]);

    useEffect(() => {
        const interval = setInterval(() => setNow(new Date()), 1000);
        return () => clearInterval(interval);
    }, []);

    useEffect(() => {
        emitState();
    }, [emitState]);

    const handleCustomSet = () => {
        let h = parseInt(customH, 10) || 12;
        let m = parseInt(customM, 10) || 0;

        if (h < 1) h = 1;
        if (h > 12) h = 12;
        if (m < 0) m = 0;
        if (m > 59) m = 59;

        setCustomH(h.toString());
        setCustomM(m.toString().padStart(2, '0'));

        let milH = h;
        if (customAmPm === 'PM' && milH !== 12) milH += 12;
        if (customAmPm === 'AM' && milH === 12) milH = 0;

        setTargetTime(`${String(milH).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
    };

    return (
        <div className="space-y-4">
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(380px,0.95fr)_minmax(420px,1.05fr)]">
                <section className="surface overflow-hidden rounded-lg">
                    <div className="border-b section-rule p-4">
                        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
                            <div>
                                <div className="flex items-center gap-2">
                                    <span className={`h-2.5 w-2.5 rounded-full ${showing ? 'bg-emerald-500 shadow-[0_0_14px_rgba(16,185,129,0.7)]' : 'bg-slate-400'}`} />
                                    <span className="text-[10px] font-black uppercase tracking-widest text-slate-500 dark:text-slate-400">{showing ? 'Live on graphics' : 'Ready to cue'}</span>
                                </div>
                                <h3 className="mt-2 text-xl font-black tracking-tight text-slate-950 dark:text-white">Countdown Console</h3>
                            </div>
                            <button
                                onClick={() => setShowing(prev => !prev)}
                                className={`flex min-h-10 items-center justify-center gap-2 rounded-lg px-4 text-[10px] font-black uppercase tracking-widest transition focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-white active:scale-95 dark:focus:ring-offset-[#181715] ${
                                    showing
                                        ? 'border border-rose-500/25 bg-rose-500/10 text-rose-500 hover:bg-rose-500/15 focus:ring-rose-500/40'
                                        : 'bg-emerald-600 text-white shadow-lg shadow-emerald-600/20 hover:bg-emerald-500 focus:ring-emerald-500/40'
                                }`}
                            >
                                {showing ? <Square className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                                {showing ? 'Hide Countdown' : 'Show Countdown'}
                            </button>
                        </div>

                        <div className="grid grid-cols-2 gap-3">
                            <div className="surface-muted rounded-lg p-3">
                                <div className={labelClass}>Target</div>
                                <div className="mt-1 text-2xl font-black tracking-wide text-slate-950 dark:text-white">{formatTime12Hour(targetTime)}</div>
                            </div>
                            <div className="surface-muted rounded-lg p-3">
                                <div className={labelClass}>Countdown</div>
                                <div className="mt-1 text-2xl font-black tabular-nums tracking-wide text-slate-950 dark:text-white">{formatDuration(secondsUntil)}</div>
                            </div>
                        </div>
                    </div>

                    <div className="p-4">
                        <label className="space-y-1.5">
                            <span className={labelClass}>Top Message</span>
                            <input type="text" value={message} onChange={e => setMessage(e.target.value)} className={fieldClass} />
                        </label>

                        <div className="mt-4">
                            <div className="mb-2 flex items-center justify-between gap-2">
                                <span className={labelClass}>Preset Cues</span>
                                <span className="text-[10px] font-semibold text-slate-500 dark:text-slate-400">{selectedPreset ? selectedPreset.label : 'Custom'} selected</span>
                            </div>
                            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                                {TIME_PRESETS.map(preset => {
                                    const selected = targetTime === preset.time;
                                    return (
                                        <button
                                            key={preset.time}
                                            onClick={() => setTargetTime(preset.time)}
                                            className={`min-h-14 rounded-lg border px-3 py-2 text-left transition active:scale-[0.98] ${
                                                selected
                                                    ? 'border-indigo-400 bg-indigo-600 text-white shadow-lg shadow-indigo-600/20'
                                                    : 'surface-muted text-slate-700 hover:border-indigo-300 hover:text-indigo-600 dark:text-slate-200 dark:hover:border-indigo-500/60 dark:hover:text-white'
                                            }`}
                                        >
                                            <div className="flex items-center justify-between gap-2">
                                                <span className="text-sm font-black">{preset.label}</span>
                                                {selected && <Check className="h-3.5 w-3.5" />}
                                            </div>
                                            <div className={`mt-1 text-[10px] font-bold uppercase tracking-wider ${selected ? 'text-indigo-100' : 'text-slate-400'}`}>
                                                {formatDuration(getSecondsUntil(preset.time, now))}
                                            </div>
                                        </button>
                                    );
                                })}
                            </div>
                        </div>

                        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
                            <div className="grid grid-cols-3 items-end gap-2">
                                <label className="space-y-1.5">
                                    <span className={labelClass}>HH</span>
                                    <input type="number" min="1" max="12" placeholder="12" value={customH} onChange={e => setCustomH(e.target.value)} className={`${fieldClass} text-center [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none`} />
                                </label>
                                <label className="space-y-1.5">
                                    <span className={labelClass}>MM</span>
                                    <input type="number" min="0" max="59" placeholder="00" value={customM} onChange={e => setCustomM(e.target.value)} className={`${fieldClass} text-center [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none`} />
                                </label>
                                <label className="space-y-1.5">
                                    <span className={labelClass}>AM/PM</span>
                                    <select value={customAmPm} onChange={e => setCustomAmPm(e.target.value)} className={fieldClass}>
                                        <option value="AM">AM</option>
                                        <option value="PM">PM</option>
                                    </select>
                                </label>
                            </div>
                            <button onClick={handleCustomSet} className="h-10 rounded-lg bg-slate-800 px-4 text-xs font-black uppercase tracking-wider text-white transition hover:bg-slate-700 active:scale-95 dark:bg-stone-700 dark:hover:bg-stone-600">
                                Set
                            </button>
                        </div>
                    </div>
                </section>

                <section className="surface rounded-lg p-3">
                    <div className="mb-2 flex items-center justify-between gap-2 px-1">
                        <div className="flex items-center gap-2">
                            <Clock3 className="h-4 w-4 text-indigo-300" />
                            <h3 className="text-xs font-black uppercase tracking-widest text-slate-600 dark:text-slate-300">On-Air Preview</h3>
                        </div>
                        <span className={`rounded-full px-2 py-1 text-[9px] font-black uppercase tracking-widest ${showing ? 'border border-emerald-400/30 bg-emerald-400/10 text-emerald-500 dark:text-emerald-200' : 'surface-muted text-slate-500 dark:text-slate-400'}`}>
                            {showing ? 'Live' : 'Hidden'}
                        </span>
                    </div>
                    <div className="relative aspect-video max-h-[320px] overflow-hidden rounded-lg border border-slate-700 bg-[radial-gradient(circle_at_50%_20%,rgba(79,70,229,0.22),transparent_36%),linear-gradient(140deg,#030712,#111827_45%,#020617)] xl:max-h-none">
                        {gradientPreview && <div className="absolute inset-0" style={{ background: gradientPreview }} />}
                        <div className="absolute inset-x-0 bottom-0 z-10 flex flex-col items-center px-4 pb-[8%] pt-[10%]">
                            <div
                                className="max-w-full truncate text-center uppercase"
                                style={{
                                    fontFamily: msgFont,
                                    fontWeight: msgWeight,
                                    fontSize: `${Math.max(9, Number(msgSize || 36) * 0.23)}px`,
                                    letterSpacing: `${Math.max(0, Number(msgSpacing || 0) * 0.16)}px`,
                                    color: msgColor,
                                    marginBottom: '0.35rem'
                                }}
                            >
                                {message || 'Sabha Starts In'}
                            </div>
                            <div
                                className="max-w-full text-center leading-none"
                                style={{
                                    fontFamily: timerFont,
                                    fontWeight: timerWeight,
                                    fontSize: `${Math.max(26, Number(timerSize || 130) * 0.34)}px`,
                                    letterSpacing: `${Math.max(0, Number(timerSpacing || 0) * 0.18)}px`,
                                    color: timerColor,
                                    textShadow: '0 10px 30px rgba(0,0,0,0.9)',
                                    fontVariantNumeric: 'tabular-nums'
                                }}
                            >
                                {previewTimer}
                            </div>
                        </div>
                    </div>
                </section>
            </div>

            <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
                <Section icon={Type} title="Timer" defaultOpen>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <label className="space-y-1.5">
                            <span className={labelClass}>Font Family</span>
                            <select value={timerFont} onChange={e => setTimerFont(e.target.value)} className={fieldClass}>
                                {FONT_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                            </select>
                        </label>
                        <label className="space-y-1.5">
                            <span className={labelClass}>Weight</span>
                            <select value={timerWeight} onChange={e => setTimerWeight(e.target.value)} className={fieldClass}>
                                {WEIGHT_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                            </select>
                        </label>
                        <NumberStepper label="Size" value={timerSize} onChange={setTimerSize} min={10} step={2} />
                        <NumberStepper label="Spacing" value={timerSpacing} onChange={setTimerSpacing} min={0} step={1} />
                        <div className="sm:col-span-2">
                            <ColorField label="Color" value={timerColor} onChange={setTimerColor} />
                        </div>
                    </div>
                </Section>

                <Section icon={SlidersHorizontal} title="Message" defaultOpen>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <label className="space-y-1.5">
                            <span className={labelClass}>Font Family</span>
                            <select value={msgFont} onChange={e => setMsgFont(e.target.value)} className={fieldClass}>
                                {MESSAGE_FONT_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                            </select>
                        </label>
                        <label className="space-y-1.5">
                            <span className={labelClass}>Weight</span>
                            <select value={msgWeight} onChange={e => setMsgWeight(e.target.value)} className={fieldClass}>
                                {WEIGHT_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                            </select>
                        </label>
                        <NumberStepper label="Size" value={msgSize} onChange={setMsgSize} min={10} step={2} />
                        <NumberStepper label="Spacing" value={msgSpacing} onChange={setMsgSpacing} min={0} step={1} />
                        <div className="sm:col-span-2">
                            <ColorField label="Color" value={msgColor} onChange={setMsgColor} />
                        </div>
                    </div>
                </Section>

                <Section icon={Palette} title="Background" defaultOpen>
                    <div className="space-y-4">
                        <label className="surface-muted flex items-center justify-between gap-3 rounded-lg px-3 py-2">
                            <span className="text-sm font-bold text-slate-700 dark:text-slate-200">Gradient enabled</span>
                            <input type="checkbox" className="h-5 w-5 accent-indigo-600" checked={isGradEnabled} onChange={e => setIsGradEnabled(e.target.checked)} />
                        </label>
                        <div className={`${isGradEnabled ? 'opacity-100' : 'pointer-events-none opacity-40'} space-y-4 transition-opacity`}>
                            <RangeField label="Background Intensity" value={bgIntensity} onChange={setBgIntensity} lowLabel="Light" highLabel="Maximum" />
                            <RangeField label="Background Height" value={bgHeight} onChange={setBgHeight} lowLabel="Low" highLabel="Full Reach" />
                            <RangeField label="Background Softness" value={bgSoftness} onChange={setBgSoftness} lowLabel="Hard Edge" highLabel="Soft Fade" />
                        </div>
                    </div>
                </Section>
            </div>
        </div>
    );
}
