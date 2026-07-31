// A short synthesised click for pad button presses.
//
// iOS Safari has no navigator.vibrate, so on the device this pad is designed for
// there is no haptic channel at all. Audio is the only confirmation available
// beyond the visual press state, which matters when the operator is looking at
// the stage rather than the tablet.
//
// iOS also refuses to start an AudioContext outside a user gesture, so the context
// is created lazily on the first press and resumed on every press — a context
// suspended by a phone call or a backgrounded tab otherwise stays dead silently.

export const PAD_CLICK_KEY = 'bc-pad-click';

let context = null;

export function isPadClickEnabled() {
    try {
        return localStorage.getItem(PAD_CLICK_KEY) === '1';
    } catch {
        return false;
    }
}

export function setPadClickEnabled(enabled) {
    try {
        localStorage.setItem(PAD_CLICK_KEY, enabled ? '1' : '0');
    } catch {
        // Private mode — the toggle just won't persist.
    }
}

export function playPadClick() {
    try {
        const Ctor = window.AudioContext || window.webkitAudioContext;
        if (!Ctor) return;
        if (!context) context = new Ctor();
        if (context.state === 'suspended') context.resume().catch(() => {});

        const now = context.currentTime;
        const osc = context.createOscillator();
        const gain = context.createGain();

        // A 12ms downward chirp reads as a mechanical key click rather than a beep.
        osc.type = 'square';
        osc.frequency.setValueAtTime(1000, now);
        osc.frequency.exponentialRampToValueAtTime(400, now + 0.012);
        gain.gain.setValueAtTime(0.08, now);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.012);

        osc.connect(gain).connect(context.destination);
        osc.start(now);
        osc.stop(now + 0.02);
    } catch {
        // Audio is a nicety; never let it break a button press.
    }
}
