import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    DEFAULT_PAD_COLOR,
    DEFAULT_PAD_LAYOUT,
    MAX_PAD_BUTTONS,
    MAX_PAD_PAGES,
    PAD_COLORS,
    PAD_COLOR_KEYS,
    PAD_COL_CHOICES,
    PAD_COMMANDS,
    PAD_EMIT_ACTIONS,
    PAD_ICON_NAMES,
    PAD_LAYER_KEYS,
    getPadActionDef,
    getPadActionOptions,
    getPadButtonActive,
    isDestructive,
    isPadActionAvailable,
    makePadButton,
    makePadPage,
    normalizePadAction,
    normalizePadButton,
    normalizePadLayout,
    normalizePadPage,
    padActionDefaults,
    resolvePadAction
} from '../frontend/src/components/padModel.js';

// ---------------------------------------------------------------------------
// Table integrity — these are the assertions that catch a renamed server event
// or a colour/icon that Tailwind will never emit.
// ---------------------------------------------------------------------------

test('every emit action declares a string event (or compound steps) and a build fn', () => {
    for (const [id, def] of Object.entries(PAD_EMIT_ACTIONS)) {
        assert.equal(typeof def.label, 'string', `${id} needs a label`);
        assert.equal(typeof def.group, 'string', `${id} needs a group`);
        if (def.steps) {
            assert.ok(Array.isArray(def.steps) && def.steps.length > 0, `${id} steps must be non-empty`);
            for (const step of def.steps) {
                assert.equal(typeof step.event, 'string', `${id} step needs an event name`);
                assert.ok(step.event.length > 0, `${id} step event must not be empty`);
                assert.equal(typeof step.build, 'function', `${id} step needs a build fn`);
            }
        } else {
            assert.equal(typeof def.event, 'string', `${id} needs an event name`);
            assert.ok(def.event.length > 0, `${id} event must not be empty`);
            assert.equal(typeof def.build, 'function', `${id} needs a build fn`);
        }
    }
});

test('media stop uses the client->server event name, not the outbound broadcast', () => {
    // `media_stop` is what the server emits outward; emitting it from a client is a
    // silent no-op. This test exists because that mistake is invisible at runtime.
    assert.equal(PAD_EMIT_ACTIONS['media.stop'].event, 'stop_media');
});

test('every default-layout button maps to a known action', () => {
    for (const page of DEFAULT_PAD_LAYOUT.pages) {
        for (const button of page.buttons) {
            const def = getPadActionDef(button.action);
            assert.ok(def, `${page.id}/${button.id} references unknown action ${button.action.kind}:${button.action.id}`);
        }
    }
});

test('every default-layout button uses a real colour and icon', () => {
    for (const page of DEFAULT_PAD_LAYOUT.pages) {
        for (const button of page.buttons) {
            assert.ok(PAD_COLOR_KEYS.includes(button.color), `${button.id} has unknown colour ${button.color}`);
            assert.ok(PAD_ICON_NAMES.includes(button.icon), `${button.id} has unknown icon ${button.icon}`);
        }
    }
});

test('every colour entry carries the full set of literal class strings', () => {
    for (const [key, value] of Object.entries(PAD_COLORS)) {
        for (const field of ['face', 'press', 'text', 'ring']) {
            assert.equal(typeof value[field], 'string', `${key}.${field} missing`);
            assert.ok(value[field].length > 0, `${key}.${field} empty`);
        }
    }
});

test('default layout covers all eight layer keys on the Layers page', () => {
    const layers = DEFAULT_PAD_LAYOUT.pages.find(page => page.id === 'page-layers');
    const keys = layers.buttons
        .filter(button => button.action.id === 'layer.toggle')
        .map(button => button.action.payload.key);
    assert.deepEqual([...keys].sort(), [...PAD_LAYER_KEYS].sort());
});

