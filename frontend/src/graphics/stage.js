import { createContext, useContext } from 'react';

// The program frame is authored at a fixed 1920x1080 and scaled to whatever the output
// window happens to be (see StageCanvas.jsx). Every graphic lays out in these coordinates,
// so a lower third at posX 10 / posY 15 lands on the same pixel of the frame on a 1366x768
// projector, a 4K screen, the NDI feed and the control-room Live Preview.
//
// Before the stage existed, graphics mixed `vw`/`vh` (which tracked the output window) with
// `rem`/`px` (which did not), so those four surfaces all composed slightly differently.
export const STAGE_WIDTH = 1920;
export const STAGE_HEIGHT = 1080;

export const StageContext = createContext({
    width: STAGE_WIDTH,
    height: STAGE_HEIGHT,
    scale: 1
});

// Stage dimensions for graphics that measure in pixels (particle canvas backing store,
// lyric auto-fit). Always reports the design frame, never the output window.
export const useStage = () => useContext(StageContext);

// Fit, never fill: cropping a lower third off the frame edge is never the right answer, so a
// non-16:9 output letterboxes/pillarboxes into the key colour instead. This is the default —
// see fillScaleFor below for the opt-in alternative.
export const fitScaleFor = (containerWidth, containerHeight) => {
    if (!containerWidth || !containerHeight) return 1;
    return Math.min(containerWidth / STAGE_WIDTH, containerHeight / STAGE_HEIGHT);
};

// Fill instead: for a direct-to-monitor/projector setup with no downstream keyer, where
// chroma-key letterbox bars would just be unwanted colour on screen rather than something a
// switcher keys out. Crops whichever axis overflows — StageCanvas's container already clips
// via overflow:hidden, so no separate crop logic is needed here.
export const fillScaleFor = (containerWidth, containerHeight) => {
    if (!containerWidth || !containerHeight) return 1;
    return Math.max(containerWidth / STAGE_WIDTH, containerHeight / STAGE_HEIGHT);
};
