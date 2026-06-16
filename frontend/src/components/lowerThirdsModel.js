export const LT_TEMPLATE_KEY = 'bc_lt_template_library_v1';
export const LT_CUE_QUEUE_KEY = 'bc_lt_cue_queue_v1';

export const ANIMATION_PRESETS = [
    { id: 'elastic', label: 'Fluid Reveal' },
    { id: 'wipe', label: 'Wipe Reveal' },
    { id: 'stagger', label: 'Stagger Lines' },
    { id: 'typeOn', label: 'Type On' },
    { id: 'slideRight', label: 'Slide Right' },
    { id: 'slideLeft', label: 'Slide Left' },
    { id: 'slideUp', label: 'Slide Up' },
    { id: 'fade', label: 'Fade' },
    { id: 'zoom', label: 'Zoom' },
    { id: 'blur', label: 'Blur' },
    { id: 'flip', label: 'Flip 3D' },
    { id: 'bounce', label: 'Bounce' },
    { id: 'elasticDrop', label: 'Elastic Drop' },
    { id: 'spin', label: 'Spin' },
    { id: 'none', label: 'None' }
];

export const SHAPE_PRESETS = [
    { id: 'glass-card', label: 'Glass Card' },
    { id: 'rounded-bar', label: 'Rounded Bar' },
    { id: 'sharp-block', label: 'Sharp Block' },
    { id: 'pill', label: 'Pill Capsule' },
    { id: 'angled', label: 'Angled Banner' },
    { id: 'split', label: 'Split Blocks' },
    { id: 'ribbon', label: 'Ribbon Tab' },
    { id: 'underline', label: 'Underline' },
    { id: 'badge-left', label: 'Logo Badge' },
    { id: 'full-band', label: 'Full Band' }
];

export const BACKGROUND_STYLES = [
    { id: 'default', label: 'Dark Glass' },
    { id: 'midnight', label: 'Midnight Blue' },
    { id: 'charcoal', label: 'Charcoal Matte' },
    { id: 'deep-purple', label: 'Deep Purple' },
    { id: 'ocean', label: 'Ocean Teal' },
    { id: 'burgundy', label: 'Burgundy Red' },
    { id: 'forest', label: 'Forest Green' },
    { id: 'warm-gold', label: 'Warm Gold' },
    { id: 'frosted', label: 'Frosted Glass' },
    { id: 'gradient-sunset', label: 'Gradient Sunset' },
    { id: 'gradient-aurora', label: 'Gradient Aurora' }
];

export const DEFAULT_LT_DESIGN = {
    shapeStyle: 'glass-card',
    accentColor: '#3b82f6',
    panelOpacity: 88,
    shadowIntensity: 75,
    borderWidth: 1,
    borderColor: '#ffffff',
    panelWidth: 650,
    posX: 10,
    posY: 15,
    logoPlacement: 'left',
    logoSize: 160,
    textAlign: 'left'
};

export const DEFAULT_LT_STYLE = {
    fontFamily: "'Outfit', sans-serif",
    fontWeight: '700',
    fontSizeFactor: '100',
    color: '#ffffff',
    letterSpacing: '0',
    bold: true,
    italic: false,
    underline: false
};

export const DEFAULT_LOWER_THIRD_DRAFT = {
    content: {
        name: '',
        title: '',
        subtitle2: '',
        logo: null
    },
    appearance: {
        bgStyle: 'default',
        shapeStyle: DEFAULT_LT_DESIGN.shapeStyle,
        accentColor: DEFAULT_LT_DESIGN.accentColor,
        panelOpacity: DEFAULT_LT_DESIGN.panelOpacity,
        shadowIntensity: DEFAULT_LT_DESIGN.shadowIntensity,
        borderWidth: DEFAULT_LT_DESIGN.borderWidth,
        borderColor: DEFAULT_LT_DESIGN.borderColor
    },
    layout: {
        panelWidth: DEFAULT_LT_DESIGN.panelWidth,
        posX: DEFAULT_LT_DESIGN.posX,
        posY: DEFAULT_LT_DESIGN.posY,
        logoPlacement: DEFAULT_LT_DESIGN.logoPlacement,
        logoSize: DEFAULT_LT_DESIGN.logoSize,
        textAlign: DEFAULT_LT_DESIGN.textAlign
    },
    typography: DEFAULT_LT_STYLE,
    behavior: {
        animation: 'elastic',
        langOpt: 'both',
        autoClear: ''
    }
};

