import gsap from 'gsap';

export function applyAnimationIn(tl, container, currentAnimation, isElasticPanel, els = {}) {
    const { elPanel, elName, elTitle, elSubtitle2, elLogo, subtitle2BgWrapper, ltSeparator } = els;

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
    if (isElasticPanel && elPanel) {
        gsap.set(elPanel, {
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
        gsap.set([elName, elTitle, elSubtitle2], { opacity: 1, x: 0, y: 0, scale: 1, clearProps: "transformOrigin" });
        if (elLogo && !elLogo.classList.contains('hidden')) gsap.set(elLogo, { x: 0, y: 0, scale: 1, opacity: 1, clearProps: "transformOrigin" });
        if (subtitle2BgWrapper) gsap.set(subtitle2BgWrapper, { opacity: 1, scaleX: 1 });
        if (ltSeparator) gsap.set(ltSeparator, { opacity: 1, scaleX: 1 });
    }            
    
    switch (currentAnimation) {
        case 'none':
            gsap.set(container, { opacity: 1, x: 0, y: 0, scale: 1, filter: "blur(0px)", clipPath: "none" });
            break;
        case 'slideRight':
            gsap.set(container, { x: -300, opacity: 0 });
            tl.to(container, { duration: 1.2, x: 0, opacity: 1, ease: "expo.out" });
            break;
        case 'slideLeft':
            gsap.set(container, { x: 300, opacity: 0 });
            tl.to(container, { duration: 1.2, x: 0, opacity: 1, ease: "expo.out" });
            break;
        case 'slideUp':
            gsap.set(container, { y: 150, opacity: 0 });
            tl.to(container, { duration: 1.2, y: 0, opacity: 1, ease: "expo.out" });
            break;
        case 'fade':
            gsap.set(container, { opacity: 0 });
            tl.to(container, { duration: 1.2, opacity: 1, ease: "power2.inOut" });
            break;
        case 'zoom':
            gsap.set(container, { scale: 0.85, opacity: 0 });
            tl.to(container, { duration: 1.2, scale: 1, opacity: 1, ease: "expo.out" });
            break;
        case 'blur':
            gsap.set(container, { filter: "blur(20px)", opacity: 0 });
            tl.to(container, { duration: 1.2, filter: "blur(0px)", opacity: 1, ease: "expo.out" });
            break;
        case 'flip':
            gsap.set(container, { rotationX: -90, opacity: 0, transformOrigin: "center top" });
            tl.to(container, { duration: 1.2, rotationX: 0, opacity: 1, ease: "expo.out" });
            break;
        case 'spin':
            gsap.set(container, { rotation: -15, scale: 0.95, opacity: 0 });
            tl.to(container, { duration: 1.2, rotation: 0, scale: 1, opacity: 1, ease: "expo.out" });
            break;
        case 'bounce':
            gsap.set(container, { y: -200, opacity: 0 });
            tl.to(container, { duration: 1.2, y: 0, opacity: 1, ease: "elastic.out(1, 0.75)" });
            break;
        case 'elasticDrop':
            gsap.set(container, { y: -150, opacity: 0 });
            tl.to(container, { duration: 1.0, y: 0, opacity: 1, ease: "back.out(1.7)" });
            break;
        case 'wipe':
            if (isElasticPanel && elPanel) {
                gsap.set(elPanel, { clipPath: "inset(0 100% 0 0)", opacity: 1 });
                gsap.set([elName, elTitle, elSubtitle2], { x: -24, opacity: 0 });
                if(elLogo && !elLogo.classList.contains('hidden')) gsap.set(elLogo, { x: -30, opacity: 0 });
                tl.to(elPanel, { duration: 0.75, clipPath: "inset(0 0% 0 0)", ease: "power4.out" })
                  .to([elName, elTitle, elSubtitle2], { duration: 0.65, x: 0, opacity: 1, stagger: 0.08, ease: "power3.out" }, "-=0.5");
                if(elLogo && !elLogo.classList.contains('hidden')) tl.to(elLogo, { duration: 0.5, x: 0, opacity: 1, ease: "power3.out" }, "-=0.65");
            } else {
                gsap.set(container, { clipPath: "inset(0 100% 0 0)", opacity: 1 });
                tl.to(container, { duration: 0.8, clipPath: "inset(0 0% 0 0)", ease: "power4.out" });
            }
            break;
        case 'stagger':
            if (isElasticPanel && elPanel) {
                gsap.set(elPanel, { opacity: 0, y: 24 });
                gsap.set([elName, elTitle, elSubtitle2], { y: 28, opacity: 0 });
                if(elLogo && !elLogo.classList.contains('hidden')) gsap.set(elLogo, { scale: 0.92, opacity: 0 });
                tl.to(elPanel, { duration: 0.55, y: 0, opacity: 1, ease: "power3.out" })
                  .to([elName, elTitle, elSubtitle2], { duration: 0.7, y: 0, opacity: 1, stagger: 0.11, ease: "expo.out" }, "-=0.25");
                if(elLogo && !elLogo.classList.contains('hidden')) tl.to(elLogo, { duration: 0.55, scale: 1, opacity: 1, ease: "power3.out" }, "-=0.85");
            } else {
                gsap.set(container, { y: 40, opacity: 0 });
                tl.to(container, { duration: 0.9, y: 0, opacity: 1, ease: "expo.out" });
            }
            break;
        case 'typeOn':
            if (isElasticPanel && elPanel) {
                gsap.set(elPanel, { opacity: 1, clipPath: "inset(0 100% 0 0)" });
                gsap.set([elName, elTitle, elSubtitle2], { opacity: 0 });
                tl.to(elPanel, { duration: 0.55, clipPath: "inset(0 0% 0 0)", ease: "power3.out" })
                  .to(elName, { duration: 0.25, opacity: 1, ease: "none" })
                  .to(elTitle, { duration: 0.25, opacity: 1, ease: "none" })
                  .to(elSubtitle2, { duration: 0.25, opacity: 1, ease: "none" });
            } else {
                gsap.set(container, { opacity: 0 });
                tl.to(container, { duration: 0.7, opacity: 1, ease: "steps(8)" });
            }
            break;
        case 'elastic':
        default:
            if (isElasticPanel && elPanel) {
                gsap.set([elName, elTitle, elSubtitle2], { opacity: 1 });

                // Ultra-smooth fluid reveal using clip-path (High Performance)
                gsap.set(elPanel, { clipPath: "inset(0 100% 0 0)", opacity: 0 });
                gsap.set([elName, elTitle, elSubtitle2], { y: 30, opacity: 0 }); 
                if(elLogo && !elLogo.classList.contains('hidden')) gsap.set(elLogo, { scale: 0.9, opacity: 0 });
                
                tl.to(elPanel, { duration: 1.0, clipPath: "inset(0 0% 0 0)", opacity: 1, ease: "expo.out" });
                if(elLogo && !elLogo.classList.contains('hidden')) tl.to(elLogo, { duration: 0.8, scale: 1, opacity: 1, ease: "power2.out" }, "-=0.8");
                tl.to(elName, { duration: 0.9, y: 0, opacity: 1, ease: "expo.out" }, "-=0.9")
                  .to(elTitle, { duration: 0.9, y: 0, opacity: 1, ease: "expo.out" }, "-=0.8");
                
                if (elSubtitle2 && !elSubtitle2.classList.contains('hidden')) {
                    tl.to(ltSeparator, { duration: 0.8, opacity: 1, scaleX: 1, transformOrigin: "left", ease: "expo.out" }, "-=0.8")
                      .to(elSubtitle2, { duration: 0.9, y: 0, opacity: 1, ease: "expo.out" }, "-=0.7");
                }
            } else {
                // Smooth reveal for lyrics
                if (currentAnimation === 'elasticDrop') {
                    gsap.set(container, { y: -100, opacity: 0 });
                    tl.to(container, { duration: 1.0, y: 0, opacity: 1, ease: "back.out(1.7)" });
                } else {
                    gsap.set(container, { y: 50, opacity: 0 });
                    tl.to(container, { duration: 1.2, y: 0, opacity: 1, ease: "expo.out" });
                }
            }
            break;
    }
}

export function applyAnimationOut(tl, container, currentAnimation, isElasticPanel, els = {}) {
    const { elPanel, elName, elTitle, elSubtitle2, ltSeparator } = els;

    switch (currentAnimation) {
        case 'none':
            gsap.set(container, { opacity: 0 });
            break;
        case 'slideRight':
            tl.to(container, { duration: 0.8, x: 300, opacity: 0, ease: "expo.in" });
            break;
        case 'slideLeft':
            tl.to(container, { duration: 0.8, x: -300, opacity: 0, ease: "expo.in" });
            break;
        case 'slideUp':
            tl.to(container, { duration: 0.8, y: -150, opacity: 0, ease: "expo.in" });
            break;
        case 'fade':
            tl.to(container, { duration: 0.8, opacity: 0, ease: "power2.inOut" });
            break;
        case 'zoom':
            tl.to(container, { duration: 0.8, scale: 0.85, opacity: 0, ease: "expo.in" });
            break;
        case 'blur':
            tl.to(container, { duration: 0.8, filter: "blur(20px)", opacity: 0, ease: "expo.in" });
            break;
        case 'flip':
            tl.to(container, { duration: 0.8, rotationX: 90, opacity: 0, ease: "expo.in" });
            break;
        case 'spin':
            tl.to(container, { duration: 0.8, rotation: 15, scale: 0.95, opacity: 0, ease: "expo.in" });
            break;
        case 'bounce':
            tl.to(container, { duration: 0.8, y: 150, opacity: 0, ease: "expo.in" });
            break;
        case 'elasticDrop':
            tl.to(container, { duration: 0.8, y: -150, opacity: 0, ease: "expo.in" });
            break;
        case 'wipe':
            if (isElasticPanel && elPanel) {
                tl.to([elName, elTitle, elSubtitle2], { duration: 0.35, x: -20, opacity: 0, stagger: 0.04, ease: "power2.in" })
                  .to(elPanel, { duration: 0.55, clipPath: "inset(0 100% 0 0)", ease: "power3.in" }, "-=0.15");
            } else {
                tl.to(container, { duration: 0.6, clipPath: "inset(0 100% 0 0)", opacity: 0, ease: "power3.in" });
            }
            break;
        case 'stagger':
            if (isElasticPanel && elPanel) {
                tl.to([elSubtitle2, elTitle, elName], { duration: 0.35, y: 20, opacity: 0, stagger: 0.06, ease: "power2.in" })
                  .to(elPanel, { duration: 0.45, y: 20, opacity: 0, ease: "power2.in" }, "-=0.15");
            } else {
                tl.to(container, { duration: 0.7, y: 35, opacity: 0, ease: "power2.in" });
            }
            break;
        case 'typeOn':
            if (isElasticPanel && elPanel) {
                tl.to([elSubtitle2, elTitle, elName], { duration: 0.15, opacity: 0, stagger: 0.05, ease: "none" })
                  .to(elPanel, { duration: 0.45, clipPath: "inset(0 100% 0 0)", opacity: 0, ease: "power2.in" }, "-=0.05");
            } else {
                tl.to(container, { duration: 0.45, opacity: 0, ease: "steps(6)" });
            }
            break;
        case 'elastic':
        default:
            if (isElasticPanel && elPanel) {
                tl.to([elName, elTitle, elSubtitle2], { duration: 0.6, y: 30, opacity: 0, ease: "expo.in" })
                  .to(ltSeparator, { duration: 0.5, opacity: 0, scaleX: 0, ease: "expo.in" }, "-=0.4")
                  .to(elPanel, { duration: 0.8, clipPath: "inset(0 100% 0 0)", opacity: 0, ease: "expo.in" }, "-=0.3");
            } else {
                tl.to(container, { duration: 0.8, y: 50, opacity: 0, ease: "expo.in" });
            }
            break;
    }
}