test('action options cover every emit action and command exactly once', () => {
    const flat = getPadActionOptions().flatMap(group => group.options.map(option => option.value));
    const expected = [
        ...Object.keys(PAD_EMIT_ACTIONS).map(id => `emit:${id}`),
        ...Object.keys(PAD_COMMANDS).map(id => `command:${id}`)
    ];
    assert.equal(flat.length, expected.length);
    assert.deepEqual([...flat].sort(), [...expected].sort());
});

// ---------------------------------------------------------------------------
// Normalisation is total and idempotent
// ---------------------------------------------------------------------------

test('normalizePadLayout survives any garbage and always yields usable pages', () => {
    for (const input of [null, undefined, 0, '', 'nope', [], [1, 2], { pages: 'x' }, { pages: [] }, { pages: null }]) {
        const layout = normalizePadLayout(input);
        assert.ok(Array.isArray(layout.pages), `pages missing for ${JSON.stringify(input)}`);
        assert.ok(layout.pages.length > 0, `no pages for ${JSON.stringify(input)}`);
        assert.equal(layout.version, 1);
    }
});

test('the default layout round-trips through normalizePadLayout unchanged', () => {
    assert.deepEqual(normalizePadLayout(DEFAULT_PAD_LAYOUT), DEFAULT_PAD_LAYOUT);
});

test('normalizePadLayout is idempotent on messy input', () => {
    const messy = {
        pages: [{
            name: 'x'.repeat(200),
            cols: 99,
            buttons: [{ label: 'y'.repeat(200), color: 'chartreuse', icon: 'nonsense', action: { kind: 'emit', id: 'pres.next' } }]
        }]
    };
    const once = normalizePadLayout(messy);
    const twice = normalizePadLayout(once);
    assert.deepEqual(twice, once);
});

test('normalizePadLayout clamps pages, buttons, names and column counts', () => {
    const layout = normalizePadLayout({
        pages: Array.from({ length: 20 }, () => ({
            name: 'x'.repeat(200),
            cols: 99,
            buttons: Array.from({ length: 200 }, () => ({ label: 'y'.repeat(200), sub: 'z'.repeat(200) }))
        }))
    });
    assert.equal(layout.pages.length, MAX_PAD_PAGES);
    assert.equal(layout.pages[0].name.length, 24);
    assert.ok(PAD_COL_CHOICES.includes(layout.pages[0].cols));
    assert.equal(layout.pages[0].buttons.length, MAX_PAD_BUTTONS);
    assert.equal(layout.pages[0].buttons[0].label.length, 20);
    assert.equal(layout.pages[0].buttons[0].sub.length, 20);
});

test('unknown actions collapse to kind none rather than throwing later', () => {
    assert.deepEqual(normalizePadAction({ kind: 'emit', id: 'does.not.exist' }), { kind: 'none', id: '', payload: {} });
    assert.deepEqual(normalizePadAction({ kind: 'bogus', id: 'pres.next' }), { kind: 'none', id: '', payload: {} });
    assert.deepEqual(normalizePadAction(null), { kind: 'none', id: '', payload: {} });
    assert.deepEqual(normalizePadAction({ kind: 'emit', id: 'pres.next', payload: [1, 2] }).payload, {});
});

test('unknown colour and icon fall back instead of emitting dead Tailwind classes', () => {
    const button = normalizePadButton({ color: 'chartreuse', icon: 'nonsense' });
    assert.equal(button.color, DEFAULT_PAD_COLOR);
    assert.equal(button.icon, 'none');
});

test('an unset hold flag inherits the action destructiveness', () => {
    assert.equal(normalizePadButton({ action: { kind: 'emit', id: 'system.clearAll' } }).hold, true);
    assert.equal(normalizePadButton({ action: { kind: 'emit', id: 'media.stop' } }).hold, true);
    assert.equal(normalizePadButton({ action: { kind: 'emit', id: 'pres.next' } }).hold, false);
    // An explicit choice always wins over the inherited default.
    assert.equal(normalizePadButton({ hold: false, action: { kind: 'emit', id: 'system.clearAll' } }).hold, false);
});

