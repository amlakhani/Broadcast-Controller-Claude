// SuperSource layout model — pure logic, no React and no DOM.
// Imported directly by tests/supersource-model.test.js under `node --test`, so it
// must stay free of browser globals. Same split as lowerThirdsModel.js.
//
// Hardware-only: this controls real ATEM/Blackmagic switchers with SuperSource.
// Every field here maps to a value the switcher's own protocol accepts — there is
// no separate software-rendering concept to keep in sync.

export const SUPERSOURCE_DOC_KEY = 'bc_supersource_doc_v1';
export const SUPERSOURCE_PRESETS_KEY = 'bc_supersource_presets_v1';

export const SUPERSOURCE_DOC_VERSION = 1;

// ---------------------------------------------------------------------------
// Coordinate system
// ---------------------------------------------------------------------------
// The canonical space is ATEM SuperSource units, stored as the raw integers the
// protocol carries. Centre origin, +x right, +y UP, frame exactly 32 x 18 units.
// Keeping the raw ints (rather than floats) means the round-trip to hardware is
// lossless and pulling state back off the device can't drift.
//
// 1920 / 32 === 1080 / 18 === 60, so one unit is exactly 60 stage px on BOTH
// axes. That single constant is the whole mapping — see boxToStageRect below.
// The 1920x1080 stage space exists purely so the designer canvas can show the
// operator where a box sits; nothing renders actual video into it.

export const FRAME_UNITS = { width: 32, height: 18 };
export const STAGE_WIDTH = 1920;
export const STAGE_HEIGHT = 1080;
export const STAGE_PX_PER_UNIT = 60;

// Scale factors from raw protocol integers to units.
const XY_UNITS_PER_RAW = 1 / 100;    // x/y are hundredths of a unit
const SIZE_PER_RAW = 1 / 1000;       // size is thousandths (0.070 .. 1.000)
const CROP_UNITS_PER_RAW = 1 / 1000; // crops are thousandths of a unit

// UNVERIFIED AGAINST HARDWARE.
// atem-connection neither documents nor clamps these — SuperSourceBoxParametersCommand
// .serialize() writes the values out raw, so an out-of-range number wraps as int16.
// These come from LibAtem's independent implementation of the same protocol.
// NOTE: y is +/-3400, NOT the widely-repeated +/-2700. Run scripts/atem-probe.js
// against real hardware to confirm before arming push, then delete this notice.
export const ATEM_BOX_LIMITS = {
    x: { min: -4800, max: 4800 },
    y: { min: -3400, max: 3400 },
    size: { min: 70, max: 1000 },
    cropTop: { min: 0, max: 18000 },
    cropBottom: { min: 0, max: 18000 },
    cropLeft: { min: 0, max: 32000 },
    cropRight: { min: 0, max: 32000 },
};

export const BOX_COUNT = 4;

// The full set of box fields — all of them map to hardware. diffBoxesForAtem
// only ever emits a subset of these keys.
export const ATEM_BOX_FIELDS = [
    'enabled', 'source', 'x', 'y', 'size',
    'cropped', 'cropTop', 'cropBottom', 'cropLeft', 'cropRight',
];

// artOption values the protocol accepts for the SuperSource Art (background) layer.
export const ART_OPTIONS = [
    { id: 'background', label: 'Background (behind the boxes)' },
    { id: 'foreground', label: 'Foreground (in front of the boxes)' },
];

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

const toNumber = (value, fallback) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export const clampField = (field, value) => {
    const limit = ATEM_BOX_LIMITS[field];
    const numeric = toNumber(value, limit ? 0 : value);
    if (!limit) return numeric;
    return clamp(Math.round(numeric), limit.min, limit.max);
};

const toBool = (value, fallback) => (typeof value === 'boolean' ? value : fallback);
const toEnum = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);
const toText = (value) => (typeof value === 'string' ? value : '');

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

// Every box starts disabled — arming push must never turn on a box the operator
// hasn't touched, the same "off until asked" convention every other layer in
// this app already follows.
export const createDefaultBox = () => ({
    enabled: false,
    source: 0,
    x: 0,
    y: 0,
    size: 500,
    cropped: false,
    cropTop: 0,
    cropBottom: 0,
    cropLeft: 0,
    cropRight: 0,
});

export const DEFAULT_BACKGROUND = {
    artFillSource: 0,
    artOption: 'background',
};

