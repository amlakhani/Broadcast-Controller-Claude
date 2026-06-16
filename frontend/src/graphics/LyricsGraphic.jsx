import { useState, useEffect, useRef } from 'react';
import gsap from 'gsap';
import { useGSAP } from '@gsap/react';
import { applyAnimationIn, applyAnimationOut } from './AnimationUtils';

export default function LyricsGraphic({ socket, windowMode }) {
    const [data, setData] = useState(null);
    const [style, setStyle] = useState({});
    
    const containerRef = useRef(null);
    const panelRef = useRef(null);
    const textContainerRef = useRef(null);
    const gujRef = useRef(null);
    const engRef = useRef(null);

    const isShowingRef = useRef(false);
    const currentAnimationRef = useRef('fade');

    const LYRICS_BG_CLASSES = [
        'lyrics-bg-midnight', 'lyrics-bg-charcoal', 'lyrics-bg-deep-purple', 
        'lyrics-bg-ocean', 'lyrics-bg-burgundy', 'lyrics-bg-forest', 
        'lyrics-bg-warm-gold', 'lyrics-bg-frosted', 'lyrics-bg-gradient-sunset', 
        'lyrics-bg-gradient-aurora', 'lyrics-bg-cinematic-gradient'
    ];

    const getBgClass = (bgStyle) => {
        if (!bgStyle || bgStyle === 'default') return '';
        if (LYRICS_BG_CLASSES.includes(`lyrics-bg-${bgStyle}`)) return `lyrics-bg-${bgStyle}`;
        return '';
    };

    const isCinematic = data?.bgStyle === 'cinematic-gradient';

    const { contextSafe } = useGSAP({ scope: containerRef });

    const animateIn = contextSafe((newData) => {
        if (windowMode === 'stage') return;

        // Check if we are staying in cinematic mode for a smooth verse transition
        const staysCinematic = isShowingRef.current && 
                             data?.bgStyle === 'cinematic-gradient' && 
                             newData.bgStyle === 'cinematic-gradient';

        const startAnimationList = () => {
            const prevAnim = currentAnimationRef.current;
            currentAnimationRef.current = newData.animation || 'fade';
            setData(newData);
            if (newData.style) setStyle(newData.style);

            if (!newData.gujText && !newData.engText) return;

            isShowingRef.current = true;
            gsap.set(containerRef.current, { opacity: 1 }); // Ensure parent is visible
            
            if (currentAnimationRef.current === 'none') {
                if (staysCinematic) {
                    applyAnimationIn(null, textContainerRef.current, 'none', false, {});
                } else {
                    applyAnimationIn(null, panelRef.current, 'none', false, {});
                }
            } else {
                const tl = gsap.timeline();
                if (staysCinematic) {
                    // Keep panel visible, only animate text in
                    applyAnimationIn(tl, textContainerRef.current, currentAnimationRef.current, false, {});
                } else {
                    // Normal full panel animation in
                    applyAnimationIn(tl, panelRef.current, currentAnimationRef.current, false, {});
                }
            }
        };

        if (isShowingRef.current) {
            if (currentAnimationRef.current === 'none') {
                startAnimationList();
            } else {
                // Animate out cleanly
                const tempTl = gsap.timeline({ onComplete: startAnimationList });
                if (staysCinematic) {
                    // Keep panel visible, only animate text out
                    applyAnimationOut(tempTl, textContainerRef.current, currentAnimationRef.current, false, {});
                } else {
                    // Full panel animation out
                    applyAnimationOut(tempTl, panelRef.current, currentAnimationRef.current, false, {});
                }
            }
        } else {
            startAnimationList();
        }
    });

    const animateOut = contextSafe(() => {
        // Force animate out regardless of internal state to ensure clear works
        gsap.killTweensOf([panelRef.current, containerRef.current, textContainerRef.current]);
        
        const finishOut = () => {
            isShowingRef.current = false; 
            gsap.set(containerRef.current, { opacity: 0 }); 
        };

        if (currentAnimationRef.current === 'none') {
            finishOut();
        } else {
            const tl = gsap.timeline({ onComplete: finishOut });
            applyAnimationOut(tl, panelRef.current, currentAnimationRef.current, false, {});
        }
    });

    useEffect(() => {
        if (!socket) return;

        const handlePlayLyrics = (d) => {
            animateIn(d);
        };
        const handleStopGraphic = () => {
            animateOut();
        };
        const handleLyricsStyleUpdate = (s) => {
            if (isShowingRef.current) {
                setStyle(s);
            }
        };
        const handleLyricsLayoutUpdate = (layout) => {
            if (isShowingRef.current) {
                setData(prev => ({ ...prev, ...layout }));
            }
        };
        
        socket.on('play_lyrics', handlePlayLyrics);
        socket.on('stop_graphic', handleStopGraphic);
        socket.on('stop_lyrics', handleStopGraphic);
        socket.on('update_lyrics_style', handleLyricsStyleUpdate);
        socket.on('update_lyrics_layout', handleLyricsLayoutUpdate);

        return () => {
            socket.off('play_lyrics', handlePlayLyrics);
            socket.off('stop_graphic', handleStopGraphic);
            socket.off('stop_lyrics', handleStopGraphic);
            socket.off('update_lyrics_style', handleLyricsStyleUpdate);
            socket.off('update_lyrics_layout', handleLyricsLayoutUpdate);
        };
    }, [socket, animateIn, animateOut]);

    const getLangVisibility = (lang) => {
        const langOpt = data?.langOpt || 'both';
        if (lang === 'eng') return langOpt === 'eng' || langOpt === 'both';
        if (lang === 'guj') return langOpt === 'guj' || langOpt === 'both';
        return true;
    };

    const getEngFontSize = () => {
        if (getLangVisibility('guj') && getLangVisibility('eng') && style.fontSize) {
            return `${style.fontSize * 0.75}px`;
        }
        return style.fontSize ? `${style.fontSize}px` : undefined;
    };

    const getContainerStyle = () => {
        if (windowMode === 'stage') return {};
        if (isCinematic) {
            return { bottom: '0', left: '50%', transform: 'translateX(-50%)' };
        }
        return {
            left: `${data?.posX ?? 50}%`,
            top: `${data?.posY ?? 88}%`,
            transform: 'translate(-50%, -50%)',
            bottom: 'auto'
        };
    };

    return (
        <div 
            ref={containerRef} 
            id="lyrics-overlay" 
            className={`absolute opacity-0 w-full flex justify-center z-[6500] ${windowMode === 'stage' ? 'hidden' : ''}`}
            style={getContainerStyle()}
        >
            <div 
                ref={panelRef} 
                className={`lyrics-glass-panel px-16 py-8 relative z-10 ${getBgClass(data?.bgStyle)}`}
            >
                {/* Cinematic Gradient Overlay - Exact Reference Implementation */}
                {isCinematic && (() => {
                    const grad = data?.cinematicGrad || {};
                    if (grad.enabled === false) return null;
                    
                    const f = (grad.bgIntensity === undefined ? 95 : parseFloat(grad.bgIntensity)) / 100;
                    const p = parseFloat(grad.bgHeight ?? 100);
                    const m = parseFloat(grad.bgSoftness ?? 75);
                    
                    return (
                        <div 
                            className="absolute inset-0 z-0 transition-all duration-700 ease-out"
                            style={{
                                background: `linear-gradient(to top, rgba(0, 0, 0, ${Math.pow(f, 0.8)}) 0%, rgba(0, 0, 0, ${Math.pow(f, 0.8) * 0.75}) ${Math.max(0, 100 - m)}%, transparent 100%)`,
                                height: `${p}%`,
                                top: 'auto',
                                bottom: 0
                            }}
                        />
                    );
                })()}

                <div ref={textContainerRef} className="w-full relative z-10">
                    <div 
                        ref={gujRef}
                        className={`text-6xl text-white font-guj font-semibold leading-[1.05] drop-shadow-lg ${getLangVisibility('guj') && data?.gujText ? '' : 'hidden'}`}
                        style={{
                            fontFamily: "'Rasa', serif",
                            fontSize: style.fontSize ? `${style.fontSize}px` : undefined,
                            fontWeight: style.fontWeight,
                            color: style.color,
                            letterSpacing: style.letterSpacing !== undefined ? `${style.letterSpacing}px` : undefined,
                            fontStyle: style.italic ? 'italic' : 'normal',
                            textDecoration: style.underline ? 'underline' : 'none',
                            whiteSpace: 'pre-line'
                        }}
                    >{data?.gujText || ''}</div>
                    
                    <div 
                        ref={engRef}
                        className={`text-5xl text-slate-300 font-eng font-medium leading-[1.05] drop-shadow-md mt-2 ${getLangVisibility('eng') && data?.engText ? '' : 'hidden'}`}
                        style={{
                            fontFamily: style.fontFamily,
                            fontSize: getEngFontSize(),
                            fontWeight: style.fontWeight,
                            color: style.color,
                            letterSpacing: style.letterSpacing !== undefined ? `${style.letterSpacing}px` : undefined,
                            fontStyle: style.italic ? 'italic' : 'normal',
                            textDecoration: style.underline ? 'underline' : 'none',
                            whiteSpace: 'pre-line'
                        }}
                    >{data?.engText || ''}</div>
                </div>
            </div>
        </div>
    );
}
