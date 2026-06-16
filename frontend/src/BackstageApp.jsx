import { useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { Clock, Rows3, Timer } from 'lucide-react';
import { socketOptions } from './auth';
import { driftLabel, elapsedForTiming, formatDuration, getSegmentTitle, remainingForTiming } from './utils/backstageCueSheet';

const socket = io(socketOptions());

const EMPTY_STATE = {
    title: 'Backstage Monitor',
    rows: [],
    currentIndex: -1,
    completedRows: {},
    displayMode: 'currentNext',
    message: null,
    timing: null,
    programDriftSeconds: 0,
    serviceStartedAt: null
};

const output = {
    app: 'bg-[#0d0d0c] text-[#fbf7ef]',
    shell: 'border-[#383329] bg-[#181715]',
    panel: 'border-[#4a443a] bg-[#22201d]',
    muted: 'border-[#383329] bg-[#151412]',
    raised: 'border-[#4a443a] bg-[#282520]',
    label: 'text-[#8d8273]',
    mutedText: 'text-[#b7aa98]'
};

function useNow(interval = 500) {
    const [now, setNow] = useState(Date.now());
    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), interval);
        return () => clearInterval(timer);
    }, [interval]);
    return now;
}

function FieldChip({ label, value, compact = false }) {
    const hasValue = value !== undefined && value !== null && String(value).trim() !== '';
    return (
        <div className={`min-h-0 rounded-lg border ${output.raised} ${compact ? 'px-2.5 py-1.5' : 'px-3 py-2'}`}>
            <div className={`truncate text-[8px] font-black uppercase tracking-[0.18em] ${output.label}`}>{label}</div>
            <div className={`${compact ? 'mt-0.5 text-sm' : 'mt-1 text-base'} truncate font-bold leading-tight ${hasValue ? 'text-[#fbf7ef]' : 'text-[#6d6254]'}`}>{hasValue ? value : '-'}</div>
        </div>
    );
}

function DetailGroup({ title, fields, compact = false, columns = 2 }) {
    return (
        <section className={`min-h-0 rounded-lg border p-2.5 ${output.muted}`}>
            <div className={`text-[9px] font-black uppercase tracking-[0.22em] ${output.label}`}>{title}</div>
            <div className={`mt-2 grid gap-2 ${columns === 3 ? 'grid-cols-3' : 'grid-cols-2'}`}>
                {fields.map(field => (
                    <FieldChip key={`${title}-${field.label}`} label={field.label} value={field.value} compact={compact} />
                ))}
            </div>
        </section>
    );
}

function cueDetailGroups(row) {
    return [
        {
            title: 'Timing',
            fields: [
                { label: 'Cue', value: row?.cueNo },
                { label: 'Start', value: row?.start },
                { label: 'End', value: row?.end },
                { label: 'Duration', value: row?.duration || (row?.durationSeconds ? formatDuration(row.durationSeconds) : '') }
            ]
        },
        {
            title: 'Program',
            fields: [
                { label: 'Segment', value: row?.segment },
                { label: 'Description', value: row?.description },
                { label: 'Presenter', value: row?.presenter }
            ]
        },
        {
            title: 'Operator Cues',
            fields: [
                { label: 'Audio Board', value: row?.audioBoard },
                { label: 'Audio PB', value: row?.audioPb },
                { label: 'Side Screen', value: row?.sideScreen },
                { label: 'Center Screen', value: row?.centerScreen },
                { label: 'GFX', value: row?.gfx }
            ]
        },
        {
            title: 'Light Cues',
            fields: [
                { label: 'Stage', value: row?.stage },
                { label: 'House', value: row?.house }
            ]
        },
        ...(row?.customFields?.length ? [{
            title: 'Additional',
            fields: row.customFields.map(field => ({ label: field.label, value: field.value }))
        }] : [])
    ];
}

