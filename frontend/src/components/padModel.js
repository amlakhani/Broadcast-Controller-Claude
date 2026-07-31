// Control Pad model — pure logic, no React, no DOM, no imports.
// Imported directly by tests/pad-model.test.js under `node --test`, so it must stay
// free of browser globals AND free of dependencies (lucide-react included). Same
// split as superSourceModel.js / lowerThirdsModel.js.
//
// This describes the configurable button grid served at /pad. The desktop lays a
// layout out, publishes it over the socket, and any paired tablet renders it.
//
// The single most important thing in here is PAD_EMIT_ACTIONS: every button that
// talks to the server does so through that table and nowhere else. That is what
// lets one test assert the whole control surface against the real server handlers,
// which is how you catch a renamed event (the server's client->server media stop is
// `stop_media`; `media_stop` is the *outbound* broadcast, and emitting it does
// nothing at all).

export const PAD_LAYOUT_KEY = 'bc_pad_layout_v1';
export const PAD_LAYOUT_VERSION = 1;

export const MAX_PAD_PAGES = 6;
export const MAX_PAD_BUTTONS = 48;
export const PAD_COL_CHOICES = [4, 5, 6];
export const DEFAULT_PAD_COLS = 5;

// Mirrors currentLayerVisibility in server.js. `layer_visibility_update` merges only
// keys it already owns, so an unknown key here would be silently dropped.
export const PAD_LAYER_KEYS = [
    'presentation', 'media', 'lowerThirds', 'lyrics',
    'translation', 'sabhaTimer', 'particles', 'mediaMessage'
];

export const PAD_LAYER_LABELS = {
    presentation: 'Slides',
    media: 'Media',
    lowerThirds: 'Lower Thirds',
    lyrics: 'Lyrics',
    translation: 'Captions',
    sabhaTimer: 'Sabha Timer',
    particles: 'Particles',
    mediaMessage: 'Media Message'
};

export const PAD_OUTPUT_MODES = ['green', 'black', 'transparent'];

// ---------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------
// Tailwind's JIT scans source files for *literal* class strings, so a configurable
// colour can never be interpolated (`bg-${color}-600` compiles to nothing). These
// literals live in a scanned file, so every class below is emitted.

export const PAD_COLORS = {
    slate:   { face: 'bg-slate-600',   press: 'active:bg-slate-500',   text: 'text-white', ring: 'ring-slate-300' },
    blue:    { face: 'bg-blue-600',    press: 'active:bg-blue-500',    text: 'text-white', ring: 'ring-blue-300' },
    emerald: { face: 'bg-emerald-600', press: 'active:bg-emerald-500', text: 'text-white', ring: 'ring-emerald-300' },
    amber:   { face: 'bg-amber-500',   press: 'active:bg-amber-400',   text: 'text-black', ring: 'ring-amber-300' },
    red:     { face: 'bg-red-600',     press: 'active:bg-red-500',     text: 'text-white', ring: 'ring-red-300' },
    violet:  { face: 'bg-violet-600',  press: 'active:bg-violet-500',  text: 'text-white', ring: 'ring-violet-300' },
    cyan:    { face: 'bg-cyan-600',    press: 'active:bg-cyan-500',    text: 'text-white', ring: 'ring-cyan-300' },
    fuchsia: { face: 'bg-fuchsia-600', press: 'active:bg-fuchsia-500', text: 'text-white', ring: 'ring-fuchsia-300' }
};

export const PAD_COLOR_KEYS = Object.keys(PAD_COLORS);
export const DEFAULT_PAD_COLOR = 'slate';

// Icon *names* only. The name -> lucide component map lives in padIcons.js, which
// this module must not import (it would break `node --test`).
export const PAD_ICON_NAMES = [
    'none',
    'chevronLeft', 'chevronRight', 'chevronsLeft', 'chevronsRight',
    'play', 'pause', 'square', 'skipForward', 'rewind', 'fastForward',
    'monitor', 'monitorOff', 'eye', 'eyeOff', 'volume', 'volumeOff',
    'repeat', 'zap', 'flame', 'timer', 'clock', 'message', 'type',
    'image', 'film', 'layers', 'sparkles', 'languages', 'listChecks',
    'alertTriangle', 'rotateCcw', 'power', 'grid'
];

const PAD_ICON_SET = new Set(PAD_ICON_NAMES);
export const DEFAULT_PAD_ICON = 'none';

