export const LT_TEMPLATE_KEY = 'bc_lt_template_library_v1';
export const LT_CUE_QUEUE_KEY = 'bc_lt_cue_queue_v1';

export const ANIMATION_PRESETS = [
    { id: 'elastic', label: 'Fluid Reveal' },
    { id: 'accentSweep', label: 'Accent Sweep' },
    { id: 'lineMask', label: 'Line Mask' },
    { id: 'wordStagger', label: 'Word Build' },
    { id: 'pushSettle', label: 'Push & Settle' },
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
    { id: 'full-band', label: 'Full Band' },
    { id: 'gradient-scrim', label: 'Gradient Scrim' },
    { id: 'stacked', label: 'Stacked Tiers' },
    { id: 'chamfered', label: 'Chamfered' },
    { id: 'outline', label: 'Outline' },
    { id: 'chevron', label: 'Chevron Tail' }
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
    { id: 'gradient-aurora', label: 'Gradient Aurora' },
    { id: 'light', label: 'Light (Inverted)' },
    { id: 'light-warm', label: 'Light Warm (Inverted)' }
];

export const DEFAULT_LT_DESIGN = {
    shapeStyle: 'glass-card',
    accentColor: '#3b82f6',
    // Second accent stop; only used when accentGradient is on.
    accentColor2: '#8b5cf6',
    accentGradient: false,
    panelOpacity: 88,
    shadowIntensity: 75,
    borderWidth: 1,
    borderColor: '#ffffff',
    // -1 keeps each shape's own radius; >= 0 overrides it.
    cornerRadius: -1,
    panelWidth: 650,
    posX: 10,
    posY: 15,
    logoPlacement: 'left',
    logoSize: 160,
    textAlign: 'left'
};