export const DEFAULT_SUPERSOURCE_DOC = {
    version: SUPERSOURCE_DOC_VERSION,
    ssrcId: 0,
    device: { designModel: 'generic-4box', designSource: 'manual' },
    background: DEFAULT_BACKGROUND,
    boxes: Array.from({ length: BOX_COUNT }, () => createDefaultBox()),
};

// ---------------------------------------------------------------------------
// Normalizer
// ---------------------------------------------------------------------------

export const normalizeBox = (input = {}) => {
    const base = createDefaultBox();
    const source = Math.max(0, Math.round(toNumber(input.source, base.source)));

    return {
        enabled: toBool(input.enabled, base.enabled),
        source,
        x: clampField('x', input.x ?? base.x),
        y: clampField('y', input.y ?? base.y),
        size: clampField('size', input.size ?? base.size),
        cropped: toBool(input.cropped, base.cropped),
        cropTop: clampField('cropTop', input.cropTop ?? base.cropTop),
        cropBottom: clampField('cropBottom', input.cropBottom ?? base.cropBottom),
        cropLeft: clampField('cropLeft', input.cropLeft ?? base.cropLeft),
        cropRight: clampField('cropRight', input.cropRight ?? base.cropRight),
    };
};

const normalizeBackground = (input = {}) => ({
    artFillSource: Math.max(0, Math.round(toNumber(input.artFillSource, 0))),
    artOption: toEnum(input.artOption, ART_OPTIONS.map(o => o.id), DEFAULT_BACKGROUND.artOption),
});

// Tolerates anything: {}, a v0 document, garbage, too many or too few boxes.
// Always returns exactly BOX_COUNT boxes so the diff never has to guard for length.
export const normalizeSuperSourceDoc = (input = {}) => {
    const rawBoxes = Array.isArray(input?.boxes) ? input.boxes : [];
    return {
        version: SUPERSOURCE_DOC_VERSION,
        ssrcId: clamp(Math.round(toNumber(input?.ssrcId, 0)), 0, 3),
        device: {
            designModel: toText(input?.device?.designModel) || DEFAULT_SUPERSOURCE_DOC.device.designModel,
            designSource: toEnum(input?.device?.designSource, ['live', 'manual'], 'manual'),
        },
        background: normalizeBackground(input?.background),
        boxes: Array.from({ length: BOX_COUNT }, (_, i) => normalizeBox(rawBoxes[i])),
    };
};

// ---------------------------------------------------------------------------
// Mapping 1: canonical -> ATEM
// ---------------------------------------------------------------------------

// Clamped and integral, ready for the wire.
export const boxToAtem = (box = {}) => ({
    enabled: toBool(box.enabled, false),
    source: Math.max(0, Math.round(toNumber(box.source, 0))),
    x: clampField('x', box.x),
    y: clampField('y', box.y),
    size: clampField('size', box.size),
    cropped: toBool(box.cropped, false),
    cropTop: clampField('cropTop', box.cropTop),
    cropBottom: clampField('cropBottom', box.cropBottom),
    cropLeft: clampField('cropLeft', box.cropLeft),
    cropRight: clampField('cropRight', box.cropRight),
});

// Inverse, for pulling live state off the device into the designer.
export const atemBoxToDoc = (atemBox = {}) => boxToAtem(atemBox);

// ---------------------------------------------------------------------------
// Mapping 2: canonical -> 1920x1080 stage pixels
// ---------------------------------------------------------------------------
// Used only by the designer canvas, to show the operator where a box sits while
// they drag/resize/crop it. Nothing downstream renders video through this.

// The FULL (uncropped) box rect in stage px. This is the element's box; the crop
// is applied on top of it as an inset, so the two stay separable.
export const boxToStageRect = (box = {}) => {
    const scale = clampField('size', box.size) * SIZE_PER_RAW;
    const width = STAGE_WIDTH * scale;
    const height = STAGE_HEIGHT * scale;

    // +y is up on the ATEM, down on the stage — hence the subtraction.
    const cx = (STAGE_WIDTH / 2) + clampField('x', box.x) * XY_UNITS_PER_RAW * STAGE_PX_PER_UNIT;
    const cy = (STAGE_HEIGHT / 2) - clampField('y', box.y) * XY_UNITS_PER_RAW * STAGE_PX_PER_UNIT;

    return { left: cx - width / 2, top: cy - height / 2, width, height };
};