// ---------------------------------------------------------------------------
// Small clamps
// ---------------------------------------------------------------------------

const str = (value, max, fallback = '') => (
    typeof value === 'string' ? value.slice(0, max) : fallback
);

const clampInt = (value, min, max, fallback = 0) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
};

const clampNum = (value, min, max, fallback = 0) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
};

const pick = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);

// ---------------------------------------------------------------------------
// Direct emit actions
// ---------------------------------------------------------------------------
// Each entry: { group, label, event, build(payload, state, ctx), destructive?, needs? }
//
// `build` returns the socket argument. Returning undefined means "emit with no
// argument" — several server handlers take none, and passing an explicit undefined
// through socket.io would still serialise as a null arg.
//
// `state` is the latest operator_state_update; `ctx` carries { mediaTime, presMeta }.
// Toggles resolve against live state rather than a local guess, so a pad that just
// connected still flips things the right way.
//
// `needs` marks what must exist for the button to be enabled on the pad:
// 'slides' | 'media' | 'clip' (a loaded media item with a known playhead).

export const PAD_EMIT_ACTIONS = {
    // --- Slides -------------------------------------------------------------
    'pres.next':  { group: 'Slides', label: 'Next Slide', event: 'pres_goto', needs: 'slides',
        build: () => ({ direction: 'next' }) },
    'pres.prev':  { group: 'Slides', label: 'Previous Slide', event: 'pres_goto', needs: 'slides',
        build: () => ({ direction: 'prev' }) },
    'pres.first': { group: 'Slides', label: 'First Slide', event: 'pres_goto', needs: 'slides',
        build: () => ({ direction: 'first' }) },
    'pres.last':  { group: 'Slides', label: 'Last Slide', event: 'pres_goto', needs: 'slides',
        build: () => ({ direction: 'last' }) },
    'pres.goto':  { group: 'Slides', label: 'Go To Slide…', event: 'pres_goto', needs: 'slides',
        fields: [{ key: 'index', type: 'int', label: 'Slide number (1-based)', min: 1, max: 999, default: 1 }],
        build: (p) => ({ index: clampInt(p?.index, 1, 999, 1) - 1 }) },
    'pres.show':   { group: 'Slides', label: 'Slides Go Live', event: 'pres_set_showing', needs: 'slides',
        build: () => true },
    'pres.hide':   { group: 'Slides', label: 'Slides Take Down', event: 'pres_set_showing', needs: 'slides',
        build: () => false },
    'pres.toggle': { group: 'Slides', label: 'Slides Live Toggle', event: 'pres_set_showing', needs: 'slides',
        build: (_p, _state, ctx) => !ctx?.presMeta?.showing },

    // --- Show safety --------------------------------------------------------
    'system.clearAll': { group: 'Show Safety', label: 'Clear All', event: 'clear_all', destructive: true,
        build: () => undefined },
    'system.undoClear': { group: 'Show Safety', label: 'Undo Clear', event: 'restore_recent_clear',
        build: () => undefined },
    // Blackout is not a server concept — the desktop's own handler is exactly these
    // two emits (App.jsx handleBlackout), and both are legal from a remote.
    'system.blackout': { group: 'Show Safety', label: 'Blackout', destructive: true,
        steps: [
            { event: 'output_mode_update', build: () => ({ backgroundMode: 'black' }) },
            { event: 'clear_all', build: () => undefined }
        ] },
    'output.mode': { group: 'Show Safety', label: 'Output Background…', event: 'output_mode_update',
        fields: [{ key: 'mode', type: 'select', label: 'Background', options: PAD_OUTPUT_MODES, default: 'green' }],
        build: (p) => ({ backgroundMode: pick(p?.mode, PAD_OUTPUT_MODES, 'green') }) },

    // --- Layer mutes --------------------------------------------------------
    'layer.toggle': { group: 'Layers', label: 'Toggle Layer…', event: 'layer_visibility_update',
        fields: [{ key: 'key', type: 'select', label: 'Layer', options: PAD_LAYER_KEYS, default: 'lyrics' }],
        build: (p, state) => {
            const key = pick(p?.key, PAD_LAYER_KEYS, 'lyrics');
            return { [key]: state?.layerVisibility?.[key] === false };
        } },
    'layer.set': { group: 'Layers', label: 'Set Layer…', event: 'layer_visibility_update',
        fields: [
            { key: 'key', type: 'select', label: 'Layer', options: PAD_LAYER_KEYS, default: 'lyrics' },
            { key: 'value', type: 'bool', label: 'Visible', default: true }
        ],
        build: (p) => ({ [pick(p?.key, PAD_LAYER_KEYS, 'lyrics')]: p?.value !== false }) },

    // --- Media transport ----------------------------------------------------
    'media.playPause': { group: 'Media', label: 'Play / Pause', event: 'media_toggle_play', needs: 'media',
        build: (_p, state) => !state?.playback?.mediaPlaying },
    // NOTE: the client->server event is `stop_media`. `media_stop` is the server's
    // outbound broadcast and emitting it from here would be a silent no-op.
    'media.stop': { group: 'Media', label: 'Stop Media', event: 'stop_media', needs: 'media', destructive: true,
        build: () => undefined },
    'media.next': { group: 'Media', label: 'Next Item', event: 'media_next', needs: 'media',
        build: () => undefined },
    // media_seek is absolute, so a relative jump needs the live playhead, which the
    // pad tracks from the media_time_update broadcast.
    'media.seekRel': { group: 'Media', label: 'Skip ± Seconds…', event: 'media_seek', needs: 'clip',
        fields: [{ key: 'seconds', type: 'num', label: 'Seconds (negative rewinds)', min: -600, max: 600, default: 10 }],
        build: (p, _state, ctx) => Math.max(0, (Number(ctx?.mediaTime) || 0) + clampNum(p?.seconds, -600, 600, 10)) },
    'media.loop': { group: 'Media', label: 'Toggle Loop', event: 'media_set_loop',
        build: (_p, state) => !state?.playback?.mediaLoop },
    'media.autoNext': { group: 'Media', label: 'Toggle Auto-Next', event: 'media_set_auto_next',
        build: (_p, state) => !state?.playback?.mediaAutoNext },
    'media.mute': { group: 'Media', label: 'Toggle Mute', event: 'media_set_muted',
        build: (_p, state) => !state?.playback?.mediaMuted },

    // --- Graphics -----------------------------------------------------------
    'graphics.hideLower': { group: 'Graphics', label: 'Hide Lower Third', event: 'hide_lower_third',
        build: () => undefined },
    'graphics.hideLyrics': { group: 'Graphics', label: 'Hide Lyrics', event: 'hide_lyrics',
        build: () => undefined },

    // --- Stage / confidence monitor ----------------------------------------
    'stage.timerStart': { group: 'Timers', label: 'Start Stage Timer…', event: 'set_stage_timer',
        fields: [
            { key: 'minutes', type: 'num', label: 'Minutes', min: 0, max: 600, default: 5 },
            { key: 'label', type: 'text', label: 'Timer label', max: 60, default: 'Segment Timer' },
            { key: 'mode', type: 'select', label: 'Direction', options: ['down', 'up'], default: 'down' }
        ],
        build: (p) => {
            const totalSeconds = Math.round(clampNum(p?.minutes, 0, 600, 5) * 60);
            const now = Date.now();
            return {
                mode: pick(p?.mode, ['down', 'up'], 'down'),
                label: str(p?.label, 60, 'Segment Timer') || 'Segment Timer',
                totalSeconds,
                startTime: now,
                endTime: now + totalSeconds * 1000
            };
        } },
    'stage.timerPause':  { group: 'Timers', label: 'Pause Stage Timer', event: 'pause_stage_timer',
        build: () => undefined },
    'stage.timerResume': { group: 'Timers', label: 'Resume Stage Timer', event: 'resume_stage_timer',
        build: (_p, state) => state?.current?.stageTimer?.data || {} },
    'stage.timerStop':   { group: 'Timers', label: 'Stop Stage Timer', event: 'stop_stage_timer',
        build: () => undefined },
    'sabha.show': { group: 'Timers', label: 'Show Sabha Countdown…', event: 'sabha_timer_update',
        fields: [
            { key: 'timeStr', type: 'text', label: 'Start time (HH:MM)', max: 5, default: '16:00' },
            { key: 'message', type: 'text', label: 'Message', max: 60, default: 'Sabha Starts In' }
        ],
        // sabha_timer_update merges into current state, so only these keys change.
        build: (p) => ({
            timeStr: str(p?.timeStr, 5, '16:00') || '16:00',
            message: str(p?.message, 60, 'Sabha Starts In') || 'Sabha Starts In',
            showing: true
        }) },
    'sabha.hide': { group: 'Timers', label: 'Hide Sabha Countdown', event: 'sabha_timer_update',
        build: () => ({ showing: false }) },

    // --- Messages & overlays ------------------------------------------------
    'stage.message': { group: 'Messages', label: 'Stage Message…', event: 'set_stage_message',
        fields: [
            { key: 'text', type: 'text', label: 'Message', max: 120, default: 'Wrap up now' },
            { key: 'color', type: 'select', label: 'Colour', options: ['default', 'red', 'amber', 'green'], default: 'default' },
            { key: 'flash', type: 'bool', label: 'Flash', default: false }
        ],
        // An empty message would broadcast a blank stage message, which looks
        // exactly like the button doing nothing. Clearing has its own action
        // below, so a blank here is always a misconfigured button — fall back.
        build: (p) => ({
            text: str(p?.text, 120, '') || 'Wrap up now',
            format: {
                color: pick(p?.color, ['default', 'red', 'amber', 'green'], 'default'),
                bold: p?.bold !== false,
                upper: Boolean(p?.upper),
                flash: Boolean(p?.flash),
                sizeOffset: clampInt(p?.sizeOffset, -40, 40, 0)
            }
        }) },
    'stage.messageClear': { group: 'Messages', label: 'Clear Stage Message', event: 'set_stage_message',
        build: () => ({ text: '', format: {} }) },
    'mediaMessage.set': { group: 'Messages', label: 'Media Message…', event: 'media_message_overlay_update',
        fields: [
            { key: 'text', type: 'text', label: 'Message', max: 180, default: '' },
            { key: 'position', type: 'select', label: 'Position', options: ['top', 'center', 'bottom', 'lowerThird'], default: 'center' },
            { key: 'size', type: 'int', label: 'Size', min: 24, max: 180, default: 72 }
        ],
        // Same trap: the server only counts this overlay as live when it has both
        // `enabled` and text, so enabling it with an empty string is a silent no-op.
        build: (p) => ({
            enabled: Boolean(str(p?.text, 180, '')),
            text: str(p?.text, 180, ''),
            position: pick(p?.position, ['top', 'center', 'bottom', 'lowerThird'], 'center'),
            size: clampInt(p?.size, 24, 180, 72),
            color: /^#[0-9a-fA-F]{6}$/.test(p?.color || '') ? p.color : '#ffffff',
            weight: pick(String(p?.weight || '800'), ['500', '700', '800', '900'], '800'),
            uppercase: Boolean(p?.uppercase),
            backdrop: p?.backdrop !== false
        }) },
    'mediaMessage.clear': { group: 'Messages', label: 'Clear Media Message', event: 'media_message_overlay_update',
        build: () => ({ enabled: false, text: '' }) },
    'particles.toggle': { group: 'Messages', label: 'Toggle Particles', event: 'particles_update',
        build: (_p, state) => ({ enabled: !state?.live?.particles }) },

    // --- Translation --------------------------------------------------------
    'translation.stop':  { group: 'Translation', label: 'Stop Translation', event: 'stop_translation', destructive: true,
        build: () => undefined },
    'translation.clear': { group: 'Translation', label: 'Clear Captions', event: 'clear_translation_display',
        build: () => undefined }
};

