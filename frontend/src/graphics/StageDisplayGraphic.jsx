import { useState, useEffect, useRef } from 'react';
import PresentationGraphic from './PresentationGraphic';

function interpolateColor(color1, color2, factor) {
    const safeFactor = Math.max(0, Math.min(1, factor));
    const result = color1.slice();
    for (let i = 0; i < 3; i++) {
        result[i] = Math.round(result[i] + safeFactor * (color2[i] - color1[i]));
    }
    return `rgb(${result[0]}, ${result[1]}, ${result[2]})`;
}

const colorBlue = [59, 130, 246];
const colorRed = [239, 68, 68];
const monitorBg = '#0d0d0c';
const monitorShell = '#181715';
const monitorPanel = '#22201d';
const monitorBorder = '#4a443a';
const monitorBorderSoft = '#383329';

export default function StageDisplayGraphic({ socket, windowMode }) {
    const [clock, setClock] = useState('');
    const [stagePresActive, setStagePresActive] = useState(false);

    const [timerText, setTimerText] = useState('--:--');
    const [isNegative, setIsNegative] = useState(false);
    const [negFlash, setNegFlash] = useState(true);
    const [negWhite, setNegWhite] = useState(false);
    const [progressPct, setProgressPct] = useState(100);
    const [progressColor, setProgressColor] = useState('rgb(59, 130, 246)');
    const countdownIntervalRef = useRef(null);

    const [messageData, setMessageData] = useState(null);
    const [presentationState, setPresentationState] = useState(null);

    const msgContainerRef = useRef(null);
    const msgTextRef = useRef(null);

    useEffect(() => {
        if (windowMode !== 'stage') return;
        const updateClock = () => {
            const now = new Date();
            let h = now.getHours();
            let m = now.getMinutes();
            let s = now.getSeconds();
            const ampm = h >= 12 ? 'PM' : 'AM';
            h = h % 12 || 12;
            setClock(`${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')} ${ampm}`);
        };
        updateClock();
        const interval = setInterval(updateClock, 1000);
        return () => clearInterval(interval);
    }, [windowMode]);

    useEffect(() => {
        if (!socket || windowMode !== 'stage') return;

        const handleTimerUpdate = (data = {}) => {
            if (countdownIntervalRef.current) clearInterval(countdownIntervalRef.current);

            const endTime = data.endTime;
            const stageTotalSeconds = data.totalSeconds || 0;
            const timerMode = data.mode || 'down';
            const startTime = data.startTime || Date.now();

            const updateTimer = () => {
                const now = Date.now();

                if (timerMode === 'clock') {
                    const d = new Date();
                    let h = d.getHours();
                    const m = d.getMinutes();
                    const s = d.getSeconds();
                    const ampm = h >= 12 ? 'PM' : 'AM';
                    h = h % 12 || 12;
                    setTimerText(`${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')} ${ampm}`);
                    setIsNegative(false);
                    setProgressPct(100);
                    setProgressColor(`rgb(${colorBlue.join(',')})`);
                    return;
                }

                if (timerMode === 'up') {
                    const elapsedMs = now - startTime;
                    if (stageTotalSeconds > 0 && elapsedMs > stageTotalSeconds * 1000) {
                        const overtimeSec = Math.floor((elapsedMs - stageTotalSeconds * 1000) / 1000);
                        setTimerText(`-${String(Math.floor(overtimeSec / 60)).padStart(2, '0')}:${String(overtimeSec % 60).padStart(2, '0')}`);
                        setIsNegative(true);
                        setProgressPct(0);
                        setProgressColor(`rgb(${colorRed.join(',')})`);
                    } else {
                        const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
                        setTimerText(`${String(Math.floor(totalSeconds / 60)).padStart(2, '0')}:${String(totalSeconds % 60).padStart(2, '0')}`);
                        setIsNegative(false);
                        if (stageTotalSeconds > 0) {
                            const pct = elapsedMs / (stageTotalSeconds * 1000);
                            setProgressPct(Math.min(100, pct * 100));
                            setProgressColor(interpolateColor(colorBlue, colorRed, pct));
                        } else {
                            setProgressPct(100);
                            setProgressColor(`rgb(${colorBlue.join(',')})`);
                        }
                    }
                    return;
                }

                const diffMs = endTime - now;
                const isNeg = diffMs < 0;
                const totalSeconds = Math.floor(Math.abs(diffMs) / 1000);
                setTimerText(`${isNeg ? '-' : ''}${String(Math.floor(totalSeconds / 60)).padStart(2, '0')}:${String(totalSeconds % 60).padStart(2, '0')}`);
                setIsNegative(isNeg);

                if (stageTotalSeconds > 0) {
                    if (isNeg) {
                        setProgressPct(0);
                        setProgressColor(`rgb(${colorRed.join(',')})`);
                    } else {
                        const pct = diffMs / (stageTotalSeconds * 1000);
                        setProgressPct(pct * 100);
                        setProgressColor(interpolateColor(colorBlue, colorRed, 1 - pct));
                    }
                } else {
                    setProgressPct(100);
                    setProgressColor(`rgb(${colorBlue.join(',')})`);
                }
            };

            updateTimer();
            countdownIntervalRef.current = setInterval(updateTimer, 100);
        };

        const handleTimerPause = () => {
            if (countdownIntervalRef.current) clearInterval(countdownIntervalRef.current);
        };
        const handleTimerStop = () => {
            if (countdownIntervalRef.current) clearInterval(countdownIntervalRef.current);
            countdownIntervalRef.current = null;
            setTimerText('--:--');
            setIsNegative(false);
            setProgressPct(100);
            setProgressColor('rgb(59, 130, 246)');
        };
        const handleMessageUpdate = (data) => {
            if (typeof data === 'string') {
                setMessageData({
                    text: data,
                    format: { color: 'default', bold: false, upper: false, sizeOffset: 0, flash: false }
                });
            } else {
                setMessageData(data);
            }
        };
        socket.on('stage_pres_toggle_update', setStagePresActive);
        socket.on('stage_neg_flash_update', setNegFlash);
        socket.on('stage_neg_white_update', setNegWhite);
        socket.on('stage_timer_update', handleTimerUpdate);
        socket.on('stage_timer_pause', handleTimerPause);
        socket.on('stage_timer_stop', handleTimerStop);
        socket.on('stage_message_update', handleMessageUpdate);
        socket.on('pres_update', setPresentationState);

        return () => {
            socket.off('stage_pres_toggle_update', setStagePresActive);
            socket.off('stage_neg_flash_update', setNegFlash);
            socket.off('stage_neg_white_update', setNegWhite);
            socket.off('stage_timer_update', handleTimerUpdate);
            socket.off('stage_timer_pause', handleTimerPause);
            socket.off('stage_timer_stop', handleTimerStop);
            socket.off('stage_message_update', handleMessageUpdate);
            socket.off('pres_update', setPresentationState);
            if (countdownIntervalRef.current) clearInterval(countdownIntervalRef.current);
        };
    }, [socket, windowMode]);

    useEffect(() => {
        if (socket && windowMode === 'stage') {
            socket.emit('request_stage_state');
        }
    }, [socket, windowMode]);

    useEffect(() => {
        if (!messageData?.text) return;

        const baseRem = stagePresActive ? 4.2 : 7.5;
        const offset = messageData.format?.sizeOffset || 0;
        const targetRem = Math.max(2.5, baseRem + offset);
        const textEl = msgTextRef.current;
        const containerEl = msgContainerRef.current;

        if (textEl && containerEl) {
            textEl.style.fontSize = `${targetRem}rem`;
            setTimeout(() => {
                let currentRem = targetRem;
                while ((textEl.offsetHeight > containerEl.clientHeight || textEl.offsetWidth > containerEl.clientWidth) && currentRem > 1.5) {
                    currentRem -= 0.4;
                    textEl.style.fontSize = `${currentRem}rem`;
                }
            }, 50);
        }
    }, [messageData, stagePresActive]);

    if (windowMode !== 'stage') return null;

    const hasMessage = Boolean(messageData?.text?.trim());

    let msgClasses = 'whitespace-pre-wrap leading-tight text-center max-w-full ';
    if (messageData?.format?.flash) msgClasses += 'animate-[flashAttention_0.4s_infinite_alternate] text-red-400 font-black ';
    else if (messageData?.format?.color === 'green') msgClasses += 'text-emerald-400 ';
    else if (messageData?.format?.color === 'red') msgClasses += 'text-red-400 ';
    else msgClasses += 'text-white ';
    msgClasses += messageData?.format?.bold ? 'font-black ' : 'font-bold ';
    if (messageData?.format?.upper) msgClasses += 'uppercase ';

    let timerClasses = 'leading-none font-black transition-all duration-500 ';
    const textLen = timerText.length;
    if (stagePresActive) {
        timerClasses += textLen > 8 ? 'text-[5.8rem] ' : 'text-[7.5rem] ';
    } else if (hasMessage) {
        timerClasses += textLen > 8 ? 'text-[10rem] ' : 'text-[16rem] ';
    } else {
        timerClasses += textLen > 8 ? 'text-[20rem] ' : 'text-[32rem] ';
    }
    if (isNegative) {
        timerClasses += negWhite ? 'text-white ' : 'text-red-500 drop-shadow-[0_0_40px_rgba(239,68,68,0.65)] ';
        if (negFlash) timerClasses += 'animate-[flashRed_1s_infinite_alternate] ';
    } else {
        timerClasses += 'text-white ';
    }

    const timerPanel = (
        <div
            id="stage-timer-box"
            className={`relative overflow-hidden border shadow-2xl transition-all duration-500 ${
                stagePresActive ? 'h-40 rounded-none border-x-0 border-t-0 px-12' : 'flex flex-1 flex-col rounded-2xl p-8'
            }`}
            style={{ backgroundColor: monitorPanel, borderColor: monitorBorder }}
        >
            <div className={`flex h-full items-center ${stagePresActive ? 'justify-center' : 'justify-center'}`}>
                <div className="absolute left-10 top-8 text-3xl font-bold uppercase tracking-widest text-[#8d8273]">
                    Timer
                </div>
                <div id="stage-timer" className={timerClasses} style={{ fontVariantNumeric: 'tabular-nums' }}>
                    {timerText}
                </div>
                <div className={`absolute right-10 font-semibold tracking-wide text-[#8d8273] tabular-nums ${stagePresActive ? 'text-4xl' : 'top-8 text-5xl'}`}>
                    {clock}
                </div>
            </div>
            <div className={`absolute bottom-0 left-0 overflow-hidden ${stagePresActive ? 'h-3 w-full' : 'h-7 w-full'}`} style={{ backgroundColor: monitorBorderSoft }}>
                <div id="graphics-timer-progress" className="h-full transition-all duration-100 ease-linear" style={{ width: `${progressPct}%`, backgroundColor: progressColor }} />
            </div>
        </div>
    );

    const messagePanel = hasMessage ? (
        <div
            id="stage-msg-box"
            className={`${stagePresActive
                ? 'rounded-2xl border border-red-300/20 p-7 shadow-2xl backdrop-blur-xl'
                : 'flex min-h-0 flex-1 flex-col rounded-2xl border border-red-400/20 p-8 shadow-2xl'}`}
            style={{ backgroundColor: stagePresActive ? 'rgba(16, 16, 15, 0.9)' : monitorPanel }}
        >
            <div className="mb-4 text-3xl font-bold uppercase tracking-[0.18em] text-red-300">Message</div>
            <div id="stage-msg-container" ref={msgContainerRef} className="flex min-h-0 flex-grow items-center justify-center overflow-hidden">
                <div id="stage-message" ref={msgTextRef} className={msgClasses}>
                    {messageData?.text || ''}
                </div>
            </div>
        </div>
    ) : null;

    if (stagePresActive) {
        return (
            <div id="stage-display-overlay" className="absolute inset-0 z-[5000] flex flex-col overflow-hidden" style={{ backgroundColor: monitorBg }}>
                <div className="relative z-[5250] flex-none">{timerPanel}</div>
                <div id="stage-pres-box" className="relative min-h-0 flex-1 bg-black">
                    <PresentationGraphic
                        socket={socket}
                        windowMode={windowMode}
                        isStageDisplaySlot={true}
                        stagePresActive={true}
                        presentationState={presentationState}
                    />
                </div>
                {hasMessage && (
                    <div className="relative z-[5300] flex-none px-8 py-6" style={{ backgroundColor: monitorShell }}>
                        {messagePanel}
                    </div>
                )}
                <style>{`
                    @keyframes flashRed { 0% { opacity: 1; } 100% { opacity: 0.55; } }
                    @keyframes flashAttention { 0% { transform: scale(1); text-shadow: 0 0 22px rgba(239, 68, 68, 0.85); } 100% { transform: scale(1.025); text-shadow: 0 0 60px rgba(255, 255, 255, 0.95); } }
                `}</style>
            </div>
        );
    }

    return (
        <div id="stage-display-overlay" className="absolute inset-0 z-[5000]" style={{ backgroundColor: monitorBg }}>
            <div className="flex h-full flex-col gap-6 overflow-hidden p-12">
                {timerPanel}
                {messagePanel}
                {!hasMessage && (
                    <div
                        className="flex h-28 items-center justify-center rounded-2xl border text-3xl font-bold uppercase tracking-[0.18em] text-[#8d8273]"
                        style={{ backgroundColor: monitorShell, borderColor: monitorBorderSoft }}
                    >
                        Stage display ready
                    </div>
                )}
            </div>
            <style>{`
                @keyframes flashRed { 0% { opacity: 1; } 100% { opacity: 0.55; } }
                @keyframes flashAttention { 0% { transform: scale(1); text-shadow: 0 0 22px rgba(239, 68, 68, 0.85); } 100% { transform: scale(1.025); text-shadow: 0 0 60px rgba(255, 255, 255, 0.95); } }
            `}</style>
        </div>
    );
}
