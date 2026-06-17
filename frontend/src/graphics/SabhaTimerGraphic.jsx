import { useState, useEffect, useRef } from 'react';
import gsap from 'gsap';
import { LAYER_Z } from './layerZ';

const clampPercent = (value, fallback) => {
    const parsed = parseFloat(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(100, Math.max(0, parsed));
};

const getSabhaGradientStyle = (gradient = {}) => {
    const intensity = clampPercent(gradient.bgIntensity, 95) / 100;
    const height = clampPercent(gradient.bgHeight, 100);
    const softness = clampPercent(gradient.bgSoftness, 75) / 100;

    if (intensity <= 0 || height <= 0) return null;

    const maxAlpha = Math.pow(intensity, 0.86) * 0.96;
    const reachStop = 18 + height * 0.82;
    const holdStop = Math.max(2, reachStop * (0.12 - softness * 0.06));
    const midStop = reachStop * (0.36 + softness * 0.1);
    const featherStop = reachStop * (0.68 + softness * 0.18);

    return {
        background: `linear-gradient(to top, rgba(0, 0, 0, ${maxAlpha}) 0%, rgba(0, 0, 0, ${maxAlpha * 0.86}) ${holdStop}%, rgba(0, 0, 0, ${maxAlpha * 0.52}) ${midStop}%, rgba(0, 0, 0, ${maxAlpha * 0.16}) ${featherStop}%, transparent ${reachStop}%, transparent 100%)`,
        height: '100%',
        top: 'auto',
        bottom: 0
    };
};

export default function SabhaTimerGraphic({ socket, windowMode }) {
    const [sabhaData, setSabhaData] = useState(null); // { showing, timeStr, message, style }
    const [timerDisplay, setTimerDisplay] = useState('00:00:00');
    
    const intervalRef = useRef(null);
    const containerRef = useRef(null);

    const updateTimer = (timeStr) => {
        if (!timeStr) return;
        const now = new Date();
        let target = new Date();
        const [h, m] = timeStr.split(':').map(Number);
        target.setHours(h, m, 0, 0);

        // If target passed, count to tomorrow
        if (target <= now) {
            target.setDate(target.getDate() + 1);
        }

        const diffMs = target - now;
        const totalSeconds = Math.floor(diffMs / 1000);
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;

        setTimerDisplay(
            `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
        );
    };

    useEffect(() => {
        if (!socket || windowMode === 'stage') return;

        const handleState = (data) => {
            console.log('Received Sabha State:', data);
            if (data.showing) {
                setSabhaData(data);
                updateTimer(data.timeStr);
                
                if (intervalRef.current) clearInterval(intervalRef.current);
                intervalRef.current = setInterval(() => {
                    updateTimer(data.timeStr);
                }, 1000);
            } else {
                setSabhaData(null);
                if (intervalRef.current) clearInterval(intervalRef.current);
                intervalRef.current = null;
            }
        };

        const handleStop = () => {
            setSabhaData(null);
            if (intervalRef.current) clearInterval(intervalRef.current);
            intervalRef.current = null;
        };

        socket.on('sabha_timer_state', handleState);
        socket.on('stop_graphic', handleStop);

        return () => {
            socket.off('sabha_timer_state', handleState);
            socket.off('stop_graphic', handleStop);
            if (intervalRef.current) clearInterval(intervalRef.current);
        };
    }, [socket, windowMode]);

    // Handle Opacity Animation separately
    useEffect(() => {
        if (sabhaData?.showing) {
            gsap.to(containerRef.current, { duration: 1, opacity: 1, ease: "power2.out" });
        } else {
            gsap.to(containerRef.current, { duration: 0.8, opacity: 0, ease: "power2.in" });
        }
    }, [sabhaData?.showing]);

    if (windowMode === 'stage') return null;

    // Use derived styles
    const msgStyle = sabhaData?.style?.msg || {};
    const timerStyle = sabhaData?.style?.timer || {};
    
    const grad = sabhaData?.style?.gradient || {};
    const gradientStyle = getSabhaGradientStyle(grad);

    return (
        <div 
            id="sabha-overlay" 
            ref={containerRef}
            className={`absolute inset-0 pointer-events-none flex flex-col justify-end opacity-0 ${!sabhaData?.showing ? 'hidden' : ''}`}
            style={{
                zIndex: LAYER_Z.countdown,
                display: !sabhaData?.showing ? 'none' : 'flex'
            }}
        >
            <div 
                id="sabha-panel" 
                className="w-full relative flex flex-col items-center justify-center"
                style={{
                    paddingBottom: '8vh',
                    paddingTop: '10vh'
                }}
            >
                {/* Dynamic Background Layer */}
                {grad.enabled !== false && gradientStyle && (
                    <div 
                        className="absolute inset-0 z-0 transition-all duration-700 ease-out"
                        style={gradientStyle}
                    />
                )}

                <div className="relative z-10 flex flex-col items-center">
                    <div 
                        id="sabha-message-text" 
                        className="text-white uppercase"
                        style={{
                            fontFamily: msgStyle.fontFamily || "'Outfit', sans-serif",
                            fontWeight: msgStyle.fontWeight || '700',
                            fontSize: `${msgStyle.fontSize || 36}px`,
                            letterSpacing: `${msgStyle.letterSpacing || 5}px`,
                            color: msgStyle.color || '#ffffff',
                            marginBottom: '1rem',
                            opacity: 1
                        }}
                    >
                        {sabhaData?.message || 'Sabha Starts In'}
                    </div>
                    
                    <div 
                        id="sabha-timer-text" 
                        className="text-white" 
                        style={{
                            fontSize: `${timerStyle.fontSize || 130}px`,
                            lineHeight: 1,
                            textShadow: '0 10px 30px rgba(0,0,0,0.9)',
                            fontVariantNumeric: 'tabular-nums',
                            fontFamily: timerStyle.fontFamily || "'Outfit', sans-serif",
                            fontWeight: timerStyle.fontWeight || '700',
                            letterSpacing: `${timerStyle.letterSpacing || 0}px`,
                            color: timerStyle.color || '#ffffff',
                            opacity: 1
                        }}
                    >
                        {timerDisplay}
                    </div>
                </div>
            </div>
        </div>
    );
}