test('destructive default-layout buttons are hold-guarded', () => {
    const guarded = DEFAULT_PAD_LAYOUT.pages
        .flatMap(page => page.buttons)
        .filter(button => getPadActionDef(button.action)?.destructive);
    assert.ok(guarded.length >= 3);
    for (const button of guarded) {
        assert.equal(button.hold, true, `${button.id} must be hold-to-fire`);
        assert.equal(isDestructive(button), true);
    }
});

test('normalizePadPage fills in ids and names by index', () => {
    const page = normalizePadPage({}, 2);
    assert.equal(page.id, 'page-2');
    assert.equal(page.name, 'Page 3');
    assert.deepEqual(page.buttons, []);
});

test('factories produce already-normalised values', () => {
    const button = makePadButton('emit:system.clearAll');
    assert.deepEqual(normalizePadButton(button), button);
    assert.equal(button.hold, true);
    assert.equal(button.color, 'red');

    const page = makePadPage('Encore');
    assert.deepEqual(normalizePadPage(page, 0), page);
    assert.equal(page.name, 'Encore');

    // Ids must be unique or React keys collide and the editor reorders wrongly.
    assert.notEqual(makePadButton('emit:pres.next').id, makePadButton('emit:pres.next').id);
});

// ---------------------------------------------------------------------------
// Action resolution
// ---------------------------------------------------------------------------

const resolve = (kind, id, payload = {}, options = {}) =>
    resolvePadAction({ kind, id, payload }, options);

test('resolvePadAction refuses unassigned and unknown actions', () => {
    assert.equal(resolvePadAction({ kind: 'none' }).ok, false);
    assert.equal(resolvePadAction(null).ok, false);
    assert.equal(resolve('emit', 'nope').ok, false);
    assert.equal(resolve('command', 'nope').ok, false);
});

test('slide navigation resolves to server-authoritative pres_goto payloads', () => {
    assert.deepEqual(resolve('emit', 'pres.next').steps, [{ event: 'pres_goto', args: { direction: 'next' } }]);
    assert.deepEqual(resolve('emit', 'pres.last').steps, [{ event: 'pres_goto', args: { direction: 'last' } }]);
});

test('go-to-slide converts the operator-facing 1-based number to a 0-based index', () => {
    assert.deepEqual(resolve('emit', 'pres.goto', { index: 1 }).steps[0].args, { index: 0 });
    assert.deepEqual(resolve('emit', 'pres.goto', { index: 12 }).steps[0].args, { index: 11 });
    // Out-of-range and junk clamp rather than sending a negative index.
    assert.deepEqual(resolve('emit', 'pres.goto', { index: -5 }).steps[0].args, { index: 0 });
    assert.deepEqual(resolve('emit', 'pres.goto', { index: 1e9 }).steps[0].args, { index: 998 });
    assert.deepEqual(resolve('emit', 'pres.goto', { index: 'abc' }).steps[0].args, { index: 0 });
});

test('argless actions resolve to undefined so the emitter sends no argument', () => {
    for (const id of ['system.clearAll', 'system.undoClear', 'media.stop', 'media.next',
        'graphics.hideLower', 'graphics.hideLyrics', 'stage.timerPause', 'stage.timerStop',
        'translation.stop', 'translation.clear']) {
        assert.equal(resolve('emit', id).steps[0].args, undefined, `${id} should take no argument`);
    }
});

test('blackout resolves to the same two emits the desktop button performs', () => {
    assert.deepEqual(resolve('emit', 'system.blackout').steps, [
        { event: 'output_mode_update', args: { backgroundMode: 'black' } },
        { event: 'clear_all', args: undefined }
    ]);
});

test('toggles resolve against live operator state, not a local guess', () => {
    const playing = { playback: { mediaPlaying: true, mediaMuted: false, mediaLoop: true } };
    assert.equal(resolve('emit', 'media.playPause', {}, { state: playing }).steps[0].args, false);
    assert.equal(resolve('emit', 'media.mute', {}, { state: playing }).steps[0].args, true);
    assert.equal(resolve('emit', 'media.loop', {}, { state: playing }).steps[0].args, false);
    // With no state yet (pad just connected) a toggle still produces a sane value.
    assert.equal(resolve('emit', 'media.playPause').steps[0].args, true);
});

