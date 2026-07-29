import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    ANIMATION_PRESETS,
    SHAPE_PRESETS,
    BACKGROUND_STYLES,
    BUILT_IN_TEMPLATES,
    DEFAULT_LT_DESIGN,
    DEFAULT_LT_STYLE,
    normalizeDraft,
    withDesign,
    withStyle,
    resolveLineColor,
    templateToDraftPatch,
    buildLowerThirdPayload,
    getTemplatePreviewColors,
} from '../frontend/src/components/lowerThirdsModel.js';

const animationIds = new Set(ANIMATION_PRESETS.map(a => a.id));
const shapeIds = new Set(SHAPE_PRESETS.map(s => s.id));
const bgIds = new Set(BACKGROUND_STYLES.map(b => b.id));

test('every built-in preset references ids that actually exist', () => {
    // The check that would have caught RunOfShowPanel sending animation:'slide',
    // which silently fell back to elastic.
    for (const preset of BUILT_IN_TEMPLATES) {
        assert.ok(animationIds.has(preset.animation), `${preset.id}: unknown animation "${preset.animation}"`);
        assert.ok(bgIds.has(preset.bgStyle), `${preset.id}: unknown bgStyle "${preset.bgStyle}"`);
        if (preset.design?.shapeStyle) {
            assert.ok(shapeIds.has(preset.design.shapeStyle), `${preset.id}: unknown shapeStyle "${preset.design.shapeStyle}"`);
        }
        assert.ok(['eng', 'guj', 'both'].includes(preset.langOpt), `${preset.id}: bad langOpt`);
    }
});

test('preset ids and names are unique', () => {
    const ids = BUILT_IN_TEMPLATES.map(p => p.id);
    assert.equal(new Set(ids).size, ids.length, 'duplicate preset id');
    const names = BUILT_IN_TEMPLATES.map(p => p.name);
    assert.equal(new Set(names).size, names.length, 'duplicate preset name');
});

test('every preset carries an explicit design block', () => {
    // Six legacy presets used to omit this, so they all rendered with identical geometry.
    for (const preset of BUILT_IN_TEMPLATES) {
        assert.ok(preset.design, `${preset.id} has no design block`);
        assert.ok(preset.design.shapeStyle, `${preset.id} has no shapeStyle`);
    }
});

test('there is at least one light/inverted preset', () => {
    const light = BUILT_IN_TEMPLATES.filter(p => p.bgStyle === 'light' || p.bgStyle === 'light-warm');
    assert.ok(light.length >= 2, `expected 2+ inverted presets, found ${light.length}`);
    // Inverted looks need dark text or they are unreadable.
    for (const preset of light) {
        assert.ok(preset.style?.color, `${preset.id} must set a text colour`);
        assert.notEqual(preset.style.color.toLowerCase(), '#ffffff', `${preset.id} uses white text on a light panel`);
    }
});

test('every background style has preview colours', () => {
    const fallback = getTemplatePreviewColors('__nope__');
    for (const bg of BACKGROUND_STYLES) {
        const colors = getTemplatePreviewColors(bg.id);
        assert.ok(colors.frame && colors.panel && colors.accent, `${bg.id} missing preview colours`);
        if (bg.id !== 'default') {
            assert.notDeepEqual(colors, fallback, `${bg.id} falls through to the default swatch`);
        }
    }
});

test('normalizeDraft round-trips the new design keys', () => {
    const draft = normalizeDraft({
        appearance: { accentColor2: '#123456', accentGradient: true, cornerRadius: 18 },
        behavior: { animationSpeed: 1.75 }
    });
    assert.equal(draft.appearance.accentColor2, '#123456');
    assert.equal(draft.appearance.accentGradient, true);
    assert.equal(draft.appearance.cornerRadius, 18);
    assert.equal(draft.behavior.animationSpeed, 1.75);

    // Surviving a second pass is the real test — normalizeDraft re-runs on every keystroke,
    // so an unthreaded key gets silently stripped on the next edit.
    const again = normalizeDraft(draft);
    assert.equal(again.appearance.accentColor2, '#123456');
    assert.equal(again.appearance.accentGradient, true);
    assert.equal(again.appearance.cornerRadius, 18);
    assert.equal(again.behavior.animationSpeed, 1.75);
});