// ---------------------------------------------------------------------------
// Relayed commands
// ---------------------------------------------------------------------------
// These cannot be done by the pad directly. They travel as `pad_command`, the
// server relays them to local (desktop) sockets only, and the always-mounted
// RunOfShowPanel executes them with its existing firing logic — which is the only
// place that can reach the blackout prop, the renderer's microphone, and the
// registered-local-media path guard.

export const PAD_COMMANDS = {
    'cue_fire': { group: 'Run of Show', label: 'Fire Cue…',
        fields: [{ key: 'cueId', type: 'cue', label: 'Cue (blank = next pending)', default: '' }] },
    'cue_status': { group: 'Run of Show', label: 'Set Cue Status…',
        fields: [
            { key: 'cueId', type: 'cue', label: 'Cue', default: '' },
            { key: 'status', type: 'select', label: 'Status', options: ['pending', 'armed', 'fired', 'skipped', 'done'], default: 'done' }
        ] },
    'translation_start': { group: 'Run of Show', label: 'Start Translation' }
};

export const PAD_CUE_STATUSES = ['pending', 'armed', 'fired', 'skipped', 'done'];

// Grouped option list for the editor's action picker.
export function getPadActionOptions() {
    const groups = new Map();
    const push = (group, value, label) => {
        if (!groups.has(group)) groups.set(group, []);
        groups.get(group).push({ value, label });
    };
    for (const [id, def] of Object.entries(PAD_EMIT_ACTIONS)) push(def.group, `emit:${id}`, def.label);
    for (const [id, def] of Object.entries(PAD_COMMANDS)) push(def.group, `command:${id}`, def.label);
    return [...groups.entries()].map(([group, options]) => ({ group, options }));
}

