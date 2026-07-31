import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, CopyPlus, Plus, RefreshCw, RotateCcw, Trash2 } from 'lucide-react';
import { deferUntilIdle, readLocalStorageArraySafe, readLocalStorageObjectSafe, useDebouncedLocalStorageEffect } from '../utils/performance';
import PadButton from './PadButton';
import { PAD_ICON_COMPONENTS } from './padIcons';
import {
    DEFAULT_PAD_LAYOUT,
    PAD_COLORS,
    PAD_COLOR_KEYS,
    PAD_COL_CHOICES,
    PAD_COMMANDS,
    PAD_EMIT_ACTIONS,
    PAD_ICON_NAMES,
    PAD_LAYOUT_KEY,
    MAX_PAD_BUTTONS,
    MAX_PAD_PAGES,
    clonePadLayout,
    getPadActionDef,
    getPadActionOptions,
    makePadButton,
    makePadPage,
    normalizePadLayout,
    padActionDefaults
} from './padModel';

const RUN_OF_SHOW_KEY = 'bc_run_of_show_v1';

const inputClass = 'control-field px-3 py-2 text-xs';
const buttonClass = 'control-button rounded-lg px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-slate-600 dark:text-slate-300';

function Field({ label, children }) {
    return (
        <label className="block space-y-1">
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{label}</span>
            {children}
        </label>
    );
}

// Renders the payload sub-form for the handful of actions that take arguments.
// Driven by the action table's own `fields` descriptors, so adding an action to
// padModel.js automatically gets an editor here.
function PayloadFields({ def, payload, cues, onChange }) {
    if (!def?.fields?.length) return null;
    return (
        <div className="space-y-3 border-t section-rule pt-3">
            {def.fields.map(field => {
                const value = payload[field.key] ?? field.default;
                if (field.type === 'bool') {
                    return (
                        <label key={field.key} className="flex items-center gap-2 text-xs font-semibold text-slate-600 dark:text-slate-300">
                            <input
                                type="checkbox"
                                checked={Boolean(value)}
                                onChange={event => onChange({ [field.key]: event.target.checked })}
                            />
                            {field.label}
                        </label>
                    );
                }
                if (field.type === 'select') {
                    return (
                        <Field key={field.key} label={field.label}>
                            <select value={value} onChange={event => onChange({ [field.key]: event.target.value })} className={inputClass}>
                                {field.options.map(option => <option key={option} value={option}>{option}</option>)}
                            </select>
                        </Field>
                    );
                }
                if (field.type === 'cue') {
                    return (
                        <Field key={field.key} label={field.label}>
                            <select value={value || ''} onChange={event => onChange({ [field.key]: event.target.value })} className={inputClass}>
                                <option value="">Next pending cue</option>
                                {cues.map(cue => <option key={cue.id} value={cue.id}>{cue.title}</option>)}
                            </select>
                        </Field>
                    );
                }
                const isNumber = field.type === 'int' || field.type === 'num';
                return (
                    <Field key={field.key} label={field.label}>
                        <input
                            type={isNumber ? 'number' : 'text'}
                            value={value}
                            min={field.min}
                            max={field.max}
                            maxLength={field.max && !isNumber ? field.max : undefined}
                            onChange={event => onChange({
                                [field.key]: isNumber ? Number(event.target.value) : event.target.value
                            })}
                            className={inputClass}
                        />
                    </Field>
                );
            })}
        </div>
    );
}