// Crop insets in stage px, measured from the edges of the full box rect. Crop is
// expressed in source-frame units, so it scales with the box.
//
// UNVERIFIED AGAINST HARDWARE: this assumes the full (uncropped) box rect stays
// anchored where x/y put it and the crop eats into it from the edges. The
// alternative is that the device re-centres on the visible remainder — if a probe
// against real hardware shows that, this is the one function to fix.
export const boxToCropInsets = (box = {}) => {
    if (!box?.cropped) return { top: 0, right: 0, bottom: 0, left: 0 };
    const scale = clampField('size', box.size) * SIZE_PER_RAW;
    const px = (raw) => raw * CROP_UNITS_PER_RAW * STAGE_PX_PER_UNIT * scale;

    const rect = boxToStageRect(box);
    const top = px(clampField('cropTop', box.cropTop));
    const bottom = px(clampField('cropBottom', box.cropBottom));
    const left = px(clampField('cropLeft', box.cropLeft));
    const right = px(clampField('cropRight', box.cropRight));

    // Opposing crops can exceed the box; clip them so the visible rect never inverts.
    const vScale = top + bottom > rect.height ? rect.height / (top + bottom) : 1;
    const hScale = left + right > rect.width ? rect.width / (left + right) : 1;
    return { top: top * vScale, bottom: bottom * vScale, left: left * hScale, right: right * hScale };
};

// The rect actually visible on screen, i.e. the full rect minus the crop.
export const boxToVisibleRect = (box = {}) => {
    const rect = boxToStageRect(box);
    const inset = boxToCropInsets(box);
    return {
        left: rect.left + inset.left,
        top: rect.top + inset.top,
        width: Math.max(0, rect.width - inset.left - inset.right),
        height: Math.max(0, rect.height - inset.top - inset.bottom),
    };
};

// ---------------------------------------------------------------------------
// Aspect ratio presets
// ---------------------------------------------------------------------------
// An ATEM box is always a 16:9 window (size scales width and height together —
// there is no separate width/height field). The ONLY way to make a box look
// square, portrait, or any other shape is to crop it — this is exactly what a
// "Square" or "9:16 Portrait" option does in H2R Graphics / MixEffect-style
// tools, so that's what these presets compute: a symmetric, centred crop.

const FRAME_ASPECT = FRAME_UNITS.width / FRAME_UNITS.height; // 16/9, the box's native shape

export const ASPECT_PRESETS = [
    { id: 'wide', label: '16:9 Widescreen (native)', ratio: FRAME_ASPECT },
    { id: 'standard', label: '4:3 Standard', ratio: 4 / 3 },
    { id: 'square', label: '1:1 Square', ratio: 1 },
    { id: 'portrait-4-5', label: '4:5 Portrait', ratio: 4 / 5 },
    { id: 'portrait-9-16', label: '9:16 Portrait (Reels / TikTok)', ratio: 9 / 16 },
    { id: 'custom', label: 'Custom crop', ratio: null },
];

// Crop values are expressed in the same 32x18 unit space the whole frame uses
// (cropTop/Bottom range 0..18000 = 0..18 units = FRAME_UNITS.height; cropLeft/Right
// range 0..32000 = 0..32 units = FRAME_UNITS.width), which is also the space a
// box's own uncropped size is defined in. That means a crop fraction removes the
// same FRACTION of the box's own dimension regardless of box size — this function
// doesn't need to know the box's size at all, only the target ratio.
export const cropForAspect = (ratio) => {
    if (!ratio || Math.abs(ratio - FRAME_ASPECT) < 1e-9) {
        return { cropped: false, cropTop: 0, cropBottom: 0, cropLeft: 0, cropRight: 0 };
    }
    if (ratio < FRAME_ASPECT) {
        // Narrower than 16:9 (square, portrait, ...) — trim left/right, keep full height.
        const visibleFraction = ratio / FRAME_ASPECT;
        const sideFraction = (1 - visibleFraction) / 2;
        const crop = Math.round(sideFraction * FRAME_UNITS.width * 1000);
        return { cropped: true, cropTop: 0, cropBottom: 0, cropLeft: crop, cropRight: crop };
    }
    // Wider than 16:9 (ultra-wide) — trim top/bottom, keep full width.
    const visibleFraction = FRAME_ASPECT / ratio;
    const edgeFraction = (1 - visibleFraction) / 2;
    const crop = Math.round(edgeFraction * FRAME_UNITS.height * 1000);
    return { cropped: true, cropTop: crop, cropBottom: crop, cropLeft: 0, cropRight: 0 };
};