test('layer toggle flips only the addressed key and reads current visibility', () => {
    const state = { layerVisibility: { lyrics: true, media: false } };
    assert.deepEqual(resolve('emit', 'layer.toggle', { key: 'lyrics' }, { state }).steps[0].args, { lyrics: false });
    assert.deepEqual(resolve('emit', 'layer.toggle', { key: 'media' }, { state }).steps[0].args, { media: true });
    // An unknown layer key would be dropped by the server, so it falls back.
    assert.deepEqual(resolve('emit', 'layer.toggle', { key: 'bogus' }, { state }).steps[0].args, { lyrics: false });
});

test('slides live toggle reads pres_meta, which is the slim state remotes receive', () => {
    assert.equal(resolve('emit', 'pres.toggle', {}, { ctx: { presMeta: { showing: true } } }).steps[0].args, false);
    assert.equal(resolve('emit', 'pres.toggle', {}, { ctx: { presMeta: { showing: false } } }).steps[0].args, true);
});

test('relative seek converts to an absolute position and never goes negative', () => {
    const ctx = { mediaTime: 30 };
    assert.equal(resolve('emit', 'media.seekRel', { seconds: 10 }, { ctx }).steps[0].args, 40);
    assert.equal(resolve('emit', 'media.seekRel', { seconds: -10 }, { ctx }).steps[0].args, 20);
    // Rewinding past the start clamps to zero rather than sending a negative time.
    assert.equal(resolve('emit', 'media.seekRel', { seconds: -90 }, { ctx }).steps[0].args, 0);
    assert.equal(resolve('emit', 'media.seekRel', { seconds: -10 }, { ctx: {} }).steps[0].args, 0);
});

test('output mode rejects anything outside the three the server accepts', () => {
    assert.deepEqual(resolve('emit', 'output.mode', { mode: 'transparent' }).steps[0].args, { backgroundMode: 'transparent' });
    assert.deepEqual(resolve('emit', 'output.mode', { mode: 'purple' }).steps[0].args, { backgroundMode: 'green' });
});

test('stage timer builds a consistent start/end window and clamps negatives', () => {
    const before = Date.now();
    const args = resolve('emit', 'stage.timerStart', { minutes: 5, label: 'Kirtan', mode: 'down' }).steps[0].args;
    assert.equal(args.totalSeconds, 300);
    assert.equal(args.label, 'Kirtan');
    assert.equal(args.mode, 'down');
    assert.ok(args.startTime >= before);
    assert.equal(args.endTime - args.startTime, 300000);

    assert.equal(resolve('emit', 'stage.timerStart', { minutes: -3 }).steps[0].args.totalSeconds, 0);
    assert.equal(resolve('emit', 'stage.timerStart', { minutes: 'abc' }).steps[0].args.totalSeconds, 300);
    assert.equal(resolve('emit', 'stage.timerStart', { mode: 'sideways' }).steps[0].args.mode, 'down');
});

test('sabha show sends only merge keys, and hide sends only the showing flag', () => {
    assert.deepEqual(resolve('emit', 'sabha.show', { timeStr: '18:30', message: 'Starting Soon' }).steps[0].args, {
        timeStr: '18:30', message: 'Starting Soon', showing: true
    });
    assert.deepEqual(resolve('emit', 'sabha.hide').steps[0].args, { showing: false });
});

test('stage and media messages clamp to the server length limits', () => {
    const stage = resolve('emit', 'stage.message', { text: 'x'.repeat(500), color: 'red', flash: true }).steps[0].args;
    assert.equal(stage.text.length, 120);
    assert.equal(stage.format.color, 'red');
    assert.equal(stage.format.flash, true);
    assert.deepEqual(resolve('emit', 'stage.messageClear').steps[0].args, { text: '', format: {} });

    const media = resolve('emit', 'mediaMessage.set', { text: 'y'.repeat(500), size: 9999, color: 'red' }).steps[0].args;
    assert.equal(media.text.length, 180);
    assert.equal(media.size, 180);
    assert.equal(media.color, '#ffffff', 'a non-hex colour must fall back, not reach the graphics layer');
    assert.equal(media.enabled, true);
});

