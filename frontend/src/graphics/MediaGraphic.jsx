import { useState, useEffect, useRef } from 'react';
import { authUrl } from '../auth';
import { createThrottledEmitter } from '../utils/performance';

export default function MediaGraphic({ socket, windowMode }) {
    const [mediaData, setMediaData] = useState(null);
    const [photoData, setPhotoData] = useState(null);
    const [loop, setLoop] = useState(false);
    const [autoNext, setAutoNext] = useState(false);
    const [muted, setMuted] = useState(false);

    const containerRef = useRef(null);
    const ytPlayerRef = useRef(null);
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

        socket.on('media_play', (data) => {
            stopMediaTracking();
            setMediaData(data);
            if (data.loop !== undefined) setLoop(data.loop);
            if (data.autoNext !== undefined) setAutoNext(data.autoNext);
            if (data.muted !== undefined) setMuted(data.muted);
        });

        socket.on('media_set_loop', (state) => setLoop(state));
        socket.on('media_set_auto_next', (state) => setAutoNext(state));
        socket.on('media_set_muted', (state) => setMuted(state));

        socket.on('media_stop', () => {
            stopMediaTracking();
            stopAudioLevelTracking();
            setMediaData(null);
        });

        socket.on('media_seek', (time) => {
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
        });

        socket.on('media_toggle_play', (shouldPlay) => {
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
        });

        socket.on('photo_play', (data) => setPhotoData(data));
        socket.on('photo_stop', () => setPhotoData(null));

        socket.emit('request_media_state');

        return () => {
            socket.off('media_play');
            socket.off('media_stop');
            socket.off('media_seek');
            socket.off('media_toggle_play');
            socket.off('photo_play');
            socket.off('photo_stop');
            stopMediaTracking();
            stopAudioLevelTracking();
        };
    }, [socket, windowMode]);

    // Initialize YouTube API only once
    useEffect(() => {
        if (!window.onYouTubeIframeAPIReady) {
            window.onYouTubeIframeAPIReady = () => {
                console.log("YouTube API Ready");
            };
            if (!document.querySelector('script[src*="youtube.com/iframe_api"]')) {
                const tag = document.createElement('script');
                tag.src = "https://www.youtube.com/iframe_api";
                const firstScriptTag = document.getElementsByTagName('script')[0];
                if (firstScriptTag) {
                    firstScriptTag.parentNode.insertBefore(tag, firstScriptTag);
                } else {
                    document.head.appendChild(tag);
                }
            }
        }
    }, []);

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

        if (mediaData.type === 'youtube') {
            // Wait for DOM to render the container
            setTimeout(() => {
                const container = document.getElementById('yt-player-container');
                if (!container) return; // Not ready yet

                if (!window.YT || !window.YT.Player) {
                    console.error("YouTube API not loaded");
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
                        }
                    }
                });
            }, 50);
        } else if (mediaData.type === 'local') {
            // Give local video a moment to mount
            setTimeout(() => {
                startMediaTracking();
                startAudioLevelTracking();
            }, 100);
        }

        return () => {
            stopMediaTracking();
            stopAudioLevelTracking();
        };
    }, [mediaData]);

    useEffect(() => {
        if (mediaData?.type === 'youtube' && ytPlayerRef.current) {
            if (muted) ytPlayerRef.current.mute();
            else ytPlayerRef.current.unMute();
        }
    }, [muted, mediaData]);

    if (windowMode === 'stage') return null;
    if (!mediaData && !photoData) return null;

    const isPreview = isPassiveOutput;

    return (
        <>
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
                            src={authUrl('/stream-video', mediaData.mediaId ? { mediaId: mediaData.mediaId } : { path: mediaData.path })} 
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
                            src={authUrl('/stream-video', photoData.mediaId ? { mediaId: photoData.mediaId } : { path: photoData.path })} 
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
        </>
    );
}
