import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { PAD_COLORS, DEFAULT_PAD_COLOR } from './padModel';
import { getPadIcon } from './padIcons';

// One pad key. Shared by the tablet (/pad) and the desktop layout editor, so the
// editor always shows exactly what the operator will see.
//
// Pointer Events rather than touch events: one code path covers iPad, a trackpad,
// and the editor preview. iOS Safari has no navigator.vibrate, so the tactility
// has to come from size, the press scale, and the hold fill.

export const HOLD_MS = 600;

function PadButton({
    button,
    disabled = false,
    active = false,
    pending = false,
    onFire,
    onSelect,
    selected = false,
    editing = false
}) {
    const [progress, setProgress] = useState(0);
    const frame = useRef(0);
    const timer = useRef(0);
    const startedAt = useRef(0);

    const cancel = useCallback(() => {
        if (frame.current) cancelAnimationFrame(frame.current);
        if (timer.current) clearTimeout(timer.current);
        frame.current = 0;
        timer.current = 0;
        setProgress(0);
    }, []);

    // Release the timer and animation frame if the grid re-renders us away mid-hold.
    useEffect(() => cancel, [cancel]);

    // The fill is animation only. Whether the hold completed is decided by the
    // timeout below, never by this: requestAnimationFrame stops entirely when the
    // page is not compositing, and a safety guard that silently stops arming
    // because the compositor stalled is worse than no guard at all.
    const step = useCallback(() => {
        const ratio = Math.min(1, (performance.now() - startedAt.current) / HOLD_MS);
        setProgress(ratio);
        if (ratio < 1) frame.current = requestAnimationFrame(step);
        else frame.current = 0;
    }, []);

    const handlePointerDown = (event) => {
        if (editing) return;
        if (disabled) return;
        // Capture keeps events flowing to this button if the finger drifts off it.
        event.currentTarget.setPointerCapture?.(event.pointerId);
        if (!button.hold) return;
        startedAt.current = performance.now();
        frame.current = requestAnimationFrame(step);
        timer.current = setTimeout(() => {
            cancel();
            onFire?.();
        }, HOLD_MS);
    };

    const handlePointerUp = (event) => {
        event.currentTarget.releasePointerCapture?.(event.pointerId);
        if (editing) return;
        if (button.hold) {
            // Released early: the fill never completed, so nothing fires.
            cancel();
            return;
        }
        if (!disabled) onFire?.();
    };

    const palette = PAD_COLORS[button.color] || PAD_COLORS[DEFAULT_PAD_COLOR];
    const Icon = getPadIcon(button.icon);

    return (
        <button
            type="button"
            disabled={disabled && !editing}
            onClick={editing ? onSelect : undefined}
            onPointerDown={handlePointerDown}
            onPointerUp={handlePointerUp}
            onPointerCancel={cancel}
            onPointerLeave={cancel}
            // A 600ms press otherwise pops the iOS callout menu mid-hold.
            onContextMenu={(event) => event.preventDefault()}
            style={{
                touchAction: 'none',
                WebkitTouchCallout: 'none',
                WebkitUserSelect: 'none',
                userSelect: 'none'
            }}
            className={`relative flex select-none flex-col items-center justify-center gap-1 overflow-hidden rounded-2xl
                px-2 py-2 text-center transition active:scale-[0.97]
                disabled:cursor-not-allowed disabled:opacity-30 disabled:active:scale-100
                ${button.wide ? 'col-span-2' : ''}
                ${palette.face} ${palette.press} ${palette.text}
                ${active ? `ring-4 ${palette.ring}` : ''}
                ${selected ? 'ring-4 ring-blue-400' : ''}
                ${pending ? 'animate-pulse' : ''}`}
        >
            {button.hold && progress > 0 && (
                <span
                    className="pointer-events-none absolute inset-y-0 left-0 bg-white/30"
                    style={{ width: `${progress * 100}%` }}
                />
            )}

            <span className="relative flex flex-col items-center gap-1">
                {Icon && <Icon className="h-6 w-6" />}
                <span className="text-xs font-bold leading-tight">{button.label}</span>
                {button.sub && <span className="text-[10px] font-semibold opacity-75">{button.sub}</span>}
            </span>

            {button.hold && (
                <span className="absolute right-1.5 top-1.5 text-[8px] font-black uppercase tracking-wider opacity-60">
                    Hold
                </span>
            )}
        </button>
    );
}

// The grid re-renders on every operator_state_update; without this a playhead tick
// would repaint every key.
export default memo(PadButton);