export const DEFAULT_LT_STYLE = {
    fontFamily: "'Outfit', sans-serif",
    // Gujarati title face. Was hardcoded to Rasa in the graphic; now selectable
    // from the same self-hosted catalogue the lyrics panel uses.
    gujFontFamily: "'Rasa', serif",
    fontWeight: '700',
    // Sizes the English lines (name + subtitle).
    fontSizeFactor: '100',
    // Gujarati scripts sit optically smaller than Latin at the same point size, so the
    // title gets its own factor. Absent on anything saved before this existed, and
    // withStyle then falls it back to fontSizeFactor — see the note there.
    gujFontSizeFactor: '100',
    color: '#ffffff',
    // Per-line overrides. Empty string means "inherit `color`", so every existing
    // saved template keeps rendering exactly as before.
    nameColor: '',
    titleColor: '',
    subtitleColor: '',
    sub2BgColor: '',
    textGlow: 0,
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
        accentColor2: DEFAULT_LT_DESIGN.accentColor2,
        accentGradient: DEFAULT_LT_DESIGN.accentGradient,
        panelOpacity: DEFAULT_LT_DESIGN.panelOpacity,
        shadowIntensity: DEFAULT_LT_DESIGN.shadowIntensity,
        borderWidth: DEFAULT_LT_DESIGN.borderWidth,
        borderColor: DEFAULT_LT_DESIGN.borderColor,
        cornerRadius: DEFAULT_LT_DESIGN.cornerRadius
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
        animationSpeed: 1,
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
        design: { shapeStyle: 'glass-card', accentColor: '#3b82f6', panelOpacity: 88, panelWidth: 650, posX: 10, posY: 15, shadowIntensity: 75 },
        style: { fontFamily: "'Outfit', sans-serif", fontWeight: '700', fontSizeFactor: '100', color: '#ffffff', letterSpacing: '0', bold: true, italic: false, underline: false }
    },
    {
        id: 'announcement-gold',
        name: 'Announcement',
        description: 'Warm event cue',
        bgStyle: 'warm-gold',
        animation: 'slideRight',
        langOpt: 'eng',
        design: { shapeStyle: 'rounded-bar', accentColor: '#f5c542', panelOpacity: 92, panelWidth: 720, posX: 10, posY: 15, shadowIntensity: 80 },
        style: { fontFamily: "'Montserrat', sans-serif", fontWeight: '800', fontSizeFactor: '92', color: '#fff7d6', letterSpacing: '1', bold: true, italic: false, underline: false }
    },
    {
        id: 'guest-midnight',
        name: 'Guest Intro',
        description: 'Formal title card',
        bgStyle: 'midnight',
        animation: 'wipe',
        langOpt: 'both',
        design: { shapeStyle: 'glass-card', accentColor: '#60a5fa', panelOpacity: 90, panelWidth: 700, posX: 10, posY: 15, shadowIntensity: 78 },
        style: { fontFamily: "'Playfair Display', serif", fontWeight: '700', fontSizeFactor: '105', color: '#ffffff', letterSpacing: '0.5', bold: true, italic: false, underline: false }
    },
    {
        id: 'minimal-frosted',
        name: 'Minimal',
        description: 'Light glass label',
        bgStyle: 'frosted',
        animation: 'fade',
        langOpt: 'eng',
        design: { shapeStyle: 'underline', accentColor: '#ffffff', panelOpacity: 20, panelWidth: 620, posX: 10, posY: 14, shadowIntensity: 40, borderWidth: 0 },
        style: { fontFamily: "'Inter', sans-serif", fontWeight: '600', fontSizeFactor: '86', color: '#ffffff', letterSpacing: '0', bold: false, italic: false, underline: false }
    },
    {
        id: 'translation-ocean',
        name: 'Gujarati Focus',
        description: 'Gujarati-first lower third',
        bgStyle: 'ocean',
        animation: 'stagger',
        langOpt: 'guj',
        design: { shapeStyle: 'ribbon', accentColor: '#2dd4bf', panelOpacity: 92, panelWidth: 740, posX: 9, posY: 15, shadowIntensity: 72 },
        style: { fontFamily: "'Outfit', sans-serif", gujFontFamily: "'Noto Sans Gujarati', sans-serif", fontWeight: '700', fontSizeFactor: '112', color: '#e8fffb', letterSpacing: '0', bold: true, italic: false, underline: false }
    },
    {
        id: 'urgent-burgundy',
        name: 'Urgent',
        description: 'High-contrast notice',
        bgStyle: 'burgundy',
        animation: 'bounce',
        langOpt: 'eng',
        design: { shapeStyle: 'sharp-block', accentColor: '#ef4444', panelOpacity: 96, panelWidth: 700, posX: 10, posY: 15, shadowIntensity: 85 },
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
    },
    {
        id: 'sports-sweep',
        name: 'Sports Sweep',
        description: 'Accent sweep, stacked tiers',
        bgStyle: 'midnight',
        animation: 'accentSweep',
        langOpt: 'eng',
        design: { shapeStyle: 'stacked', accentColor: '#38bdf8', accentColor2: '#2563eb', accentGradient: true, panelOpacity: 95, panelWidth: 840, posX: 8, posY: 16, shadowIntensity: 82, textAlign: 'left' },
        style: { fontFamily: "'Oswald', sans-serif", fontWeight: '800', fontSizeFactor: '96', color: '#ffffff', nameColor: '#ffffff', subtitleColor: '#7dd3fc', letterSpacing: '0.6', textGlow: 30, bold: true, italic: false, underline: false }
    },
    {
        id: 'news-scrim',
        name: 'News Scrim',
        description: 'Soft gradient, no hard edge',
        bgStyle: 'charcoal',
        animation: 'lineMask',
        langOpt: 'both',
        design: { shapeStyle: 'gradient-scrim', accentColor: '#e2e8f0', panelOpacity: 90, panelWidth: 1920, posX: 0, posY: 0, shadowIntensity: 0, borderWidth: 0, textAlign: 'left' },
        style: { fontFamily: "'Inter', sans-serif", fontWeight: '700', fontSizeFactor: '94', color: '#ffffff', subtitleColor: '#cbd5e1', letterSpacing: '0.2', textGlow: 45, bold: true, italic: false, underline: false }
    },
    {
        id: 'aurora-chevron',
        name: 'Aurora Chevron',
        description: 'Angled tail, gradient accent',
        bgStyle: 'gradient-aurora',
        animation: 'pushSettle',
        langOpt: 'both',
        design: { shapeStyle: 'chevron', accentColor: '#5eead4', accentColor2: '#818cf8', accentGradient: true, panelOpacity: 93, panelWidth: 800, posX: 8, posY: 15, shadowIntensity: 78 },
        style: { fontFamily: "'Poppins', sans-serif", fontWeight: '700', fontSizeFactor: '98', color: '#f0fdfa', subtitleColor: '#99f6e4', letterSpacing: '0.3', textGlow: 25, bold: true, italic: false, underline: false }
    },
    {
        id: 'editorial-light',
        name: 'Editorial Light',
        description: 'Inverted — dark text on light',
        bgStyle: 'light',
        animation: 'wordStagger',
        langOpt: 'both',
        design: { shapeStyle: 'chamfered', accentColor: '#0f172a', panelOpacity: 96, panelWidth: 760, posX: 9, posY: 15, shadowIntensity: 55, borderWidth: 0, cornerRadius: 4 },
        style: { fontFamily: "'Playfair Display', serif", fontWeight: '700', fontSizeFactor: '100', color: '#0f172a', subtitleColor: '#475569', letterSpacing: '0', textGlow: 0, bold: true, italic: false, underline: false }
    },
    {
        id: 'warm-light-serif',
        name: 'Warm Light',
        description: 'Inverted — soft cream panel',
        bgStyle: 'light-warm',
        animation: 'blur',
        langOpt: 'both',
        design: { shapeStyle: 'rounded-bar', accentColor: '#b45309', panelOpacity: 96, panelWidth: 720, posX: 10, posY: 15, shadowIntensity: 50, borderWidth: 0 },
        style: { fontFamily: "'Lora', serif", gujFontFamily: "'Rasa', serif", fontWeight: '600', fontSizeFactor: '98', color: '#3f2d10', subtitleColor: '#92400e', letterSpacing: '0', textGlow: 0, bold: true, italic: false, underline: false }
    },
    {
        id: 'outline-minimal',
        name: 'Outline',
        description: 'Stroke only, no fill',
        bgStyle: 'default',
        animation: 'flip',
        langOpt: 'eng',
        design: { shapeStyle: 'outline', accentColor: '#f8fafc', panelOpacity: 0, panelWidth: 660, posX: 10, posY: 15, shadowIntensity: 35, borderWidth: 2, borderColor: '#f8fafc' },
        style: { fontFamily: "'Bebas Neue', cursive", fontWeight: '400', fontSizeFactor: '108', color: '#ffffff', letterSpacing: '2', textGlow: 55, bold: false, italic: false, underline: false }
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
    logoSize: toNumber(clean(design.logoSize, DEFAULT_LT_DESIGN.logoSize), DEFAULT_LT_DESIGN.logoSize),
    cornerRadius: toNumber(clean(design.cornerRadius, DEFAULT_LT_DESIGN.cornerRadius), DEFAULT_LT_DESIGN.cornerRadius),
    accentGradient: design.accentGradient ?? DEFAULT_LT_DESIGN.accentGradient
});