// Which preset (if any) a box's current crop matches, for reflecting state back
// into the dropdown. Anything hand-tuned that doesn't land exactly on a preset
// falls back to 'custom' rather than lying about which one is "selected".
export const matchAspectPreset = (box = {}) => {
    if (!box.cropped) return 'wide';
    for (const preset of ASPECT_PRESETS) {
        if (preset.id === 'custom' || preset.id === 'wide') continue;
        const target = cropForAspect(preset.ratio);
        if (
            box.cropTop === target.cropTop && box.cropBottom === target.cropBottom
            && box.cropLeft === target.cropLeft && box.cropRight === target.cropRight
        ) {
            return preset.id;
        }
    }
    return 'custom';
};

// ---------------------------------------------------------------------------
// Animated transitions
// ---------------------------------------------------------------------------
// The ATEM protocol has no tween for SuperSource box changes — a parameter set
// is an instant cut on real hardware. The Blackmagic-native way to fake a smooth
// move is a recorded macro that replays a rapid sequence of the same box-set
// commands with timed pauses between them; interpolateDoc produces exactly that
// sequence's keyframes, driven live from this app instead of a stored macro —
// same wire traffic, no macro-pool bookkeeping. See runPresetTransition in the
// panel for how the keyframes get streamed to the switcher.

// Smooth accelerate/decelerate, matching how a DVE move is typically shaped.
export const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - ((-2 * t + 2) ** 3) / 2);

// Interpolated document at eased time `t` (0..1) between `from` and `to`. Only
// boxes enabled in BOTH documents are tweened — a box being newly enabled or
// disabled just snaps, rather than faking a grow-from-nothing animation.
// Background and device fields always jump straight to `to`.
export const interpolateDoc = (from, to, t) => {
    const fromDoc = normalizeSuperSourceDoc(from);
    const toDoc = normalizeSuperSourceDoc(to);
    const eased = easeInOutCubic(clamp(t, 0, 1));
    const lerp = (a, b) => Math.round(a + (b - a) * eased);

    return normalizeSuperSourceDoc({
        ...toDoc,
        boxes: toDoc.boxes.map((target, i) => {
            const start = fromDoc.boxes[i];
            if (!start.enabled || !target.enabled) return target;
            return {
                ...target,
                x: lerp(start.x, target.x),
                y: lerp(start.y, target.y),
                size: lerp(start.size, target.size),
                cropped: start.cropped || target.cropped,
                cropTop: lerp(start.cropTop, target.cropTop),
                cropBottom: lerp(start.cropBottom, target.cropBottom),
                cropLeft: lerp(start.cropLeft, target.cropLeft),
                cropRight: lerp(start.cropRight, target.cropRight),
            };
        }),
    });
};

// Inverse of boxToStageRect — drives drag and resize on the designer canvas.
// `rect` describes the FULL box, matching what boxToStageRect returns.
export const stageRectToBox = (rect = {}) => {
    const width = Math.max(1, toNumber(rect.width, 0));
    const cx = toNumber(rect.left, 0) + width / 2;
    const cy = toNumber(rect.top, 0) + Math.max(1, toNumber(rect.height, 0)) / 2;

    return {
        size: clampField('size', (width / STAGE_WIDTH) / SIZE_PER_RAW),
        x: clampField('x', (cx - STAGE_WIDTH / 2) / (XY_UNITS_PER_RAW * STAGE_PX_PER_UNIT)),
        y: clampField('y', (STAGE_HEIGHT / 2 - cy) / (XY_UNITS_PER_RAW * STAGE_PX_PER_UNIT)),
    };
};

// ---------------------------------------------------------------------------
// Diff — what protects the UDP link
// ---------------------------------------------------------------------------

// Minimal per-box field patches between two documents. Returns [] when nothing
// changed, which is what stops a redraw storm from becoming a command storm.
export const diffBoxesForAtem = (prevDoc, nextDoc, { boxCount = BOX_COUNT } = {}) => {
    const prev = prevDoc ? normalizeSuperSourceDoc(prevDoc).boxes : null;
    const next = normalizeSuperSourceDoc(nextDoc).boxes;
    const patches = [];

    for (let i = 0; i < Math.min(boxCount, BOX_COUNT); i += 1) {
        const target = boxToAtem(next[i]);
        if (!prev) {
            patches.push({ boxIndex: i, props: target });
            continue;
        }
        const before = boxToAtem(prev[i]);
        const props = {};
        for (const field of ATEM_BOX_FIELDS) {
            if (before[field] !== target[field]) props[field] = target[field];
        }
        if (Object.keys(props).length > 0) patches.push({ boxIndex: i, props });
    }
    return patches;
};

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------
// Geometry only. Applying a preset never touches `source`, so the operator's
// input assignments survive — same contract as apply_template in LowerThirdsPanel.

