import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Clapperboard, CopyPlus, Layers, Play, Save, Sparkles, Trash2 } from 'lucide-react';
import { GUJ_FONT_OPTIONS } from '../utils/lyricsFonts';
import {
    ANIMATION_PRESETS,
    BACKGROUND_STYLES,
    BUILT_IN_TEMPLATES,
    DEFAULT_LOWER_THIRD_DRAFT,
    DEFAULT_LT_DESIGN,
    LT_CUE_QUEUE_KEY,
    LT_TEMPLATE_KEY,
    SHAPE_PRESETS,
    buildLowerThirdPayload,
    createCueFromDraft,
    createTemplateFromDraft,
    getDesignFromDraft,
    getStyleFromDraft,
    getTemplatePreviewColors,
    normalizeDraft,
    templateToDraftPatch
} from './lowerThirdsModel';
import { deferUntilIdle, readLocalStorageArraySafe, useDebouncedLocalStorageEffect } from '../utils/performance';

const cloneDefaultDraft = () => normalizeDraft(DEFAULT_LOWER_THIRD_DRAFT);

const mergeSection = (draft, section, values) => ({
    ...draft,
    [section]: {
        ...draft[section],
        ...values
    }
});

function draftReducer(state, action) {
    switch (action.type) {
        case 'update_section':
            return normalizeDraft(mergeSection(state, action.section, action.values));
        case 'apply_template': {
            const patch = templateToDraftPatch(action.template);
            // Apply the template's layout too — previously it was dropped, so presets
            // that set width/position/alignment (e.g. Full Band) never looked as designed.
            // Behaviour keeps the operator's autoClear/langOpt but takes the preset's motion.
            return normalizeDraft({
                ...state,
                appearance: patch.appearance,
                layout: patch.layout,
                typography: patch.typography,
                behavior: {
                    ...state.behavior,
                    animation: patch.behavior.animation,
                    animationSpeed: patch.behavior.animationSpeed
                }
            });
        }
        case 'load_cue':
            return normalizeDraft(action.cue);
        case 'reset_design':
            return normalizeDraft({
                ...state,
                appearance: {
                    ...state.appearance,
                    shapeStyle: DEFAULT_LT_DESIGN.shapeStyle,
                    accentColor: DEFAULT_LT_DESIGN.accentColor,
                    accentColor2: DEFAULT_LT_DESIGN.accentColor2,
                    accentGradient: DEFAULT_LT_DESIGN.accentGradient,
                    panelOpacity: DEFAULT_LT_DESIGN.panelOpacity,
                    shadowIntensity: DEFAULT_LT_DESIGN.shadowIntensity,
                    borderWidth: DEFAULT_LT_DESIGN.borderWidth,
                    borderColor: DEFAULT_LT_DESIGN.borderColor,
                    cornerRadius: DEFAULT_LT_DESIGN.cornerRadius
                },
                layout: {
                    ...state.layout,
                    panelWidth: DEFAULT_LT_DESIGN.panelWidth,
                    posX: DEFAULT_LT_DESIGN.posX,
                    posY: DEFAULT_LT_DESIGN.posY,
                    logoPlacement: DEFAULT_LT_DESIGN.logoPlacement,
                    logoSize: DEFAULT_LT_DESIGN.logoSize,
                    textAlign: DEFAULT_LT_DESIGN.textAlign
                }
            });
        default:
            return state;
    }
}

