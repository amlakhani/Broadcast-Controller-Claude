import { useState, useEffect, useRef, useCallback } from 'react';
import gsap from 'gsap';
import { useGSAP } from '@gsap/react';
import { applyAnimationIn, applyAnimationOut } from './AnimationUtils';
import { LAYER_Z } from './layerZ';

const DEFAULT_DESIGN = {
    shapeStyle: 'glass-card',
    accentColor: '#3b82f6',
    panelOpacity: 88,
    shadowIntensity: 75,
    borderWidth: 1,
    borderColor: '#ffffff',
    panelWidth: 650,
    posX: 10,
    posY: 15,
    logoPlacement: 'left',
    logoSize: 160,
    textAlign: 'left'
};

const hexToRgb = (hex = '#3b82f6') => {
    const normalized = hex.replace('#', '');
    const value = normalized.length === 3
        ? normalized.split('').map(ch => ch + ch).join('')
        : normalized.padEnd(6, '0').slice(0, 6);
    const int = parseInt(value, 16);
    return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255 };
};

const rgba = (hex, alpha) => {
    const { r, g, b } = hexToRgb(hex);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

const getThemeBackground = (bgStyle, alpha) => {
    const themes = {
        midnight: `linear-gradient(145deg, rgba(10, 15, 60, ${alpha}), rgba(20, 30, 80, ${Math.max(alpha - 0.05, 0)}))`,
        charcoal: `rgba(38, 38, 38, ${alpha})`,
        'deep-purple': `linear-gradient(145deg, rgba(40, 10, 70, ${alpha}), rgba(60, 20, 90, ${Math.max(alpha - 0.05, 0)}))`,
        ocean: `linear-gradient(145deg, rgba(5, 40, 50, ${alpha}), rgba(10, 60, 70, ${Math.max(alpha - 0.05, 0)}))`,
        burgundy: `linear-gradient(145deg, rgba(60, 10, 15, ${alpha}), rgba(80, 15, 25, ${Math.max(alpha - 0.05, 0)}))`,
        forest: `linear-gradient(145deg, rgba(8, 40, 20, ${alpha}), rgba(15, 55, 30, ${Math.max(alpha - 0.05, 0)}))`,
        'warm-gold': `linear-gradient(145deg, rgba(50, 35, 10, ${alpha}), rgba(65, 45, 15, ${Math.max(alpha - 0.05, 0)}))`,
        frosted: `rgba(255, 255, 255, ${Math.max(alpha * 0.18, 0.08)})`,
        'gradient-sunset': `linear-gradient(135deg, rgba(120, 30, 50, ${alpha}), rgba(180, 60, 20, ${Math.max(alpha - 0.03, 0)}), rgba(200, 120, 30, ${Math.max(alpha - 0.08, 0)}))`,
        'gradient-aurora': `linear-gradient(135deg, rgba(10, 30, 60, ${alpha}), rgba(20, 80, 100, ${Math.max(alpha - 0.03, 0)}), rgba(40, 120, 80, ${Math.max(alpha - 0.08, 0)}), rgba(80, 60, 130, ${Math.max(alpha - 0.03, 0)}))`,
        // Inverted panels — pair these with dark text colours.
        light: `linear-gradient(145deg, rgba(248, 250, 252, ${alpha}), rgba(226, 232, 240, ${Math.max(alpha - 0.04, 0)}))`,
        'light-warm': `linear-gradient(145deg, rgba(255, 251, 240, ${alpha}), rgba(253, 240, 214, ${Math.max(alpha - 0.04, 0)}))`,
        default: `linear-gradient(135deg, rgba(15, 23, 42, ${alpha}), rgba(30, 41, 59, ${Math.max(alpha - 0.1, 0)}))`
    };
    return themes[bgStyle || 'default'] || themes.default;
};

export default function LowerThirdsGraphic({ socket, windowMode }) {
    const [data, setData] = useState(null);
    const [style, setStyle] = useState({});
    
    const positionRef = useRef(null);
    const containerRef = useRef(null);
    const panelRef = useRef(null);
    const nameRef = useRef(null);
    const titleRef = useRef(null);
    const subtitle2Ref = useRef(null);
    const logoRef = useRef(null);
    const ltSeparatorRef = useRef(null);
    const subtitle2BgWrapperRef = useRef(null);

    const isShowingRef = useRef(false);
    const currentAnimationRef = useRef('elastic');
    const currentSpeedRef = useRef(1);
    const activeTimelineRef = useRef(null);
    const animateInRef = useRef(null);
    const animateOutRef = useRef(null);
    const clearFallbackTimerRef = useRef(null);
    
    const { contextSafe } = useGSAP({ scope: containerRef });

    const getAnimatedElements = useCallback(() => [
        positionRef.current,
        containerRef.current,
        panelRef.current,
        nameRef.current,
        titleRef.current,
        subtitle2Ref.current,
        logoRef.current,
        ltSeparatorRef.current,
        subtitle2BgWrapperRef.current
    ].filter(Boolean), []);

    const stopActiveAnimation = useCallback(() => {
        if (clearFallbackTimerRef.current) {
            clearTimeout(clearFallbackTimerRef.current);
            clearFallbackTimerRef.current = null;
        }
        if (activeTimelineRef.current) {
            activeTimelineRef.current.kill();
            activeTimelineRef.current = null;
        }
        gsap.killTweensOf(getAnimatedElements());
    }, [getAnimatedElements]);

    const finishClear = useCallback(() => {
        if (clearFallbackTimerRef.current) {
            clearTimeout(clearFallbackTimerRef.current);
            clearFallbackTimerRef.current = null;
        }
        activeTimelineRef.current = null;
        isShowingRef.current = false;
        if (containerRef.current) {
            gsap.set(containerRef.current, {
                opacity: 0,
                x: 0,
                y: 0,
                scale: 1,
                rotation: 0,
                rotationX: 0,
                filter: 'blur(0px)',
                clipPath: 'none',
                clearProps: 'transformOrigin'
            });
        }
        if (panelRef.current) {
            gsap.set(panelRef.current, {
                opacity: 1,
                visibility: 'inherit',
                x: 0,
                y: 0,
                scale: 1,
                rotation: 0,
                rotationX: 0,
                filter: 'blur(0px)',
                clipPath: 'none',
                clearProps: 'transformOrigin'
            });
        }
        gsap.set([
            nameRef.current,
            titleRef.current,
            subtitle2Ref.current,
            logoRef.current,
            ltSeparatorRef.current,
            subtitle2BgWrapperRef.current
        ].filter(Boolean), {
            opacity: 1,
            x: 0,
            y: 0,
            scale: 1,
            scaleX: 1,
            clearProps: 'transformOrigin'
        });
    }, []);

    const animateIn = contextSafe((newData) => {
        if (windowMode === 'stage') return;

        stopActiveAnimation();
        
        currentAnimationRef.current = newData.animation || 'elastic';
        currentSpeedRef.current = Number(newData.animationSpeed) > 0 ? Number(newData.animationSpeed) : 1;

        setData(newData);
        if (newData.style) setStyle(newData.style);

        const els = {
            elPanel: panelRef.current,
            elName: nameRef.current,
            elTitle: titleRef.current,
            elSubtitle2: subtitle2Ref.current,
            elLogo: logoRef.current,
            subtitle2BgWrapper: subtitle2BgWrapperRef.current,
            ltSeparator: ltSeparatorRef.current,
            speed: currentSpeedRef.current
        };

        // Reset panel state to prepare for all animations
        if (containerRef.current) {
            gsap.set(containerRef.current, { opacity: 1, x: 0, y: 0, scale: 1, rotation: 0, rotationX: 0, filter: 'blur(0px)', clipPath: 'none' });
        }
        if (panelRef.current) {
            gsap.set(panelRef.current, { autoAlpha: 1, x: 0, y: 0, scale: 1, rotation: 0, rotationX: 0, filter: 'blur(0px)', clipPath: 'none' });
        }
        gsap.set([nameRef.current, titleRef.current, subtitle2Ref.current, logoRef.current].filter(Boolean), { y: 0, x: 0, opacity: 1, scale: 1 });

        const tl = gsap.timeline({
            onComplete: () => {
                activeTimelineRef.current = null;
                isShowingRef.current = true;
            }
        });
        activeTimelineRef.current = tl;
        applyAnimationIn(tl, panelRef.current, currentAnimationRef.current, true, els);
    });

    const animateOut = contextSafe(() => {
        stopActiveAnimation();

        // Force animate out regardless of internal state to ensure clear works
        const els = {
            elPanel: panelRef.current,
            elName: nameRef.current,
            elTitle: titleRef.current,
            elSubtitle2: subtitle2Ref.current,
            elLogo: logoRef.current,
            ltSeparator: ltSeparatorRef.current,
            speed: currentSpeedRef.current
        };

        const tl = gsap.timeline({ onComplete: finishClear });
        activeTimelineRef.current = tl;
        // Panel on the way out as well as in, so entrance and exit mirror each other
        // (this previously passed containerRef, making the two asymmetric).
        applyAnimationOut(tl, panelRef.current, currentAnimationRef.current, true, els);
        tl.to(containerRef.current, { duration: 0.05, opacity: 0, ease: 'none' }, '>');
    });

    useEffect(() => {
        animateInRef.current = animateIn;
        animateOutRef.current = animateOut;
    }, [animateIn, animateOut]);

    useEffect(() => {
        if (!socket) return;

        const handlePlayGraphic = (d) => {
            animateInRef.current?.(d);
        };
        const handleStopGraphic = () => {
            animateOutRef.current?.();
            // Scale the safety net with the animation speed, otherwise a slow exit
            // (0.5x) would be cut off mid-flight by a fixed 950ms timer.
            const speed = currentSpeedRef.current > 0 ? currentSpeedRef.current : 1;
            clearFallbackTimerRef.current = setTimeout(() => {
                finishClear();
            }, Math.round(950 / speed) + 150);
        };
        const handleStyleUpdate = (s) => {
            setStyle(s);
        };
        const handleDesignUpdate = (design) => {
            setData(prev => prev ? { ...prev, design: { ...(prev.design || {}), ...(design || {}) } } : prev);
        };
        
        socket.on('play_graphic', handlePlayGraphic);
        socket.on('stop_graphic', handleStopGraphic);
        socket.on('stop_lower_third', handleStopGraphic);
        socket.on('update_lt_style', handleStyleUpdate);
        socket.on('update_lt_design', handleDesignUpdate);

        return () => {
            stopActiveAnimation();
            socket.off('play_graphic', handlePlayGraphic);
            socket.off('stop_graphic', handleStopGraphic);
            socket.off('stop_lower_third', handleStopGraphic);
            socket.off('update_lt_style', handleStyleUpdate);
            socket.off('update_lt_design', handleDesignUpdate);
        };
    }, [socket, stopActiveAnimation, finishClear]);

    // Derived styles
    const sf = (style.fontSizeFactor || 100) / 100;
    const nameFontSize = `${4 * sf}rem`;
    const titleFontSize = `${2.2 * sf}rem`;
    const subtitle2FontSize = `${1.5 * sf}rem`;

    const getLangVisibility = (element) => {
        const langOpt = data?.langOpt || 'both';
        if (element === 'name') return langOpt === 'eng' || langOpt === 'both';
        if (element === 'title') return langOpt === 'guj' || langOpt === 'both';
        return true;
    };

    const hasSubtitle2 = data?.subtitle2 && data.subtitle2.trim() !== '';
    const design = { ...DEFAULT_DESIGN, ...(data?.design || {}) };
    const panelAlpha = Math.max(0, Math.min(Number(design.panelOpacity) || 0, 100)) / 100;
    const isFullBand = design.shapeStyle === 'full-band';
    const isUnderline = design.shapeStyle === 'underline';
    const isBadge = design.shapeStyle === 'badge-left' || design.logoPlacement === 'badge';
    const logoVisible = data?.logo && design.logoPlacement !== 'hidden';
    const logoOnRight = design.logoPlacement === 'right';
    const textAlignClass = design.textAlign === 'center' ? 'items-center text-center' : design.textAlign === 'right' ? 'items-end text-right' : 'items-start text-left';
    const borderRgb = hexToRgb(design.borderColor || '#ffffff');
    const shadowStrength = Number(design.shadowIntensity) || 0;
    const panelShadow = design.shapeStyle === 'underline' || design.shapeStyle === 'gradient-scrim'
        ? 'none'
        : `drop-shadow(0 ${16 + shadowStrength / 4}px ${28 + shadowStrength}px rgba(0,0,0,${0.25 + shadowStrength / 160}))`;
    const isScrim = design.shapeStyle === 'gradient-scrim';
    const isStacked = design.shapeStyle === 'stacked';
    const isOutline = design.shapeStyle === 'outline';
    // Shapes that draw no solid panel of their own.
    const isBare = isUnderline || isScrim || isOutline;

    // Flat accent, or a two-stop gradient when the operator enables it.
    const accentFill = design.accentGradient
        ? `linear-gradient(90deg, ${design.accentColor}, ${design.accentColor2 || design.accentColor})`
        : design.accentColor;
    const accentFillVertical = design.accentGradient
        ? `linear-gradient(180deg, ${design.accentColor}, ${design.accentColor2 || design.accentColor})`
        : design.accentColor;

    const shapeStyles = {
        'glass-card': { borderRadius: '22px' },
        'rounded-bar': { borderRadius: '14px' },
        'sharp-block': { borderRadius: '0px' },
        pill: { borderRadius: '999px' },
        angled: { borderRadius: '0px', clipPath: 'polygon(5% 0, 100% 0, 95% 100%, 0 100%)' },
        split: { borderRadius: '8px' },
        ribbon: { borderRadius: '10px 28px 28px 10px' },
        underline: { borderRadius: '0px' },
        'badge-left': { borderRadius: '18px' },
        'full-band': { borderRadius: '0px' },
        // Soft feathered band with no hard edge — the scrim look. Multi-stop fade
        // modelled on the Sabha timer's gradient generator.
        'gradient-scrim': { borderRadius: '0px' },
        // Two tiers: the surface covers the name row, a second bar sits under the title.
        stacked: { borderRadius: '4px' },
        chamfered: { borderRadius: '0px', clipPath: 'polygon(0 0, calc(100% - 28px) 0, 100% 28px, 100% 100%, 28px 100%, 0 calc(100% - 28px))' },
        outline: { borderRadius: '10px' },
        chevron: { borderRadius: '0px', clipPath: 'polygon(0 0, 100% 0, calc(100% - 46px) 100%, 0 100%)' }
    };

    // cornerRadius >= 0 overrides whatever the shape would use.
    const radiusOverride = Number(design.cornerRadius);
    const cornerOverride = Number.isFinite(radiusOverride) && radiusOverride >= 0
        ? { borderRadius: `${radiusOverride}px` }
        : {};
    // The scrim spans the frame like a full band.
    const isFullWidth = isFullBand || isScrim;
    const safePanelWidth = Math.max(360, Math.min(Number(design.panelWidth) || DEFAULT_DESIGN.panelWidth, 1920));
    const panelFrameStyle = {
        width: isFullWidth ? '100vw' : `${safePanelWidth}px`,
        maxWidth: isFullWidth ? '100vw' : '1920px',
        boxSizing: 'border-box',
        filter: panelShadow
    };
    // A scrim is a vertical fade with no edge, so it can't reuse the flat theme fill.
    const scrimBackground = `linear-gradient(to top, rgba(0,0,0,${Math.min(0.96, panelAlpha)}) 0%, rgba(0,0,0,${Math.min(0.96, panelAlpha) * 0.72}) 42%, rgba(0,0,0,${Math.min(0.96, panelAlpha) * 0.32}) 72%, rgba(0,0,0,0) 100%)`;

    const panelSurfaceStyle = {
        position: 'absolute',
        inset: 0,
        background: isUnderline || isOutline
            ? 'transparent'
            : isScrim
                ? scrimBackground
                : getThemeBackground(data?.bgStyle, panelAlpha),
        border: isUnderline || isScrim
            ? 'none'
            : isOutline
                ? `${Math.max(2, Number(design.borderWidth) || 2)}px solid ${design.accentColor}`
                : `${Number(design.borderWidth) || 0}px solid rgba(${borderRgb.r}, ${borderRgb.g}, ${borderRgb.b}, ${Math.max(panelAlpha * 0.6, 0.12)})`,
        borderLeft: ['glass-card', 'rounded-bar', 'sharp-block'].includes(design.shapeStyle) ? `14px solid ${design.accentColor}` : undefined,
        backdropFilter: isBare ? 'none' : 'blur(20px)',
        WebkitBackdropFilter: isBare ? 'none' : 'blur(20px)',
        ...shapeStyles[design.shapeStyle],
        ...cornerOverride
    };
    const normalizedX = Math.max(0, Math.min(Number(design.posX) || 0, 100));
    const normalizedY = Math.max(0, Math.min(Number(design.posY) || 0, 100));
    const positionStyle = {
        zIndex: LAYER_Z.lowerThirds,
        left: isFullWidth ? 0 : `${normalizedX}%`,
        bottom: isFullWidth ? 0 : `${normalizedY}%`,
        width: isFullWidth ? '100vw' : 'auto',
        justifyContent: isFullBand ? 'center' : 'flex-start',
        transform: isFullWidth ? 'none' : `translate(${-normalizedX}%, ${normalizedY}%)`,
        transformOrigin: normalizedX === 0 ? 'left bottom' : normalizedX === 100 ? 'right bottom' : 'center bottom',
        maxWidth: '100vw',
        maxHeight: '100vh'
    };
    const containerStyle = {
        gap: isBadge ? '0px' : '2rem'
    };
    const logoStyle = {
        width: `${design.logoSize}px`,
        height: `${design.logoSize}px`,
        maxWidth: `${design.logoSize * 1.8}px`,
        maxHeight: `${design.logoSize}px`
    };
    const panelPadding = isFullBand
        ? '2.6rem 6.2rem'
        : isScrim
            ? '5rem 6.2rem 2.8rem 6.2rem'
        : isStacked
            ? '2.1rem 3.6rem 2.6rem 3.6rem'
        : isOutline
            ? '2.1rem 3.6rem'
        : design.shapeStyle === 'chamfered'
            ? '2.35rem 4.2rem'
        : design.shapeStyle === 'chevron'
            ? '2.35rem 6rem 2.35rem 4rem'
        : isUnderline
            ? '0.8rem 1rem 1.45rem 1rem'
            : design.shapeStyle === 'pill'
                ? '2.45rem 4.35rem'
                : design.shapeStyle === 'angled'
                    ? '2.35rem 4.7rem'
                : design.shapeStyle === 'ribbon'
                    ? '2.35rem 4.2rem 2.35rem 4.85rem'
                    : design.shapeStyle === 'badge-left'
                        ? '2.4rem 4rem 2.4rem 4.5rem'
                        : '2.35rem 4rem';
    const splitNameStyle = design.shapeStyle === 'split' ? { backgroundColor: rgba(design.accentColor, 0.24), padding: '0.45rem 0.95rem', borderRadius: '6px' } : {};
    const contentInsetStyle = {
        paddingLeft: design.shapeStyle === 'badge-left' ? '2rem' : 0,
        gap: '0.15rem'
    };

    // Per-line colour falls back to the single `color`, so templates saved before
    // per-line colours existed render exactly as they did.
    const lineColor = (key) => {
        const value = style[key];
        return (typeof value === 'string' && value.trim()) ? value : style.color;
    };
    const glow = Math.max(0, Math.min(Number(style.textGlow) || 0, 100));
    const textGlowShadow = glow > 0
        ? `0 ${2 + glow / 18}px ${8 + glow / 2}px rgba(0,0,0,${0.35 + glow / 220}), 0 0 ${glow / 1.6}px rgba(0,0,0,${glow / 260})`
        : undefined;
    // Word spans only exist for the word-build animation; everything else renders plain text.
    const useWordSpans = (data?.animation === 'wordStagger') && Boolean(data?.name);

    return (
        <div ref={positionRef} style={positionStyle} className={`absolute flex items-center ${windowMode === 'stage' ? 'hidden' : ''}`}>
            <div id="lower-third" ref={containerRef} style={containerStyle} className={`flex items-center opacity-0 ${logoOnRight ? 'flex-row-reverse' : ''}`}>
                
                {logoVisible && (
                    <img
                        ref={logoRef}
                        src={data.logo}
                        style={logoStyle}
                        className={`object-contain filter drop-shadow-[0_4px_10px_rgba(0,0,0,0.5)] ${isBadge ? 'rounded-full bg-black/35 border-4 p-4 -mr-8 z-10' : ''}`}
                        alt="Logo"
                    />
                )}
                
                <div ref={panelRef} style={{ ...panelFrameStyle, padding: panelPadding }} className="relative overflow-hidden will-change-transform">
                    <div style={panelSurfaceStyle}></div>
                    {design.shapeStyle === 'angled' && (
                        <div
                            className="absolute top-0 bottom-0 w-12"
                            style={{
                                left: '1.3rem',
                                backgroundColor: rgba(design.accentColor, 0.85),
                                transform: 'skewX(-14deg)',
                                transformOrigin: 'bottom left'
                            }}
                        />
                    )}
                    {design.shapeStyle === 'ribbon' && <div className="absolute left-0 top-0 bottom-0 w-8" style={{ background: accentFillVertical }} />}
                    {design.shapeStyle === 'badge-left' && <div className="absolute left-0 top-0 bottom-0 w-16" style={{ backgroundColor: rgba(design.accentColor, 0.45) }} />}
                    {design.shapeStyle === 'full-band' && <div className="absolute top-0 left-0 right-0 h-1.5" style={{ background: accentFill }} />}
                    {/* Stacked tiers: an accent rule under the name row plus a lower bar,
                        giving the two-level look without a second animated element. */}
                    {isStacked && (
                        <>
                            <div className="absolute left-0 top-0 bottom-0 w-2.5" style={{ background: accentFillVertical }} />
                            <div className="absolute left-0 right-0 bottom-0 h-2" style={{ background: accentFill }} />
                        </>
                    )}
                    {design.shapeStyle === 'chevron' && <div className="absolute left-0 top-0 bottom-0 w-3" style={{ background: accentFillVertical }} />}
                    {design.shapeStyle === 'chamfered' && <div className="absolute left-0 top-0 bottom-0 w-2.5" style={{ background: accentFillVertical }} />}
                    {isScrim && <div className="absolute left-0 bottom-0 h-1" style={{ width: '38%', background: accentFill }} />}
                    <div id="block-reveal-bg" className="absolute inset-0 bg-white origin-left hidden z-[-1]"></div>
                    
                    <div className={`relative flex flex-col ${textAlignClass}`} style={contentInsetStyle}>
                        
                        <div className="reveal-mask block-reveal-container" id="name-container">
                            <div id="name-overlay" className="block-reveal-overlay hidden"></div>
                            <div 
                                ref={nameRef} 
                                className={`name-text font-eng font-bold block-reveal-content ${getLangVisibility('name') ? '' : 'hidden'}`}
                                style={{
                                    ...splitNameStyle,
                                    fontFamily: style.fontFamily,
                                    fontWeight: style.fontWeight,
                                    color: lineColor('nameColor'),
                                    textShadow: textGlowShadow,
                                    letterSpacing: `${style.letterSpacing}px`,
                                    fontStyle: style.italic ? 'italic' : 'normal',
                                    textDecoration: style.underline ? 'underline' : 'none',
                                    fontSize: nameFontSize,
                                    lineHeight: 1.05
                                }}
                            >
                                {useWordSpans
                                    ? data.name.split(/\s+/).filter(Boolean).map((word, i) => (
                                        <span key={i} className="lt-word inline-block">
                                            {word}{' '}
                                        </span>
                                    ))
                                    : (data?.name || '')}
                            </div>
                        </div>

                    <div className="reveal-mask block-reveal-container mt-1" id="title-container">
                        <div id="title-overlay" className="block-reveal-overlay secondary hidden" style={{ backgroundColor: style.sub2BgColor }}></div>
                        <div 
                            ref={titleRef} 
                            className={`title-text font-guj font-medium block-reveal-content ${getLangVisibility('title') ? '' : 'hidden'}`}
                            style={{
                                fontFamily: style.gujFontFamily || "'Rasa', serif",
                                fontWeight: style.fontWeight,
                                color: lineColor('titleColor'),
                                textShadow: textGlowShadow,
                                letterSpacing: `${style.letterSpacing}px`,
                                fontStyle: style.italic ? 'italic' : 'normal',
                                textDecoration: style.underline ? 'underline' : 'none',
                                fontSize: titleFontSize,
                                lineHeight: 1.25
                            }}
                        >
                            {data?.title || ''}
                        </div>
                    </div>

                    <div ref={ltSeparatorRef} className={`h-0.5 my-4 rounded-full w-full ${hasSubtitle2 ? '' : 'hidden'}`} style={{ background: design.accentGradient ? accentFill : rgba(design.accentColor, 0.55) }}></div>

                    <div className="reveal-mask block-reveal-container" id="subtitle2-container">
                        <div ref={subtitle2BgWrapperRef} className={hasSubtitle2 ? '' : 'hidden'} style={{ backgroundColor: style.sub2BgColor }}>
                            <div id="subtitle2-overlay" className="block-reveal-overlay secondary hidden" style={{ backgroundColor: style.sub2BgColor }}></div>
                            <div 
                                ref={subtitle2Ref} 
                                className="subtitle2-text font-eng block-reveal-content text-slate-400 font-bold uppercase tracking-[0.2em] text-xl"
                                style={{
                                    fontFamily: style.fontFamily,
                                    fontWeight: style.fontWeight,
                                    color: lineColor('subtitleColor'),
                                    textShadow: textGlowShadow,
                                    letterSpacing: `${style.letterSpacing}px`,
                                    fontStyle: style.italic ? 'italic' : 'normal',
                                    textDecoration: style.underline ? 'underline' : 'none',
                                    fontSize: subtitle2FontSize,
                                    lineHeight: 1.2
                                }}
                            >
                                {data?.subtitle2 || ''}
                            </div>
                        </div>
                    </div>

                </div>
                    {isUnderline && <div className="absolute left-0 right-0 bottom-0 h-1.5 rounded-full" style={{ background: accentFill }} />}
                </div>
            </div>
        </div>
    );
}