export const BUILT_IN_TEMPLATES = [
    {
        id: 'speaker-glass',
        name: 'Speaker Glass',
        description: 'Clean speaker ID',
        bgStyle: 'default',
        animation: 'elastic',
        langOpt: 'both',
        style: { fontFamily: "'Outfit', sans-serif", fontWeight: '700', fontSizeFactor: '100', color: '#ffffff', letterSpacing: '0', bold: true, italic: false, underline: false }
    },
    {
        id: 'announcement-gold',
        name: 'Announcement',
        description: 'Warm event cue',
        bgStyle: 'warm-gold',
        animation: 'slideRight',
        langOpt: 'eng',
        style: { fontFamily: "'Montserrat', sans-serif", fontWeight: '800', fontSizeFactor: '92', color: '#fff7d6', letterSpacing: '1', bold: true, italic: false, underline: false }
    },
    {
        id: 'guest-midnight',
        name: 'Guest Intro',
        description: 'Formal title card',
        bgStyle: 'midnight',
        animation: 'wipe',
        langOpt: 'both',
        style: { fontFamily: "'Playfair Display', serif", fontWeight: '700', fontSizeFactor: '105', color: '#ffffff', letterSpacing: '0.5', bold: true, italic: false, underline: false }
    },
    {
        id: 'minimal-frosted',
        name: 'Minimal',
        description: 'Light glass label',
        bgStyle: 'frosted',
        animation: 'fade',
        langOpt: 'eng',
        style: { fontFamily: "'Inter', sans-serif", fontWeight: '600', fontSizeFactor: '86', color: '#ffffff', letterSpacing: '0', bold: false, italic: false, underline: false }
    },
    {
        id: 'translation-ocean',
        name: 'Gujarati Focus',
        description: 'Gujarati-first lower third',
        bgStyle: 'ocean',
        animation: 'stagger',
        langOpt: 'guj',
        style: { fontFamily: "'Outfit', sans-serif", fontWeight: '700', fontSizeFactor: '112', color: '#e8fffb', letterSpacing: '0', bold: true, italic: false, underline: false }
    },
    {
        id: 'urgent-burgundy',
        name: 'Urgent',
        description: 'High-contrast notice',
        bgStyle: 'burgundy',
        animation: 'bounce',
        langOpt: 'eng',
        style: { fontFamily: "'Oswald', sans-serif", fontWeight: '800', fontSizeFactor: '100', color: '#ffffff', letterSpacing: '1.5', bold: true, italic: false, underline: false }
    },
    {
        id: 'festival-ribbon',
        name: 'Festival Ribbon',
        description: 'Celebration banner',
        bgStyle: 'gradient-sunset',
        animation: 'wipe',
        langOpt: 'both',
        design: { shapeStyle: 'ribbon', accentColor: '#f59e0b', panelOpacity: 92, panelWidth: 820, posX: 8, posY: 13, shadowIntensity: 85 },
        style: { fontFamily: "'Montserrat', sans-serif", fontWeight: '800', fontSizeFactor: '98', color: '#fff7ed', letterSpacing: '0.5', bold: true, italic: false, underline: false }
    },
    {
        id: 'formal-split',
        name: 'Formal Split',
        description: 'Name/title blocks',
        bgStyle: 'charcoal',
        animation: 'stagger',
        langOpt: 'both',
        design: { shapeStyle: 'split', accentColor: '#94a3b8', panelOpacity: 96, panelWidth: 760, posX: 9, posY: 14, shadowIntensity: 65 },
        style: { fontFamily: "'Playfair Display', serif", fontWeight: '700', fontSizeFactor: '102', color: '#ffffff', letterSpacing: '0', bold: true, italic: false, underline: false }
    },
    {
        id: 'youth-pill',
        name: 'Youth Pill',
        description: 'Compact modern',
        bgStyle: 'deep-purple',
        animation: 'zoom',
        langOpt: 'eng',
        design: { shapeStyle: 'pill', accentColor: '#a78bfa', panelOpacity: 90, panelWidth: 680, posX: 11, posY: 15, shadowIntensity: 70 },
        style: { fontFamily: "'Poppins', sans-serif", fontWeight: '800', fontSizeFactor: '90', color: '#ffffff', letterSpacing: '0.5', bold: true, italic: false, underline: false }
    },
    {
        id: 'broadcast-sharp',
        name: 'Broadcast Sharp',
        description: 'Clean rectangular',
        bgStyle: 'midnight',
        animation: 'slideRight',
        langOpt: 'both',
        design: { shapeStyle: 'sharp-block', accentColor: '#38bdf8', panelOpacity: 94, panelWidth: 760, posX: 8, posY: 14, shadowIntensity: 80 },
        style: { fontFamily: "'Inter', sans-serif", fontWeight: '800', fontSizeFactor: '95', color: '#ffffff', letterSpacing: '0.4', bold: true, italic: false, underline: false }
    },
    {
        id: 'minimal-underline',
        name: 'Minimal Line',
        description: 'No box lower third',
        bgStyle: 'default',
        animation: 'fade',
        langOpt: 'eng',
        design: { shapeStyle: 'underline', accentColor: '#22c55e', panelOpacity: 0, panelWidth: 640, posX: 10, posY: 14, shadowIntensity: 45, borderWidth: 0 },
        style: { fontFamily: "'Outfit', sans-serif", fontWeight: '700', fontSizeFactor: '88', color: '#ffffff', letterSpacing: '0', bold: true, italic: false, underline: false }
    },
    {
        id: 'media-full-band',
        name: 'Full Band',
        description: 'Wide lower strap',
        bgStyle: 'ocean',
        animation: 'slideUp',
        langOpt: 'both',
        design: { shapeStyle: 'full-band', accentColor: '#14b8a6', panelOpacity: 90, panelWidth: 1920, posX: 0, posY: 0, shadowIntensity: 60, textAlign: 'center' },
        style: { fontFamily: "'Montserrat', sans-serif", fontWeight: '700', fontSizeFactor: '92', color: '#ecfeff', letterSpacing: '0.2', bold: true, italic: false, underline: false }
    },
    {
        id: 'guest-badge',
        name: 'Guest Badge',
        description: 'Logo-forward intro',
        bgStyle: 'forest',
        animation: 'elastic',
        langOpt: 'both',
        design: { shapeStyle: 'badge-left', accentColor: '#22c55e', panelOpacity: 92, panelWidth: 780, posX: 8, posY: 14, logoPlacement: 'badge', logoSize: 150, shadowIntensity: 85 },
        style: { fontFamily: "'Outfit', sans-serif", fontWeight: '800', fontSizeFactor: '100', color: '#f0fdf4', letterSpacing: '0', bold: true, italic: false, underline: false }
    },
    {
        id: 'angled-announcement',
        name: 'Angled Notice',
        description: 'Slanted energy',
        bgStyle: 'burgundy',
        animation: 'wipe',
        langOpt: 'eng',
        design: { shapeStyle: 'angled', accentColor: '#ef4444', panelOpacity: 94, panelWidth: 780, posX: 9, posY: 14, shadowIntensity: 80 },
        style: { fontFamily: "'Oswald', sans-serif", fontWeight: '800', fontSizeFactor: '96', color: '#ffffff', letterSpacing: '1.2', bold: true, italic: false, underline: false }
    }
];

