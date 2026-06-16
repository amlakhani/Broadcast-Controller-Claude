import { useState, useEffect, useRef } from 'react';
import gsap from 'gsap';
import { useGSAP } from '@gsap/react';
import { applyAnimationIn, applyAnimationOut } from './AnimationUtils';

// Helper to prune finalized sentences so the total text stays within 2 lines,
// while guaranteeing each finalized sentence stays visible for a minimum duration.
const pruneSentences = (sentences, currentInterim, fontSize) => {
    const fSize = fontSize ? parseFloat(fontSize) : 48;
    const charWidth = fSize * 0.45; // average character width factor
    // Assuming container width of 1400px, max 2 lines
    const maxCharacters = Math.floor((1400 / charWidth) * 2);
    
    let result = [...sentences];
    const minDisplayTimeMs = 3500; // Guarantee 3.5 seconds readability time for each sentence
    const now = Date.now();

    while (result.length > 0) {
        const textArray = result.map(s => s.text);
        const combinedText = textArray.join(' ') + ' ' + currentInterim;
        
        if (combinedText.length > maxCharacters) {
            // Only prune the oldest sentence if it has been on screen for at least minDisplayTimeMs
            const oldest = result[0];
            if (now - oldest.timestamp >= minDisplayTimeMs) {
                result.shift(); // remove oldest
            } else {
                break; // Keep it on screen because it is too new to prune
            }
        } else {
            break;
        }
    }
    return result;
};

export default function TranslationGraphic({ socket, windowMode }) {
    const [finalizedSentences, setFinalizedSentences] = useState([]);
    const [interimText, setInterimText] = useState('');
    const [style, setStyle] = useState({});
    const [autoClear, setAutoClear] = useState(0);

    const containerRef = useRef(null);
    const panelRef = useRef(null);
    const textRef = useRef(null);

    const isShowingRef = useRef(false);
    const clearTimerRef = useRef(null);

    const { contextSafe } = useGSAP({ scope: containerRef });

    const triggerAnimateOut = contextSafe(() => {
        if (clearTimerRef.current) {
            clearTimeout(clearTimerRef.current);
            clearTimerRef.current = null;
        }
        if (!isShowingRef.current) return;

        gsap.killTweensOf(containerRef.current);
        
        const finishOut = () => {
            isShowingRef.current = false; 
            gsap.set(containerRef.current, { opacity: 0 }); 
            setFinalizedSentences([]);
            setInterimText('');
        };

        // Simple fade out
        gsap.to(containerRef.current, {
            opacity: 0,
            duration: 0.3,
            ease: 'power2.out',
            onComplete: finishOut
        });
    });

    useEffect(() => {
        if (!socket) return;
        
        const handleTranslationUpdate = (d) => {
            if (windowMode === 'stage') return;

            // Reset/Clear existing auto-clear timer
            if (clearTimerRef.current) {
                clearTimeout(clearTimerRef.current);
                clearTimerRef.current = null;
            }

            if (d.style) setStyle(d.style);
            
            const currentAutoClear = d.layout?.autoClear || autoClear || 0;
            setAutoClear(currentAutoClear);

            // Update texts and apply pruning
            const fontSize = d.style?.fontSize || style.fontSize || 48;
            if (d.isFinal) {
                setInterimText('');
                setFinalizedSentences(prev => {
                    const next = [...prev, { text: d.text, timestamp: Date.now() }];
                    return pruneSentences(next, '', fontSize);
                });
            } else {
                setInterimText(d.text);
                setFinalizedSentences(prev => {
                    return pruneSentences(prev, d.text, fontSize);
                });
            }

            // If not currently showing, trigger GSAP fade-in
            if (!isShowingRef.current) {
                isShowingRef.current = true;
                gsap.killTweensOf(containerRef.current);
                
                // Simple fade in
                gsap.fromTo(containerRef.current, 
                    { opacity: 0 },
                    { 
                        opacity: 1, 
                        duration: 0.35, 
                        ease: 'power2.out' 
                    }
                );
            }

            // Setup new auto-clear timer if autoClear is positive
            if (currentAutoClear > 0) {
                clearTimerRef.current = setTimeout(() => {
                    triggerAnimateOut();
                }, currentAutoClear * 1000);
            }
        };

        const handleHideTranslation = () => {
            triggerAnimateOut();
        };

        const handleStyleUpdate = (s) => {
            setStyle(s);
        };

        const handleLayoutUpdate = (layout) => {
            if (layout.autoClear !== undefined) {
                setAutoClear(layout.autoClear);
            }
        };

        socket.on('translation_update', handleTranslationUpdate);
        socket.on('hide_translation', handleHideTranslation);
        socket.on('update_translation_style', handleStyleUpdate);
        socket.on('update_translation_layout', handleLayoutUpdate);

        return () => {
            socket.off('translation_update', handleTranslationUpdate);
            socket.off('hide_translation', handleHideTranslation);
            socket.off('update_translation_style', handleStyleUpdate);
            socket.off('update_translation_layout', handleLayoutUpdate);
            if (clearTimerRef.current) {
                clearTimeout(clearTimerRef.current);
            }
        };
    }, [socket, windowMode, style, autoClear, triggerAnimateOut]);

    const getContainerStyle = () => {
        if (windowMode === 'stage') return {};
        return {
            bottom: '12%',
            left: '50%',
            transform: 'translateX(-50%)',
            top: 'auto'
        };
    };

    return (
        <div 
            ref={containerRef} 
            id="translation-overlay" 
            className={`absolute opacity-0 w-full flex justify-center z-[6400] ${windowMode === 'stage' ? 'hidden' : ''}`}
            style={getContainerStyle()}
        >
            <div 
                ref={panelRef} 
                className="px-6 py-2 text-center select-none"
                style={{
                    background: 'rgba(15, 15, 15, 0.88)',
                    borderRadius: '0px',
                    maxWidth: '85vw',
                    display: 'inline-block'
                }}
            >
                <div ref={textRef} className="w-full text-center">
                    <p 
                        className="text-5xl text-white font-eng leading-[1.25] transition-all duration-300"
                        style={{
                            fontFamily: style.fontFamily || "'Outfit', sans-serif",
                            fontSize: style.fontSize ? `${style.fontSize}px` : undefined,
                            color: style.color || '#ffffff',
                            letterSpacing: style.letterSpacing !== undefined ? `${style.letterSpacing}px` : undefined,
                            textDecoration: style.underline ? 'underline' : 'none'
                        }}
                    >
                        {finalizedSentences.map((s, idx) => (
                            <span 
                                key={idx} 
                                className="mr-3 opacity-100" 
                                style={{ 
                                    fontStyle: 'normal',
                                    fontWeight: style.fontWeight || '400'
                                }}
                            >
                                {s.text}
                            </span>
                        ))}
                        {interimText && (
                            <span 
                                className="opacity-75" 
                                style={{ 
                                    fontStyle: 'italic',
                                    fontWeight: style.fontWeight || '400'
                                }}
                            >
                                {interimText}
                            </span>
                        )}
                    </p>
                </div>
            </div>
        </div>
    );
}