export function getPadActionDef(action) {
    if (!action || action.kind === 'none') return null;
    if (action.kind === 'emit') return PAD_EMIT_ACTIONS[action.id] || null;
    if (action.kind === 'command') return PAD_COMMANDS[action.id] || null;
    return null;
}

// The payload an action starts life with. The editor shows a field's `default`
// whether or not it is stored, so without seeding these the operator sees a
// populated form backed by an empty payload — and the button silently sends
// nothing. Seed on create and on action change so shown == stored.
export function padActionDefaults(def) {
    const payload = {};
    for (const field of def?.fields || []) {
        if (field.default !== undefined) payload[field.key] = field.default;
    }
    return payload;
}

export function isDestructive(button) {
    if (!button) return false;
    if (typeof button.hold === 'boolean') return button.hold;
    return Boolean(getPadActionDef(button.action)?.destructive);
}

// Resolve a button's action into concrete socket emissions.
// Returns { ok, steps: [{ event, args }] } for direct emits, or
// { ok, command: { type, payload } } for a relayed command.
export function resolvePadAction(action, { state = null, ctx = {} } = {}) {
    if (!action || action.kind === 'none') return { ok: false, error: 'No action assigned.' };

    if (action.kind === 'command') {
        const def = PAD_COMMANDS[action.id];
        if (!def) return { ok: false, error: 'Unknown command.' };
        return { ok: true, command: { type: action.id, payload: { ...(action.payload || {}) } } };
    }

    const def = PAD_EMIT_ACTIONS[action.id];
    if (!def) return { ok: false, error: 'Unknown action.' };

    const payload = action.payload || {};
    const steps = def.steps
        ? def.steps.map(step => ({ event: step.event, args: step.build(payload, state, ctx) }))
        : [{ event: def.event, args: def.build(payload, state, ctx) }];

    return { ok: true, steps };
}

