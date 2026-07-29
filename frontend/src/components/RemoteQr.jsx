import { useEffect, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { X } from 'lucide-react';

// The pairing code rides in the URL *fragment*: fragments are never sent to the server,
// so the credential stays out of request logs. RemotePairing strips it after use.
export function buildRemoteQrValue(url, code) {
    if (!url) return '';
    return code ? `${url}#c=${code}` : url;
}

function secondsLeft(expiresAt) {
    if (!expiresAt) return null;
    return Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
}

export default function RemoteQr({ url, code = '', expiresAt = 0, label = 'Remote' }) {
    const [isOpen, setIsOpen] = useState(false);
    const [remaining, setRemaining] = useState(() => secondsLeft(expiresAt));

    useEffect(() => {
        setRemaining(secondsLeft(expiresAt));
        if (!expiresAt) return undefined;
        const timer = setInterval(() => setRemaining(secondsLeft(expiresAt)), 1000);
        return () => clearInterval(timer);
    }, [expiresAt]);

    useEffect(() => {
        if (!isOpen) return undefined;
        const onKey = (event) => { if (event.key === 'Escape') setIsOpen(false); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [isOpen]);

    if (!url) return null;
    const value = buildRemoteQrValue(url, code);

    return (
        <>
            {/* Always black-on-white: a theme-aware "dark mode" QR is a classic scan failure. */}
            <button
                onClick={() => setIsOpen(true)}
                title={`Enlarge ${label} QR code`}
                aria-label={`Enlarge ${label} QR code`}
                className="shrink-0 rounded-md bg-white p-1.5 shadow-sm transition hover:scale-105 active:scale-95"
            >
                <QRCodeSVG value={value} size={72} level="M" bgColor="#ffffff" fgColor="#000000" />
            </button>

            {isOpen && (
                <div
                    className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
                    onMouseDown={() => setIsOpen(false)}
                >
                    <div
                        className="surface-raised flex w-full max-w-md flex-col items-center gap-4 rounded-3xl p-6 shadow-2xl"
                        onMouseDown={event => event.stopPropagation()}
                    >
                        <div className="flex w-full items-start justify-between gap-3">
                            <div>
                                <div className="text-base font-bold text-slate-800 dark:text-slate-100">{label}</div>
                                <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                                    {code ? 'Scan to open and pair automatically' : 'Scan to open on your phone'}
                                </div>
                            </div>
                            <button
                                onClick={() => setIsOpen(false)}
                                aria-label="Close"
                                className="rounded-full p-1.5 text-slate-500 transition hover:bg-slate-500/10 hover:text-slate-800 dark:hover:text-slate-100"
                            >
                                <X className="h-4 w-4" />
                            </button>
                        </div>

                        <div className="rounded-2xl bg-white p-4 shadow-inner">
                            <QRCodeSVG
                                value={value}
                                size={280}
                                level="M"
                                bgColor="#ffffff"
                                fgColor="#000000"
                                style={{ width: 'min(60vmin, 280px)', height: 'min(60vmin, 280px)' }}
                            />
                        </div>

                        <div className="w-full break-all text-center text-xs font-semibold text-slate-600 dark:text-slate-300">
                            {url}
                        </div>

                        {code ? (
                            <div className="w-full text-center">
                                <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Pairing Code</div>
                                <div className="surface mt-1 rounded-md px-3 py-2 text-2xl font-black tracking-[0.25em] text-slate-900 dark:text-white">
                                    {code}
                                </div>
                                {remaining !== null && (
                                    <div className="mt-1.5 text-[11px] font-semibold text-amber-600 dark:text-amber-400">
                                        {remaining > 0 ? `New code in ${remaining}s` : 'Refreshing code…'}
                                    </div>
                                )}
                            </div>
                        ) : null}
                    </div>
                </div>
            )}
        </>
    );
}
