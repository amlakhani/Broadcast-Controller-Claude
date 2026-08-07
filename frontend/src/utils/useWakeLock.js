import { useEffect } from 'react';

// Holds a screen wake lock while `active` is true, re-acquiring when the page becomes visible
// again (the browser drops the lock whenever the tab is hidden or the device sleeps).
//
// Both remotes need this — a tablet that dims mid-service is a real operational problem — and
// they previously carried byte-identical 25-line copies of it.
export function useWakeLock(active) {
    useEffect(() => {
        if (!active || typeof navigator === 'undefined' || !navigator.wakeLock) return;
        let sentinel = null;
        let cancelled = false;

        const acquire = async () => {
            try {
                sentinel = await navigator.wakeLock.request('screen');
            } catch {
                // Unsupported or denied — not fatal.
            }
        };

        const onVisibility = () => {
            if (document.visibilityState === 'visible' && !cancelled) acquire();
        };

        acquire();
        document.addEventListener('visibilitychange', onVisibility);
        return () => {
            cancelled = true;
            document.removeEventListener('visibilitychange', onVisibility);
            sentinel?.release?.().catch(() => {});
        };
    }, [active]);
}