// Should the button read as "on" right now? Drives the ring on the pad, so an
// operator can see the current state of a toggle without looking at the output.
// Layer toggles light up when the layer is MUTED — the abnormal state is the one
// worth shouting about.
export function getPadButtonActive(button, { state = null, ctx = {} } = {}) {
    const action = button?.action;
    if (!action || action.kind !== 'emit') return false;
    const payload = action.payload || {};

    switch (action.id) {
        case 'layer.toggle':
            return state?.layerVisibility?.[payload.key] === false;
        case 'layer.set':
            return state?.layerVisibility?.[payload.key] === (payload.value !== false);
        case 'pres.toggle':
        case 'pres.show':
            return Boolean(ctx?.presMeta?.showing);
        case 'media.playPause':
            return Boolean(state?.playback?.mediaPlaying);
        case 'media.mute':
            return Boolean(state?.playback?.mediaMuted);
        case 'media.loop':
            return Boolean(state?.playback?.mediaLoop);
        case 'media.autoNext':
            return Boolean(state?.playback?.mediaAutoNext);
        case 'particles.toggle':
            return Boolean(state?.live?.particles);
        case 'output.mode':
            return state?.outputMode?.backgroundMode === payload.mode;
        case 'mediaMessage.set':
            return Boolean(state?.live?.mediaMessage);
        default:
            return false;
    }
}

