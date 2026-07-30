import { useEffect, useMemo, useState } from 'react';
import { LAYER_Z } from './layerZ';

const DEFAULT_OVERLAY = {
    enabled: false,
    text: '',
    position: 'center',
    size: 72,
    color: '#ffffff',
    weight: '800',
    uppercase: false,
    backdrop: true
};

const positionClass = {
    top: 'items-start pt-20',
    center: 'items-center',
    bottom: 'items-end pb-20',
    lowerThird: 'items-end pb-32'
};

export default function MediaMessageOverlayGraphic({ socket, windowMode }) {
    const [overlay, setOverlay] = useState(DEFAULT_OVERLAY);

    useEffect(() => {
        if (!socket || windowMode === 'stage') return undefined;
        const handleUpdate = (data = {}) => {
            setOverlay(prev => ({ ...prev, ...data }));
        };

        socket.on('media_message_overlay_update', handleUpdate);
        socket.emit('request_media_state');

        return () => {
            socket.off('media_message_overlay_update', handleUpdate);
        };
    }, [socket, windowMode]);

    const displayText = overlay.uppercase ? overlay.text.toUpperCase() : overlay.text;
    const fontSize = Math.max(24, Math.min(180, Number(overlay.size) || DEFAULT_OVERLAY.size));
    const contentStyle = useMemo(() => ({
        color: overlay.color || DEFAULT_OVERLAY.color,
        fontSize: `${fontSize}px`,
        fontWeight: overlay.weight || DEFAULT_OVERLAY.weight,
        fontVariantNumeric: 'tabular-nums',
        textShadow: '0 4px 22px rgba(0,0,0,0.82), 0 0 60px rgba(0,0,0,0.45)'
    }), [fontSize, overlay.color, overlay.weight]);

    if (windowMode === 'stage' || !overlay.enabled || !overlay.text?.trim()) return null;

    return (
        <div className={`absolute inset-0 flex justify-center px-16 pointer-events-none ${positionClass[overlay.position] || positionClass.center}`} style={{ zIndex: LAYER_Z.mediaMessage }}>
            <div className={`${overlay.backdrop ? 'rounded-2xl border border-white/15 bg-black/45 px-12 py-7 shadow-2xl backdrop-blur-sm' : ''} max-w-[88%]`}>
                <div className="whitespace-pre-wrap break-words text-center leading-tight tracking-normal" style={contentStyle}>
                    {displayText}
                </div>
            </div>
        </div>
    );
}
