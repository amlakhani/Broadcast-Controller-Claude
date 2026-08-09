import gsap from 'gsap';

// `isElasticPanel` is effectively "am I a lower third": lower thirds pass true and supply
// the `els` element map, lyrics pass false and animate their container as one block.
//
// `els.speed` is the operator's animation-speed multiplier (2 = twice as fast). Every
// duration and stagger goes through the local `d()` so one knob retimes the whole set.

const scaler = (els) => {
    const speed = Number(els?.speed);
    const safe = Number.isFinite(speed) && speed > 0 ? Math.min(Math.max(speed, 0.25), 4) : 1;
    return (value) => value / safe;
};

const isVisible = (el) => Boolean(el) && !el.classList.contains('hidden');

// Staggered entrance for the text lines (plus logo and separator).
//
// This is what the 11 "panel only" animations were missing: they tweened the panel and
// left the text welded to it, which is why they read as flat rather than broadcast.
function addTextReveal(tl, els, d, opts = {}) {
    const { elName, elTitle, elSubtitle2, elLogo, ltSeparator } = els;
    const {
        from = { y: 26, opacity: 0 },
        stagger = 0.09,
        duration = 0.62,
        ease = 'expo.out',
        position = '-=0.55'
    } = opts;

    const lines = [elName, elTitle, elSubtitle2].filter(Boolean);
    if (lines.length === 0) return;

    gsap.set(lines, from);
    if (isVisible(elLogo)) gsap.set(elLogo, { opacity: 0, scale: 0.92 });
    if (ltSeparator) gsap.set(ltSeparator, { opacity: 0, scaleX: 0, transformOrigin: 'left' });

    tl.to(lines, { duration: d(duration), x: 0, y: 0, opacity: 1, stagger: d(stagger), ease }, position);
    if (isVisible(elLogo)) {
        tl.to(elLogo, { duration: d(duration), opacity: 1, scale: 1, ease: 'power3.out' }, '<');
    }
    if (ltSeparator && isVisible(elSubtitle2)) {
        tl.to(ltSeparator, { duration: d(duration * 0.9), opacity: 1, scaleX: 1, ease: 'expo.out' }, '<');
    }
}