test('a freshly created button stores the defaults the editor displays', () => {
    // The inspector renders `payload[key] ?? field.default`, so a default that is
    // shown but not stored produces a button that looks configured and fires an
    // empty payload. This is what made Stage Message do nothing.
    for (const [id, def] of Object.entries(PAD_EMIT_ACTIONS)) {
        if (!def.fields?.length) continue;
        const button = makePadButton(`emit:${id}`);
        for (const field of def.fields) {
            if (field.default === undefined) continue;
            assert.equal(
                button.action.payload[field.key],
                field.default,
                `${id}.${field.key} default must be stored, not just displayed`
            );
        }
    }
});

test('padActionDefaults collects every declared default and ignores the rest', () => {
    assert.deepEqual(padActionDefaults(PAD_EMIT_ACTIONS['stage.message']), {
        text: 'Wrap up now', color: 'default', flash: false
    });
    assert.deepEqual(padActionDefaults(PAD_EMIT_ACTIONS['pres.next']), {});
    assert.deepEqual(padActionDefaults(null), {});
});

test('stage message never fires blank, since a blank one is indistinguishable from a dead button', () => {
    assert.equal(resolve('emit', 'stage.message').steps[0].args.text, 'Wrap up now');
    assert.equal(resolve('emit', 'stage.message', { text: '' }).steps[0].args.text, 'Wrap up now');
    assert.equal(resolve('emit', 'stage.message', { text: 'Two minutes' }).steps[0].args.text, 'Two minutes');
    // Clearing has its own action, so the fallback above costs nothing.
    assert.deepEqual(resolve('emit', 'stage.messageClear').steps[0].args, { text: '', format: {} });
});

test('the media message overlay only enables when it has something to show', () => {
    // The server counts this layer live only when enabled AND text are both set,
    // so enabling with an empty string is a silent no-op.
    assert.equal(resolve('emit', 'mediaMessage.set').steps[0].args.enabled, false);
    assert.equal(resolve('emit', 'mediaMessage.set', { text: '' }).steps[0].args.enabled, false);
    assert.equal(resolve('emit', 'mediaMessage.set', { text: 'Hello' }).steps[0].args.enabled, true);
});

test('every payload-taking action produces a usable emit from an empty payload', () => {
    // Belt and braces for buttons created before defaults were seeded: no action
    // may resolve to something the server will treat as a no-op.
    const emptyish = (value) => value === '' || value === undefined || value === null;
    for (const [id, def] of Object.entries(PAD_EMIT_ACTIONS)) {
        if (!def.fields?.length) continue;
        const { steps } = resolve('emit', id, {});
        for (const { event, args } of steps) {
            assert.ok(event, `${id} produced a step with no event`);
            if (args && typeof args === 'object' && 'text' in args) {
                // Either it carries text, or it explicitly declares itself off.
                assert.ok(
                    !emptyish(args.text) || args.enabled === false,
                    `${id} would broadcast an empty text payload`
                );
            }
        }
    }
});

test('commands resolve to a relay envelope rather than a direct emit', () => {
    const fire = resolve('command', 'cue_fire', { cueId: 'cue-1' });
    assert.equal(fire.ok, true);
    assert.equal(fire.steps, undefined);
    assert.deepEqual(fire.command, { type: 'cue_fire', payload: { cueId: 'cue-1' } });

    // No cue id is meaningful: the desktop fires the next pending cue.
    assert.deepEqual(resolve('command', 'cue_fire').command, { type: 'cue_fire', payload: {} });
    assert.equal(resolve('command', 'translation_start').command.type, 'translation_start');
});

