import { useCallback, useEffect, useRef } from 'react';

export const DEFAULT_THROTTLE_MS = 200;

export function readLocalStorageArraySafe(key, fallback = []) {
    try {
        const parsed = JSON.parse(localStorage.getItem(key));
        return Array.isArray(parsed) ? parsed : fallback;
    } catch {
        return fallback;
    }
}

export function readLocalStorageObjectSafe(key, fallback = {}) {
    try {
        const parsed = JSON.parse(localStorage.getItem(key));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
    } catch {
        return fallback;
    }
}

export function deferUntilIdle(callback, timeout = 120) {
    if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
        const id = window.requestIdleCallback(callback, { timeout: 1000 });
        return () => window.cancelIdleCallback?.(id);
    }
    const id = window.setTimeout(callback, timeout);
    return () => window.clearTimeout(id);
}

export function createThrottledEmitter(callback, wait = DEFAULT_THROTTLE_MS) {
    let lastRun = 0;
    let timer = null;
    let lastArgs = null;

    const flush = () => {
        timer = null;
        lastRun = Date.now();
        callback(...lastArgs);
        lastArgs = null;
    };

    const throttled = (...args) => {
        lastArgs = args;
        const remaining = wait - (Date.now() - lastRun);
        if (remaining <= 0 || lastRun === 0) {
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
            flush();
            return;
        }
        if (!timer) timer = setTimeout(flush, remaining);
    };

    throttled.cancel = () => {
        if (timer) clearTimeout(timer);
        timer = null;
        lastArgs = null;
    };

    throttled.flush = () => {
        if (!lastArgs) return;
        if (timer) clearTimeout(timer);
        flush();
    };

    return throttled;
}

export function useThrottledCallback(callback, wait = DEFAULT_THROTTLE_MS) {
    const callbackRef = useRef(callback);
    const throttledRef = useRef(null);

    useEffect(() => {
        callbackRef.current = callback;
    }, [callback]);

    if (!throttledRef.current) {
        throttledRef.current = createThrottledEmitter((...args) => callbackRef.current(...args), wait);
    }

    useEffect(() => {
        const throttled = throttledRef.current;
        return () => throttled.cancel();
    }, []);

    return useCallback((...args) => throttledRef.current(...args), []);
}

export function useDebouncedLocalStorageEffect(key, value, delay = 400) {
    const didMountRef = useRef(false);

    useEffect(() => {
        if (!didMountRef.current) {
            didMountRef.current = true;
            return undefined;
        }

        const timer = setTimeout(() => {
            try {
                localStorage.setItem(key, JSON.stringify(value));
            } catch (error) {
                console.error(`Failed to persist ${key}:`, error);
            }
        }, delay);

        return () => clearTimeout(timer);
    }, [key, value, delay]);
}
