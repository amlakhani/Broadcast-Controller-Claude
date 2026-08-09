import { useEffect, useRef, useState } from 'react';

// Mounts children only once scrolled into view — keeps a 40-slide grid from
// spinning up 40 Google Slides iframes (or decoding 40 slide bitmaps) at once.
// Shared by the slides remote's "All Slides" sheet and the desktop Slides
// panel's grid, which have the same problem for the same reason.
export default function LazyMount({ children, className }) {
    const ref = useRef(null);
    const [visible, setVisible] = useState(false);

    useEffect(() => {
        const node = ref.current;
        if (!node || visible) return;
        if (typeof IntersectionObserver === 'undefined') {
            setVisible(true);
            return;
        }
        const observer = new IntersectionObserver((entries) => {
            if (entries.some(entry => entry.isIntersecting)) {
                setVisible(true);
                observer.disconnect();
            }
        }, { rootMargin: '200px' });
        observer.observe(node);
        return () => observer.disconnect();
    }, [visible]);

    return <div ref={ref} className={className}>{visible ? children : null}</div>;
}