export function applyAnimationIn(tl, container, currentAnimation, isElasticPanel, els = {}) {
    const { elPanel, elName, elTitle, elSubtitle2, elLogo, subtitle2BgWrapper, ltSeparator } = els;
    const d = scaler(els);
    const panelMode = Boolean(isElasticPanel && elPanel);

    gsap.set(container, {
        opacity: 1,
        x: 0,
        y: 0,
        scale: 1,
        rotationX: 0,
        rotation: 0,
        filter: "blur(0px)",
        clipPath: "none",
        clearProps: "transformOrigin"
    });

    // Critical Reset: Ensure all LT elements are visible and in position before animating
    if (panelMode) {
        gsap.set(elPanel, {
            opacity: 1,
            x: 0,
            y: 0,
            scale: 1,
            scaleY: 1,
            rotationX: 0,
            rotation: 0,
            filter: "blur(0px)",
            clipPath: "none",
            clearProps: "transformOrigin"
        });
        // clipPath is reset here too because lineMask leaves it on the text lines.
        gsap.set([elName, elTitle, elSubtitle2], { opacity: 1, x: 0, y: 0, scale: 1, clipPath: "none", clearProps: "transformOrigin" });
        if (isVisible(elLogo)) gsap.set(elLogo, { x: 0, y: 0, scale: 1, opacity: 1, clearProps: "transformOrigin" });
        if (subtitle2BgWrapper) gsap.set(subtitle2BgWrapper, { opacity: 1, scaleX: 1 });
        if (ltSeparator) gsap.set(ltSeparator, { opacity: 1, scaleX: 1 });
        const words = elName ? elName.querySelectorAll('.lt-word') : [];
        if (words.length) gsap.set(words, { opacity: 1, x: 0, y: 0 });
    }

    switch (currentAnimation) {
        case 'none':
            gsap.set(container, { opacity: 1, x: 0, y: 0, scale: 1, filter: "blur(0px)", clipPath: "none" });
            break;
        case 'slideRight':
            gsap.set(container, { x: -300, opacity: 0 });
            tl.to(container, { duration: d(1.0), x: 0, opacity: 1, ease: "expo.out" });
            if (panelMode) addTextReveal(tl, els, d, { from: { x: -22, opacity: 0 }, position: '-=0.62' });
            break;
        case 'slideLeft':
            gsap.set(container, { x: 300, opacity: 0 });
            tl.to(container, { duration: d(1.0), x: 0, opacity: 1, ease: "expo.out" });
            if (panelMode) addTextReveal(tl, els, d, { from: { x: 22, opacity: 0 }, position: '-=0.62' });
            break;
        case 'slideUp':
            gsap.set(container, { y: 150, opacity: 0 });
            tl.to(container, { duration: d(1.0), y: 0, opacity: 1, ease: "expo.out" });
            if (panelMode) addTextReveal(tl, els, d, { position: '-=0.62' });
            break;
        case 'fade':
            gsap.set(container, { opacity: 0 });
            tl.to(container, { duration: d(0.9), opacity: 1, ease: "power2.inOut" });
            if (panelMode) addTextReveal(tl, els, d, { from: { y: 18, opacity: 0 }, position: '-=0.55' });
            break;
        case 'zoom':
            gsap.set(container, { scale: 0.85, opacity: 0 });
            tl.to(container, { duration: d(1.0), scale: 1, opacity: 1, ease: "expo.out" });
            if (panelMode) addTextReveal(tl, els, d, { from: { scale: 0.94, opacity: 0 }, position: '-=0.6' });
            break;
        case 'blur':
            gsap.set(container, { filter: "blur(20px)", opacity: 0 });
            tl.to(container, { duration: d(1.0), filter: "blur(0px)", opacity: 1, ease: "expo.out" });
            if (panelMode) addTextReveal(tl, els, d, { from: { y: 16, opacity: 0 }, position: '-=0.6' });
            break;
        case 'flip':
            gsap.set(container, { rotationX: -90, opacity: 0, transformOrigin: "center top" });
            tl.to(container, { duration: d(1.0), rotationX: 0, opacity: 1, ease: "expo.out" });
            if (panelMode) addTextReveal(tl, els, d, { position: '-=0.5' });
            break;
        case 'spin':
            gsap.set(container, { rotation: -15, scale: 0.95, opacity: 0 });
            tl.to(container, { duration: d(1.0), rotation: 0, scale: 1, opacity: 1, ease: "expo.out" });
            if (panelMode) addTextReveal(tl, els, d, { position: '-=0.55' });
            break;
        case 'bounce':
            gsap.set(container, { y: -200, opacity: 0 });
            tl.to(container, { duration: d(1.2), y: 0, opacity: 1, ease: "elastic.out(1, 0.75)" });
            if (panelMode) addTextReveal(tl, els, d, { position: '-=0.85' });
            break;
        case 'elasticDrop':
            gsap.set(container, { y: -150, opacity: 0 });
            tl.to(container, { duration: d(1.0), y: 0, opacity: 1, ease: "back.out(1.7)" });
            if (panelMode) addTextReveal(tl, els, d, { position: '-=0.6' });
            break;

        // A thin accent bar races across, then the panel opens vertically behind it —
        // the classic sports/news build.
        case 'accentSweep':
            if (panelMode) {
                gsap.set(elPanel, { clipPath: "inset(0 100% 0 0)", scaleY: 0.14, transformOrigin: "left bottom", opacity: 1 });
                tl.to(elPanel, { duration: d(0.42), clipPath: "inset(0 0% 0 0)", ease: "power3.inOut" })
                  .to(elPanel, { duration: d(0.5), scaleY: 1, ease: "expo.out" }, "-=0.04");
                addTextReveal(tl, els, d, { from: { y: 22, opacity: 0 }, stagger: 0.07, position: '-=0.28' });
            } else {
                gsap.set(container, { clipPath: "inset(0 100% 0 0)", opacity: 1 });
                tl.to(container, { duration: d(0.8), clipPath: "inset(0 0% 0 0)", ease: "power4.out" });
            }
            break;

        // Each line wipes in under its own mask.
        case 'lineMask':
            if (panelMode) {
                const lines = [elName, elTitle, elSubtitle2].filter(Boolean);
                gsap.set(elPanel, { opacity: 1, clipPath: "inset(0 100% 0 0)" });
                gsap.set(lines, { clipPath: "inset(0 100% 0 0)", opacity: 1, y: 0 });
                if (isVisible(elLogo)) gsap.set(elLogo, { opacity: 0, scale: 0.94 });
                if (ltSeparator) gsap.set(ltSeparator, { opacity: 0, scaleX: 0, transformOrigin: "left" });

                tl.to(elPanel, { duration: d(0.5), clipPath: "inset(0 0% 0 0)", ease: "power4.out" })
                  .to(lines, { duration: d(0.55), clipPath: "inset(0 0% 0 0)", stagger: d(0.12), ease: "power3.out" }, "-=0.22");
                if (isVisible(elLogo)) tl.to(elLogo, { duration: d(0.5), opacity: 1, scale: 1, ease: "power3.out" }, "-=0.5");
                if (ltSeparator && isVisible(elSubtitle2)) tl.to(ltSeparator, { duration: d(0.45), opacity: 1, scaleX: 1, ease: "expo.out" }, "-=0.35");
            } else {
                gsap.set(container, { clipPath: "inset(0 100% 0 0)", opacity: 1 });
                tl.to(container, { duration: d(0.8), clipPath: "inset(0 0% 0 0)", ease: "power3.out" });
            }
            break;

        // Word-by-word build. The graphic renders `.lt-word` spans for this animation;
        // if they are absent (e.g. an empty name) it degrades to the standard reveal.
        case 'wordStagger':
            if (panelMode) {
                const words = elName ? elName.querySelectorAll('.lt-word') : [];
                gsap.set(elPanel, { clipPath: "inset(0 100% 0 0)", opacity: 1 });
                tl.to(elPanel, { duration: d(0.55), clipPath: "inset(0 0% 0 0)", ease: "power4.out" });

                if (words.length) {
                    gsap.set(elName, { opacity: 1, y: 0 });
                    gsap.set(words, { y: 26, opacity: 0 });
                    gsap.set([elTitle, elSubtitle2].filter(Boolean), { y: 22, opacity: 0 });
                    if (isVisible(elLogo)) gsap.set(elLogo, { opacity: 0, scale: 0.92 });
                    if (ltSeparator) gsap.set(ltSeparator, { opacity: 0, scaleX: 0, transformOrigin: "left" });

                    tl.to(words, { duration: d(0.5), y: 0, opacity: 1, stagger: d(0.055), ease: "expo.out" }, "-=0.3");
                    tl.to([elTitle, elSubtitle2].filter(Boolean), { duration: d(0.6), y: 0, opacity: 1, stagger: d(0.09), ease: "expo.out" }, "-=0.2");
                    if (isVisible(elLogo)) tl.to(elLogo, { duration: d(0.5), opacity: 1, scale: 1, ease: "power3.out" }, "<");
                    if (ltSeparator && isVisible(elSubtitle2)) tl.to(ltSeparator, { duration: d(0.45), opacity: 1, scaleX: 1, ease: "expo.out" }, "<");
                } else {
                    addTextReveal(tl, els, d, { position: '-=0.3' });
                }
            } else {
                gsap.set(container, { y: 40, opacity: 0 });
                tl.to(container, { duration: d(0.9), y: 0, opacity: 1, ease: "expo.out" });
            }
            break;

        // Overshoots its mark then settles back, text trailing slightly.
        case 'pushSettle':
            if (panelMode) {
                gsap.set(elPanel, { x: -150, opacity: 0 });
                tl.to(elPanel, { duration: d(0.8), x: 0, opacity: 1, ease: "back.out(1.4)" });
                addTextReveal(tl, els, d, { from: { x: -24, opacity: 0 }, stagger: 0.08, position: '-=0.5' });
            } else {
                gsap.set(container, { x: -120, opacity: 0 });
                tl.to(container, { duration: d(0.9), x: 0, opacity: 1, ease: "back.out(1.4)" });
            }
            break;

        case 'wipe':
            if (panelMode) {
                gsap.set(elPanel, { clipPath: "inset(0 100% 0 0)", opacity: 1 });
                gsap.set([elName, elTitle, elSubtitle2], { x: -24, opacity: 0 });
                if (isVisible(elLogo)) gsap.set(elLogo, { x: -30, opacity: 0 });
                tl.to(elPanel, { duration: d(0.75), clipPath: "inset(0 0% 0 0)", ease: "power4.out" })
                  .to([elName, elTitle, elSubtitle2], { duration: d(0.65), x: 0, opacity: 1, stagger: d(0.08), ease: "power3.out" }, "-=0.5");
                if (isVisible(elLogo)) tl.to(elLogo, { duration: d(0.5), x: 0, opacity: 1, ease: "power3.out" }, "-=0.65");
            } else {
                gsap.set(container, { clipPath: "inset(0 100% 0 0)", opacity: 1 });
                tl.to(container, { duration: d(0.8), clipPath: "inset(0 0% 0 0)", ease: "power4.out" });
            }
            break;
        case 'stagger':
            if (panelMode) {
                gsap.set(elPanel, { opacity: 0, y: 24 });
                gsap.set([elName, elTitle, elSubtitle2], { y: 28, opacity: 0 });
                if (isVisible(elLogo)) gsap.set(elLogo, { scale: 0.92, opacity: 0 });
                tl.to(elPanel, { duration: d(0.55), y: 0, opacity: 1, ease: "power3.out" })
                  .to([elName, elTitle, elSubtitle2], { duration: d(0.7), y: 0, opacity: 1, stagger: d(0.11), ease: "expo.out" }, "-=0.25");
                if (isVisible(elLogo)) tl.to(elLogo, { duration: d(0.55), scale: 1, opacity: 1, ease: "power3.out" }, "-=0.85");
            } else {
                gsap.set(container, { y: 40, opacity: 0 });
                tl.to(container, { duration: d(0.9), y: 0, opacity: 1, ease: "expo.out" });
            }
            break;
        case 'typeOn':
            if (panelMode) {
                gsap.set(elPanel, { opacity: 1, clipPath: "inset(0 100% 0 0)" });
                gsap.set([elName, elTitle, elSubtitle2], { opacity: 0 });
                tl.to(elPanel, { duration: d(0.55), clipPath: "inset(0 0% 0 0)", ease: "power3.out" })
                  .to(elName, { duration: d(0.25), opacity: 1, ease: "none" })
                  .to(elTitle, { duration: d(0.25), opacity: 1, ease: "none" })
                  .to(elSubtitle2, { duration: d(0.25), opacity: 1, ease: "none" });
            } else {
                gsap.set(container, { opacity: 0 });
                tl.to(container, { duration: d(0.7), opacity: 1, ease: "steps(8)" });
            }
            break;
        case 'elastic':
        default:
            if (panelMode) {
                gsap.set([elName, elTitle, elSubtitle2], { opacity: 1 });

                // Ultra-smooth fluid reveal using clip-path (High Performance).
                // The panel itself stays at opacity 1 throughout — clip-path alone does the
                // reveal. Cross-fading opacity here too used to mean the panel briefly sat
                // at very low alpha mid-tween, which (with no real video behind it, just the
                // flat chroma-key background) blended straight through to raw green.
                gsap.set(elPanel, { clipPath: "inset(0 100% 0 0)", opacity: 1 });
                gsap.set([elName, elTitle, elSubtitle2], { y: 30, opacity: 0 });
                if (isVisible(elLogo)) gsap.set(elLogo, { scale: 0.9, opacity: 0 });

                tl.to(elPanel, { duration: d(1.0), clipPath: "inset(0 0% 0 0)", ease: "expo.out" });
                if (isVisible(elLogo)) tl.to(elLogo, { duration: d(0.8), scale: 1, opacity: 1, ease: "power2.out" }, "-=0.8");
                tl.to(elName, { duration: d(0.9), y: 0, opacity: 1, ease: "expo.out" }, "-=0.9")
                  .to(elTitle, { duration: d(0.9), y: 0, opacity: 1, ease: "expo.out" }, "-=0.8");

                if (isVisible(elSubtitle2)) {
                    tl.to(ltSeparator, { duration: d(0.8), opacity: 1, scaleX: 1, transformOrigin: "left", ease: "expo.out" }, "-=0.8")
                      .to(elSubtitle2, { duration: d(0.9), y: 0, opacity: 1, ease: "expo.out" }, "-=0.7");
                }
            } else {
                // Smooth reveal for lyrics
                gsap.set(container, { y: 50, opacity: 0 });
                tl.to(container, { duration: d(1.2), y: 0, opacity: 1, ease: "expo.out" });
            }
            break;
    }
}

