// Maps the pad model's icon *names* to lucide components.
//
// Deliberately separate from padModel.js: that module is imported by
// tests/pad-model.test.js under `node --test` and must stay dependency-free.
// Keeping the lucide import here is what lets the model be unit-tested at all.
//
// Note the lucide v1 rename — the old `AlertTriangle` is now `TriangleAlert`.

import {
    ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight,
    Clock, Eye, EyeOff, FastForward, Film, Flame, Grid3x3, Image,
    Languages, Layers, ListChecks, MessageSquare, Monitor, MonitorOff,
    Pause, Play, Power, Repeat, Rewind, RotateCcw, SkipForward, Sparkles,
    Square, Timer, TriangleAlert, Type, Volume2, VolumeX, Zap
} from 'lucide-react';

export const PAD_ICON_COMPONENTS = {
    none: null,
    chevronLeft: ChevronLeft,
    chevronRight: ChevronRight,
    chevronsLeft: ChevronsLeft,
    chevronsRight: ChevronsRight,
    play: Play,
    pause: Pause,
    square: Square,
    skipForward: SkipForward,
    rewind: Rewind,
    fastForward: FastForward,
    monitor: Monitor,
    monitorOff: MonitorOff,
    eye: Eye,
    eyeOff: EyeOff,
    volume: Volume2,
    volumeOff: VolumeX,
    repeat: Repeat,
    zap: Zap,
    flame: Flame,
    timer: Timer,
    clock: Clock,
    message: MessageSquare,
    type: Type,
    image: Image,
    film: Film,
    layers: Layers,
    sparkles: Sparkles,
    languages: Languages,
    listChecks: ListChecks,
    alertTriangle: TriangleAlert,
    rotateCcw: RotateCcw,
    power: Power,
    grid: Grid3x3
};

export function getPadIcon(name) {
    return PAD_ICON_COMPONENTS[name] || null;
}