export default function PadLayoutPanel({ socket, isRemoteClient = false }) {
    const [layout, setLayout] = useState(null);
    const [pageIndex, setPageIndex] = useState(0);
    const [selectedId, setSelectedId] = useState(null);
    const [cues, setCues] = useState([]);
    const [padCount, setPadCount] = useState(0);

    useEffect(() => deferUntilIdle(() => {
        const stored = readLocalStorageObjectSafe(PAD_LAYOUT_KEY, null);
        setLayout(stored ? normalizePadLayout(stored) : clonePadLayout(DEFAULT_PAD_LAYOUT));
        setCues(readLocalStorageArraySafe(RUN_OF_SHOW_KEY));
    }), []);

    useDebouncedLocalStorageEffect(PAD_LAYOUT_KEY, layout);

    // Publish for the tablets. Debounced because `layout` changes on every
    // keystroke in the label fields, and the server re-broadcasts each publish.
    const layoutRef = useRef(layout);
    layoutRef.current = layout;
    useEffect(() => {
        if (!socket || isRemoteClient || !layout) return;
        const publish = () => {
            if (layoutRef.current) socket.emit('pad_layout_update', layoutRef.current);
        };
        const timer = setTimeout(publish, 300);
        socket.on('connect', publish);
        return () => {
            clearTimeout(timer);
            socket.off('connect', publish);
        };
    }, [socket, layout, isRemoteClient]);

    // How many devices are paired — the operator wants to know the QR was used.
    useEffect(() => {
        if (!socket) return;
        const onStatus = (status) => setPadCount(status?.sessions?.filter(s => s.connected).length || 0);
        socket.on('remote_access_status_update', onStatus);
        socket.emit('remote_access_status_request');
        return () => socket.off('remote_access_status_update', onStatus);
    }, [socket]);

    const page = layout?.pages[Math.min(pageIndex, layout.pages.length - 1)] || null;
    const selected = page?.buttons.find(button => button.id === selectedId) || null;
    const selectedDef = getPadActionDef(selected?.action);
    const actionOptions = useMemo(() => getPadActionOptions(), []);

    if (!layout) return <div className="p-4 text-xs font-semibold text-slate-500">Loading pad layout…</div>;

    const updatePage = (patch) => {
        setLayout(prev => ({
            ...prev,
            pages: prev.pages.map((item, i) => (i === pageIndex ? { ...item, ...patch } : item))
        }));
    };

    const updateButton = (buttonId, patch) => {
        updatePage({ buttons: page.buttons.map(item => (item.id === buttonId ? { ...item, ...patch } : item)) });
    };

    const updatePayload = (buttonId, patch) => {
        updatePage({
            buttons: page.buttons.map(item => (
                item.id === buttonId
                    ? { ...item, action: { ...item.action, payload: { ...item.action.payload, ...patch } } }
                    : item
            ))
        });
    };

    const addButton = () => {
        if (page.buttons.length >= MAX_PAD_BUTTONS) return;
        const button = makePadButton('emit:pres.next');
        updatePage({ buttons: [...page.buttons, button] });
        setSelectedId(button.id);
    };

    const duplicateButton = () => {
        if (!selected || page.buttons.length >= MAX_PAD_BUTTONS) return;
        const copy = { ...selected, id: makePadButton().id, action: { ...selected.action, payload: { ...selected.action.payload } } };
        const index = page.buttons.findIndex(item => item.id === selected.id);
        const next = [...page.buttons];
        next.splice(index + 1, 0, copy);
        updatePage({ buttons: next });
        setSelectedId(copy.id);
    };

    const deleteButton = () => {
        if (!selected) return;
        updatePage({ buttons: page.buttons.filter(item => item.id !== selected.id) });
        setSelectedId(null);
    };

    // Reorder by move buttons rather than drag and drop — the same idiom the Run of
    // Show panel already uses, and it works with a trackpad on a cramped screen.
    const moveButton = (direction) => {
        if (!selected) return;
        const index = page.buttons.findIndex(item => item.id === selected.id);
        const nextIndex = index + direction;
        if (nextIndex < 0 || nextIndex >= page.buttons.length) return;
        const next = [...page.buttons];
        [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
        updatePage({ buttons: next });
    };

    const addPage = () => {
        if (layout.pages.length >= MAX_PAD_PAGES) return;
        const created = makePadPage(`Page ${layout.pages.length + 1}`);
        setLayout(prev => ({ ...prev, pages: [...prev.pages, created] }));
        setPageIndex(layout.pages.length);
        setSelectedId(null);
    };

    const deletePage = () => {
        if (layout.pages.length <= 1) return;
        setLayout(prev => ({ ...prev, pages: prev.pages.filter((_, i) => i !== pageIndex) }));
        setPageIndex(index => Math.max(0, index - 1));
        setSelectedId(null);
    };

    const movePage = (direction) => {
        const nextIndex = pageIndex + direction;
        if (nextIndex < 0 || nextIndex >= layout.pages.length) return;
        setLayout(prev => {
            const next = [...prev.pages];
            [next[pageIndex], next[nextIndex]] = [next[nextIndex], next[pageIndex]];
            return { ...prev, pages: next };
        });
        setPageIndex(nextIndex);
    };

    const changeAction = (value) => {
        if (!selected) return;
        const [kind, id] = value.split(':');
        const def = kind === 'emit' ? PAD_EMIT_ACTIONS[id] : PAD_COMMANDS[id];
        updateButton(selected.id, {
            // Seed the payload from the field defaults, or the inspector would show
            // values it never stored and the button would fire with an empty payload.
            action: { kind, id, payload: padActionDefaults(def) },
            // A newly chosen destructive action arms its own guard, so a Clear All
            // is never left as a hair-trigger by omission.
            hold: Boolean(def?.destructive)
        });
    };

    return (
        <div className="space-y-4 p-4">
            <div className="surface-raised flex flex-wrap items-center gap-3 rounded-xl p-3">
                <div className="min-w-0 flex-1">
                    <div className="text-sm font-bold text-slate-900 dark:text-white">Control Pad Layout</div>
                    <div className="text-[11px] font-semibold text-slate-500">
                        Published live to every paired pad · {padCount} device{padCount === 1 ? '' : 's'} connected
                    </div>
                </div>
                <button
                    onClick={() => setCues(readLocalStorageArraySafe(RUN_OF_SHOW_KEY))}
                    className={`${buttonClass} flex items-center gap-2`}
                >
                    <RefreshCw className="h-3.5 w-3.5" /> Refresh Cues
                </button>
                <button
                    onClick={() => { setLayout(clonePadLayout(DEFAULT_PAD_LAYOUT)); setPageIndex(0); setSelectedId(null); }}
                    className={`${buttonClass} flex items-center gap-2`}
                >
                    <RotateCcw className="h-3.5 w-3.5" /> Reset to Defaults
                </button>
            </div>

            {/* Page strip */}
            <div className="surface-raised flex flex-wrap items-center gap-2 rounded-xl p-3">
                {layout.pages.map((item, index) => (
                    <button
                        key={item.id}
                        onClick={() => { setPageIndex(index); setSelectedId(null); }}
                        className={`rounded-lg px-3 py-2 text-xs font-bold transition ${
                            index === pageIndex ? 'bg-blue-600 text-white' : 'control-button text-slate-600 dark:text-slate-300'
                        }`}
                    >
                        {item.name}
                    </button>
                ))}
                <button onClick={addPage} disabled={layout.pages.length >= MAX_PAD_PAGES} className={`${buttonClass} flex items-center gap-1 disabled:opacity-40`}>
                    <Plus className="h-3.5 w-3.5" /> Page
                </button>
                <div className="ml-auto flex items-center gap-2">
                    <input
                        value={page.name}
                        onChange={event => updatePage({ name: event.target.value.slice(0, 24) })}
                        className="control-field w-40 px-3 py-1.5 text-xs"
                    />
                    <select value={page.cols} onChange={event => updatePage({ cols: Number(event.target.value) })} className="control-field w-28 px-2 py-1.5 text-xs">
                        {PAD_COL_CHOICES.map(value => <option key={value} value={value}>{value} columns</option>)}
                    </select>
                    <button onClick={() => movePage(-1)} className={buttonClass}><ArrowLeft className="h-3.5 w-3.5" /></button>
                    <button onClick={() => movePage(1)} className={buttonClass}><ArrowRight className="h-3.5 w-3.5" /></button>
                    <button onClick={deletePage} disabled={layout.pages.length <= 1} className={`${buttonClass} disabled:opacity-40`}>
                        <Trash2 className="h-3.5 w-3.5" />
                    </button>
                </div>
            </div>

            <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_320px]">
                {/* Grid preview — the same component the tablet renders, so what the
                    operator arranges here is exactly what they will see. */}
                <div className="surface-raised rounded-xl p-3">
                    <div className="mb-2 flex items-center justify-between">
                        <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
                            Preview · tap a key to edit
                        </span>
                        <button onClick={addButton} disabled={page.buttons.length >= MAX_PAD_BUTTONS} className={`${buttonClass} flex items-center gap-1 disabled:opacity-40`}>
                            <Plus className="h-3.5 w-3.5" /> Button
                        </button>
                    </div>
                    {page.buttons.length === 0 ? (
                        <p className="py-10 text-center text-xs font-semibold text-slate-500">
                            No buttons on this page yet.
                        </p>
                    ) : (
                        <div
                            className="grid gap-3 auto-rows-[minmax(84px,1fr)] rounded-lg bg-slate-950/40 p-3"
                            style={{ gridTemplateColumns: `repeat(${page.cols}, minmax(0, 1fr))` }}
                        >
                            {page.buttons.map(button => (
                                <PadButton
                                    key={button.id}
                                    button={button}
                                    editing
                                    selected={button.id === selectedId}
                                    onSelect={() => setSelectedId(button.id)}
                                />
                            ))}
                        </div>
                    )}
                </div>

                {/* Inspector */}
                <div className="surface-raised space-y-3 rounded-xl p-3">
                    {!selected ? (
                        <p className="py-6 text-center text-xs font-semibold text-slate-500">
                            Select a button to edit it.
                        </p>
                    ) : (
                        <>
                            <div className="flex items-center gap-2">
                                <button onClick={() => moveButton(-1)} className={buttonClass}><ArrowLeft className="h-3.5 w-3.5" /></button>
                                <button onClick={() => moveButton(1)} className={buttonClass}><ArrowRight className="h-3.5 w-3.5" /></button>
                                <button onClick={duplicateButton} className={buttonClass}><CopyPlus className="h-3.5 w-3.5" /></button>
                                <button onClick={deleteButton} className={`${buttonClass} ml-auto text-red-600 dark:text-red-400`}>
                                    <Trash2 className="h-3.5 w-3.5" />
                                </button>
                            </div>

                            <Field label="Action">
                                <select
                                    value={selected.action.kind === 'none' ? '' : `${selected.action.kind}:${selected.action.id}`}
                                    onChange={event => changeAction(event.target.value)}
                                    className={inputClass}
                                >
                                    <option value="">— none —</option>
                                    {actionOptions.map(group => (
                                        <optgroup key={group.group} label={group.group}>
                                            {group.options.map(option => (
                                                <option key={option.value} value={option.value}>{option.label}</option>
                                            ))}
                                        </optgroup>
                                    ))}
                                </select>
                            </Field>

                            <Field label="Label">
                                <input
                                    value={selected.label}
                                    maxLength={20}
                                    onChange={event => updateButton(selected.id, { label: event.target.value.slice(0, 20) })}
                                    className={inputClass}
                                />
                            </Field>

                            <Field label="Sub-label">
                                <input
                                    value={selected.sub}
                                    maxLength={20}
                                    onChange={event => updateButton(selected.id, { sub: event.target.value.slice(0, 20) })}
                                    className={inputClass}
                                />
                            </Field>

                            <Field label="Colour">
                                <div className="flex flex-wrap gap-1.5">
                                    {PAD_COLOR_KEYS.map(key => (
                                        <button
                                            key={key}
                                            onClick={() => updateButton(selected.id, { color: key })}
                                            title={key}
                                            className={`h-7 w-7 rounded-md ${PAD_COLORS[key].face} ${
                                                selected.color === key ? 'ring-2 ring-blue-400 ring-offset-1' : ''
                                            }`}
                                        />
                                    ))}
                                </div>
                            </Field>

                            <Field label="Icon">
                                <div className="grid max-h-32 grid-cols-8 gap-1 overflow-y-auto">
                                    {PAD_ICON_NAMES.map(name => {
                                        const Icon = PAD_ICON_COMPONENTS[name];
                                        return (
                                            <button
                                                key={name}
                                                onClick={() => updateButton(selected.id, { icon: name })}
                                                title={name}
                                                className={`flex h-8 items-center justify-center rounded-md control-button ${
                                                    selected.icon === name ? 'ring-2 ring-blue-400' : ''
                                                }`}
                                            >
                                                {Icon ? <Icon className="h-4 w-4" /> : <span className="text-[9px] font-bold">—</span>}
                                            </button>
                                        );
                                    })}
                                </div>
                            </Field>

                            <div className="flex flex-wrap gap-4">
                                <label className="flex items-center gap-2 text-xs font-semibold text-slate-600 dark:text-slate-300">
                                    <input
                                        type="checkbox"
                                        checked={selected.wide}
                                        onChange={event => updateButton(selected.id, { wide: event.target.checked })}
                                    />
                                    Double width
                                </label>
                                <label className={`flex items-center gap-2 text-xs font-semibold ${
                                    selectedDef?.destructive ? 'text-amber-600 dark:text-amber-400' : 'text-slate-600 dark:text-slate-300'
                                }`}>
                                    <input
                                        type="checkbox"
                                        checked={selected.hold}
                                        onChange={event => updateButton(selected.id, { hold: event.target.checked })}
                                    />
                                    Hold to fire
                                </label>
                            </div>

                            {selectedDef?.destructive && !selected.hold && (
                                <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] font-semibold text-amber-700 dark:text-amber-300">
                                    This action interrupts the show. Without hold-to-fire, one stray tap triggers it.
                                </p>
                            )}

                            <PayloadFields
                                def={selectedDef}
                                payload={selected.action.payload}
                                cues={cues}
                                onChange={patch => updatePayload(selected.id, patch)}
                            />
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}
