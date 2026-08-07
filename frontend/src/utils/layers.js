// Shared graphics-layer constants. DEFAULT_LAYER_VISIBILITY was declared identically in both
// App.jsx and GraphicsApp.jsx, so adding a layer meant remembering to add it in two files or
// the control window and the output window would disagree about what exists.

export const DEFAULT_LAYER_VISIBILITY = {
    presentation: true,
    media: true,
    lowerThirds: true,
    lyrics: true,
    translation: true,
    sabhaTimer: true,
    particles: true,
    mediaMessage: true,
};