test('resolving never mutates the stored button payload', () => {
    const action = { kind: 'emit', id: 'layer.toggle', payload: { key: 'lyrics' } };
    resolvePadAction(action, { state: { layerVisibility: { lyrics: true } } });
    assert.deepEqual(action.payload, { key: 'lyrics' });

    const command = { kind: 'command', id: 'cue_fire', payload: { cueId: 'cue-1' } };
    const resolved = resolvePadAction(command);
    resolved.command.payload.cueId = 'mutated';
    assert.equal(command.payload.cueId, 'cue-1');
});

// ---------------------------------------------------------------------------
// Availability gating
// ---------------------------------------------------------------------------

test('slide buttons are unavailable with no deck loaded', () => {
    const action = { kind: 'emit', id: 'pres.next', payload: {} };
    assert.equal(isPadActionAvailable(action, { ctx: { presMeta: { mode: 'none' } } }), false);
    assert.equal(isPadActionAvailable(action, { ctx: {} }), false);
    assert.equal(isPadActionAvailable(action, { ctx: { presMeta: { mode: 'url' } } }), true);
});

test('media buttons are unavailable with nothing loaded, and seek also needs a playhead', () => {
    const play = { kind: 'emit', id: 'media.playPause', payload: {} };
    const seek = { kind: 'emit', id: 'media.seekRel', payload: {} };
    const loaded = { current: { media: { name: 'clip.mp4' } } };

    assert.equal(isPadActionAvailable(play, { state: null }), false);
    assert.equal(isPadActionAvailable(play, { state: loaded }), true);
    assert.equal(isPadActionAvailable(seek, { state: loaded, ctx: {} }), false);
    assert.equal(isPadActionAvailable(seek, { state: loaded, ctx: { mediaTime: 0 } }), true);
});

test('layer buttons light up when the layer is muted, not when it is visible', () => {
    // Muted is the abnormal state and the usual cause of "why isn't it showing".
    const button = { action: { kind: 'emit', id: 'layer.toggle', payload: { key: 'lyrics' } } };
    assert.equal(getPadButtonActive(button, { state: { layerVisibility: { lyrics: false } } }), true);
    assert.equal(getPadButtonActive(button, { state: { layerVisibility: { lyrics: true } } }), false);
    assert.equal(getPadButtonActive(button, { state: null }), false);
});

test('toggle buttons reflect live playback and output state', () => {
    const state = {
        playback: { mediaPlaying: true, mediaMuted: false, mediaLoop: true, mediaAutoNext: false },
        live: { particles: true },
        outputMode: { backgroundMode: 'black' }
    };
    const active = (id, payload = {}) => getPadButtonActive(
        { action: { kind: 'emit', id, payload } },
        { state, ctx: { presMeta: { showing: true } } }
    );

    assert.equal(active('media.playPause'), true);
    assert.equal(active('media.mute'), false);
    assert.equal(active('media.loop'), true);
    assert.equal(active('media.autoNext'), false);
    assert.equal(active('particles.toggle'), true);
    assert.equal(active('pres.toggle'), true);
    assert.equal(active('output.mode', { mode: 'black' }), true);
    assert.equal(active('output.mode', { mode: 'green' }), false);
});

test('non-toggle and relayed buttons never read as active', () => {
    assert.equal(getPadButtonActive({ action: { kind: 'emit', id: 'pres.next', payload: {} } }, {}), false);
    assert.equal(getPadButtonActive({ action: { kind: 'command', id: 'cue_fire', payload: {} } }, {}), false);
    assert.equal(getPadButtonActive({ action: { kind: 'none' } }, {}), false);
    assert.equal(getPadButtonActive(null, {}), false);
});

test('actions with no requirement are always available, unknown ones never are', () => {
    assert.equal(isPadActionAvailable({ kind: 'emit', id: 'system.clearAll', payload: {} }), true);
    assert.equal(isPadActionAvailable({ kind: 'command', id: 'cue_fire', payload: {} }), true);
    assert.equal(isPadActionAvailable({ kind: 'none' }), false);
});