const toNumber = (value, fallback) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};

const clean = (value, fallback) => value ?? fallback;

export const withDesign = (design = {}) => ({
    ...DEFAULT_LT_DESIGN,
    ...design,
    panelOpacity: toNumber(clean(design.panelOpacity, DEFAULT_LT_DESIGN.panelOpacity), DEFAULT_LT_DESIGN.panelOpacity),
    shadowIntensity: toNumber(clean(design.shadowIntensity, DEFAULT_LT_DESIGN.shadowIntensity), DEFAULT_LT_DESIGN.shadowIntensity),
    borderWidth: toNumber(clean(design.borderWidth, DEFAULT_LT_DESIGN.borderWidth), DEFAULT_LT_DESIGN.borderWidth),
    panelWidth: toNumber(clean(design.panelWidth, DEFAULT_LT_DESIGN.panelWidth), DEFAULT_LT_DESIGN.panelWidth),
    posX: toNumber(clean(design.posX, DEFAULT_LT_DESIGN.posX), DEFAULT_LT_DESIGN.posX),
    posY: toNumber(clean(design.posY, DEFAULT_LT_DESIGN.posY), DEFAULT_LT_DESIGN.posY),
    logoSize: toNumber(clean(design.logoSize, DEFAULT_LT_DESIGN.logoSize), DEFAULT_LT_DESIGN.logoSize)
});