async function transliterateGujarati(text) {
    if (!text || !text.trim()) return text;
    try {
        const res = await fetch(`https://inputtools.google.com/request?text=${encodeURIComponent(text)}&itc=gu-t-i0-und&num=1&cp=0&cs=1&ie=utf-8&oe=utf-8`);
        const data = await res.json();
        if (data[0] === 'SUCCESS' && data[1] && data[1][0] && data[1][0][1] && data[1][0][1][0]) {
            return data[1][0][1][0];
        }
    } catch (e) {
        console.error('Transliteration Error:', e);
    }
    return text;
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

const FieldLabel = ({ children }) => (
    <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-wider">{children}</label>
);

const inputClass = 'control-field px-3 py-2 text-sm';
const compactInputClass = 'control-field px-2 py-1.5 text-xs';

export default function LowerThirdsPanel({ socket }) {
    const [draft, dispatch] = useReducer(draftReducer, undefined, cloneDefaultDraft);
    const [customTemplates, setCustomTemplates] = useState([]);
    const [cueQueue, setCueQueue] = useState([]);
    const [activeCueIndex, setActiveCueIndex] = useState(0);
    const [templateNameInput, setTemplateNameInput] = useState('');
    const [templateSaveState, setTemplateSaveState] = useState('idle');

    const titleInputRef = useRef(null);
    const crossSyncTimerRef = useRef(null);

    const { content, appearance, layout, typography, behavior } = draft;
    const allTemplates = [...BUILT_IN_TEMPLATES, ...customTemplates];
    const currentStyle = useMemo(() => getStyleFromDraft(draft), [draft]);
    const currentDesign = useMemo(() => getDesignFromDraft(draft), [draft]);
    const selectedAnimation = ANIMATION_PRESETS.find(animation => animation.id === behavior.animation);
    const selectedShape = SHAPE_PRESETS.find(shape => shape.id === appearance.shapeStyle);
    const selectedBackground = BACKGROUND_STYLES.find(bg => bg.id === appearance.bgStyle);

    const updateSection = useCallback((section, values) => {
        dispatch({ type: 'update_section', section, values });
    }, []);

    useEffect(() => deferUntilIdle(() => {
        setCustomTemplates(readLocalStorageArraySafe(LT_TEMPLATE_KEY));
        setCueQueue(readLocalStorageArraySafe(LT_CUE_QUEUE_KEY));
    }), []);

    useDebouncedLocalStorageEffect(LT_TEMPLATE_KEY, customTemplates);
    useDebouncedLocalStorageEffect(LT_CUE_QUEUE_KEY, cueQueue);

    useEffect(() => {
        clearTimeout(crossSyncTimerRef.current);
        if (!content.name.trim()) {
            updateSection('content', { title: '' });
            return undefined;
        }
        crossSyncTimerRef.current = setTimeout(async () => {
            const transText = await transliterateGujarati(content.name);
            updateSection('content', { title: transText });
        }, 750);
        return () => clearTimeout(crossSyncTimerRef.current);
    }, [content.name, updateSection]);

    useEffect(() => {
        if (!socket) return;
        socket.emit('update_lt_style', currentStyle);
    }, [socket, currentStyle]);

    useEffect(() => {
        if (!socket) return;
        socket.emit('update_lt_design', currentDesign);
    }, [socket, currentDesign]);

    const attachTransliteration = useCallback((el) => {
        if (!el) return;
        titleInputRef.current = el;
        if (el._translitAttached) return;
        el._translitAttached = true;

        el.addEventListener('keydown', async (e) => {
            if (e.key !== ' ' && e.key !== 'Enter') return;
            const cursor = el.selectionStart;
            const textBeforeCursor = el.value.substring(0, cursor);
            const match = textBeforeCursor.match(/([a-zA-Z]+)$/);
            if (!match) return;
            e.preventDefault();
            const transWord = await transliterateGujarati(match[1]);
            const newBefore = textBeforeCursor.substring(0, textBeforeCursor.length - match[1].length) + transWord + (e.key === 'Enter' ? '\n' : ' ');
            const newVal = newBefore + el.value.substring(cursor);
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            nativeInputValueSetter.call(el, newVal);
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.selectionStart = el.selectionEnd = newBefore.length;
        });

        el.addEventListener('blur', async () => {
            const text = el.value;
            const match = text.match(/([a-zA-Z]+)$/);
            if (!match) return;
            const transWord = await transliterateGujarati(match[1]);
            const newVal = text.substring(0, text.length - match[1].length) + transWord;
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            nativeInputValueSetter.call(el, newVal);
            el.dispatchEvent(new Event('input', { bubbles: true }));
        });

        el.addEventListener('paste', async (ev) => {
            ev.preventDefault();
            const text = (ev.clipboardData || window.clipboardData).getData('text');
            const cursor = el.selectionStart;
            const val = el.value;
            const nextText = /[a-zA-Z]/.test(text) ? await transliterateGujarati(text) : text;
            const newVal = val.substring(0, cursor) + nextText + val.substring(el.selectionEnd);
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            nativeInputValueSetter.call(el, newVal);
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.selectionStart = el.selectionEnd = cursor + nextText.length;
        });
    }, []);

    const saveTemplates = (templates) => {
        setCustomTemplates(templates);
        return true;
    };

    const saveCueQueue = (queue) => {
        setCueQueue(queue);
        if (activeCueIndex >= queue.length) setActiveCueIndex(Math.max(queue.length - 1, 0));
    };

    const showLowerThirdData = (payload) => {
        if (!socket) return;
        socket.emit('show_lower_third', {
            ...payload,
            name: (payload.name || '').trim(),
            title: (payload.title || '').trim(),
            subtitle2: (payload.subtitle2 || '').trim(),
            autoClear: payload.autoClear ? Number(payload.autoClear) : 0,
            logo: payload.logo || null
        });
    };

    const handleShow = () => showLowerThirdData(buildLowerThirdPayload(draft));
    const handleHide = () => socket?.emit('hide_lower_third');

    const handleFile = (e) => {
        const file = e.target.files[0];
        if (!file) {
            updateSection('content', { logo: null });
            return;
        }
        const reader = new FileReader();
        reader.onload = (event) => updateSection('content', { logo: event.target.result });
        reader.readAsDataURL(file);
    };

    const handleSaveTemplate = () => {
        const fallbackName = content.name.trim() ? `${content.name.trim()} Design` : `Custom Design ${customTemplates.length + 1}`;
        const templateName = (templateNameInput.trim() || fallbackName).slice(0, 48);
        const newTemplate = createTemplateFromDraft(draft, templateName);
        if (saveTemplates([...customTemplates, newTemplate])) {
            setTemplateNameInput('');
            setTemplateSaveState('saved');
            window.setTimeout(() => setTemplateSaveState('idle'), 1400);
        }
    };

    const addCurrentToCueQueue = () => {
        const cue = createCueFromDraft(draft, `cue-${Date.now()}`);
        cue.label = content.name || content.title || `Cue ${cueQueue.length + 1}`;
        saveCueQueue([...cueQueue, cue]);
        setActiveCueIndex(cueQueue.length);
    };

    const showCue = (index) => {
        const cue = cueQueue[index];
        if (!cue) return;
        setActiveCueIndex(index);
        dispatch({ type: 'load_cue', cue });
        showLowerThirdData(buildLowerThirdPayload(normalizeDraft(cue)));
    };

    const showNextCue = () => {
        if (cueQueue.length === 0) return;
        showCue(Math.min(activeCueIndex + 1, cueQueue.length - 1));
    };

    const removeCue = (index) => {
        saveCueQueue(cueQueue.filter((_, idx) => idx !== index));
    };

    const moveCue = (index, direction) => {
        const nextIndex = index + direction;
        if (nextIndex < 0 || nextIndex >= cueQueue.length) return;
        const nextQueue = [...cueQueue];
        const [item] = nextQueue.splice(index, 1);
        nextQueue.splice(nextIndex, 0, item);
        saveCueQueue(nextQueue);
        if (activeCueIndex === index) setActiveCueIndex(nextIndex);
    };

    const preview = getTemplatePreviewColors(appearance.bgStyle);
    const previewScale = 250 / 1920;
    const draftPanelWidth = appearance.shapeStyle === 'full-band' ? 250 : Math.max(40, Math.min(Number(layout.panelWidth) || DEFAULT_LT_DESIGN.panelWidth, 1920) * previewScale);
    const draftX = appearance.shapeStyle === 'full-band' ? 0 : Math.max(0, Math.min(Number(layout.posX) || 0, 100));
    const draftY = appearance.shapeStyle === 'full-band' ? 0 : Math.max(0, Math.min(Number(layout.posY) || 0, 100));
    const draftLeft = appearance.shapeStyle === 'full-band' ? 0 : (draftX / 100) * 250;
    const draftBottom = (draftY / 100) * 140;
    const SQUARE_PREVIEW_SHAPES = ['sharp-block', 'angled', 'full-band', 'gradient-scrim', 'chamfered', 'chevron'];
    const previewShapeClass = appearance.shapeStyle === 'pill'
        ? 'rounded-full'
        : appearance.shapeStyle === 'outline'
            ? 'rounded-lg bg-transparent border-2'
            : appearance.shapeStyle === 'stacked'
                ? 'rounded-sm'
                : SQUARE_PREVIEW_SHAPES.includes(appearance.shapeStyle)
                    ? 'rounded-none'
                    : 'rounded-lg';

    const cueQueuePanel = (
        <div className="surface rounded-lg p-3 space-y-3 h-full">
            <SectionHeader
                icon={Clapperboard}
                title="Cue Queue"
                detail="Run order stores content and design together."
                action={(
                    <div className="flex items-center gap-2">
                        <button onClick={addCurrentToCueQueue} className="control-button-muted text-[10px] px-2 py-1 font-bold flex items-center gap-1 text-slate-700 dark:text-slate-200">
                            <CopyPlus className="w-3 h-3" />
                            ADD CURRENT
                        </button>
                        <button onClick={showNextCue} disabled={cueQueue.length === 0 || activeCueIndex >= cueQueue.length - 1} className="text-[10px] px-3 py-1 rounded-lg font-bold transition flex items-center gap-1 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:hover:bg-emerald-600 text-white">
                            <Play className="w-3 h-3" />
                            NEXT CUE
                        </button>
                    </div>
                )}
            />
            <div className="flex gap-2 overflow-x-auto pb-1 2xl:grid 2xl:grid-cols-2 2xl:overflow-x-visible 2xl:overflow-y-auto 2xl:max-h-[390px]">
                {cueQueue.length === 0 ? (
                    <div className="text-xs text-slate-500 italic py-3 w-full text-center">Add lower thirds here to build the event run order.</div>
                ) : (
                    cueQueue.map((cue, idx) => {
                        const normalizedCue = normalizeDraft(cue);
                        return (
                            <div key={cue.id || idx}
                                className={`surface-muted group min-w-[220px] 2xl:min-w-0 rounded-lg p-2 ${idx === activeCueIndex ? 'border-emerald-500 ring-2 ring-emerald-500/20' : ''}`}>
                                <button onClick={() => showCue(idx)} className="w-full text-left">
                                    <div className="flex items-center justify-between gap-2">
                                        <span className="text-[10px] font-mono text-slate-500">#{idx + 1}</span>
                                        <span className="text-[9px] font-bold text-slate-500 uppercase">{normalizedCue.appearance.shapeStyle}</span>
                                    </div>
                                    <div className="text-xs font-bold text-slate-800 dark:text-slate-100 truncate mt-1">{normalizedCue.content.name || cue.label || '(No Name)'}</div>
                                    <div className="text-[10px] text-slate-500 truncate font-guj">{normalizedCue.content.title || normalizedCue.content.subtitle2 || '(No Title)'}</div>
                                </button>
                                <div className="flex items-center gap-1 mt-2 opacity-100 md:opacity-0 group-hover:opacity-100 transition">
                                    <button onClick={() => moveCue(idx, -1)} className="control-button-muted p-1 rounded"><ArrowUp className="w-3 h-3" /></button>
                                    <button onClick={() => moveCue(idx, 1)} className="control-button-muted p-1 rounded"><ArrowDown className="w-3 h-3" /></button>
                                    <button onClick={() => showCue(idx)} className="px-2 py-1 rounded bg-emerald-600 text-white text-[9px] font-bold">TAKE</button>
                                    <button onClick={() => removeCue(idx)} className="ml-auto p-1 rounded bg-red-600 text-white"><Trash2 className="w-3 h-3" /></button>
                                </div>
                            </div>
                        );
                    })
                )}
            </div>
        </div>
    );

    return (
        <div className="space-y-3">
            <div className="grid grid-cols-1 2xl:grid-cols-[minmax(0,1.25fr)_minmax(330px,0.75fr)] gap-3">
                <div className="surface rounded-lg p-3 space-y-3">
                    <SectionHeader
                        icon={Play}
                        title="Live Builder"
                        detail="Build the next lower third here. Design presets below keep layout, motion, and content untouched."
                        action={(
                            <div className="flex items-center gap-2">
                                <span className="hidden md:inline-flex text-[10px] font-bold text-slate-500 uppercase tracking-wider border section-rule rounded-lg px-2 py-1">
                                    {selectedShape?.label || appearance.shapeStyle}
                                </span>
                                <span className="hidden md:inline-flex text-[10px] font-bold text-slate-500 uppercase tracking-wider border section-rule rounded-lg px-2 py-1">
                                    {selectedAnimation?.label || behavior.animation}
                                </span>
                            </div>
                        )}
                    />

                    <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_250px] gap-3">
                        <div className="space-y-3">
                            <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
                                <div className="space-y-1.5">
                                    <FieldLabel>English Name</FieldLabel>
                                    <input type="text" value={content.name} onChange={e => updateSection('content', { name: e.target.value })} placeholder="e.g. John Doe" className={inputClass} />
                                </div>
                                <div className="space-y-1.5">
                                    <div className="flex items-center justify-between gap-2">
                                        <FieldLabel>Gujarati Title</FieldLabel>
                                        <span className="text-[9px] text-emerald-600 dark:text-emerald-400 uppercase font-bold tracking-widest whitespace-nowrap">Auto</span>
                                    </div>
                                    <input type="text" ref={attachTransliteration} value={content.title} onChange={e => updateSection('content', { title: e.target.value })} placeholder="દા.ત. મુખ્ય અતિથિ" className={inputClass} dir="auto" />
                                </div>
                                <div className="space-y-1.5">
                                    <FieldLabel>Subtitle</FieldLabel>
                                    <input type="text" value={content.subtitle2} onChange={e => updateSection('content', { subtitle2: e.target.value })} placeholder="Optional subtitle" className={inputClass} />
                                </div>
                            </div>

                            <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                                <div className="space-y-1.5">
                                    <FieldLabel>Language Mode</FieldLabel>
                                    <select value={behavior.langOpt} onChange={e => updateSection('behavior', { langOpt: e.target.value })} className={inputClass}>
                                        <option value="both">English + Gujarati</option>
                                        <option value="eng">English Only</option>
                                        <option value="guj">Gujarati Only</option>
                                    </select>
                                </div>
                                <div className="space-y-1.5">
                                    <FieldLabel>Auto Clear</FieldLabel>
                                    <input type="number" value={behavior.autoClear} onChange={e => updateSection('behavior', { autoClear: e.target.value })} placeholder="Manual" min="0" className={inputClass} />
                                </div>
                                <div className="space-y-1.5 md:col-span-2">
                                    <FieldLabel>Logo</FieldLabel>
                                    <div className="flex items-center gap-2">
                                        <input type="file" accept="image/*" onChange={handleFile}
                                            className="min-w-0 flex-1 text-xs text-slate-600 dark:text-slate-400 file:mr-3 file:py-2 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-bold file:bg-blue-600 file:text-white hover:file:bg-blue-700" />
                                        {content.logo && (
                                            <button onClick={() => updateSection('content', { logo: null })} className="px-3 py-2 rounded-lg text-[10px] font-bold bg-red-600/10 text-red-600 border border-red-600/20">
                                                REMOVE
                                            </button>
                                        )}
                                    </div>
                                </div>
                            </div>

                            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                                <button onClick={handleShow} className="col-span-2 bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-3 rounded-xl font-bold shadow-lg shadow-emerald-600/20 transition active:scale-95">
                                    TAKE LIVE
                                </button>
                                <button onClick={addCurrentToCueQueue} className="control-button-muted text-slate-700 dark:text-slate-200 px-3 py-3 rounded-lg font-bold text-xs active:scale-95">
                                    ADD TO QUEUE
                                </button>
                                <button onClick={handleHide} className="bg-red-600/10 hover:bg-red-600 text-red-600 hover:text-white border border-red-600/20 px-3 py-3 rounded-xl font-bold text-xs transition active:scale-95">
                                    CLEAR
                                </button>
                            </div>
                        </div>

                        <div className={`${preview.frame} rounded-xl border border-slate-700 overflow-hidden min-h-[190px] relative`}>
                            <div className="absolute inset-0 opacity-20 bg-[linear-gradient(90deg,transparent_0,rgba(255,255,255,.2)_1px,transparent_1px),linear-gradient(0deg,transparent_0,rgba(255,255,255,.16)_1px,transparent_1px)] bg-[length:28px_28px]" />
                            <div className="absolute left-3 right-3 top-3 flex items-center justify-between">
                                <span className="text-[9px] text-white/60 font-bold uppercase tracking-wider">Draft Look</span>
                                <span className="text-[9px] text-white/60 font-bold uppercase tracking-wider">{selectedBackground?.label || appearance.bgStyle}</span>
                            </div>
                            <div
                                className={`absolute ${preview.panel} ${previewShapeClass} border-l-4 p-3 shadow-xl`}
                                style={{
                                    borderLeftColor: appearance.accentColor,
                                    width: `${draftPanelWidth}px`,
                                    left: `${draftLeft}px`,
                                    bottom: `${draftBottom + 14}px`,
                                    transform: appearance.shapeStyle === 'full-band' ? 'none' : `translateX(-${draftX}%)`,
                                    minHeight: '74px',
                                    clipPath: appearance.shapeStyle === 'angled' ? 'polygon(6% 0, 100% 0, 94% 100%, 0 100%)' : undefined
                                }}
                            >
                                {appearance.shapeStyle === 'angled' && (
                                    <div
                                        className="absolute top-0 bottom-0 w-4"
                                        style={{
                                            left: '0.75rem',
                                            backgroundColor: appearance.accentColor,
                                            transform: 'skewX(-14deg)'
                                        }}
                                    />
                                )}
                                <div className="relative">
                                    <div className="text-white font-bold text-[13px] leading-tight truncate">{content.name || 'Speaker Name'}</div>
                                    <div className="text-white/80 text-[11px] leading-tight truncate font-guj">{content.title || 'ગુજરાતી શીર્ષક'}</div>
                                    <div className="mt-2 h-px w-full" style={{ backgroundColor: appearance.accentColor }} />
                                    <div className="mt-2 text-[9px] font-bold text-white/55 uppercase tracking-widest truncate">{content.subtitle2 || 'Subtitle'}</div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                {cueQueuePanel}
            </div>

            <div className="surface rounded-lg p-3 space-y-3">
                <SectionHeader
                    icon={Sparkles}
                    title="Design Presets"
                    detail="Presets change visual styling only. Layout, motion, and content stay as set."
                    action={(
                        <div className="flex flex-wrap items-center gap-2">
                            <input
                                type="text"
                                value={templateNameInput}
                                onChange={e => setTemplateNameInput(e.target.value)}
                                onKeyDown={e => {
                                    if (e.key === 'Enter') handleSaveTemplate();
                                }}
                                placeholder={content.name.trim() ? `${content.name.trim()} Design` : `Custom Design ${customTemplates.length + 1}`}
                                className="control-field w-40 px-2 py-1 text-[10px]"
                            />
                            <button onClick={handleSaveTemplate}
                                className={`text-[10px] px-2 py-1 rounded-lg font-bold transition flex items-center gap-1 border ${
                                    templateSaveState === 'saved'
                                        ? 'bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-600 dark:text-emerald-300 border-emerald-500/30'
                                        : 'bg-amber-500/10 hover:bg-amber-500/20 text-amber-600 dark:text-amber-300 border-amber-500/30'
                                }`}>
                                <Save className="w-3 h-3" />
                                {templateSaveState === 'saved' ? 'SAVED' : 'SAVE DESIGN'}
                            </button>
                        </div>
                    )}
                />
                <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-2">
                    {allTemplates.map(template => {
                        const isCustom = template.id?.startsWith('custom-');
                        const patch = templateToDraftPatch(template);
                        const colors = getTemplatePreviewColors(patch.appearance.bgStyle);
                        const isSelected = appearance.bgStyle === patch.appearance.bgStyle &&
                            appearance.accentColor === patch.appearance.accentColor &&
                            appearance.shapeStyle === patch.appearance.shapeStyle;
                        return (
                            <div key={template.id} className="relative group">
                                <button onClick={() => dispatch({ type: 'apply_template', template })}
                                    className={`surface-muted w-full text-left rounded-lg overflow-hidden transition active:scale-[0.98] ${isSelected ? 'border-amber-500 ring-2 ring-amber-500/20' : 'hover:border-amber-500/60'}`}>
                                    <div className={`h-16 ${colors.frame} relative overflow-hidden`}>
                                        <div className={`absolute ${patch.appearance.shapeStyle === 'full-band' ? 'left-0 right-0 bottom-2' : 'left-3 bottom-2.5 w-[78%]'} h-8 flex items-center`}>
                                            <div
                                                className={`w-full h-full ${patch.appearance.shapeStyle === 'pill' ? 'rounded-full' : patch.appearance.shapeStyle === 'sharp-block' || patch.appearance.shapeStyle === 'angled' ? 'rounded-none' : 'rounded-md'} ${colors.panel} ${colors.accent} border-l-4 px-2 py-1.5 shadow-lg`}
                                                style={{
                                                    borderLeftColor: patch.appearance.accentColor,
                                                    clipPath: patch.appearance.shapeStyle === 'angled' ? 'polygon(8% 0, 100% 0, 92% 100%, 0 100%)' : undefined
                                                }}
                                            >
                                                <div className="h-1.5 w-[66%] rounded bg-white/90 mb-1.5" />
                                                <div className="h-1 w-[48%] rounded bg-white/45" />
                                            </div>
                                        </div>
                                    </div>
                                    <div className="px-2 py-2">
                                        <div className="text-xs font-bold text-slate-800 dark:text-slate-100 truncate">{template.name}</div>
                                        <div className="text-[9px] text-slate-500 truncate">{SHAPE_PRESETS.find(s => s.id === patch.appearance.shapeStyle)?.label || patch.appearance.shapeStyle}</div>
                                    </div>
                                </button>
                                {isCustom && (
                                    <button onClick={() => saveTemplates(customTemplates.filter(item => item.id !== template.id))}
                                        className="absolute top-1 right-1 p-1 rounded bg-red-600 text-white opacity-0 group-hover:opacity-100 transition">
                                        <Trash2 className="w-3 h-3" />
                                    </button>
                                )}
                            </div>
                        );
                    })}
                </div>
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-[1fr_1fr_0.8fr] gap-3">
                <div className="surface rounded-lg p-3 space-y-3">
                    <SectionHeader
                        icon={Sparkles}
                        title="Shape And Layout"
                        action={<button onClick={() => dispatch({ type: 'reset_design' })} className="text-[10px] font-bold text-slate-500 hover:text-slate-800 dark:hover:text-white uppercase tracking-widest transition">Reset</button>}
                    />
                    <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
                        {SHAPE_PRESETS.map(shape => (
                            <button key={shape.id} onClick={() => updateSection('appearance', { shapeStyle: shape.id })}
                                className={`px-2 py-1.5 rounded-lg text-[10px] font-bold border transition ${appearance.shapeStyle === shape.id ? 'bg-amber-600 text-white border-amber-600' : 'control-button-muted hover:text-slate-800 dark:hover:text-white'}`}>
                                {shape.label}
                            </button>
                        ))}
                    </div>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                        <div className="space-y-1">
                            <FieldLabel>Background</FieldLabel>
                            <select value={appearance.bgStyle} onChange={e => updateSection('appearance', { bgStyle: e.target.value })} className={compactInputClass}>
                                {BACKGROUND_STYLES.map(bg => <option key={bg.id} value={bg.id}>{bg.label}</option>)}
                            </select>
                        </div>
                        <div className="space-y-1">
                            <FieldLabel>Width</FieldLabel>
                            <input type="number" min="360" max="1920" step="20" value={layout.panelWidth} onChange={e => updateSection('layout', { panelWidth: Number(e.target.value) })} className={compactInputClass} />
                        </div>
                        <div className="space-y-1">
                            <FieldLabel>Text Align</FieldLabel>
                            <select value={layout.textAlign} onChange={e => updateSection('layout', { textAlign: e.target.value })} className={compactInputClass}>
                                <option value="left">Left</option>
                                <option value="center">Center</option>
                                <option value="right">Right</option>
                            </select>
                        </div>
                        <div className="space-y-1">
                            <FieldLabel>Logo Placement</FieldLabel>
                            <select value={layout.logoPlacement} onChange={e => updateSection('layout', { logoPlacement: e.target.value })} className={compactInputClass}>
                                <option value="left">Left</option>
                                <option value="right">Right</option>
                                <option value="badge">Badge</option>
                                <option value="hidden">Hidden</option>
                            </select>
                        </div>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                        {[
                            ['Horizontal', layout.posX, value => updateSection('layout', { posX: value }), 0, 100, '%'],
                            ['Vertical', layout.posY, value => updateSection('layout', { posY: value }), 0, 100, '%'],
                            ['Opacity', appearance.panelOpacity, value => updateSection('appearance', { panelOpacity: value }), 0, 100, '%'],
                            ['Shadow', appearance.shadowIntensity, value => updateSection('appearance', { shadowIntensity: value }), 0, 100, '%']
                        ].map(([label, value, setter, min, max, suffix]) => (
                            <div key={label} className="space-y-1">
                                <div className="flex items-center justify-between">
                                    <FieldLabel>{label}</FieldLabel>
                                    <span className="text-[10px] font-bold text-amber-500">{value}{suffix}</span>
                                </div>
                                <input type="range" min={min} max={max} value={value} onChange={e => setter(Number(e.target.value))}
                                    className="w-full h-1.5 bg-slate-200 dark:bg-slate-700 rounded-lg appearance-none cursor-pointer accent-amber-500" />
                            </div>
                        ))}
                    </div>
                </div>

                <div className="surface rounded-lg p-3 space-y-3">
                    <SectionHeader icon={Layers} title="Look And Motion" />
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                        <div className="space-y-1">
                            <FieldLabel>Accent</FieldLabel>
                            <input type="color" value={appearance.accentColor} onChange={e => updateSection('appearance', { accentColor: e.target.value })} className="control-field h-8 px-1 py-1 cursor-pointer" />
                        </div>
                        <div className="space-y-1">
                            <FieldLabel>Border Width</FieldLabel>
                            <input type="number" min="0" max="12" value={appearance.borderWidth} onChange={e => updateSection('appearance', { borderWidth: Number(e.target.value) })} className={compactInputClass} />
                        </div>
                        <div className="space-y-1">
                            <FieldLabel>Border Color</FieldLabel>
                            <input type="color" value={appearance.borderColor} onChange={e => updateSection('appearance', { borderColor: e.target.value })} className="control-field h-8 px-1 py-1 cursor-pointer" />
                        </div>
                        <div className="space-y-1">
                            <FieldLabel>Logo Size</FieldLabel>
                            <input type="number" min="60" max="260" value={layout.logoSize} onChange={e => updateSection('layout', { logoSize: Number(e.target.value) })} className={compactInputClass} />
                        </div>
                        <div className="space-y-1">
                            <FieldLabel>Accent 2</FieldLabel>
                            <input type="color" value={appearance.accentColor2} onChange={e => updateSection('appearance', { accentColor2: e.target.value })} className="control-field h-8 px-1 py-1 cursor-pointer" />
                        </div>
                        <div className="space-y-1">
                            <FieldLabel>Gradient Accent</FieldLabel>
                            <button onClick={() => updateSection('appearance', { accentGradient: !appearance.accentGradient })}
                                className={`w-full rounded-lg border px-2 py-1.5 text-[10px] font-bold transition ${appearance.accentGradient ? 'bg-indigo-600 text-white border-indigo-600' : 'control-button-muted'}`}>
                                {appearance.accentGradient ? 'On' : 'Off'}
                            </button>
                        </div>
                        <div className="space-y-1">
                            <FieldLabel>Corner Radius</FieldLabel>
                            <input type="number" min="-1" max="120" value={appearance.cornerRadius}
                                title="-1 keeps each shape's own radius"
                                onChange={e => updateSection('appearance', { cornerRadius: Number(e.target.value) })} className={compactInputClass} />
                        </div>
                        <div className="space-y-1">
                            <FieldLabel>Text Glow</FieldLabel>
                            <input type="number" min="0" max="100" value={typography.textGlow} onChange={e => updateSection('typography', { textGlow: Number(e.target.value) })} className={compactInputClass} />
                        </div>
                    </div>
                    <div className="space-y-2">
                        <div className="flex items-center justify-between">
                            <FieldLabel>Animation</FieldLabel>
                            <span className="text-[10px] font-bold text-indigo-500">{selectedAnimation?.label || behavior.animation}</span>
                        </div>
                        <div className="flex flex-wrap gap-2">
                            {ANIMATION_PRESETS.map(animation => (
                                <button key={animation.id} onClick={() => updateSection('behavior', { animation: animation.id })}
                                    className={`px-2.5 py-1 rounded-lg text-[10px] font-bold border transition ${behavior.animation === animation.id ? 'bg-indigo-600 text-white border-indigo-600' : 'control-button-muted hover:text-slate-800 dark:hover:text-white'}`}>
                                    {animation.label}
                                </button>
                            ))}
                        </div>
                    </div>
                    <div className="space-y-1">
                        <div className="flex items-center justify-between">
                            <FieldLabel>Animation Speed</FieldLabel>
                            <span className="text-[10px] font-bold text-slate-500">{Number(behavior.animationSpeed || 1).toFixed(2)}x</span>
                        </div>
                        <input type="range" min="0.5" max="2" step="0.05" value={behavior.animationSpeed || 1}
                            onChange={e => updateSection('behavior', { animationSpeed: Number(e.target.value) })}
                            className="w-full h-1.5 bg-slate-200 dark:bg-slate-700 rounded-lg appearance-none cursor-pointer accent-indigo-500" />
                    </div>
                </div>

                <div className="surface rounded-lg p-3 space-y-3">
                    <SectionHeader icon={Layers} title="Typography" />
                    <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1.5 col-span-2">
                            <FieldLabel>Font Family</FieldLabel>
                            <select value={typography.fontFamily} onChange={e => updateSection('typography', { fontFamily: e.target.value })} className={compactInputClass}>
                                <option value="'Outfit', sans-serif">Outfit</option>
                                <option value="'Inter', sans-serif">Inter</option>
                                <option value="'Poppins', sans-serif">Poppins</option>
                                <option value="'Montserrat', sans-serif">Montserrat</option>
                                <option value="'Roboto', sans-serif">Roboto</option>
                                <option value="'Playfair Display', serif">Playfair Display</option>
                                <option value="'Lora', serif">Lora</option>
                                <option value="'Bebas Neue', cursive">Bebas Neue</option>
                                <option value="'Oswald', sans-serif">Oswald</option>
                                <option value="'Open Sans', sans-serif">Open Sans</option>
                            </select>
                        </div>
                        <div className="space-y-1.5 col-span-2">
                            <FieldLabel>Gujarati Title Font</FieldLabel>
                            <select value={typography.gujFontFamily} onChange={e => updateSection('typography', { gujFontFamily: e.target.value })} className={compactInputClass}>
                                {GUJ_FONT_OPTIONS.map(font => (
                                    <option key={font.value} value={font.value}>{font.label}</option>
                                ))}
                            </select>
                        </div>
                        <div className="space-y-1.5">
                            <FieldLabel>Weight</FieldLabel>
                            <select value={typography.fontWeight} onChange={e => updateSection('typography', { fontWeight: e.target.value })} className={compactInputClass}>
                                <option value="300">Light</option>
                                <option value="400">Regular</option>
                                <option value="600">Semi-Bold</option>
                                <option value="700">Bold</option>
                                <option value="800">Extra-Bold</option>
                            </select>
                        </div>
                        <div className="space-y-1.5">
                            <FieldLabel>Color (all lines)</FieldLabel>
                            <input type="color" value={typography.color} onChange={e => updateSection('typography', { color: e.target.value })} className="control-field h-8 px-1 py-1 cursor-pointer" />
                        </div>
                        {/* Per-line overrides. Blank inherits the colour above, which is what
                            keeps templates saved before this existed looking identical. */}
                        {[
                            ['nameColor', 'Name'],
                            ['titleColor', 'Title'],
                            ['subtitleColor', 'Subtitle']
                        ].map(([key, label]) => (
                            <div key={key} className="space-y-1.5">
                                <FieldLabel>{label} Colour</FieldLabel>
                                <div className="flex gap-1">
                                    <input type="color" value={typography[key] || typography.color}
                                        onChange={e => updateSection('typography', { [key]: e.target.value })}
                                        className="control-field h-8 flex-1 px-1 py-1 cursor-pointer" />
                                    <button onClick={() => updateSection('typography', { [key]: '' })}
                                        title="Inherit the colour above"
                                        className={`rounded px-2 text-[9px] font-bold transition ${typography[key] ? 'control-button-muted' : 'bg-indigo-600 text-white'}`}>
                                        AUTO
                                    </button>
                                </div>
                            </div>
                        ))}
                        <div className="space-y-1.5">
                            <FieldLabel>Size</FieldLabel>
                            <input type="number" value={typography.fontSizeFactor} onChange={e => updateSection('typography', { fontSizeFactor: e.target.value })} className={compactInputClass} />
                        </div>
                        <div className="space-y-1.5">
                            <FieldLabel>Spacing</FieldLabel>
                            <input type="number" value={typography.letterSpacing} onChange={e => updateSection('typography', { letterSpacing: e.target.value })} step="0.5" className={compactInputClass} />
                        </div>
                        <div className="col-span-2 flex gap-1">
                            <button onClick={() => updateSection('typography', { bold: !typography.bold })} className={`flex-1 rounded p-1.5 text-xs font-bold transition ${typography.bold ? 'bg-indigo-600 text-white' : 'control-button-muted text-slate-600 dark:text-slate-400'}`}>B</button>
                            <button onClick={() => updateSection('typography', { italic: !typography.italic })} className={`flex-1 rounded p-1.5 text-xs italic transition ${typography.italic ? 'bg-indigo-600 text-white' : 'control-button-muted text-slate-600 dark:text-slate-400'}`}>I</button>
                            <button onClick={() => updateSection('typography', { underline: !typography.underline })} className={`flex-1 rounded p-1.5 text-xs underline transition ${typography.underline ? 'bg-indigo-600 text-white' : 'control-button-muted text-slate-600 dark:text-slate-400'}`}>U</button>
                        </div>
                    </div>
                </div>
            </div>

        </div>
    );
}