test('normalizeDraft round-trips the new typography keys', () => {
    const draft = normalizeDraft({
        typography: {
            nameColor: '#ff0000', titleColor: '#00ff00', subtitleColor: '#0000ff',
            gujFontFamily: "'Noto Sans Gujarati', sans-serif", textGlow: 40, sub2BgColor: '#101010'
        }
    });
    const again = normalizeDraft(draft);
    assert.equal(again.typography.nameColor, '#ff0000');
    assert.equal(again.typography.titleColor, '#00ff00');
    assert.equal(again.typography.subtitleColor, '#0000ff');
    assert.equal(again.typography.gujFontFamily, "'Noto Sans Gujarati', sans-serif");
    assert.equal(again.typography.textGlow, 40);
    assert.equal(again.typography.sub2BgColor, '#101010');
});

test('per-line colour falls back to the shared colour', () => {
    const style = withStyle({ color: '#abcdef' });
    assert.equal(resolveLineColor(style, 'nameColor'), '#abcdef');
    assert.equal(resolveLineColor(style, 'titleColor'), '#abcdef');
    assert.equal(resolveLineColor({ ...style, nameColor: '   ' }, 'nameColor'), '#abcdef', 'whitespace counts as unset');
    assert.equal(resolveLineColor({ ...style, nameColor: '#111111' }, 'nameColor'), '#111111');
});

test('withDesign coerces the new numeric keys', () => {
    const design = withDesign({ cornerRadius: '24', panelWidth: '800' });
    assert.equal(design.cornerRadius, 24);
    assert.equal(design.panelWidth, 800);
    // Garbage falls back to the default rather than producing NaN.
    assert.equal(withDesign({ cornerRadius: 'nope' }).cornerRadius, DEFAULT_LT_DESIGN.cornerRadius);
    assert.equal(withDesign({}).accentGradient, false);
});

test('withStyle coerces textGlow and keeps booleans', () => {
    assert.equal(withStyle({ textGlow: '55' }).textGlow, 55);
    assert.equal(withStyle({ textGlow: 'nope' }).textGlow, DEFAULT_LT_STYLE.textGlow);
    assert.equal(withStyle({ bold: false }).bold, false);
});

test('templateToDraftPatch carries layout so presets apply fully', () => {
    // Full Band never actually went full-width because layout was dropped on apply.
    const fullBand = BUILT_IN_TEMPLATES.find(p => p.design?.shapeStyle === 'full-band');
    assert.ok(fullBand, 'expected a full-band preset');

    const patch = templateToDraftPatch(fullBand);
    assert.ok(patch.layout, 'patch must include layout');
    assert.equal(patch.layout.panelWidth, fullBand.design.panelWidth);
    assert.equal(patch.layout.textAlign, fullBand.design.textAlign);
    assert.equal(patch.appearance.shapeStyle, 'full-band');
});

test('the wire payload carries animation speed and the new style keys', () => {
    const payload = buildLowerThirdPayload(normalizeDraft({
        content: { name: 'Speaker' },
        behavior: { animationSpeed: 0.5 },
        typography: { nameColor: '#fefefe', textGlow: 20 }
    }));
    assert.equal(payload.animationSpeed, 0.5);
    assert.equal(payload.style.nameColor, '#fefefe');
    assert.equal(payload.style.textGlow, 20);
    assert.equal(payload.name, 'Speaker');
    assert.ok(payload.design.shapeStyle);
});

test('a legacy flat template still normalizes', () => {
    // Templates saved before the section model existed use flat keys.
    const legacy = {
        name: 'Old Template',
        bgStyle: 'midnight',
        animation: 'wipe',
        langOpt: 'both',
        design: { shapeStyle: 'ribbon', accentColor: '#ff8800', panelWidth: 700 },
        style: { fontFamily: "'Inter', sans-serif", color: '#ffffff' }
    };
    const draft = normalizeDraft(legacy);
    assert.equal(draft.appearance.bgStyle, 'midnight');
    assert.equal(draft.appearance.shapeStyle, 'ribbon');
    assert.equal(draft.appearance.accentColor, '#ff8800');
    assert.equal(draft.layout.panelWidth, 700);
    assert.equal(draft.behavior.animation, 'wipe');
    // Unset new keys take defaults rather than undefined.
    assert.equal(draft.appearance.accentGradient, DEFAULT_LT_DESIGN.accentGradient);
    assert.equal(draft.typography.textGlow, DEFAULT_LT_STYLE.textGlow);
    assert.equal(draft.behavior.animationSpeed, 1);
});