export const withStyle = (style = {}) => {
    const fontSizeFactor = clean(style.fontSizeFactor, DEFAULT_LT_STYLE.fontSizeFactor);
    return {
        ...DEFAULT_LT_STYLE,
        ...style,
        fontSizeFactor,
        // Falls back to the English size rather than to the default, so a template or cue
        // saved before this control existed keeps both lines on the one scale it was
        // designed at. A preset with fontSizeFactor 112 must not drop its title to 100.
        gujFontSizeFactor: clean(style.gujFontSizeFactor, fontSizeFactor),
        textGlow: toNumber(clean(style.textGlow, DEFAULT_LT_STYLE.textGlow), DEFAULT_LT_STYLE.textGlow),
        bold: style.bold ?? DEFAULT_LT_STYLE.bold,
        italic: style.italic ?? DEFAULT_LT_STYLE.italic,
        underline: style.underline ?? DEFAULT_LT_STYLE.underline
    };
};

// Per-line colour with fallback to the single `color`, so templates saved before
// per-line colours existed render identically.
export const resolveLineColor = (style = {}, key) => {
    const value = style[key];
    return (typeof value === 'string' && value.trim()) ? value : (style.color || DEFAULT_LT_STYLE.color);
};

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
            accentColor2: clean(input.appearance?.accentColor2, legacyDesign.accentColor2),
            accentGradient: clean(input.appearance?.accentGradient, legacyDesign.accentGradient),
            panelOpacity: clean(input.appearance?.panelOpacity, legacyDesign.panelOpacity),
            shadowIntensity: clean(input.appearance?.shadowIntensity, legacyDesign.shadowIntensity),
            borderWidth: clean(input.appearance?.borderWidth, legacyDesign.borderWidth),
            borderColor: clean(input.appearance?.borderColor, legacyDesign.borderColor),
            cornerRadius: clean(input.appearance?.cornerRadius, legacyDesign.cornerRadius)
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
        // Run the merge back through withStyle so the Gujarati-size fallback is applied to
        // the *merged* English size. Passing the explicit value (or undefined) keeps a draft
        // that carries only `typography` from inheriting a stale size off `style`.
        typography: withStyle({
            ...legacyStyle,
            ...(input.typography || {}),
            gujFontSizeFactor: input.typography?.gujFontSizeFactor ?? input.style?.gujFontSizeFactor
        }),
        behavior: {
            ...DEFAULT_LOWER_THIRD_DRAFT.behavior,
            ...(input.behavior || {}),
            animation: clean(input.behavior?.animation, input.animation ?? DEFAULT_LOWER_THIRD_DRAFT.behavior.animation),
            animationSpeed: toNumber(clean(input.behavior?.animationSpeed, input.animationSpeed ?? DEFAULT_LOWER_THIRD_DRAFT.behavior.animationSpeed), DEFAULT_LOWER_THIRD_DRAFT.behavior.animationSpeed),
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
        animationSpeed: normalized.behavior.animationSpeed,
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
    if (bgStyle === 'charcoal') return { frame: 'bg-slate-950', panel: 'bg-neutral-800', accent: 'border-neutral-400' };
    if (bgStyle === 'gradient-sunset') return { frame: 'bg-slate-950', panel: 'bg-orange-900/80', accent: 'border-orange-400' };
    if (bgStyle === 'gradient-aurora') return { frame: 'bg-slate-950', panel: 'bg-teal-900/80', accent: 'border-teal-300' };
    if (bgStyle === 'light') return { frame: 'bg-slate-800', panel: 'bg-slate-100', accent: 'border-slate-500' };
    if (bgStyle === 'light-warm') return { frame: 'bg-stone-800', panel: 'bg-amber-50', accent: 'border-amber-600' };
    return { frame: 'bg-slate-950', panel: 'bg-slate-900', accent: 'border-blue-500' };
};
