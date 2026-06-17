// Program/graphics output stacking order, bottom (low) → top (high).
// Single source of truth for layer z-index — change ordering HERE; the graphics
// components import these instead of hard-coding z-index. Gaps left for future inserts.
export const LAYER_Z = {
    media: 100,        // background: video / photo / youtube / webpage / canva
    slides: 200,       // google slides / canva slides (foreground content)
    particles: 300,    // ambient dust — above background, behind all text
    mediaMessage: 400, // text burned onto media (tied to media)
    lyrics: 500,
    lowerThirds: 600,
    translation: 700,  // topmost text
    countdown: 800,    // pre-show takeover — top of program layers
};