export function applyAnimationOut(tl, container, currentAnimation, isElasticPanel, els = {}) {
    // elLogo was previously omitted here, so the logo never animated out — it just
    // vanished with the container.
    const { elPanel, elName, elTitle, elSubtitle2, elLogo, ltSeparator } = els;
    const d = scaler(els);
    const panelMode = Boolean(isElasticPanel && elPanel);
    const lines = [elName, elTitle, elSubtitle2].filter(Boolean);

    // Text leads the panel out, mirroring the entrance.
    const addTextExit = (opts = {}) => {
        const { to = { y: 20, opacity: 0 }, stagger = 0.06, duration = 0.32, ease = 'power2.in' } = opts;
        if (lines.length === 0) return;
        tl.to([...lines].reverse(), { duration: d(duration), ...to, stagger: d(stagger), ease });
        if (isVisible(elLogo)) tl.to(elLogo, { duration: d(duration), opacity: 0, scale: 0.94, ease }, '<');
        if (ltSeparator) tl.to(ltSeparator, { duration: d(duration), opacity: 0, scaleX: 0, transformOrigin: 'left', ease }, '<');
    };

    switch (currentAnimation) {
        case 'none':
            gsap.set(container, { opacity: 0 });
            break;
        case 'slideRight':
            if (panelMode) addTextExit({ to: { x: 20, opacity: 0 } });
            tl.to(container, { duration: d(0.6), x: 300, opacity: 0, ease: "expo.in" }, panelMode ? '-=0.2' : 0);
            break;
        case 'slideLeft':
            if (panelMode) addTextExit({ to: { x: -20, opacity: 0 } });
            tl.to(container, { duration: d(0.6), x: -300, opacity: 0, ease: "expo.in" }, panelMode ? '-=0.2' : 0);
            break;
        case 'slideUp':
            if (panelMode) addTextExit();
            tl.to(container, { duration: d(0.6), y: -150, opacity: 0, ease: "expo.in" }, panelMode ? '-=0.2' : 0);
            break;
        case 'fade':
            if (panelMode) addTextExit({ to: { y: 12, opacity: 0 } });
            tl.to(container, { duration: d(0.6), opacity: 0, ease: "power2.inOut" }, panelMode ? '-=0.2' : 0);
            break;
        case 'zoom':
            if (panelMode) addTextExit({ to: { scale: 0.96, opacity: 0 } });
            tl.to(container, { duration: d(0.6), scale: 0.85, opacity: 0, ease: "expo.in" }, panelMode ? '-=0.2' : 0);
            break;
        case 'blur':
            if (panelMode) addTextExit({ to: { y: 12, opacity: 0 } });
            tl.to(container, { duration: d(0.6), filter: "blur(20px)", opacity: 0, ease: "expo.in" }, panelMode ? '-=0.2' : 0);
            break;
        case 'flip':
            if (panelMode) addTextExit();
            tl.to(container, { duration: d(0.6), rotationX: 90, opacity: 0, ease: "expo.in" }, panelMode ? '-=0.2' : 0);
            break;
        case 'spin':
            if (panelMode) addTextExit();
            tl.to(container, { duration: d(0.6), rotation: 15, scale: 0.95, opacity: 0, ease: "expo.in" }, panelMode ? '-=0.2' : 0);
            break;
        case 'bounce':
            if (panelMode) addTextExit();
            tl.to(container, { duration: d(0.6), y: 150, opacity: 0, ease: "expo.in" }, panelMode ? '-=0.2' : 0);
            break;
        case 'elasticDrop':
            if (panelMode) addTextExit();
            tl.to(container, { duration: d(0.6), y: -150, opacity: 0, ease: "expo.in" }, panelMode ? '-=0.2' : 0);
            break;

        case 'accentSweep':
            if (panelMode) {
                addTextExit({ to: { y: 16, opacity: 0 }, duration: 0.28 });
                tl.to(elPanel, { duration: d(0.32), scaleY: 0.14, transformOrigin: "left bottom", ease: "power3.in" }, "-=0.12")
                  .to(elPanel, { duration: d(0.4), clipPath: "inset(0 100% 0 0)", ease: "power3.inOut" }, "-=0.05");
            } else {
                tl.to(container, { duration: d(0.6), clipPath: "inset(0 100% 0 0)", opacity: 0, ease: "power3.in" });
            }
            break;
        case 'lineMask':
            if (panelMode) {
                tl.to([...lines].reverse(), { duration: d(0.3), clipPath: "inset(0 100% 0 0)", stagger: d(0.07), ease: "power2.in" });
                if (ltSeparator) tl.to(ltSeparator, { duration: d(0.25), opacity: 0, scaleX: 0, transformOrigin: "left", ease: "power2.in" }, '<');
                if (isVisible(elLogo)) tl.to(elLogo, { duration: d(0.3), opacity: 0, ease: "power2.in" }, '<');
                tl.to(elPanel, { duration: d(0.45), clipPath: "inset(0 100% 0 0)", ease: "power3.in" }, "-=0.12");
            } else {
                tl.to(container, { duration: d(0.6), clipPath: "inset(0 100% 0 0)", opacity: 0, ease: "power3.in" });
            }
            break;
        case 'wordStagger':
            if (panelMode) {
                const words = elName ? elName.querySelectorAll('.lt-word') : [];
                if (words.length) {
                    tl.to([...words].reverse(), { duration: d(0.22), y: 18, opacity: 0, stagger: d(0.03), ease: "power2.in" });
                    tl.to([elTitle, elSubtitle2].filter(Boolean), { duration: d(0.28), y: 16, opacity: 0, stagger: d(0.05), ease: "power2.in" }, "-=0.2");
                    if (ltSeparator) tl.to(ltSeparator, { duration: d(0.25), opacity: 0, scaleX: 0, transformOrigin: "left", ease: "power2.in" }, '<');
                    if (isVisible(elLogo)) tl.to(elLogo, { duration: d(0.28), opacity: 0, ease: "power2.in" }, '<');
                } else {
                    addTextExit();
                }
                tl.to(elPanel, { duration: d(0.45), clipPath: "inset(0 100% 0 0)", opacity: 0, ease: "power3.in" }, "-=0.1");
            } else {
                tl.to(container, { duration: d(0.6), y: 30, opacity: 0, ease: "power2.in" });
            }
            break;
        case 'pushSettle':
            if (panelMode) {
                addTextExit({ to: { x: -18, opacity: 0 }, duration: 0.28 });
                tl.to(elPanel, { duration: d(0.5), x: -150, opacity: 0, ease: "back.in(1.2)" }, "-=0.15");
            } else {
                tl.to(container, { duration: d(0.6), x: -120, opacity: 0, ease: "power2.in" });
            }
            break;

        case 'wipe':
            tl.to([elName, elTitle, elSubtitle2], { duration: d(0.35), x: -20, opacity: 0, stagger: d(0.04), ease: "power2.in" });
            if (isVisible(elLogo)) tl.to(elLogo, { duration: d(0.35), x: -24, opacity: 0, ease: "power2.in" }, '<');
            tl.to(elPanel, { duration: d(0.55), clipPath: "inset(0 100% 0 0)", ease: "power3.in" }, "-=0.15");
            break;
        case 'stagger':
            tl.to([elSubtitle2, elTitle, elName], { duration: d(0.35), y: 20, opacity: 0, stagger: d(0.06), ease: "power2.in" });
            if (isVisible(elLogo)) tl.to(elLogo, { duration: d(0.35), scale: 0.94, opacity: 0, ease: "power2.in" }, '<');
            tl.to(elPanel, { duration: d(0.45), y: 20, opacity: 0, ease: "power2.in" }, "-=0.15");
            break;
        case 'typeOn':
            tl.to([elSubtitle2, elTitle, elName], { duration: d(0.15), opacity: 0, stagger: d(0.05), ease: "none" });
            if (isVisible(elLogo)) tl.to(elLogo, { duration: d(0.15), opacity: 0, ease: "none" }, '<');
            tl.to(elPanel, { duration: d(0.45), clipPath: "inset(0 100% 0 0)", opacity: 0, ease: "power2.in" }, "-=0.05");
            break;
        case 'elastic':
        default:
            tl.to([elName, elTitle, elSubtitle2], { duration: d(0.6), y: 30, opacity: 0, ease: "expo.in" });
            if (isVisible(elLogo)) tl.to(elLogo, { duration: d(0.5), scale: 0.9, opacity: 0, ease: "expo.in" }, '<');
            tl.to(ltSeparator, { duration: d(0.5), opacity: 0, scaleX: 0, ease: "expo.in" }, "-=0.4")
              // Panel opacity stays at 1 here too — see the matching note in applyAnimationIn.
              // clip-path closing back to 0 width is what hides it; fading alpha on top of
              // that just re-exposed the raw chroma-key green mid-close.
              .to(elPanel, { duration: d(0.8), clipPath: "inset(0 100% 0 0)", ease: "expo.in" }, "-=0.3");
            break;
    }
}