export const withStyle = (style = {}) => ({
    ...DEFAULT_LT_STYLE,
    ...style,
    bold: style.bold ?? DEFAULT_LT_STYLE.bold,
    italic: style.italic ?? DEFAULT_LT_STYLE.italic,
    underline: style.underline ?? DEFAULT_LT_STYLE.underline
});

export const getDesignFromDraft = (draft) => withDesign({
    ...draft.appearance,
    ...draft.layout
});

export const getStyleFromDraft = (draft) => withStyle(draft.typography);

export const normalizeDraft = (input = {}) => {
    const legacyDesign = withDesign(input.design || {});
    const legacyStyle = withStyle(input.style || {});

    return {
        content: {
            ...DEFAULT_LOWER_THIRD_DRAFT.content,
            ...(input.content || {}),
            name: clean(input.content?.name, input.name ?? DEFAULT_LOWER_THIRD_DRAFT.content.name),
            title: clean(input.content?.title, input.title ?? DEFAULT_LOWER_THIRD_DRAFT.content.title),
            subtitle2: clean(input.content?.subtitle2, input.subtitle2 ?? DEFAULT_LOWER_THIRD_DRAFT.content.subtitle2),
            logo: clean(input.content?.logo, input.logo ?? DEFAULT_LOWER_THIRD_DRAFT.content.logo)
        },
        appearance: {
            ...DEFAULT_LOWER_THIRD_DRAFT.appearance,
            ...(input.appearance || {}),
            bgStyle: clean(input.appearance?.bgStyle, input.bgStyle ?? DEFAULT_LOWER_THIRD_DRAFT.appearance.bgStyle),
            shapeStyle: clean(input.appearance?.shapeStyle, legacyDesign.shapeStyle),
            accentColor: clean(input.appearance?.accentColor, legacyDesign.accentColor),
            panelOpacity: clean(input.appearance?.panelOpacity, legacyDesign.panelOpacity),
            shadowIntensity: clean(input.appearance?.shadowIntensity, legacyDesign.shadowIntensity),
            borderWidth: clean(input.appearance?.borderWidth, legacyDesign.borderWidth),
            borderColor: clean(input.appearance?.borderColor, legacyDesign.borderColor)
        },
        layout: {
            ...DEFAULT_LOWER_THIRD_DRAFT.layout,
            ...(input.layout || {}),
            panelWidth: clean(input.layout?.panelWidth, legacyDesign.panelWidth),
            posX: clean(input.layout?.posX, legacyDesign.posX),
            posY: clean(input.layout?.posY, legacyDesign.posY),
            logoPlacement: clean(input.layout?.logoPlacement, legacyDesign.logoPlacement),
            logoSize: clean(input.layout?.logoSize, legacyDesign.logoSize),
            textAlign: clean(input.layout?.textAlign, legacyDesign.textAlign)
        },
        typography: {
            ...DEFAULT_LOWER_THIRD_DRAFT.typography,
            ...legacyStyle,
            ...(input.typography || {})
        },
        behavior: {
            ...DEFAULT_LOWER_THIRD_DRAFT.behavior,
            ...(input.behavior || {}),
            animation: clean(input.behavior?.animation, input.animation ?? DEFAULT_LOWER_THIRD_DRAFT.behavior.animation),
            langOpt: clean(input.behavior?.langOpt, input.langOpt ?? DEFAULT_LOWER_THIRD_DRAFT.behavior.langOpt),
            autoClear: clean(input.behavior?.autoClear, input.autoClear ?? DEFAULT_LOWER_THIRD_DRAFT.behavior.autoClear)
        }
    };
};

