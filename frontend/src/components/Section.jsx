import { useCallback, useRef } from 'react';
import { ChevronDown } from 'lucide-react';

function readStoredOpen(storageKey, fallback) {
    if (!storageKey) return fallback;
    try {
        const stored = localStorage.getItem(storageKey);
        if (stored === null) return fallback;
        return stored === 'true';
    } catch {
        return fallback;
    }
}

export default function Section({ icon: Icon, title, children, action, storageKey, defaultOpen = false }) {
    const initialOpenRef = useRef(null);
    if (initialOpenRef.current === null) {
        initialOpenRef.current = readStoredOpen(storageKey, defaultOpen);
    }

    const handleToggle = useCallback((e) => {
        if (!storageKey) return;
        try {
            localStorage.setItem(storageKey, String(e.currentTarget.open));
        } catch {
            /* storage unavailable — open state simply won't persist */
        }
    }, [storageKey]);

    return (
        <details className="surface group rounded-lg" open={initialOpenRef.current} onToggle={handleToggle}>
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3">
                <div className="flex items-center gap-2">
                    {Icon && (
                        <span className="surface-muted flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 dark:text-slate-300">
                            <Icon className="h-4 w-4" />
                        </span>
                    )}
                    <h4 className="text-xs font-bold uppercase tracking-widest text-slate-600 dark:text-slate-300">{title}</h4>
                </div>
                <div className="flex items-center gap-3">
                    {action && (
                        <span onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}>
                            {action}
                        </span>
                    )}
                    <ChevronDown className="h-4 w-4 text-slate-400 transition group-open:rotate-180" />
                </div>
            </summary>
            <div className="border-t section-rule px-4 py-4">
                {children}
            </div>
        </details>
    );
}