function CueDetails({ row, compact = false, groupColumns = 1, fieldColumns = 2, includeGroups = null }) {
    const groups = cueDetailGroups(row).filter(group => !includeGroups || includeGroups.includes(group.title));
    return (
        <div className={`grid min-h-0 ${groupColumns === 2 ? 'grid-cols-2' : 'grid-cols-1'} ${compact ? 'gap-2.5' : 'gap-3'}`}>
            {groups.map(group => (
                <DetailGroup key={group.title} title={group.title} fields={group.fields} compact={compact} columns={fieldColumns} />
            ))}
        </div>
    );
}

function customLabelsForRows(rows = []) {
    return Array.from(new Set(rows.flatMap(row => row.customFields?.map(field => field.label) || [])));
}

function RundownTable({ rows, currentIndex = -1, completedRows = {}, customLabels = customLabelsForRows(rows), compact = false, emptyText = 'No cue rows to show.', followCurrent = false }) {
    const currentRowRef = useRef(null);
    const columns = ['Cue', 'Start', 'End', 'Duration', 'Segment', 'Description', 'Presenter', 'Audio', 'Screens', 'GFX', 'Lights', ...customLabels];
    const headerClass = compact ? 'px-2 py-1.5' : 'px-3 py-3';
    const cellClass = compact ? 'px-2 py-1.5' : 'px-3 py-3';

    useEffect(() => {
        if (!followCurrent || !currentRowRef.current) return;
        currentRowRef.current.scrollIntoView({
            block: 'center',
            inline: 'nearest',
            behavior: 'smooth'
        });
    }, [followCurrent, currentIndex, rows.length]);

    return (
        <div className={`${followCurrent ? 'h-full' : ''} overflow-auto rounded-lg border border-[#4a443a]`}>
            <table className={`w-full border-collapse text-left ${compact ? 'text-[11px]' : 'text-sm'}`}>
                <thead className="sticky top-0 z-10 bg-[#22201d] text-[9px] font-black uppercase tracking-widest text-[#b7aa98]">
                    <tr>
                        {columns.map(label => (
                            <th key={label} className={`border-b border-[#4a443a] ${headerClass}`}>{label}</th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {rows.length === 0 ? (
                        <tr>
                            <td colSpan={columns.length} className={`${cellClass} text-center font-bold text-[#8d8273]`}>{emptyText}</td>
                        </tr>
                    ) : rows.map(row => {
                        const index = Number(row.index);
                        const isCurrent = index === currentIndex;
                        const isDone = Boolean(completedRows[row.id]);
                        const isNext = index === currentIndex + 1;
                        return (
                            <tr
                                key={row.id}
                                ref={isCurrent ? currentRowRef : null}
                                className={`${isCurrent ? 'bg-emerald-500/20 text-white' : isNext ? 'bg-blue-500/10' : isDone ? 'bg-[#10100f] text-[#8d8273]' : 'bg-[#151412]'} border-b border-[#383329] last:border-b-0`}
                            >
                                <td className={`${cellClass} font-black`}>{row.cueNo}</td>
                                <td className={cellClass}>{row.start}</td>
                                <td className={cellClass}>{row.end}</td>
                                <td className={cellClass}>{row.duration}</td>
                                <td className={`${cellClass} font-black`}>{row.segment}</td>
                                <td className={cellClass}>{row.description}</td>
                                <td className={cellClass}>{row.presenter}</td>
                                <td className={cellClass}>{[row.audioBoard, row.audioPb].filter(Boolean).join(' / ')}</td>
                                <td className={cellClass}>{[row.sideScreen, row.centerScreen].filter(Boolean).join(' / ')}</td>
                                <td className={cellClass}>{row.gfx}</td>
                                <td className={cellClass}>{[row.stage, row.house].filter(Boolean).join(' / ')}</td>
                                {customLabels.map(label => (
                                    <td key={`${row.id}-${label}`} className={cellClass}>{row.customFields?.find(field => field.label === label)?.value || '-'}</td>
                                ))}
                            </tr>
                        );
                    })}
                </tbody>
            </table>
        </div>
    );
}

function StatusTile({ icon: Icon, label, value, tone = 'slate' }) {
    const tones = {
        slate: 'border-[#4a443a] bg-[#22201d] text-[#fbf7ef]',
        green: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200',
        blue: 'border-blue-500/40 bg-blue-500/10 text-blue-200',
        red: 'border-red-500/40 bg-red-500/10 text-red-200'
    };
    return (
        <div className={`rounded-lg border px-3 py-2 ${tones[tone] || tones.slate}`}>
            <div className="flex items-center gap-2 text-[9px] font-black uppercase tracking-[0.2em] opacity-70">
                <Icon className="h-3.5 w-3.5" />
                {label}
            </div>
            <div className="mt-1 text-xl font-black">{value}</div>
        </div>
    );
}

function BackstageMessage({ message }) {
    if (!message?.text) return null;
    const tones = {
        normal: 'border-[#6a5f50] bg-[#282520] text-[#fbf7ef]',
        info: 'border-blue-400 bg-blue-500 text-white',
        warning: 'border-amber-300 bg-amber-400 text-slate-950',
        urgent: 'border-red-300 bg-red-600 text-white'
    };
    return (
        <div className={`rounded-lg border-2 px-5 py-3 text-center shadow-2xl ${tones[message.tone] || tones.normal} ${message.flash ? 'animate-pulse' : ''}`}>
            <div className="text-[10px] font-black uppercase tracking-[0.25em] opacity-80">Backstage Message</div>
            <div className="mt-1 text-3xl font-black tracking-normal">{message.text}</div>
        </div>
    );
}

function CurrentNextView({ state, now }) {
    const current = state.rows[state.currentIndex];
    const next = state.rows[state.currentIndex + 1];
    const nextThree = state.rows.slice(state.currentIndex + 2, state.currentIndex + 5);
    const nextThreeCustomLabels = customLabelsForRows(nextThree);
    const elapsed = elapsedForTiming(state.timing, now);
    const remaining = remainingForTiming(state.timing, now);
    const drift = driftLabel(state.programDriftSeconds);
    return (
        <div className={`flex h-screen min-h-0 flex-col overflow-hidden p-5 ${output.app}`}>
            <header className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                    <div className={`text-[10px] font-black uppercase tracking-[0.26em] ${output.label}`}>Backstage Monitor</div>
                    <h1 className="mt-1 text-3xl font-black leading-tight">{state.title}</h1>
                </div>
                <div className="grid w-full grid-cols-3 gap-2 xl:w-auto xl:min-w-[470px]">
                    <StatusTile icon={Clock} label="Live Clock" value={new Date(now).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })} />
                    <StatusTile icon={Timer} label="Elapsed" value={state.serviceStartedAt ? formatDuration((now - state.serviceStartedAt) / 1000) : '0:00'} />
                    <StatusTile icon={Rows3} label="Program" value={drift.label} tone={drift.tone} />
                </div>
            </header>

            <div className="mt-3">
                <BackstageMessage message={state.message} />
            </div>

            <main className="mt-3 grid min-h-0 flex-1 grid-rows-[minmax(0,0.88fr)_auto] gap-3 pb-1">
                <div className="grid min-h-0 grid-cols-[0.56fr_1.44fr] gap-4">
                <aside className="min-h-0">
                    <section className={`flex h-full min-h-0 flex-col rounded-lg border p-4 ${output.panel}`}>
                        <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                                <div className="text-[10px] font-black uppercase tracking-[0.26em] text-emerald-400">Current</div>
                                <h2 className="mt-2 text-2xl font-black leading-tight tracking-normal">{current ? getSegmentTitle(current) : 'No Current Segment'}</h2>
                                <p className={`mt-2 line-clamp-2 text-sm font-bold ${output.mutedText}`}>{current?.description || '-'}</p>
                            </div>
                            <div className="min-w-[145px] rounded-lg border border-emerald-400/40 bg-emerald-400/10 p-3 text-center">
                                <div className="text-[9px] font-black uppercase tracking-[0.2em] text-emerald-300">Remaining</div>
                                <div className="mt-1 text-4xl font-black tabular-nums text-emerald-100">{formatDuration(remaining)}</div>
                                <div className={`mt-1 text-[10px] font-bold uppercase tracking-widest ${output.mutedText}`}>Elapsed {formatDuration(elapsed)}</div>
                            </div>
                        </div>
                        <div className="mt-3 min-h-0">
                            <CueDetails row={current} compact includeGroups={['Timing', 'Program']} />
                        </div>
                    </section>
                </aside>

                <section className="flex min-h-0 flex-col rounded-lg border border-blue-400/50 bg-[#22201d] p-4 shadow-2xl shadow-blue-950/20">
                    <div className="text-[11px] font-black uppercase tracking-[0.3em] text-blue-400">Next</div>
                    <h3 className="mt-2 text-4xl font-black leading-none tracking-normal">{next ? getSegmentTitle(next) : 'End of Rundown'}</h3>
                    <p className={`mt-2 line-clamp-1 text-lg font-bold ${output.mutedText}`}>{next?.description || '-'}</p>
                    <div className="mt-3 min-h-0">
                        <CueDetails row={next} groupColumns={2} fieldColumns={2} />
                    </div>
                </section>
                </div>

                <section className="min-h-0">
                    <div className={`mb-2 text-[10px] font-black uppercase tracking-[0.26em] ${output.label}`}>Next 3</div>
                    <RundownTable
                        rows={nextThree}
                        currentIndex={state.currentIndex}
                        completedRows={state.completedRows}
                        customLabels={nextThreeCustomLabels}
                        compact
                        emptyText="No additional upcoming cues."
                    />
                </section>
            </main>
        </div>
    );
}

function FullRundownView({ state, now }) {
    const drift = driftLabel(state.programDriftSeconds);
    const customLabels = customLabelsForRows(state.rows);
    return (
        <div className={`flex h-screen min-h-0 flex-col overflow-hidden p-6 ${output.app}`}>
            <header className="mb-5 flex shrink-0 items-center justify-between gap-4">
                <div>
                    <div className={`text-[11px] font-black uppercase tracking-[0.3em] ${output.label}`}>Full Rundown</div>
                    <h1 className="mt-1 text-3xl font-black">{state.title}</h1>
                </div>
                <div className="flex items-center gap-3">
                    <StatusTile icon={Clock} label="Clock" value={new Date(now).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} />
                    <StatusTile icon={Timer} label="Timer" value={formatDuration(remainingForTiming(state.timing, now))} />
                    <StatusTile icon={Rows3} label="Program" value={drift.label} tone={drift.tone} />
                </div>
            </header>
            <BackstageMessage message={state.message} />
            <div className="mt-5 min-h-0 flex-1">
                <RundownTable
                    rows={state.rows}
                    currentIndex={state.currentIndex}
                    completedRows={state.completedRows}
                    customLabels={customLabels}
                    followCurrent
                />
            </div>
        </div>
    );
}

export default function BackstageApp() {
    const [state, setState] = useState(EMPTY_STATE);
    const now = useNow();

    useEffect(() => {
        const handleUpdate = (nextState) => setState({ ...EMPTY_STATE, ...(nextState || {}) });
        socket.on('backstage_state_update', handleUpdate);
        socket.on('close_window_command', () => window.close());
        socket.emit('request_backstage_state');
        return () => {
            socket.off('backstage_state_update', handleUpdate);
            socket.off('close_window_command');
        };
    }, []);

    const mode = useMemo(() => state.displayMode || 'currentNext', [state.displayMode]);
    if (mode === 'full') return <FullRundownView state={state} now={now} />;
    return <CurrentNextView state={state} now={now} />;
}