export const buildLowerThirdPayload = (draft) => {
    const normalized = normalizeDraft(draft);
    return {
        name: normalized.content.name,
        title: normalized.content.title,
        subtitle2: normalized.content.subtitle2,
        animation: normalized.behavior.animation,
        langOpt: normalized.behavior.langOpt,
        autoClear: normalized.behavior.autoClear,
        bgStyle: normalized.appearance.bgStyle,
        logo: normalized.content.logo,
        style: getStyleFromDraft(normalized),
        design: getDesignFromDraft(normalized)
    };
};

export const templateToDraftPatch = (template = {}) => {
    const normalized = normalizeDraft(template);
    return {
        appearance: normalized.appearance,
        layout: normalized.layout,
        typography: normalized.typography,
        behavior: normalized.behavior
    };
};

export const createTemplateFromDraft = (draft, name, id = `custom-${Date.now()}`) => {
    const normalized = normalizeDraft(draft);
    return {
        id,
        name,
        description: `${normalized.appearance.bgStyle} / ${normalized.behavior.animation}`,
        appearance: normalized.appearance,
        layout: normalized.layout,
        typography: normalized.typography,
        behavior: normalized.behavior,
        bgStyle: normalized.appearance.bgStyle,
        animation: normalized.behavior.animation,
        langOpt: normalized.behavior.langOpt,
        design: getDesignFromDraft(normalized),
        style: getStyleFromDraft(normalized)
    };
};

export const createCueFromDraft = (draft, id = `cue-${Date.now()}`) => {
    const payload = buildLowerThirdPayload(draft);
    return {
        ...payload,
        id,
        label: payload.name || payload.title || 'Lower Third Cue'
    };
};

export const getTemplatePreviewColors = (bgStyle) => {
    if (bgStyle === 'warm-gold') return { frame: 'bg-stone-950', panel: 'bg-yellow-900/80', accent: 'border-yellow-400' };
    if (bgStyle === 'midnight') return { frame: 'bg-slate-950', panel: 'bg-blue-950', accent: 'border-blue-400' };
    if (bgStyle === 'frosted') return { frame: 'bg-slate-950', panel: 'bg-white/20', accent: 'border-white/70' };
    if (bgStyle === 'ocean') return { frame: 'bg-slate-950', panel: 'bg-cyan-950', accent: 'border-cyan-400' };
    if (bgStyle === 'burgundy') return { frame: 'bg-slate-950', panel: 'bg-red-950', accent: 'border-red-400' };
    if (bgStyle === 'forest') return { frame: 'bg-slate-950', panel: 'bg-emerald-950', accent: 'border-emerald-400' };
    if (bgStyle === 'deep-purple') return { frame: 'bg-slate-950', panel: 'bg-purple-950', accent: 'border-purple-400' };
    return { frame: 'bg-slate-950', panel: 'bg-slate-900', accent: 'border-blue-500' };
};