export const SUPERSOURCE_PRESETS = [
    {
        id: 'split-2',
        name: '2-Box Split',
        description: 'Two half-size boxes, side by side',
        requiresBoxes: 2,
        boxes: [
            { enabled: true, x: -800, y: 0, size: 500 },
            { enabled: true, x: 800, y: 0, size: 500 },
        ],
    },
    {
        id: 'quad',
        name: 'Quad 4-Grid',
        description: 'Four half-size boxes filling the frame',
        requiresBoxes: 4,
        boxes: [
            { enabled: true, x: -800, y: 450, size: 500 },
            { enabled: true, x: 800, y: 450, size: 500 },
            { enabled: true, x: -800, y: -450, size: 500 },
            { enabled: true, x: 800, y: -450, size: 500 },
        ],
    },
    {
        id: 'one-big-three-small',
        name: '1 Big + 3 Small Right',
        description: 'Large left box with a stacked column of three',
        requiresBoxes: 4,
        boxes: [
            { enabled: true, x: -350, y: 0, size: 750 },
            { enabled: true, x: 1220, y: 400, size: 200 },
            { enabled: true, x: 1220, y: 0, size: 200 },
            { enabled: true, x: 1220, y: -400, size: 200 },
        ],
    },
    {
        id: 'two-corner-insets',
        name: '2 Corner Insets',
        description: 'Full-frame bed with two small insets in the top corners',
        requiresBoxes: 3,
        boxes: [
            { enabled: true, x: -933, y: -483, size: 320 },
            { enabled: true, x: 933, y: -483, size: 320 },
            { enabled: false },
            { enabled: true, x: 0, y: 0, size: 1000 },
        ],
    },
    {
        id: 'worship-speaker-slides',
        name: 'Worship Speaker + Slides',
        description: 'Speaker inset left, slide deck right',
        requiresBoxes: 2,
        boxes: [
            { enabled: true, x: -1069, y: 0, size: 290 },
            { enabled: true, x: 494, y: 0, size: 660 },
        ],
    },
];

// Merge a preset's geometry onto a document, preserving every input assignment.
// Boxes the preset doesn't mention are disabled but otherwise left intact, so
// switching presets back and forth doesn't lose work.
export const applyPresetDefinition = (doc, preset) => {
    const normalized = normalizeSuperSourceDoc(doc);
    if (!preset?.boxes) return normalized;

    return normalizeSuperSourceDoc({
        ...normalized,
        boxes: normalized.boxes.map((box, i) => {
            const patch = preset.boxes[i];
            if (!patch) return { ...box, enabled: false };
            // Geometry only — the operator's input assignment is theirs.
            return { ...box, ...patch, source: box.source };
        }),
    });
};

// Look up by id across built-ins plus whatever the operator has saved.
export const applyPreset = (doc, presetId, customPresets = []) => {
    const preset = [...SUPERSOURCE_PRESETS, ...customPresets].find(p => p?.id === presetId);
    return preset ? applyPresetDefinition(doc, preset) : normalizeSuperSourceDoc(doc);
};

// Snapshot the current geometry as a reusable preset. `source` is deliberately
// NOT captured — a preset is a layout, not a routing.
export const createPresetFromDoc = (doc, name, id = `custom-${Date.now()}`) => {
    const normalized = normalizeSuperSourceDoc(doc);
    const enabled = normalized.boxes.filter(box => box.enabled);

    return {
        id,
        name,
        description: `${enabled.length}-box custom layout`,
        custom: true,
        requiresBoxes: enabled.length,
        boxes: normalized.boxes.map(box => (box.enabled
            ? {
                enabled: true,
                x: box.x,
                y: box.y,
                size: box.size,
                cropped: box.cropped,
                cropTop: box.cropTop,
                cropBottom: box.cropBottom,
                cropLeft: box.cropLeft,
                cropRight: box.cropRight,
            }
            : { enabled: false })),
    };
};
