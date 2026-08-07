import { useState, useEffect, useRef } from 'react';
import { authUrl } from '../auth';
import { createThrottledEmitter } from '../utils/performance';
import { LAYER_Z } from './layerZ';

export default function MediaGraphic({ socket, windowMode }) {
    const [mediaData, setMediaData] = useState(null);
    const [photoData, setPhotoData] = useState(null);
    const [loop, setLoop] = useState(false);
    const [autoNext, setAutoNext] = useState(false);
    const [muted, setMuted] = useState(false);

    const containerRef = useRef(null);
    const ytPlayerRef = useRef(null);
    const ytRetryTimerRef = useRef(null);
    const localVideoRef = useRef(null);
    const mediaIntervalRef = useRef(null);
    const audioContextRef = useRef(null);
    const audioSourceRef = useRef(null);
    const audioAnalyserRef = useRef(null);
    const audioLevelTimerRef = useRef(null);
    const throttledTimeEmitRef = useRef(null);
    const throttledAudioEmitRef = useRef(null);
    const outputRole = new URLSearchParams(window.location.search);
    const isPassiveOutput = outputRole.get('preview') === 'true' || outputRole.get('ndi') === 'true';

    // Track state in refs for event listeners
    const loopRef = useRef(false);
    const autoNextRef = useRef(false);

    useEffect(() => {
        if (!socket) return undefined;
        throttledTimeEmitRef.current = createThrottledEmitter((payload) => {
            socket.emit('media_time_update', payload);
        }, 200);
        throttledAudioEmitRef.current = createThrottledEmitter((payload) => {
            socket.emit('media_audio_level', payload);
        }, 200);

        return () => {
            throttledTimeEmitRef.current?.cancel();
            throttledAudioEmitRef.current?.cancel();
            throttledTimeEmitRef.current = null;
            throttledAudioEmitRef.current = null;
        };
    }, [socket]);

    useEffect(() => {
        loopRef.current = loop;
        autoNextRef.current = autoNext;
    }, [loop, autoNext]);

    // Handle end of media
    const handleMediaEnd = () => {
        if (loopRef.current) {
            if (mediaData?.type === 'local' && localVideoRef.current) {
                localVideoRef.current.currentTime = 0;
                localVideoRef.current.play();
            } else if (mediaData?.type === 'youtube' && ytPlayerRef.current) {
                ytPlayerRef.current.seekTo(0);
                ytPlayerRef.current.playVideo();
            }
        } else if (autoNextRef.current && !isPassiveOutput) {
            socket.emit('media_next');
        }
    };

    const mediaDataRef = useRef(null);
    const isMutedRef = useRef(false);

    useEffect(() => {
        mediaDataRef.current = mediaData;
    }, [mediaData]);

    useEffect(() => {
        isMutedRef.current = muted;
    }, [muted]);

    // Cleanup helper
    const stopMediaTracking = () => {
        if (mediaIntervalRef.current) clearInterval(mediaIntervalRef.current);
        mediaIntervalRef.current = null;
    };

    const stopAudioLevelTracking = () => {
        if (audioLevelTimerRef.current) clearInterval(audioLevelTimerRef.current);
        audioLevelTimerRef.current = null;
        if (audioSourceRef.current) {
            try { audioSourceRef.current.disconnect(); } catch (e) {}
            audioSourceRef.current = null;
        }
        if (audioAnalyserRef.current) {
            try { audioAnalyserRef.current.disconnect(); } catch (e) {}
            audioAnalyserRef.current = null;
        }
        if (audioContextRef.current) {
            try { audioContextRef.current.close(); } catch (e) {}
            audioContextRef.current = null;
        }
    };

    const startAudioLevelTracking = () => {
        stopAudioLevelTracking();
        if (isPassiveOutput || !socket || mediaDataRef.current?.type !== 'local' || !localVideoRef.current) return;

        try {
            const AudioContextClass = window.AudioContext || window.webkitAudioContext;
            if (!AudioContextClass) return;

            const audioContext = new AudioContextClass();
            const analyser = audioContext.createAnalyser();
            analyser.fftSize = 256;
            analyser.smoothingTimeConstant = 0.75;

            const source = audioContext.createMediaElementSource(localVideoRef.current);
            source.connect(analyser);
            analyser.connect(audioContext.destination);

            const samples = new Uint8Array(analyser.frequencyBinCount);
            audioContextRef.current = audioContext;
            audioSourceRef.current = source;
            audioAnalyserRef.current = analyser;

            audioLevelTimerRef.current = setInterval(() => {
                if (!audioAnalyserRef.current) return;
                audioAnalyserRef.current.getByteFrequencyData(samples);
                const average = samples.reduce((sum, value) => sum + value, 0) / samples.length;
                throttledAudioEmitRef.current?.({
                    level: isMutedRef.current ? 0 : Math.min(1, average / 160),
                    muted: isMutedRef.current,
                    ts: Date.now()
                });
            }, 200);
        } catch (error) {
            console.warn('Audio level tracking unavailable:', error);
            stopAudioLevelTracking();
        }
    };

    // Start tracking helper — only emit from the real graphics output, not preview iframes
    const startMediaTracking = () => {
        stopMediaTracking();
        if (isPassiveOutput) return; // Don't emit time updates from preview/NDI windows
        mediaIntervalRef.current = setInterval(() => {
            const currentMedia = mediaDataRef.current;
            if (currentMedia?.type === 'local' && localVideoRef.current) {
                const vid = localVideoRef.current;
                if (vid.duration) {
                    throttledTimeEmitRef.current?.({
                        currentTime: vid.currentTime,
                        duration: vid.duration
                    });
                }
            } else if (currentMedia?.type === 'youtube' && ytPlayerRef.current?.getCurrentTime) {
                const player = ytPlayerRef.current;
                try {
                    if (player.getDuration && player.getDuration() > 0) {
                        throttledTimeEmitRef.current?.({
                            currentTime: player.getCurrentTime(),
                            duration: player.getDuration()
                        });
                    }
                } catch (e) {}
            }
        }, 500);
    };

    const emitLocalVideoTime = ({ immediate = false } = {}) => {
        if (isPassiveOutput || !socket || !localVideoRef.current) return;
        const vid = localVideoRef.current;
        if (!Number.isFinite(vid.duration) || vid.duration <= 0) return;
        const payload = {
            currentTime: vid.currentTime || 0,
            duration: vid.duration
        };
        if (immediate) {
            throttledTimeEmitRef.current?.cancel();
            socket.emit('media_time_update', payload);
            return;
        }
        throttledTimeEmitRef.current?.(payload);
    };

    useEffect(() => {
        if (!socket || windowMode === 'stage') return;

        // Every handler is named and removed by reference below. Previously three of them were
        // anonymous and never removed at all, and the rest were removed with the argument-less
        // socket.off('event') form — which drops EVERY listener for that event on a socket that
        // is shared at module scope by all the graphics layers.
        const handleMediaPlay = (data) => {
            stopMediaTracking();
            setMediaData(data);
            if (data.loop !== undefined) setLoop(data.loop);
            if (data.autoNext !== undefined) setAutoNext(data.autoNext);
            if (data.muted !== undefined) setMuted(data.muted);
        };
        const handleSetLoop = (state) => setLoop(state);
        const handleSetAutoNext = (state) => setAutoNext(state);
        const handleSetMuted = (state) => setMuted(state);
        const handleMediaStop = () => {
            stopMediaTracking();
            stopAudioLevelTracking();
            setMediaData(null);
        };
        const handlePhotoPlay = (data) => setPhotoData(data);
        const handlePhotoStop = () => setPhotoData(null);

        socket.on('media_play', handleMediaPlay);
        socket.on('media_set_loop', handleSetLoop);
        socket.on('media_set_auto_next', handleSetAutoNext);
        socket.on('media_set_muted', handleSetMuted);
        socket.on('media_stop', handleMediaStop);

        const handleMediaSeek = (time) => {
            const currentMedia = mediaDataRef.current;
            if (currentMedia?.type === 'local' && localVideoRef.current) {
                const vid = localVideoRef.current;
                const targetTime = Number(time);
                if (Number.isFinite(targetTime)) {
                    const maxTime = Number.isFinite(vid.duration) ? vid.duration : targetTime;
                    vid.currentTime = Math.min(Math.max(0, targetTime), maxTime);
                    emitLocalVideoTime({ immediate: true });
                }
            } else if (currentMedia?.type === 'youtube' && ytPlayerRef.current?.seekTo) {
                try { ytPlayerRef.current.seekTo(time, true); } catch(e) {}
            }
        };

        const handleTogglePlay = (shouldPlay) => {
            const currentMedia = mediaDataRef.current;
            if (currentMedia?.type === 'local' && localVideoRef.current) {
                if (shouldPlay) localVideoRef.current.play();
                else localVideoRef.current.pause();
            } else if (currentMedia?.type === 'youtube' && ytPlayerRef.current?.playVideo) {
                try {
                    if (shouldPlay) ytPlayerRef.current.playVideo();
                    else ytPlayerRef.current.pauseVideo();
                } catch(e) {}
            }
        };

        socket.on('media_seek', handleMediaSeek);
        socket.on('media_toggle_play', handleTogglePlay);
        socket.on('photo_play', handlePhotoPlay);
        socket.on('photo_stop', handlePhotoStop);

        socket.emit('request_media_state');

        return () => {
            socket.off('media_play', handleMediaPlay);
            socket.off('media_set_loop', handleSetLoop);
            socket.off('media_set_auto_next', handleSetAutoNext);
            socket.off('media_set_muted', handleSetMuted);
            socket.off('media_stop', handleMediaStop);
            socket.off('media_seek', handleMediaSeek);
            socket.off('media_toggle_play', handleTogglePlay);
            socket.off('photo_play', handlePhotoPlay);
            socket.off('photo_stop', handlePhotoStop);
            stopMediaTracking();
            stopAudioLevelTracking();
        };
    }, [socket, windowMode]);

    // Injected on first actual YouTube playback rather than on mount, so an output window that
    // never plays a YouTube item makes no external request at all. graphics.html used to load
    // this eagerly in <head>, which stalled the on-air renderer's parse whenever the network
    // was slow or blocked.
    const ensureYouTubeApi = () => {
        if (document.querySelector('script[src*="youtube.com/iframe_api"]')) return;
        if (!window.onYouTubeIframeAPIReady) {
            window.onYouTubeIframeAPIReady = () => {};
        }
        const tag = document.createElement('script');
        tag.src = 'https://www.youtube.com/iframe_api';
        document.head.appendChild(tag);
    };

    // Handle initialization when mediaData changes
    useEffect(() => {
        if (!mediaData || mediaData.type !== 'youtube') {
            // Clean up YT player if it exists
            if (ytPlayerRef.current && ytPlayerRef.current.destroy) {
                try {
                    ytPlayerRef.current.destroy();
                } catch (e) {}
                ytPlayerRef.current = null;
            }
                if (!mediaData) return;
        }

        const isPreview = isPassiveOutput;
        let cancelled = false;

        if (mediaData.type === 'youtube') {
            ensureYouTubeApi();
            const MAX_ATTEMPTS = 40; // ~2s at 50ms between attempts

            const tryInitYouTubePlayer = (attempt = 0) => {
                if (cancelled) return;

                const container = document.getElementById('yt-player-container');
                const apiReady = window.YT && window.YT.Player;

                if (!container || !apiReady) {
                    if (attempt >= MAX_ATTEMPTS) {
                        console.error(!container
                            ? "YouTube player container never mounted; giving up"
                            : "YouTube iframe API never became ready; giving up");
                        return;
                    }
                    ytRetryTimerRef.current = setTimeout(() => tryInitYouTubePlayer(attempt + 1), 50);
                    return;
                }

                // If player already exists, check if it's still healthy
                if (ytPlayerRef.current && ytPlayerRef.current.getIframe) {
                    const iframe = ytPlayerRef.current.getIframe();
                    if (iframe && document.body.contains(iframe)) {
                        try {
                            ytPlayerRef.current.loadVideoById(mediaData.id);
                            if (isPreview || muted) ytPlayerRef.current.mute();
                            else ytPlayerRef.current.unMute();
                            return;
                        } catch (e) {
                            console.log("Player error, re-initializing...");
                        }
                    }
                }

                // If we reach here, we need a new player
                if (ytPlayerRef.current && ytPlayerRef.current.destroy) {
                    try { ytPlayerRef.current.destroy(); } catch(e) {}
                }

                ytPlayerRef.current = new window.YT.Player('yt-player-container', {
                    videoId: mediaData.id,
                    playerVars: {
                        autoplay: 1,
                        controls: 0,
                        rel: 0,
                        modestbranding: 1,
                        enablejsapi: 1,
                        mute: (isPreview || muted) ? 1 : 0
                    },
                    events: {
                        onReady: (event) => {
                            event.target.playVideo();
                            if (isPreview || muted) event.target.mute();
                            startMediaTracking();
                        },
                        onStateChange: (event) => {
                            // YT.PlayerState.ENDED = 0
                            if (event.data === 0) {
                                handleMediaEnd();
                            }
                        },
                        onError: (event) => {
                            console.error("YouTube player error, code:", event.data);
                        }
                    }
                });
            };

            tryInitYouTubePlayer();
        } else if (mediaData.type === 'local') {
            // Give local video a moment to mount
            setTimeout(() => {
                startMediaTracking();
                startAudioLevelTracking();
            }, 100);
        }

        return () => {
            cancelled = true;
            if (ytRetryTimerRef.current) {
                clearTimeout(ytRetryTimerRef.current);
                ytRetryTimerRef.current = null;
            }
            stopMediaTracking();
            stopAudioLevelTracking();
        };
    }, [mediaData]);

    useEffect(() => {
        if (mediaData?.type === 'youtube' && ytPlayerRef.current) {
            // A freshly-constructed YT.Player can land in this same effect
            // flush before its postMessage handshake with the embedded
            // iframe completes, so mute/unMute may not exist yet. onReady
            // already applies the correct initial mute state, so it's safe
            // to just skip until the API is actually there.
            try {
                if (muted) ytPlayerRef.current.mute?.();
                else ytPlayerRef.current.unMute?.();
            } catch (e) {}
        }
    }, [muted, mediaData]);

    if (windowMode === 'stage') return null;
    if (!mediaData && !photoData) return null;

    const isPreview = isPassiveOutput;

    return (
        <div style={{ position: 'absolute', inset: 0, zIndex: LAYER_Z.media, isolation: 'isolate' }}>
            {mediaData && (
                <div
                    id="media-overlay"
                    key={`media-${mediaData.type}-${mediaData.id || mediaData.path}-${mediaData.ts || ''}`}
                    ref={containerRef}
                    className="absolute inset-0 bg-black flex items-center justify-center z-[6000]"
                >
                    {mediaData.type === 'youtube' && (
                        <div id="yt-player-container" className="w-full h-full pointer-events-none"></div>
                    )}
                    
                    {mediaData.type === 'local' && (
                        <video 
                            id="local-video-player" 
                            ref={localVideoRef}
                            className="w-full h-full object-contain"
                            src={mediaData.mediaId ? authUrl('/stream-video', { mediaId: mediaData.mediaId }) : undefined}
                            autoPlay 
                            muted={isPreview || muted}
                            onLoadedMetadata={emitLocalVideoTime}
                            onTimeUpdate={emitLocalVideoTime}
                            onSeeked={emitLocalVideoTime}
                            onEnded={handleMediaEnd}
                            onError={(e) => {
                                console.error("Video Error:", e);
                            }}
                        ></video>
                    )}

                    {mediaData.type === 'webpage' && (
                        <iframe
                            id="webpage-player"
                            src={mediaData.path}
                            className="w-full h-full border-none"
                            allow="autoplay; fullscreen"
                            allowFullScreen
                            style={{ pointerEvents: 'none' }}
                        ></iframe>
                    )}
                </div>
            )}

            {photoData && (
                <div 
                    id="photo-overlay"
                    key={`photo-${photoData.type}-${photoData.path}-${photoData.ts || ''}`}
                    className="absolute inset-0 bg-black flex items-center justify-center z-[6001]"
                >
                    {photoData.type === 'photo' && (
                        <img 
                            src={photoData.mediaId ? authUrl('/stream-video', { mediaId: photoData.mediaId }) : undefined}
                            className="w-full h-full object-contain"
                            alt={photoData.name || "Photo"} 
                        />
                    )}
                    {photoData.type === 'canva' && (() => {
                        // Normalize Canva URL to strict embed format
                        let embedUrl = photoData.path;
                        if (embedUrl.includes('canva.com')) {
                            try {
                                const urlObj = new URL(embedUrl);
                                let path = urlObj.pathname;
                                path = path.replace(/\/$/, '');
                                if (!path.endsWith('/view') && !path.endsWith('/watch')) {
                                    path = path.replace(/\/edit$/, '');
                                    if (!path.endsWith('/view')) path += '/view';
                                }
                                embedUrl = `https://www.canva.com${path}?embed`;
                            } catch (e) {
                                console.error("Canva normalization error", e);
                            }
                        }

                        return (
                            <iframe
                                loading="lazy"
                                className="w-full h-full border-none"
                                src={embedUrl}
                                allowFullScreen="allowfullscreen"
                                allow="fullscreen"
                            ></iframe>
                        );
                    })()}
                </div>
            )}
        </div>
    );
}
