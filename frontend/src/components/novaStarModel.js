// Pure logic for the NovaStar panel — no DOM, unit-testable under
// `node --test`, same split NovaStarPanel.jsx keeps from its stateful glue
// as videohubModel.js does for VideohubPanel.jsx.

export function clampBrightness(value) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return 0;
    return Math.min(100, Math.max(0, n));
}

export function screenLabelFor(screens, screenId) {
    const match = (screens || []).find(s => s.screenId === screenId);
    if (match) return match.name;
    return screenId != null ? `Screen ${screenId}` : 'No screen selected';
}

export const DEFAULT_TEXT_OSD_FIELDS = {
    enable: true,
    chars: '',
    x: 0,
    y: 0,
    width: 1920,
    height: 200,
    fontPercent: 80,
    fontColor: { A: 100, R: 255, G: 255, B: 255 },
    backgroundEnable: false,
    backgroundColor: { A: 0, R: 0, G: 0, B: 0 },
};

// #RRGGBB <-> the OpenAPI's {A,R,G,B} (0-100 alpha, 0-255 channels) shape,
// since a plain <input type="color"> only speaks hex.
export function hexToArgb(hex, alpha = 100) {
    const clean = (hex || '#ffffff').replace('#', '');
    const r = parseInt(clean.slice(0, 2), 16) || 0;
    const g = parseInt(clean.slice(2, 4), 16) || 0;
    const b = parseInt(clean.slice(4, 6), 16) || 0;
    return { A: alpha, R: r, G: g, B: b };
}

export function argbToHex({ R = 255, G = 255, B = 255 } = {}) {
    const toHex = (n) => Math.max(0, Math.min(255, Number(n) || 0)).toString(16).padStart(2, '0');
    return `#${toHex(R)}${toHex(G)}${toHex(B)}`;
}

// Hard guard so an operator can't fire an oversized JSON POST at the
// processor — the OpenAPI inlines the whole image as base64 in the body.
export const MAX_IMAGE_OSD_BASE64_LENGTH = 3_000_000; // ~2.2MB binary