// Is a button usable given current live state? Drives the pad's disabled styling.
export function isPadActionAvailable(action, { state = null, ctx = {} } = {}) {
    const def = getPadActionDef(action);
    if (!def) return false;
    if (def.needs === 'slides') return Boolean(ctx?.presMeta?.mode && ctx.presMeta.mode !== 'none');
    if (def.needs === 'media') return Boolean(state?.current?.media);
    if (def.needs === 'clip') return Boolean(state?.current?.media) && Number.isFinite(Number(ctx?.mediaTime));
    return true;
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

export function normalizePadAction(action) {
    if (!action || typeof action !== 'object') return { kind: 'none', id: '', payload: {} };
    const kind = pick(action.kind, ['emit', 'command', 'none'], 'none');
    const id = str(action.id, 48);
    const known = kind === 'emit' ? Boolean(PAD_EMIT_ACTIONS[id])
        : kind === 'command' ? Boolean(PAD_COMMANDS[id])
        : false;
    if (!known) return { kind: 'none', id: '', payload: {} };
    return {
        kind,
        id,
        payload: action.payload && typeof action.payload === 'object' && !Array.isArray(action.payload)
            ? { ...action.payload }
            : {}
    };
}

export function normalizePadButton(button, index = 0) {
    const source = button && typeof button === 'object' ? button : {};
    const action = normalizePadAction(source.action);
    const icon = str(source.icon, 32, DEFAULT_PAD_ICON);
    return {
        id: str(source.id, 64) || `btn-${index}`,
        label: str(source.label, 20),
        sub: str(source.sub, 20),
        icon: PAD_ICON_SET.has(icon) ? icon : DEFAULT_PAD_ICON,
        color: pick(str(source.color, 16), PAD_COLOR_KEYS, DEFAULT_PAD_COLOR),
        wide: Boolean(source.wide),
        // An unset `hold` inherits the action's own destructiveness, so a Clear All
        // dropped in from the editor is guarded by default rather than by memory.
        hold: typeof source.hold === 'boolean'
            ? source.hold
            : Boolean(getPadActionDef(action)?.destructive),
        action
    };
}

export function normalizePadPage(page, index = 0) {
    const source = page && typeof page === 'object' ? page : {};
    const buttons = Array.isArray(source.buttons) ? source.buttons : [];
    return {
        id: str(source.id, 64) || `page-${index}`,
        name: str(source.name, 24) || `Page ${index + 1}`,
        cols: pick(Number(source.cols), PAD_COL_CHOICES, DEFAULT_PAD_COLS),
        buttons: buttons.slice(0, MAX_PAD_BUTTONS).map((button, i) => normalizePadButton(button, i))
    };
}

// Structural pass only — no fallback. Kept separate from normalizePadLayout so the
// default layout below can be built with it without a circular reference.
function normalizePadLayoutShape(source) {
    return {
        version: PAD_LAYOUT_VERSION,
        updatedAt: Number.isFinite(Number(source.updatedAt)) ? Number(source.updatedAt) : 0,
        pages: (source.pages || []).slice(0, MAX_PAD_PAGES).map((page, i) => normalizePadPage(page, i))
    };
}

// Total: any input at all yields a usable layout. Garbage in falls back to the
// defaults so a corrupted localStorage entry can never leave the pad blank.
export function normalizePadLayout(layout) {
    const source = layout && typeof layout === 'object' && !Array.isArray(layout) ? layout : {};
    const pages = Array.isArray(source.pages) ? source.pages : [];
    if (pages.length === 0) return clonePadLayout(DEFAULT_PAD_LAYOUT);
    return normalizePadLayoutShape({ ...source, pages });
}

export function clonePadLayout(layout) {
    return {
        version: PAD_LAYOUT_VERSION,
        updatedAt: layout.updatedAt || 0,
        pages: layout.pages.map(page => ({
            ...page,
            buttons: page.buttons.map(button => ({ ...button, action: { ...button.action, payload: { ...button.action.payload } } }))
        }))
    };
}

let seq = 0;
const nextId = (prefix) => `${prefix}-${Date.now().toString(36)}-${(seq += 1).toString(36)}`;

export function makePadButton(actionKey = '') {
    const [kind, id] = actionKey.split(':');
    const bare = kind && id ? normalizePadAction({ kind, id, payload: {} }) : { kind: 'none', id: '', payload: {} };
    const def = getPadActionDef(bare);
    const action = { ...bare, payload: padActionDefaults(def) };
    return normalizePadButton({
        id: nextId('btn'),
        label: def?.label?.replace(/…$/, '') || 'Button',
        icon: DEFAULT_PAD_ICON,
        color: def?.destructive ? 'red' : DEFAULT_PAD_COLOR,
        action
    });
}

export function makePadPage(name = 'New Page') {
    return { id: nextId('page'), name: name.slice(0, 24), cols: DEFAULT_PAD_COLS, buttons: [] };
}

// ---------------------------------------------------------------------------
// Default layout
// ---------------------------------------------------------------------------
// Three pages so /pad is immediately useful on a device that has never been
// configured. Ids are stable strings (not generated) so the layout round-trips
// through normalizePadLayout unchanged, which the model test asserts.

const btn = (id, label, actionKey, extra = {}) => {
    const [kind, actionId] = actionKey.split(':');
    return normalizePadButton({ id, label, action: { kind, id: actionId, payload: extra.payload || {} }, ...extra });
};

export const DEFAULT_PAD_LAYOUT = normalizePadLayoutShape({
    version: PAD_LAYOUT_VERSION,
    updatedAt: 0,
    pages: [
        {
            id: 'page-show',
            name: 'Show',
            cols: 5,
            buttons: [
                btn('show-prev', 'Previous', 'emit:pres.prev', { icon: 'chevronLeft' }),
                btn('show-next', 'Next Slide', 'emit:pres.next', { icon: 'chevronRight', color: 'blue', wide: true }),
                btn('show-live', 'Slides Live', 'emit:pres.toggle', { icon: 'monitor', color: 'emerald' }),
                btn('show-first', 'First', 'emit:pres.first', { icon: 'chevronsLeft' }),
                btn('show-cue', 'Fire Next Cue', 'command:cue_fire', { icon: 'listChecks', color: 'emerald', wide: true }),
                btn('show-hidelt', 'Hide Lower 3rd', 'emit:graphics.hideLower', { icon: 'eyeOff' }),
                btn('show-hidelyr', 'Hide Lyrics', 'emit:graphics.hideLyrics', { icon: 'eyeOff' }),
                btn('show-undo', 'Undo Clear', 'emit:system.undoClear', { icon: 'rotateCcw', color: 'amber' }),
                btn('show-blackout', 'Blackout', 'emit:system.blackout', { icon: 'power', color: 'red' }),
                btn('show-clear', 'Clear All', 'emit:system.clearAll', { icon: 'alertTriangle', color: 'red', wide: true })
            ]
        },
        {
            id: 'page-media',
            name: 'Media',
            cols: 5,
            buttons: [
                btn('media-play', 'Play / Pause', 'emit:media.playPause', { icon: 'play', color: 'emerald', wide: true }),
                btn('media-back', 'Back 10s', 'emit:media.seekRel', { icon: 'rewind', payload: { seconds: -10 } }),
                btn('media-fwd', 'Forward 10s', 'emit:media.seekRel', { icon: 'fastForward', payload: { seconds: 10 } }),
                btn('media-next', 'Next Item', 'emit:media.next', { icon: 'skipForward' }),
                btn('media-mute', 'Mute', 'emit:media.mute', { icon: 'volumeOff' }),
                btn('media-loop', 'Loop', 'emit:media.loop', { icon: 'repeat' }),
                btn('media-auto', 'Auto-Next', 'emit:media.autoNext', { icon: 'skipForward' }),
                btn('media-msgclear', 'Clear Message', 'emit:mediaMessage.clear', { icon: 'message' }),
                btn('media-stop', 'Stop Media', 'emit:media.stop', { icon: 'square', color: 'red' })
            ]
        },
        {
            id: 'page-layers',
            name: 'Layers',
            cols: 4,
            buttons: [
                ...PAD_LAYER_KEYS.map(key => btn(
                    `layer-${key}`,
                    PAD_LAYER_LABELS[key],
                    'emit:layer.toggle',
                    { icon: 'layers', color: 'violet', payload: { key } }
                )),
                btn('out-green', 'Green Output', 'emit:output.mode', { icon: 'square', color: 'emerald', payload: { mode: 'green' } }),
                btn('out-black', 'Black Output', 'emit:output.mode', { icon: 'square', payload: { mode: 'black' } }),
                btn('out-transparent', 'Transparent', 'emit:output.mode', { icon: 'square', color: 'cyan', payload: { mode: 'transparent' } }),
                btn('layer-particles', 'Particles', 'emit:particles.toggle', { icon: 'sparkles', color: 'fuchsia' })
            ]
        }
    ]
});
