import { useState, useEffect, useRef } from 'react';
import { Video, Play, Film, Trash2, GripVertical, Image as ImageIcon, Layout, Monitor, Trash, Grid, List, Globe, Folder, Upload, Type, X, Clock } from 'lucide-react';
import { authUrl } from '../auth';
import { ensureMediaIds, registerLocalMedia } from '../utils/localMedia';
import { deferUntilIdle, readLocalStorageArraySafe, useDebouncedLocalStorageEffect, useThrottledCallback } from '../utils/performance';
import { scheduleTick, localDateKey, formatCountdown, formatClock12, formatDays } from '../utils/schedule';

const WEEKDAY_OPTIONS = [['S', 0], ['M', 1], ['T', 2], ['W', 3], ['T', 4], ['F', 5], ['S', 6]];

const MEDIA_PLAYLIST_KEY = 'bc_media_playlist_v1';
const PHOTO_PLAYLIST_KEY = 'bc_photo_playlist_v1';
const SCHEDULED_PLAYS_KEY = 'bc_scheduled_plays_v1';
const VIEW_MODE_KEY = 'bc_media_view_mode';
const MEDIA_FOLDERS_KEY = 'bc_media_folders_v1';
const ACTIVE_FOLDER_KEY = 'bc_media_active_folder_v1';
const DEFAULT_FOLDER_ID = 'default';
const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'webm', 'mkv']);
const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp']);

const DEFAULT_FOLDERS = [{ id: DEFAULT_FOLDER_ID, name: 'Unsorted' }];

const getFileName = (filePath = '') => filePath.split(/[/\\]/).pop() || 'Local file';
const getExtension = (filePath = '') => getFileName(filePath).split('.').pop()?.toLowerCase() || '';
const isVideoPath = (filePath = '') => VIDEO_EXTENSIONS.has(getExtension(filePath));
const isImagePath = (filePath = '') => IMAGE_EXTENSIONS.has(getExtension(filePath));
const getFolderIdForNewItem = (activeFolderId) => activeFolderId === 'all' ? DEFAULT_FOLDER_ID : activeFolderId;

export default function MediaPanel({ socket, showParticleOverlayControls = false }) {
    const [playlist, setPlaylist] = useState([]);
    const [photoPlaylist, setPhotoPlaylist] = useState([]);

    const [youtubeUrl, setYoutubeUrl] = useState('');
    const [youtubePlaylistUrl, setYoutubePlaylistUrl] = useState('');
    const [playlistLimit, setPlaylistLimit] = useState(''); // newest N to fetch; blank = all
    const [selectedLocalPath, setSelectedLocalPath] = useState('');
    const [localFileName, setLocalFileName] = useState('No file selected');
    const [webpageUrl, setWebpageUrl] = useState('');
    
    const [canvaUrl, setCanvaUrl] = useState('');
    const [canvaName, setCanvaName] = useState('');
    const [selectedPhotoPath, setSelectedPhotoPath] = useState('');
    const [photoFileName, setPhotoFileName] = useState('No photos selected');

    const [mediaData, setMediaData] = useState(null);
    const [isPlaying, setIsPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [isMuted, setIsMuted] = useState(false);
    const [loop, setLoop] = useState(false);
    const [autoNext, setAutoNext] = useState(false);
    const [photoLoop, setPhotoLoop] = useState(false);
    const [photoAutoNext, setPhotoAutoNext] = useState(false);
    const [photoInterval, setPhotoInterval] = useState(5);
    const [isPhotoLive, setIsPhotoLive] = useState(false);
    const [currentPhotoIdx, setCurrentPhotoIdx] = useState(-1);

    const [isFetchingYt, setIsFetchingYt] = useState(false);
    const [isFetchingPlaylist, setIsFetchingPlaylist] = useState(false);

    // YouTube playlist import picker: fetched videos (or null when closed) + selected ids.
    const [playlistPickerItems, setPlaylistPickerItems] = useState(null);
    const [selectedVideoIds, setSelectedVideoIds] = useState(() => new Set());

    // Scheduled Plays: auto-play a library item at a clock time (once/daily).
    const [scheduledPlays, setScheduledPlays] = useState([]);
    const [scheduleNow, setScheduleNow] = useState(() => new Date());
    const [newScheduleIdx, setNewScheduleIdx] = useState('');
    const [newScheduleTime, setNewScheduleTime] = useState('');
    const [newScheduleMode, setNewScheduleMode] = useState('once');
    const [newScheduleDays, setNewScheduleDays] = useState([]);

    // Particle States
    const [particlesEnabled, setParticlesEnabled] = useState(false);
    const [particleType, setParticleType] = useState('dust'); // 'snow', 'dust', 'bokeh', 'stars', 'fireflies'
    const [particleIntensity, setParticleIntensity] = useState(50);
    const [particleSpeed, setParticleSpeed] = useState(50);
    const [messageOverlayEnabled, setMessageOverlayEnabled] = useState(false);
    const [messageOverlayText, setMessageOverlayText] = useState('');
    const [messageOverlayPosition, setMessageOverlayPosition] = useState('center');
    const [messageOverlaySize, setMessageOverlaySize] = useState(72);
    const [messageOverlayColor, setMessageOverlayColor] = useState('#ffffff');
    const [messageOverlayWeight, setMessageOverlayWeight] = useState('800');
    const [messageOverlayUppercase, setMessageOverlayUppercase] = useState(false);
    const [messageOverlayBackdrop, setMessageOverlayBackdrop] = useState(true);

    const [videoViewMode, setVideoViewMode] = useState(() => {
        return localStorage.getItem(VIEW_MODE_KEY) || 'grid';
    });
    const [mediaFolders, setMediaFolders] = useState(DEFAULT_FOLDERS);
    const [activeFolderId, setActiveFolderId] = useState(() => {
        return localStorage.getItem(ACTIVE_FOLDER_KEY) || 'all';
    });
    const [newFolderName, setNewFolderName] = useState('');
    const [isDropActive, setIsDropActive] = useState(false);
    const [isImportingDrop, setIsImportingDrop] = useState(false);
    const seekTrackRef = useRef(null);
    const seekDraggingRef = useRef(false);
    const throttledMediaTimeUpdate = useThrottledCallback((data) => {
        setDuration(data.duration || 0);
        if (!seekDraggingRef.current) setCurrentTime(data.currentTime || 0);
    }, 200);

    // mediaIds are per-app-run, so every restored playlist needs fresh ones before its items
    // can be streamed or thumbnailed. Set the saved list first so the UI paints immediately,
    // then swap in the registered version.
    useEffect(() => deferUntilIdle(() => {
        const savedPlaylist = readLocalStorageArraySafe(MEDIA_PLAYLIST_KEY);
        const savedPhotos = readLocalStorageArraySafe(PHOTO_PLAYLIST_KEY);
        setPlaylist(savedPlaylist);
        setPhotoPlaylist(savedPhotos);
        setMediaFolders(readLocalStorageArraySafe(MEDIA_FOLDERS_KEY, DEFAULT_FOLDERS));
        setScheduledPlays(readLocalStorageArraySafe(SCHEDULED_PLAYS_KEY));

        ensureMediaIds(savedPlaylist)
            .then(next => { if (next !== savedPlaylist) setPlaylist(next); })
            .catch(err => console.error('Could not re-register saved media:', err));
        ensureMediaIds(savedPhotos)
            .then(next => { if (next !== savedPhotos) setPhotoPlaylist(next); })
            .catch(err => console.error('Could not re-register saved photos:', err));
    }), []);
    useDebouncedLocalStorageEffect(SCHEDULED_PLAYS_KEY, scheduledPlays);

    useDebouncedLocalStorageEffect(MEDIA_PLAYLIST_KEY, playlist);
    useDebouncedLocalStorageEffect(PHOTO_PLAYLIST_KEY, photoPlaylist);

    // Emit Particle Updates
    useEffect(() => {
        if (!socket) return;
        socket.emit('particles_update', {
            enabled: particlesEnabled,
            type: particleType,
            intensity: particleIntensity,
            speed: particleSpeed
        });
    }, [particlesEnabled, particleType, particleIntensity, particleSpeed, socket]);

    useEffect(() => {
        if (!socket) return;
        socket.emit('media_message_overlay_update', {
            enabled: messageOverlayEnabled,
            text: messageOverlayText,
            position: messageOverlayPosition,
            size: messageOverlaySize,
            color: messageOverlayColor,
            weight: messageOverlayWeight,
            uppercase: messageOverlayUppercase,
            backdrop: messageOverlayBackdrop
        });
    }, [messageOverlayEnabled, messageOverlayText, messageOverlayPosition, messageOverlaySize, messageOverlayColor, messageOverlayWeight, messageOverlayUppercase, messageOverlayBackdrop, socket]);

    useEffect(() => {
        localStorage.setItem(VIEW_MODE_KEY, videoViewMode);
    }, [videoViewMode]);

    useDebouncedLocalStorageEffect(MEDIA_FOLDERS_KEY, mediaFolders);

    useEffect(() => {
        localStorage.setItem(ACTIVE_FOLDER_KEY, activeFolderId);
    }, [activeFolderId]);

    const activeFolderExists = activeFolderId === 'all' || mediaFolders.some(folder => folder.id === activeFolderId);
    useEffect(() => {
        if (!activeFolderExists) setActiveFolderId('all');
    }, [activeFolderExists]);

    // Socket events for progress
    useEffect(() => {
        if (!socket) return;

        const handleTimeUpdate = (data) => {
            throttledMediaTimeUpdate(data);
        };

        const handleMediaStop = () => {
            seekDraggingRef.current = false;
            setIsPlaying(false);
            setCurrentTime(0);
            setDuration(0);
            setMediaData(null);
        };

        const handlePhotoStop = () => {
            setIsPhotoLive(false);
            setCurrentPhotoIdx(-1);
        };

        const handleMediaPlay = (data) => {
            seekDraggingRef.current = false;
            setIsPlaying(true);
            setMediaData(data);
            setCurrentTime(0);
            setDuration(data?.duration || 0);
        };

        const handleTogglePlay = (state) => setIsPlaying(state);
        const handleMuteState = (state) => setIsMuted(state);
        const handleLoopState = (state) => setLoop(state);
        const handleAutoNextState = (state) => setAutoNext(state);
        socket.on('media_time_update', handleTimeUpdate);
        socket.on('media_stop', handleMediaStop);
        socket.on('photo_stop', handlePhotoStop);
        socket.on('media_play', handleMediaPlay);
        socket.on('media_toggle_play', handleTogglePlay);
        socket.on('media_set_muted', handleMuteState);
        socket.on('media_set_loop', handleLoopState);
        socket.on('media_set_auto_next', handleAutoNextState);
        // Reads the latest handler through a ref instead of bouncing the event through a
        // synthetic DOM CustomEvent to dodge a stale closure. The old indirection also made the
        // listener effect re-subscribe on every playlist change (every drag-reorder, every
        // thumbnail hydration).
        const handleMediaNext = () => playNextRef.current?.();
        socket.on('media_next', handleMediaNext);

        socket.emit('request_media_state');

        return () => {
            socket.off('media_time_update', handleTimeUpdate);
            socket.off('media_stop', handleMediaStop);
            // photo_stop was registered but never removed, so it accumulated a duplicate
            // handler on every remount (and immediately under StrictMode in dev).
            socket.off('photo_stop', handlePhotoStop);
            socket.off('media_play', handleMediaPlay);
            socket.off('media_toggle_play', handleTogglePlay);
            socket.off('media_set_muted', handleMuteState);
            socket.off('media_set_loop', handleLoopState);
            socket.off('media_set_auto_next', handleAutoNextState);
            socket.off('media_next', handleMediaNext);
        };

    }, [socket, throttledMediaTimeUpdate]);

    useEffect(() => {
        const clearTimelineDrag = () => {
            seekDraggingRef.current = false;
        };

        window.addEventListener('pointerup', clearTimelineDrag);
        window.addEventListener('blur', clearTimelineDrag);
        return () => {
            window.removeEventListener('pointerup', clearTimelineDrag);
            window.removeEventListener('blur', clearTimelineDrag);
        };
    }, []);

    // Kept current so the media_next socket handler above always calls the latest closure
    // without having to re-subscribe when the playlist changes.
    const playNextRef = useRef(null);

    const handlePlayNext = () => {
        if (playlist.length === 0) return;
        
        const currentIndex = playlist.findIndex(item => isSameMediaItem(item, mediaData));
        const nextIndex = (currentIndex + 1) % playlist.length;
        playPlaylistItem(playlist[nextIndex]);
    };

    playNextRef.current = handlePlayNext;

    const formatMediaTime = (seconds) => {
        if (!seconds || isNaN(seconds)) return "0:00";
        const m = Math.floor(seconds / 60);
        const s = Math.floor(seconds % 60);
        return `${m}:${s < 10 ? '0' : ''}${s}`;
    };

    const getItemTitle = (item) => item?.name || (item?.type === 'youtube' ? `YouTube: ${item.id}` : item?.type === 'webpage' ? item.path : 'Local File');

    const isSameMediaItem = (item, other) => {
        if (!item || !other || item.type !== other.type) return false;
        if (item.type === 'youtube') return item.id === other.id;
        return item.path === other.path;
    };

    const currentPlaylistIndex = playlist.findIndex(item => isSameMediaItem(item, mediaData));
    const currentPlaylistItem = currentPlaylistIndex >= 0 ? playlist[currentPlaylistIndex] : mediaData;
    const effectiveDuration = duration || currentPlaylistItem?.duration || mediaData?.duration || 0;
    const visiblePlaylistEntries = playlist
        .map((item, index) => ({ item, index }))
        .filter(({ item }) => activeFolderId === 'all' || (item.folderId || DEFAULT_FOLDER_ID) === activeFolderId);

    const createVideoThumbnail = (video) => {
        const canvas = document.createElement('canvas');
        const sourceWidth = video.videoWidth || 320;
        const sourceHeight = video.videoHeight || 180;
        canvas.width = 320;
        canvas.height = Math.max(1, Math.round((sourceHeight / sourceWidth) * canvas.width));
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL('image/jpeg', 0.72);
    };

    const hydrateLocalVideoItem = (item) => new Promise((resolve) => {
        const video = document.createElement('video');
        let settled = false;

        const finish = (patch = {}) => {
            if (settled) return;
            settled = true;
            video.removeAttribute('src');
            video.load();
            resolve({ ...item, ...patch });
        };

        video.preload = 'metadata';
        video.muted = true;
        video.crossOrigin = 'anonymous';
        if (!item.mediaId) return finish();
        video.src = authUrl('/stream-video', { mediaId: item.mediaId });
        video.onloadedmetadata = () => {
            const detectedDuration = Number.isFinite(video.duration) ? video.duration : item.duration;
            const captureAt = Math.min(Math.max((detectedDuration || 1) * 0.1, 0.15), 2);
            video.currentTime = captureAt;
            video.onseeked = () => {
                try {
                    finish({ duration: detectedDuration, thumbnail: createVideoThumbnail(video) });
                } catch {
                    finish({ duration: detectedDuration });
                }
            };
        };
        video.onerror = () => finish();
        setTimeout(() => finish(), 5000);
    });

    const createLocalVideoItem = async (filePath, folderId = getFolderIdForNewItem(activeFolderId)) => {
        const registered = await registerLocalMedia(filePath, 'local');
        const item = {
            type: 'local',
            path: registered?.path || filePath,
            mediaId: registered?.mediaId,
            name: registered?.name || getFileName(filePath),
            folderId
        };
        return hydrateLocalVideoItem(item);
    };

    const updatePlaylistItem = (index, patch) => {
        setPlaylist(prev => prev.map((item, idx) => idx === index ? { ...item, ...patch } : item));
    };

    const addMediaFolder = () => {
        const name = newFolderName.trim();
        if (!name) return;
        const id = `folder-${Date.now()}`;
        setMediaFolders(prev => [...prev, { id, name }]);
        setActiveFolderId(id);
        setNewFolderName('');
    };

    const handleAddYoutubePlaylist = async () => {
        const url = youtubePlaylistUrl.trim();
        if (!url) { alert("Please enter a YouTube Playlist URL."); return; }
        if (!url.includes('list=')) { alert("Invalid Playlist URL. Must contain 'list='"); return; }

        // Optionally cap to the newest N videos (blank / invalid = fetch all).
        const limit = parseInt(playlistLimit, 10);
        const params = Number.isFinite(limit) && limit > 0 ? { url, max: String(limit) } : { url };

        setIsFetchingPlaylist(true);
        try {
            const response = await fetch(authUrl('/fetch-youtube-playlist', params));
            if (response.ok) {
                const items = await response.json();
                if (items && items.length > 0) {
                    // Open the picker with everything selected by default.
                    setPlaylistPickerItems(items);
                    setSelectedVideoIds(new Set(items.map(item => item.id)));
                    setYoutubePlaylistUrl('');
                } else {
                    alert("No videos found in this playlist.");
                }
            } else {
                alert("Failed to fetch playlist items.");
            }
        } catch (e) {
            console.error(e);
            alert("Error fetching playlist.");
        }
        setIsFetchingPlaylist(false);
    };

    const toggleVideoSelected = (id) => {
        setSelectedVideoIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    };

    const allPickerSelected = playlistPickerItems
        ? selectedVideoIds.size === playlistPickerItems.length
        : false;

    const toggleSelectAllPicker = () => {
        if (!playlistPickerItems) return;
        setSelectedVideoIds(allPickerSelected ? new Set() : new Set(playlistPickerItems.map(i => i.id)));
    };

    const closePlaylistPicker = () => {
        setPlaylistPickerItems(null);
        setSelectedVideoIds(new Set());
    };

    const confirmImportPlaylist = () => {
        if (!playlistPickerItems) return;
        const folderId = getFolderIdForNewItem(activeFolderId);
        const selected = playlistPickerItems.filter(item => selectedVideoIds.has(item.id));
        if (selected.length === 0) return;
        setPlaylist(prev => [...selected.map(item => ({ ...item, folderId })), ...prev]);
        closePlaylistPicker();
    };

    const toggleMute = () => {
        const newState = !isMuted;
        setIsMuted(newState);
        socket?.emit('media_set_muted', newState);
    };

    const toggleLoop = () => {
        const newState = !loop;
        setLoop(newState);
        socket?.emit('media_set_loop', newState);
    };

    const toggleAutoNext = () => {
        const newState = !autoNext;
        setAutoNext(newState);
        socket?.emit('media_set_auto_next', newState);
    };

    const handleAddYoutube = async () => {
        const ytUrl = youtubeUrl.trim();
        if (!ytUrl) { alert("Please enter a YouTube URL."); return; }
        
        let videoId = '';
        try {
            const url = new URL(ytUrl);
            if (url.hostname.includes('youtu.be')) videoId = url.pathname.slice(1);
            else videoId = url.searchParams.get('v');
        } catch (e) {}

        if (videoId) {
            setIsFetchingYt(true);
            let videoTitle = '';
            try {
                const response = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`);
                if (response.ok) {
                    const data = await response.json();
                    if (data && data.title) videoTitle = data.title;
                }
            } catch(e) {
                console.error("Failed to fetch YT title", e);
            }
            
            setPlaylist(prev => [{ type: 'youtube', id: videoId, name: videoTitle || `YouTube: ${videoId}`, folderId: getFolderIdForNewItem(activeFolderId) }, ...prev]);
            setYoutubeUrl('');
            setIsFetchingYt(false);
        } else {
            alert("Invalid YouTube URL");
        }
    };

    const handleBrowseLocal = async () => {
        if (window.broadcastAPI) {
            try {
                const filePath = await window.broadcastAPI.selectLocalVideo();
                if (filePath) {
                    setSelectedLocalPath(filePath);
                    const fileName = filePath.split(/[/\\]/).pop();
                    setLocalFileName(fileName);
                }
            } catch (err) {
                console.error("Electron IPC Error", err);
                alert("Error interacting with file system.");
            }
        } else {
            alert("Native file browsing requires running the Electron app.");
            // Fallback for browser (would need an input[type="file"] returning a blob URL or similar)
        }
    };

    const handleAddLocal = async () => {
        if (!selectedLocalPath) {
            alert("Please browse and select a local file first.");
            return;
        }
        const item = await createLocalVideoItem(selectedLocalPath);
        setPlaylist(prev => [item, ...prev]);
    };

    const handleAddWebpage = () => {
        let url = webpageUrl.trim();
        if (!url) { alert("Please enter a webpage URL."); return; }
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
            url = 'https://' + url;
        }
        try {
            new URL(url); // validate
        } catch (e) {
            alert("Invalid URL.");
            return;
        }
        const hostname = new URL(url).hostname;
        setPlaylist(prev => [{ type: 'webpage', path: url, name: hostname, folderId: getFolderIdForNewItem(activeFolderId) }, ...prev]);
        setWebpageUrl('');
    };

    const removePlaylistItem = (index, e) => {
        e.stopPropagation();
        setPlaylist(prev => prev.filter((_, i) => i !== index));
    };

    const clearVideoLibrary = () => {
        if (playlist.length === 0) return;
        if (!window.confirm('Clear all saved videos, YouTube items, and webpages from the video library?')) return;
        setPlaylist([]);
    };

    const playPlaylistItem = (item) => {
        if (!socket) return;
        const timestamp = Date.now();
        const payload = { ...item, ts: timestamp };
        if (item.type === 'youtube') {
            const ytUrl = `https://www.youtube.com/watch?v=${item.id}`;
            setYoutubeUrl(ytUrl);
            setSelectedLocalPath('');
            setLocalFileName('No file selected');
            socket.emit('play_media', payload);
        } else if (item.type === 'local') {
            setSelectedLocalPath(item.path);
            setLocalFileName(item.name);
            setYoutubeUrl('');
            socket.emit('play_media', payload);
        } else if (item.type === 'webpage') {
            setYoutubeUrl('');
            setSelectedLocalPath('');
            setLocalFileName('No file selected');
            socket.emit('play_media', payload);
        }
        setMediaData(payload);
        setDuration(item.duration || 0);
        setCurrentTime(0);
        setIsPlaying(true);
    };

    // --- Scheduled Plays: fire a library item at a clock time (once/daily) ---
    // The interval reads the latest schedules + play fn via a ref to dodge stale
    // closures (same concern as the media_next handler above).
    const scheduleRuntimeRef = useRef({ scheduledPlays, playPlaylistItem });
    scheduleRuntimeRef.current = { scheduledPlays, playPlaylistItem };

    useEffect(() => {
        const interval = setInterval(() => {
            const { scheduledPlays: schedules, playPlaylistItem: play } = scheduleRuntimeRef.current;
            if (!schedules || schedules.length === 0) return;
            const now = new Date();
            setScheduleNow(now); // drives the live countdown display
            const fireIds = new Set();
            for (const s of schedules) {
                if (scheduleTick(s, now).shouldFire) fireIds.add(s.id);
            }
            if (fireIds.size === 0) return;
            const todayKey = localDateKey(now);
            for (const s of schedules) {
                if (fireIds.has(s.id) && s.item) play(s.item);
            }
            setScheduledPlays(prev => prev.map(s => {
                if (!fireIds.has(s.id)) return s;
                return s.mode === 'once'
                    ? { ...s, enabled: false, lastFiredDate: todayKey }
                    : { ...s, lastFiredDate: todayKey };
            }));
        }, 1000);
        return () => clearInterval(interval);
    }, []);

    const toggleNewScheduleDay = (day) => setNewScheduleDays(prev => (
        prev.includes(day) ? prev.filter(d => d !== day) : [...prev, day]
    ));

    const addSchedule = () => {
        if (newScheduleIdx === '' || !newScheduleTime) return;
        if (newScheduleMode === 'weekly' && newScheduleDays.length === 0) return;
        const item = playlist[Number(newScheduleIdx)];
        if (!item) return;
        setScheduledPlays(prev => [...prev, {
            id: `sched-${Date.now()}`,
            item,
            time: newScheduleTime,
            mode: newScheduleMode,
            days: newScheduleMode === 'weekly' ? [...newScheduleDays].sort((a, b) => a - b) : undefined,
            enabled: true,
            lastFiredDate: null,
        }]);
        setNewScheduleIdx('');
        setNewScheduleTime('');
        setNewScheduleMode('once');
        setNewScheduleDays([]);
    };

    const removeSchedule = (id) => setScheduledPlays(prev => prev.filter(s => s.id !== id));

    const toggleSchedule = (id) => setScheduledPlays(prev => prev.map(s => {
        if (s.id !== id) return s;
        const enabling = !s.enabled;
        const patch = { enabled: enabling };
        // Re-enabling a fired one-time schedule makes it eligible again.
        if (enabling && s.mode === 'once') patch.lastFiredDate = null;
        return { ...s, ...patch };
    }));

    const handleMediaDrop = async (e) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDropActive(false);

        const files = Array.from(e.dataTransfer?.files || []);
        if (files.length === 0) return;

        if (!window.broadcastAPI?.getPathForFile) {
            alert('Drag/drop import requires running the Electron app.');
            return;
        }

        setIsImportingDrop(true);
        const folderId = getFolderIdForNewItem(activeFolderId);
        const videoItems = [];
        const photoItems = [];
        const skippedFiles = [];

        for (const file of files) {
            const filePath = window.broadcastAPI.getPathForFile(file);
            if (!filePath) {
                skippedFiles.push(file.name);
            } else if (isVideoPath(filePath)) {
                videoItems.push(await createLocalVideoItem(filePath, folderId));
            } else if (isImagePath(filePath)) {
                const registered = await registerLocalMedia(filePath, 'photo');
                photoItems.push({ type: 'photo', path: registered.path, mediaId: registered.mediaId, name: registered.name || getFileName(filePath) });
            } else {
                skippedFiles.push(file.name || getFileName(filePath));
            }
        }

        if (videoItems.length > 0) setPlaylist(prev => [...videoItems, ...prev]);
        if (photoItems.length > 0) setPhotoPlaylist(prev => [...photoItems, ...prev]);
        if (skippedFiles.length > 0) {
            alert(`Skipped ${skippedFiles.length} unsupported file${skippedFiles.length === 1 ? '' : 's'}.`);
        }
        setIsImportingDrop(false);
    };

    // --- PHOTO LIBRARY HANDLERS ---
    const handleBrowsePhoto = async () => {
        if (window.broadcastAPI) {
            try {
                const filePaths = await window.broadcastAPI.selectLocalPhoto();
                if (filePaths && filePaths.length > 0) {
                    setSelectedPhotoPath(filePaths);
                    setPhotoFileName(filePaths.length === 1 ? filePaths[0].split(/[/\\]/).pop() : `${filePaths.length} photos selected`);
                }
            } catch (e) {
                console.error(e);
                alert("Error interacting with file system.");
            }
        } else {
            alert("Native photo browsing requires running the Electron app.");
        }
    };

    const handleAddPhoto = async () => {
        if (!selectedPhotoPath || selectedPhotoPath.length === 0) return;
        
        const newItems = Array.isArray(selectedPhotoPath)
            ? await Promise.all(selectedPhotoPath.map(async p => {
                const registered = await registerLocalMedia(p, 'photo');
                return { type: 'photo', path: registered.path, mediaId: registered.mediaId, name: registered.name || p.split(/[/\\]/).pop() };
            }))
            : [await registerLocalMedia(selectedPhotoPath, 'photo').then(registered => ({ type: 'photo', path: registered.path, mediaId: registered.mediaId, name: registered.name || photoFileName }))];
        
        const newPlaylist = [...photoPlaylist, ...newItems];
        setPhotoPlaylist(newPlaylist);
        setSelectedPhotoPath('');
        setPhotoFileName('No photos selected');
    };

    const handleAddCanva = () => {
        if (!canvaUrl) return;
        let url = canvaUrl.trim();

        // Extract URL from iframe tag if pasted
        if (url.includes('<iframe')) {
            const srcMatch = url.match(/src="([^"]+)"/);
            if (srcMatch) url = srcMatch[1];
        }

        if (!url.startsWith('http://') && !url.startsWith('https://')) {
            url = 'https://' + url;
        }

        // Normalize Canva URL to embed format
        if (url.includes('canva.com')) {
            try {
                const urlObj = new URL(url);
                let path = urlObj.pathname;
                path = path.replace(/\/$/, '');
                if (!path.endsWith('/view') && !path.endsWith('/watch')) {
                    path = path.replace(/\/edit$/, '');
                    if (!path.endsWith('/view')) path += '/view';
                }
                url = `https://www.canva.com${path}?embed`;
            } catch (e) {
                console.error("Canva normalization error", e);
            }
        }

        const newItem = { type: 'canva', path: url, name: canvaName || 'Canva Presentation' };
        const newPlaylist = [...photoPlaylist, newItem];
        setPhotoPlaylist(newPlaylist);
        setCanvaUrl('');
        setCanvaName('');
    };

    const removePhotoItem = (index, e) => {
        if (e) e.stopPropagation();
        const newPlaylist = photoPlaylist.filter((_, i) => i !== index);
        setPhotoPlaylist(newPlaylist);
        if (currentPhotoIdx === index) stopPhotoOutput();
    };

    const clearPhotoLibrary = () => {
        if (photoPlaylist.length === 0) return;
        if (!window.confirm('Clear all saved photos and Canva slides from this library?')) return;
        setPhotoPlaylist([]);
        stopPhotoOutput();
    };

    const stopPhotoOutput = () => {
        setIsPhotoLive(false);
        setCurrentPhotoIdx(-1);
        socket?.emit('photo_stop');
    };

    const playPhotoAtIndex = (index) => {
        if (index < 0 || index >= photoPlaylist.length) return;
        setCurrentPhotoIdx(index);
        let item = { ...photoPlaylist[index] };
        
        // Self-healing for old/incorrect Canva links
        if (item.type === 'canva' && item.path.includes('canva.com') && !item.path.includes('?embed')) {
            try {
                const urlObj = new URL(item.path);
                let path = urlObj.pathname;
                path = path.replace(/\/$/, '');
                if (!path.endsWith('/view') && !path.endsWith('/watch')) {
                    path = path.replace(/\/edit$/, '');
                    if (!path.endsWith('/view')) path += '/view';
                }
                item.path = `https://www.canva.com${path}?embed`;
            } catch (e) {}
        }

        socket?.emit('photo_play', { ...item, ts: Date.now() });
    };

    // Photo Automation Timer
    useEffect(() => {
        let timer = null;
        if (isPhotoLive && photoAutoNext && photoPlaylist.length > 1) {
            timer = setTimeout(() => {
                let nextIdx = currentPhotoIdx + 1;
                if (nextIdx >= photoPlaylist.length) {
                    if (photoLoop) nextIdx = 0;
                    else {
                        stopPhotoOutput();
                        return;
                    }
                }
                playPhotoAtIndex(nextIdx);
            }, photoInterval * 1000);
        }
        return () => clearTimeout(timer);
    }, [isPhotoLive, photoAutoNext, photoLoop, photoInterval, currentPhotoIdx, photoPlaylist]);

    // Drag and Drop handlers for Media
    const [draggedIdx, setDraggedIdx] = useState(null);

    const onDragStart = (e, index) => {
        setDraggedIdx(index);
        e.dataTransfer.effectAllowed = 'move';
    };

    const onDragOver = (e, index) => {
        e.preventDefault();
        if (draggedIdx === null || draggedIdx === index) return;
        const newPlaylist = [...playlist];
        const item = newPlaylist[draggedIdx];
        newPlaylist.splice(draggedIdx, 1);
        newPlaylist.splice(index, 0, item);
        setDraggedIdx(index);
        setPlaylist(newPlaylist);
    };

    const onDragEnd = () => {
        setDraggedIdx(null);
    };

    // Drag and Drop handlers for Photos
    const [draggedPhotoIdx, setDraggedPhotoIdx] = useState(null);

    const onPhotoDragStart = (e, index) => {
        setDraggedPhotoIdx(index);
        e.dataTransfer.effectAllowed = 'move';
    };

    const onPhotoDragOver = (e, index) => {
        e.preventDefault();
        if (draggedPhotoIdx === null || draggedPhotoIdx === index) return;
        const newPlaylist = [...photoPlaylist];
        const item = newPlaylist[draggedPhotoIdx];
        newPlaylist.splice(draggedPhotoIdx, 1);
        newPlaylist.splice(index, 0, item);
        setDraggedPhotoIdx(index);
        setPhotoPlaylist(newPlaylist);
    };

    const onPhotoDragEnd = () => {
        setDraggedPhotoIdx(null);
    };


    const handleStopClear = () => {
        socket?.emit('stop_media');
        setIsPlaying(false);
        setMediaData(null);
    };

    const clearMessageOverlay = () => {
        setMessageOverlayText('');
        setMessageOverlayEnabled(false);
    };

    const togglePlay = () => {
        const newPlayState = !isPlaying;
        setIsPlaying(newPlayState);
        socket?.emit('media_toggle_play', newPlayState);
    };

    const commitSeekTime = (value) => {
        const val = Number(value);
        if (!Number.isFinite(val) || !effectiveDuration) return;
        const clamped = Math.min(Math.max(0, val), effectiveDuration);
        setCurrentTime(clamped);
        socket?.emit('media_seek', clamped);
    };

    const seekFromClientX = (clientX) => {
        const track = seekTrackRef.current;
        if (!track || !effectiveDuration) return;
        const rect = track.getBoundingClientRect();
        if (!rect.width) return;
        const ratio = Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1);
        commitSeekTime(ratio * effectiveDuration);
    };

    const handleTimelinePointerDown = (e) => {
        if (!effectiveDuration) return;
        seekDraggingRef.current = true;
        e.currentTarget.setPointerCapture?.(e.pointerId);
        seekFromClientX(e.clientX);
    };

    const handleTimelinePointerMove = (e) => {
        if (!seekDraggingRef.current) return;
        seekFromClientX(e.clientX);
    };

    const stopTimelineDrag = (e) => {
        seekDraggingRef.current = false;
        e.currentTarget.releasePointerCapture?.(e.pointerId);
    };

    const handleTimelineKeyDown = (e) => {
        if (!effectiveDuration) return;
        const step = e.shiftKey ? 10 : 5;
        let nextTime = currentTime;
        if (e.key === 'ArrowLeft') nextTime -= step;
        else if (e.key === 'ArrowRight') nextTime += step;
        else if (e.key === 'Home') nextTime = 0;
        else if (e.key === 'End') nextTime = effectiveDuration;
        else return;
        e.preventDefault();
        commitSeekTime(nextTime);
    };

    const progressPercent = effectiveDuration ? Math.min(Math.max((currentTime / effectiveDuration) * 100, 0), 100) : 0;

    return (
        <div className="grid grid-cols-1 2xl:grid-cols-[minmax(560px,1fr)_minmax(420px,0.85fr)] gap-4">
            {/* MEDIA PLAYLIST */}
            <div className="surface space-y-3 rounded-lg p-3 2xl:col-start-1 2xl:row-start-1">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b section-rule pb-2">
                    <div className="flex items-center space-x-2">
                        <Video className="w-4 h-4 text-indigo-500" />
                        <h3 className="text-sm font-bold text-slate-700 dark:text-slate-300 uppercase tracking-[0.2em]">Video Library</h3>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        <button
                            onClick={clearVideoLibrary}
                            disabled={playlist.length === 0}
                            className="inline-flex items-center gap-1.5 rounded-md border border-red-500/20 bg-red-600/10 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-red-600 transition hover:bg-red-600 hover:text-white disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-red-600/10 disabled:hover:text-red-600"
                            title="Clear Video Library"
                        >
                            <Trash2 className="w-3 h-3" />
                            Clear
                        </button>
                        <div className="surface-muted flex items-center rounded-lg p-0.5">
                            <button onClick={() => setVideoViewMode('grid')} className={`rounded-md p-1 transition ${videoViewMode === 'grid' ? 'bg-indigo-600 text-white' : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'}`} title="Grid View"><Grid className="w-3.5 h-3.5" /></button>
                            <button onClick={() => setVideoViewMode('list')} className={`rounded-md p-1 transition ${videoViewMode === 'list' ? 'bg-indigo-600 text-white' : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'}`} title="List View"><List className="w-3.5 h-3.5" /></button>
                        </div>
                        <button onClick={toggleLoop} className={`rounded px-2 py-1 text-[10px] font-bold transition ${loop ? 'bg-indigo-600 text-white' : 'control-button-muted text-slate-500'}`}>
                            LOOP: {loop ? 'ON' : 'OFF'}
                        </button>
                        <button onClick={toggleAutoNext} className={`rounded px-2 py-1 text-[10px] font-bold transition ${autoNext ? 'bg-indigo-600 text-white' : 'control-button-muted text-slate-500'}`}>
                            AUTO NEXT: {autoNext ? 'ON' : 'OFF'}
                        </button>
                    </div>
                </div>
                <div className="space-y-2">
                    <div className="space-y-2">
                        <div className="flex flex-wrap items-center gap-2">
                            <button onClick={() => setActiveFolderId('all')} className={`rounded-lg border px-2.5 py-1 text-[10px] font-bold transition ${activeFolderId === 'all' ? 'border-indigo-600 bg-indigo-600 text-white' : 'control-button-muted text-slate-500'}`}>
                                All
                            </button>
                            {mediaFolders.map(folder => (
                                <button key={folder.id} onClick={() => setActiveFolderId(folder.id)} className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-[10px] font-bold transition ${activeFolderId === folder.id ? 'border-indigo-600 bg-indigo-600 text-white' : 'control-button-muted text-slate-500'}`}>
                                    <Folder className="w-3 h-3" />
                                    {folder.name}
                                </button>
                            ))}
                        </div>
                        <div className="flex items-center gap-2">
                            <input type="text" value={newFolderName} onChange={e => setNewFolderName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') addMediaFolder(); }} placeholder="New folder..."
                                className="control-field w-40 px-2 py-1 text-[10px]" />
                            <button onClick={addMediaFolder} className="control-button-muted px-2.5 py-1 text-[10px] font-bold">
                                + Folder
                            </button>
                        </div>
                    </div>
                </div>

                <div
                    onDragEnter={(e) => { e.preventDefault(); setIsDropActive(true); }}
                    onDragOver={(e) => { e.preventDefault(); setIsDropActive(true); }}
                    onDragLeave={(e) => { e.preventDefault(); setIsDropActive(false); }}
                    onDrop={handleMediaDrop}
                    className={`flex items-center justify-center gap-2 rounded-lg border border-dashed p-3 text-xs transition ${isDropActive ? 'border-indigo-500 bg-indigo-500/10 text-indigo-500' : 'surface-muted text-slate-500'}`}
                >
                    <Upload className="w-4 h-4" />
                    <span className="font-medium">{isImportingDrop ? 'Importing media...' : 'Drop videos here, or drop photos to add them to the photo library'}</span>
                </div>

                <div className={videoViewMode === 'grid' 
                    ? "grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3 max-h-[240px] overflow-y-auto pr-2 custom-scrollbar" 
                    : "flex flex-col gap-2 max-h-[240px] overflow-y-auto pr-2 custom-scrollbar"}>
                    {visiblePlaylistEntries.length === 0 ? (
                        <div className="text-xs text-slate-500 dark:text-slate-500 italic col-span-full text-center py-4">Library is empty</div>
                    ) : (
                        visiblePlaylistEntries.map(({ item, index: idx }, visibleIdx) => {
                            const isThisPlaying = isSameMediaItem(item, mediaData);

                            return (
                                <div 
                                    key={`${item.type}-${item.id || item.path}-${idx}`} 
                                    draggable
                                    onDragStart={(e) => onDragStart(e, idx)}
                                    onDragOver={(e) => onDragOver(e, idx)}
                                    onDragEnd={onDragEnd}
                                    onClick={() => playPlaylistItem(item)} 
                                    className={`surface-muted group relative flex cursor-grab overflow-hidden rounded-lg transition active:cursor-grabbing ${isThisPlaying && isPlaying ? 'border-indigo-500 ring-2 ring-indigo-500/30' : 'hover:border-indigo-500/50'} ${draggedIdx === idx ? 'opacity-50 ring-2 ring-indigo-500/20' : ''} ${videoViewMode === 'grid' ? 'aspect-video flex-col' : 'h-16 shrink-0 flex-row items-center'}`}
                                >
                                    {/* Thumbnail */}
                                    <div className={videoViewMode === 'grid' ? "w-full h-full relative" : "w-28 h-full relative flex-shrink-0 bg-black"}>
                                        {item.type === 'youtube' ? (
                                            <img 
                                                src={`https://img.youtube.com/vi/${item.id}/mqdefault.jpg`} 
                                                alt={item.name}
                                                className="w-full h-full object-cover opacity-80 group-hover:opacity-100 transition"
                                            />
                                        ) : item.type === 'webpage' ? (
                                            <div className="w-full h-full bg-cyan-600/10 flex flex-col items-center justify-center p-2 text-center">
                                                <Globe className="w-8 h-8 text-cyan-500 mb-1" />
                                                <span className="text-[8px] font-bold text-cyan-400 uppercase tracking-tighter">Webpage</span>
                                            </div>
                                        ) : item.thumbnail ? (
                                            <img
                                                src={item.thumbnail}
                                                alt={item.name}
                                                className="w-full h-full object-cover opacity-80 group-hover:opacity-100 transition"
                                            />
                                        ) : (
                                            <div className="w-full h-full bg-indigo-600/10 flex flex-col items-center justify-center p-2 text-center">
                                                <Film className="w-8 h-8 text-indigo-500 mb-1" />
                                                <span className="text-[8px] font-bold text-indigo-400 uppercase tracking-tighter">Local Video</span>
                                            </div>
                                        )}
                                        {/* Type Badge on Thumbnail */}
                                        <div className={`absolute ${videoViewMode === 'grid' ? 'top-1 left-1' : 'top-1 left-1'} bg-black/60 backdrop-blur-md text-white text-[8px] font-mono px-1.5 py-0.5 rounded border border-white/20 flex items-center gap-1`}>
                                            {item.type === 'youtube' ? <Play className="w-2 h-2 text-red-500 fill-red-500" /> : item.type === 'webpage' ? <Globe className="w-2 h-2 text-cyan-500" /> : <Film className="w-2 h-2 text-blue-500" />}
                                            {visibleIdx + 1}
                                        </div>
                                        {item.duration ? (
                                            <div className="absolute bottom-1 right-1 bg-black/70 text-white text-[8px] font-mono px-1.5 py-0.5 rounded">
                                                {formatMediaTime(item.duration)}
                                            </div>
                                        ) : null}
                                    </div>

                                    {/* Overlay Title (Grid) or Content (List) */}
                                    {videoViewMode === 'grid' ? (
                                        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent p-2">
                                            <p className="text-[9px] text-white font-medium truncate">{getItemTitle(item)}</p>
                                        </div>
                                    ) : (
                                        <div className="flex-1 px-3 py-2 flex flex-col justify-center min-w-0 pr-20">
                                            <p className="text-xs font-semibold text-slate-800 dark:text-slate-200 truncate" title={getItemTitle(item)}>{getItemTitle(item)}</p>
                                            <p className="text-[9px] font-bold text-slate-500 uppercase tracking-wider mt-0.5">{item.type}{item.duration ? ` · ${formatMediaTime(item.duration)}` : ''}</p>
                                            <select value={item.folderId || DEFAULT_FOLDER_ID} onClick={e => e.stopPropagation()} onChange={e => updatePlaylistItem(idx, { folderId: e.target.value })}
                                                className="control-field mt-1 w-32 rounded px-1 py-0.5 text-[9px]">
                                                {mediaFolders.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
                                            </select>
                                        </div>
                                    )}

                                    {videoViewMode === 'grid' && (
                                        <select value={item.folderId || DEFAULT_FOLDER_ID} onClick={e => e.stopPropagation()} onChange={e => updatePlaylistItem(idx, { folderId: e.target.value })}
                                            className="absolute bottom-7 left-2 max-w-[calc(100%-1rem)] bg-black/60 text-white border border-white/20 rounded px-1 py-0.5 text-[8px] outline-none opacity-0 group-hover:opacity-100 transition-opacity">
                                            {mediaFolders.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
                                        </select>
                                    )}

                                    {/* Drag Handle */}
                                    <div className={`absolute ${videoViewMode === 'grid' ? 'top-1 right-1' : 'inset-y-0 right-10 flex items-center'} opacity-0 group-hover:opacity-100 transition-opacity`}>
                                        <GripVertical className="w-4 h-4 text-slate-400 dark:text-slate-500" />
                                    </div>

                                    {/* Delete Button */}
                                    <button 
                                        onClick={(e) => { e.stopPropagation(); removePlaylistItem(idx, e); }} 
                                        className={`absolute ${videoViewMode === 'grid' ? 'top-1 right-6' : 'inset-y-0 right-2 flex items-center h-fit my-auto'} p-1.5 bg-red-600 text-white rounded shadow-lg opacity-0 group-hover:opacity-100 transition-opacity transform hover:scale-110 active:scale-95`}
                                    >
                                        <Trash2 className="w-3 h-3" />
                                    </button>
                                </div>
                            );
                        })
                    )}
                </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 2xl:col-start-1 2xl:row-start-2">
                {/* YouTube Input */}
                <div className="surface-muted space-y-3 rounded-lg p-3">
                    <div className="space-y-3">
                        <div className="flex items-center space-x-2">
                            <Play className="w-4 h-4 text-red-500 fill-red-500" />
                            <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wide">Youtube</label>
                        </div>
                        <div className="flex space-x-2">
                            <input type="text" value={youtubeUrl} onChange={e=>setYoutubeUrl(e.target.value)} placeholder="Video URL..." 
                                className="control-field flex-1 px-3 py-1.5 text-sm" />
                            <button onClick={handleAddYoutube} disabled={isFetchingYt} className="control-button-muted px-3 text-xs font-bold">
                                {isFetchingYt ? '...' : '+ Video'}
                            </button>
                        </div>
                    </div>
                    <div className="space-y-3 border-t section-rule pt-2">
                        <label className="block text-sm font-medium text-slate-700 dark:text-slate-300">YouTube Playlist URL</label>
                        <div className="flex space-x-2">
                            <input type="text" value={youtubePlaylistUrl} onChange={e=>setYoutubePlaylistUrl(e.target.value)} placeholder="Playlist URL..."
                                className="control-field flex-1 px-3 py-1.5 text-sm" />
                            <input type="number" min="1" value={playlistLimit} onChange={e=>setPlaylistLimit(e.target.value)}
                                title="Newest videos to fetch (leave blank for all)" placeholder="All"
                                style={{ flex: '0 0 4rem', width: '4rem' }}
                                className="control-field px-2 py-1.5 text-sm text-center" />
                            <button onClick={handleAddYoutubePlaylist} disabled={isFetchingPlaylist} className="bg-indigo-600 hover:bg-indigo-500 text-white text-xs px-3 rounded-lg font-bold transition">
                                {isFetchingPlaylist ? '...' : '+ Playlist'}
                            </button>
                        </div>
                        <p className="text-xs text-slate-500 dark:text-slate-400">Fetches the newest videos first. Leave the count blank to load the whole playlist.</p>
                    </div>
                </div>

                {/* Local File + Webpage Input */}
                <div className="surface-muted space-y-3 rounded-lg p-3">
                    <div className="flex items-center space-x-2">
                        <Film className="w-4 h-4 text-blue-500" />
                        <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wide">Local Video</label>
                    </div>
                    <div className="control-field flex items-center space-x-2 p-2">
                        <button onClick={handleBrowseLocal} className="bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold py-1.5 px-3 rounded-md transition flex-none shadow-sm active:scale-95">
                            Browse...
                        </button>
                        <span className="text-xs text-slate-600 dark:text-slate-400 truncate flex-1" title={selectedLocalPath || ''}>
                            {localFileName}
                        </span>
                    </div>
                    <button onClick={handleAddLocal} className="control-button-muted flex w-full items-center justify-center px-4 py-2 text-sm font-medium active:scale-95">
                        + Add Local File to Playlist
                    </button>

                    <div className="space-y-2 border-t section-rule pt-2">
                        <div className="flex items-center space-x-2">
                            <Globe className="w-3.5 h-3.5 text-cyan-500" />
                            <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Webpage URL</label>
                        </div>
                        <div className="flex space-x-2">
                            <input type="text" value={webpageUrl} onChange={e => setWebpageUrl(e.target.value)} placeholder="https://example.com" 
                                className="control-field flex-1 px-3 py-1.5 text-sm" />
                            <button onClick={handleAddWebpage} className="bg-cyan-600 hover:bg-cyan-500 text-white text-xs px-3 rounded-lg font-bold transition">
                                + Add
                            </button>
                        </div>
                    </div>
                </div>

                {/* Scheduled Videos */}
                <div className="surface-muted space-y-3 rounded-lg p-3">
                    <div className="flex items-center space-x-2">
                        <Clock className="w-4 h-4 text-amber-500" />
                        <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wide">Scheduled Videos</label>
                    </div>

                    <div className="space-y-2">
                        <select value={newScheduleIdx} onChange={e => setNewScheduleIdx(e.target.value)}
                            className="control-field w-full px-3 py-1.5 text-sm">
                            <option value="">Choose a video…</option>
                            {playlist.map((item, i) => (
                                <option key={i} value={i}>{getItemTitle(item)}</option>
                            ))}
                        </select>
                        <input type="time" value={newScheduleTime} onChange={e => setNewScheduleTime(e.target.value)}
                            className="control-field w-full px-3 py-1.5 text-sm" />
                        <div className="flex overflow-hidden rounded-lg border border-slate-500/20">
                            {[['once', 'Once'], ['daily', 'Daily'], ['weekly', 'Days']].map(([mode, label]) => (
                                <button key={mode} onClick={() => setNewScheduleMode(mode)}
                                    className={`flex-1 px-3 py-1.5 text-xs font-bold transition ${newScheduleMode === mode ? 'bg-amber-500 text-white' : 'bg-slate-500/10 text-slate-500'}`}>{label}</button>
                            ))}
                        </div>
                        {newScheduleMode === 'weekly' && (
                            <div className="flex justify-between gap-1">
                                {WEEKDAY_OPTIONS.map(([label, day], i) => {
                                    const active = newScheduleDays.includes(day);
                                    return (
                                        <button key={i} onClick={() => toggleNewScheduleDay(day)}
                                            title={['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][day]}
                                            className={`h-7 flex-1 rounded text-xs font-bold transition ${active ? 'bg-amber-500 text-white' : 'bg-slate-500/10 text-slate-500 hover:bg-slate-500/20'}`}>
                                            {label}
                                        </button>
                                    );
                                })}
                            </div>
                        )}
                        <button onClick={addSchedule} disabled={newScheduleIdx === '' || !newScheduleTime || (newScheduleMode === 'weekly' && newScheduleDays.length === 0)}
                            className="control-button-muted flex w-full items-center justify-center px-4 py-2 text-sm font-medium active:scale-95 disabled:cursor-not-allowed disabled:opacity-40">
                            + Schedule
                        </button>
                    </div>

                    {scheduledPlays.length > 0 ? (
                        <div className="space-y-1.5 border-t section-rule pt-2">
                            {scheduledPlays.map(s => {
                                const { secondsUntil } = scheduleTick(s, scheduleNow);
                                const done = s.mode === 'once' && !!s.lastFiredDate;
                                return (
                                    <div key={s.id} className="flex items-center gap-2 rounded-md bg-slate-500/5 px-2 py-1.5">
                                        <div className="min-w-0 flex-1">
                                            <div className="truncate text-sm text-slate-700 dark:text-slate-200">{getItemTitle(s.item)}</div>
                                            <div className="flex items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400">
                                                <span className="font-semibold">{formatClock12(s.time)}</span>
                                                <span className="rounded bg-slate-500/15 px-1 py-0.5 uppercase tracking-wide">{s.mode === 'daily' ? 'Daily' : s.mode === 'weekly' ? formatDays(s.days) : 'Once'}</span>
                                                <span>{done ? 'Done' : (s.enabled ? formatCountdown(secondsUntil) : 'Off')}</span>
                                            </div>
                                        </div>
                                        <button onClick={() => toggleSchedule(s.id)} title={s.enabled ? 'Disable' : 'Enable'}
                                            className={`flex-none rounded px-2 py-1 text-[10px] font-bold uppercase tracking-wide transition ${s.enabled ? 'bg-emerald-500/15 text-emerald-600' : 'bg-slate-500/15 text-slate-500'}`}>
                                            {s.enabled ? 'On' : 'Off'}
                                        </button>
                                        <button onClick={() => removeSchedule(s.id)} title="Delete schedule"
                                            className="flex-none rounded p-1 text-slate-400 transition hover:bg-red-600/10 hover:text-red-600">
                                            <Trash2 className="h-3.5 w-3.5" />
                                        </button>
                                    </div>
                                );
                            })}
                        </div>
                    ) : (
                        <p className="text-xs text-slate-500 dark:text-slate-400">Auto-play a video at a set time. Fires while the Controller window is open.</p>
                    )}
                </div>
            </div>

            {/* Actions */}
            <div className="flex space-x-3 border-t section-rule pt-2 2xl:col-start-1 2xl:row-start-3">
                <button onClick={toggleMute} 
                    className={`flex-1 px-5 py-2.5 rounded-xl font-bold uppercase tracking-widest text-[10px] transition active:scale-95 border ${isMuted ? 'bg-red-600/10 hover:bg-red-600 text-red-600 hover:text-white border-red-600/20' : 'bg-slate-500/10 hover:bg-slate-500 text-slate-500 hover:text-white border-slate-500/20'}`}>
                    {isMuted ? '🔇 Muted' : '🔊 Mute'}
                </button>
                <button onClick={handleStopClear} 
                    className="flex-1 bg-red-600/10 hover:bg-red-600 text-red-600 hover:text-white border border-red-600/20 px-5 py-2.5 rounded-xl font-bold uppercase tracking-widest text-[10px] transition active:scale-95">
                    Stop & Clear
                </button>
            </div>

            {/* Media Progress */}
            <div className="mt-0 space-y-2 border-t section-rule pt-3 2xl:col-start-1 2xl:row-start-4">
                <div className="flex items-center space-x-3">
                    <button onClick={togglePlay} className="control-button-muted flex h-10 w-10 flex-none items-center justify-center rounded-full text-sm leading-none active:scale-95">
                        {isPlaying ? '⏸' : '▶'}
                    </button>
                    <div className="flex-grow space-y-1">
                        <div className="flex justify-between text-xs text-slate-600 dark:text-slate-400 font-medium px-1">
                            <span>{formatMediaTime(currentTime)}</span>
                            <span>{formatMediaTime(effectiveDuration)}</span>
                        </div>
                        <div
                            ref={seekTrackRef}
                            role="slider"
                            tabIndex={0}
                            aria-valuemin={0}
                            aria-valuemax={Math.round(effectiveDuration || 0)}
                            aria-valuenow={Math.round(currentTime || 0)}
                            onPointerDown={handleTimelinePointerDown}
                            onPointerMove={handleTimelinePointerMove}
                            onPointerUp={stopTimelineDrag}
                            onPointerCancel={stopTimelineDrag}
                            onKeyDown={handleTimelineKeyDown}
                            className={`relative w-full h-4 flex items-center ${effectiveDuration ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'} focus:outline-none group`}
                        >
                            <div className="absolute left-0 right-0 h-2 bg-slate-200 dark:bg-slate-700 rounded-lg overflow-hidden">
                                <div className="h-full bg-indigo-500 rounded-lg" style={{ width: `${progressPercent}%` }} />
                            </div>
                            <div className="absolute top-1/2 w-4 h-4 -mt-2 -ml-2 bg-indigo-500 border-2 border-white dark:border-slate-900 rounded-full shadow transition-transform group-focus:scale-110 group-hover:scale-110" style={{ left: `${progressPercent}%` }} />
                        </div>
                    </div>
                </div>
            </div>

            <div className="section-rule my-4 h-px 2xl:hidden" />

            {/* PHOTO / CANVA LIBRARY */}
            <div className="surface space-y-3 rounded-lg p-3 2xl:col-start-2 2xl:row-start-1 2xl:row-span-4">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b section-rule pb-2">
                    <div className="flex items-center space-x-2">
                        <ImageIcon className="w-4 h-4 text-emerald-500" />
                        <h3 className="text-sm font-bold text-slate-700 dark:text-slate-300 uppercase tracking-[0.2em]">Photo / Canva Library</h3>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        <button
                            onClick={clearPhotoLibrary}
                            disabled={photoPlaylist.length === 0}
                            className="inline-flex items-center gap-1.5 rounded-md border border-red-500/20 bg-red-600/10 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-red-600 transition hover:bg-red-600 hover:text-white disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-red-600/10 disabled:hover:text-red-600"
                            title="Clear Photo / Canva Library"
                        >
                            <Trash className="w-3 h-3" />
                            Clear
                        </button>
                        <button onClick={() => setPhotoLoop(!photoLoop)} className={`rounded px-2 py-1 text-[10px] font-bold transition ${photoLoop ? 'bg-emerald-600 text-white' : 'control-button-muted text-slate-500'}`}>
                            LOOP: {photoLoop ? 'ON' : 'OFF'}
                        </button>
                        <button onClick={() => setPhotoAutoNext(!photoAutoNext)} className={`rounded px-2 py-1 text-[10px] font-bold transition ${photoAutoNext ? 'bg-emerald-600 text-white' : 'control-button-muted text-slate-500'}`}>
                            AUTO NEXT: {photoAutoNext ? 'ON' : 'OFF'}
                        </button>
                    </div>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3 max-h-[240px] overflow-y-auto pr-2 custom-scrollbar">
                    {photoPlaylist.length === 0 ? (
                        <div className="text-xs text-slate-500 italic col-span-full text-center py-6">No photos or Canva slides saved yet.</div>
                    ) : (
                        photoPlaylist.map((item, idx) => (
                            <div 
                                key={idx} 
                                draggable
                                onDragStart={(e) => onPhotoDragStart(e, idx)}
                                onDragOver={(e) => onPhotoDragOver(e, idx)}
                                onDragEnd={onPhotoDragEnd}
                                onClick={() => { setIsPhotoLive(true); playPhotoAtIndex(idx); }}
                                className={`surface-muted group relative flex aspect-video cursor-grab flex-col overflow-hidden rounded-lg transition active:cursor-grabbing ${currentPhotoIdx === idx && isPhotoLive ? 'border-emerald-500 ring-2 ring-emerald-500/30' : 'hover:border-emerald-500/50'} ${draggedPhotoIdx === idx ? 'opacity-50 ring-2 ring-emerald-500/20' : ''}`}
                            >
                                {/* Thumbnail */}
                                {item.type === 'photo' ? (
                                    <img 
                                        src={item.mediaId ? authUrl('/local-image', { mediaId: item.mediaId }) : undefined}
                                        alt={item.name}
                                        className="w-full h-full object-cover"
                                    />
                                ) : (
                                    <div className="w-full h-full bg-purple-600/10 flex flex-col items-center justify-center p-2 text-center">
                                        <Layout className="w-8 h-8 text-purple-500 mb-1" />
                                        <span className="text-[8px] font-bold text-purple-400 uppercase tracking-tighter">Canva Slide</span>
                                    </div>
                                )}

                                {/* Overlay Title */}
                                <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent p-2">
                                    <p className="text-[9px] text-white font-medium truncate">{item.name}</p>
                                </div>

                                {/* Index Badge */}
                                <div className="absolute top-1 left-1 bg-black/60 backdrop-blur-md text-white text-[8px] font-mono px-1.5 py-0.5 rounded border border-white/20">
                                    {idx + 1}
                                </div>

                                {/* Drag Handle */}
                                <div className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                    <GripVertical className="w-3 h-3 text-white/50" />
                                </div>

                                {/* Delete Button */}
                                <button 
                                    onClick={(e) => removePhotoItem(idx, e)} 
                                    className="absolute top-1 right-6 p-1 bg-red-600 text-white rounded shadow-lg opacity-0 group-hover:opacity-100 transition-opacity transform hover:scale-110 active:scale-95"
                                >
                                    <Trash className="w-2.5 h-2.5" />
                                </button>
                            </div>
                        ))
                    )}
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {/* Local Photo Input */}
                    <div className="surface-muted space-y-2 rounded-lg p-3">
                        <div className="flex items-center space-x-2">
                            <ImageIcon className="w-3.5 h-3.5 text-emerald-500" />
                            <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Local Photos</label>
                        </div>
                        <div className="control-field flex items-center space-x-2 p-1.5">
                            <button onClick={handleBrowsePhoto} className="bg-emerald-600 hover:bg-emerald-500 text-white text-[10px] font-bold py-1 px-2.5 rounded transition flex-none">
                                Browse...
                            </button>
                            <span className="text-[10px] text-slate-500 truncate flex-1">{photoFileName}</span>
                        </div>
                        <button onClick={handleAddPhoto} className="w-full bg-emerald-600/10 hover:bg-emerald-600/20 text-emerald-600 dark:text-emerald-400 text-[10px] font-bold py-2 rounded-lg border border-emerald-600/20 transition uppercase tracking-widest">
                            + Add to Photo Library
                        </button>
                    </div>

                    {/* Canva Input */}
                    <div className="surface-muted space-y-2 rounded-lg p-3">
                        <div className="flex items-center space-x-2">
                            <Monitor className="w-3.5 h-3.5 text-purple-500" />
                            <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Canva</label>
                        </div>
                        <div className="space-y-1.5">
                            <input type="text" value={canvaUrl} onChange={e=>setCanvaUrl(e.target.value)} placeholder="Canva share URL..." 
                                className="control-field w-full px-2.5 py-1.5 text-[10px]" />
                            <input type="text" value={canvaName} onChange={e=>setCanvaName(e.target.value)} placeholder="Name..." 
                                className="control-field w-full px-2.5 py-1.5 text-[10px]" />
                        </div>
                        <button onClick={handleAddCanva} className="w-full bg-purple-600/10 hover:bg-purple-600/20 text-purple-600 dark:text-purple-400 text-[10px] font-bold py-2 rounded-lg border border-purple-600/20 transition uppercase tracking-widest">
                            + Save Canva to Library
                        </button>
                    </div>
                </div>

                <div className="pt-3 flex space-x-3">
                    <div className="surface-muted flex w-1/2 items-center space-x-3 rounded-lg px-4">
                        <span className="text-[10px] font-bold text-slate-400 uppercase whitespace-nowrap">Auto Interval</span>
                        <input type="range" min="1" max="60" value={photoInterval} onChange={e=>setPhotoInterval(parseInt(e.target.value))} 
                            className="flex-1 h-1.5 bg-slate-200 dark:bg-slate-700 rounded-lg appearance-none cursor-pointer accent-emerald-500 min-w-0" />
                        <span className="text-[10px] font-mono font-bold text-emerald-500 w-6 text-right flex-none">{photoInterval}s</span>
                    </div>

                    <button onClick={stopPhotoOutput} 
                        className="w-1/2 bg-red-600/10 hover:bg-red-600 text-red-600 hover:text-white border border-red-600/20 py-2.5 rounded-xl font-bold uppercase tracking-widest text-[10px] transition active:scale-95 flex items-center justify-center">
                        Stop & Clear
                    </button>
                </div>

                {/* MESSAGE OVERLAY */}
                <div className="surface-muted space-y-3 rounded-lg p-3">
                    <div className="flex items-center justify-between border-b section-rule pb-2">
                        <div className="flex items-center space-x-2">
                            <Type className="w-3.5 h-3.5 text-cyan-500" />
                            <h4 className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Message Overlay</h4>
                        </div>
                        <label className="relative inline-flex items-center cursor-pointer">
                            <input type="checkbox" className="sr-only peer" checked={messageOverlayEnabled} onChange={e => setMessageOverlayEnabled(e.target.checked)} />
                            <div className="w-9 h-5 bg-slate-200 dark:bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-cyan-600"></div>
                        </label>
                    </div>

                    <div className={`${messageOverlayEnabled ? 'opacity-100' : 'opacity-50'} space-y-3 transition-all duration-300`}>
                        <textarea
                            value={messageOverlayText}
                            onChange={e => setMessageOverlayText(e.target.value)}
                            rows="2"
                            maxLength={180}
                            placeholder="Type a message to show over media..."
                            className="control-field w-full resize-none px-3 py-2 text-xs focus:ring-cyan-500"
                        />

                        <div className="grid grid-cols-2 gap-3">
                            <label className="space-y-1.5">
                                <span className="block text-[10px] font-bold text-slate-500 uppercase tracking-wider">Position</span>
                                <select value={messageOverlayPosition} onChange={e => setMessageOverlayPosition(e.target.value)} className="control-field w-full px-2 py-1.5 text-[10px]">
                                    <option value="top">Top</option>
                                    <option value="center">Center</option>
                                    <option value="bottom">Bottom</option>
                                    <option value="lowerThird">Lower Third</option>
                                </select>
                            </label>
                            <label className="space-y-1.5">
                                <span className="block text-[10px] font-bold text-slate-500 uppercase tracking-wider">Weight</span>
                                <select value={messageOverlayWeight} onChange={e => setMessageOverlayWeight(e.target.value)} className="control-field w-full px-2 py-1.5 text-[10px]">
                                    <option value="500">Medium</option>
                                    <option value="700">Bold</option>
                                    <option value="800">Extra Bold</option>
                                    <option value="900">Black</option>
                                </select>
                            </label>
                        </div>

                        <div className="grid grid-cols-[1fr_auto] gap-3">
                            <label className="space-y-1.5">
                                <div className="flex justify-between items-center">
                                    <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Size</span>
                                    <span className="text-[10px] font-mono font-bold text-cyan-500">{messageOverlaySize}px</span>
                                </div>
                                <input type="range" min="28" max="150" value={messageOverlaySize} onChange={e => setMessageOverlaySize(parseInt(e.target.value))} className="w-full h-1.5 bg-slate-200 dark:bg-slate-700 rounded-lg appearance-none cursor-pointer accent-cyan-500" />
                            </label>
                            <label className="space-y-1.5">
                                <span className="block text-[10px] font-bold text-slate-500 uppercase tracking-wider">Color</span>
                                <input type="color" value={messageOverlayColor} onChange={e => setMessageOverlayColor(e.target.value)} className="h-8 w-11 rounded-lg border border-slate-300 dark:border-slate-700 bg-transparent p-1" />
                            </label>
                        </div>

                        <div className="grid grid-cols-3 gap-2">
                            <button onClick={() => setMessageOverlayUppercase(prev => !prev)} className={`rounded-lg px-2 py-2 text-[9px] font-bold uppercase tracking-wider transition ${messageOverlayUppercase ? 'bg-cyan-600 text-white' : 'control-button-muted text-slate-500'}`}>
                                Upper: {messageOverlayUppercase ? 'On' : 'Off'}
                            </button>
                            <button onClick={() => setMessageOverlayBackdrop(prev => !prev)} className={`rounded-lg px-2 py-2 text-[9px] font-bold uppercase tracking-wider transition ${messageOverlayBackdrop ? 'bg-cyan-600 text-white' : 'control-button-muted text-slate-500'}`}>
                                Backdrop: {messageOverlayBackdrop ? 'On' : 'Off'}
                            </button>
                            <button onClick={clearMessageOverlay} className="rounded-lg border border-red-600/20 bg-red-600/10 px-2 py-2 text-[9px] font-bold uppercase tracking-wider text-red-600 transition hover:bg-red-600 hover:text-white">
                                Clear
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            {/* PARTICLE OVERLAYS */}
            {showParticleOverlayControls && (
                <div className="surface space-y-4 rounded-lg p-4">
                    <div className="flex items-center justify-between border-b section-rule pb-2">
                        <div className="flex items-center space-x-2">
                            <Monitor className="w-4 h-4 text-indigo-500" />
                            <h3 className="text-sm font-bold text-slate-700 dark:text-slate-300 uppercase tracking-[0.2em]">Particle Overlays</h3>
                        </div>
                        <label className="relative inline-flex items-center cursor-pointer">
                            <input type="checkbox" className="sr-only peer" checked={particlesEnabled} onChange={e => setParticlesEnabled(e.target.checked)} />
                            <div className="w-11 h-6 bg-slate-200 dark:bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-indigo-600"></div>
                        </label>
                    </div>

                    <div className={`${particlesEnabled ? 'opacity-100' : 'opacity-40 pointer-events-none'} space-y-4 transition-all duration-300`}>
                        <div className="grid grid-cols-2 gap-4">
                            <div className="space-y-1.5">
                                <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-wider">Effect Type</label>
                                <select 
                                    value={particleType} 
                                    onChange={e => setParticleType(e.target.value)}
                                    className="control-field w-full px-3 py-2 text-xs"
                                >
                                    <option value="dust">Floating Dust</option>
                                    <option value="snow">Gentle Snow</option>
                                    <option value="rain">Heavy Rain</option>
                                    <option value="bokeh">Cinematic Bokeh</option>
                                    <option value="petals">Floating Petals</option>
                                    <option value="bubbles">Floating Bubbles</option>
                                    <option value="stars">Twinkling Stars</option>
                                    <option value="fireflies">Fireflies (Glow)</option>
                                    <option value="confetti">Party Confetti</option>
                                    <option value="digital">Digital Rain (Matrix)</option>
                                </select>
                            </div>
                            <div className="space-y-1.5">
                                <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-wider">Speed</label>
                                <div className="flex items-center space-x-3">
                                    <input 
                                        type="range" min="1" max="100" value={particleSpeed} 
                                        onChange={e => setParticleSpeed(parseInt(e.target.value))}
                                        className="flex-1 h-1.5 bg-slate-200 dark:bg-slate-700 rounded-lg appearance-none cursor-pointer accent-indigo-500" 
                                    />
                                    <span className="text-[10px] font-mono font-bold text-indigo-500 w-6">{particleSpeed}</span>
                                </div>
                            </div>
                        </div>

                        <div className="space-y-1.5">
                            <div className="flex justify-between items-center">
                                <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Density / Intensity</label>
                                <span className="text-[10px] font-mono font-bold text-indigo-500 bg-indigo-500/10 px-2 py-0.5 rounded">{particleIntensity}%</span>
                            </div>
                            <input 
                                type="range" min="1" max="100" value={particleIntensity} 
                                onChange={e => setParticleIntensity(parseInt(e.target.value))}
                                className="w-full h-1.5 bg-slate-200 dark:bg-slate-700 rounded-lg appearance-none cursor-pointer accent-indigo-500" 
                            />
                        </div>
                    </div>
                </div>
            )}

            {/* YouTube playlist import picker */}
            {playlistPickerItems !== null && (
                <div
                    className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
                    onMouseDown={closePlaylistPicker}
                >
                    <div
                        className="surface-raised flex max-h-[85vh] w-full max-w-xl flex-col overflow-hidden rounded-3xl shadow-2xl"
                        onMouseDown={e => e.stopPropagation()}
                    >
                        {/* Header */}
                        <div className="flex shrink-0 items-start justify-between gap-3 border-b section-rule p-5">
                            <div>
                                <h3 className="text-base font-bold text-slate-800 dark:text-slate-100">Import Playlist</h3>
                                <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                                    {playlistPickerItems.length} video{playlistPickerItems.length === 1 ? '' : 's'} found — choose which to import
                                </p>
                            </div>
                            <button
                                onClick={closePlaylistPicker}
                                className="rounded-full p-1.5 text-slate-500 transition hover:bg-slate-500/10 hover:text-slate-800 dark:hover:text-slate-100"
                                aria-label="Close"
                            >
                                <X className="h-4 w-4" />
                            </button>
                        </div>

                        {/* Toolbar */}
                        <div className="flex shrink-0 items-center justify-between gap-3 border-b section-rule px-5 py-2.5">
                            <button
                                onClick={toggleSelectAllPicker}
                                className="control-button-muted px-3 py-1 text-xs font-bold"
                            >
                                {allPickerSelected ? 'Deselect all' : 'Select all'}
                            </button>
                            <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">
                                {selectedVideoIds.size} of {playlistPickerItems.length} selected
                            </span>
                        </div>

                        {/* Video list */}
                        <div className="min-h-0 flex-1 overflow-y-auto p-2">
                            {playlistPickerItems.map(item => {
                                const checked = selectedVideoIds.has(item.id);
                                return (
                                    <label
                                        key={item.id}
                                        className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 transition hover:bg-slate-500/10"
                                    >
                                        <input
                                            type="checkbox"
                                            checked={checked}
                                            onChange={() => toggleVideoSelected(item.id)}
                                            className="h-4 w-4 shrink-0 cursor-pointer accent-indigo-500"
                                        />
                                        <img
                                            src={`https://i.ytimg.com/vi/${item.id}/default.jpg`}
                                            alt=""
                                            loading="lazy"
                                            className="h-9 w-16 shrink-0 rounded bg-slate-200 object-cover dark:bg-slate-700"
                                        />
                                        <span className="min-w-0 flex-1 truncate text-sm text-slate-700 dark:text-slate-200">
                                            {item.name}
                                        </span>
                                    </label>
                                );
                            })}
                        </div>

                        {/* Footer */}
                        <div className="flex shrink-0 items-center justify-end gap-2 border-t section-rule p-4">
                            <button onClick={closePlaylistPicker} className="control-button-muted px-4 py-1.5 text-sm font-bold">
                                Cancel
                            </button>
                            <button
                                onClick={confirmImportPlaylist}
                                disabled={selectedVideoIds.size === 0}
                                className="rounded-lg bg-indigo-600 px-4 py-1.5 text-sm font-bold text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-40"
                            >
                                Import Selected ({selectedVideoIds.size})
                            </button>
                        </div>
                    </div>
                </div>
            )}

        </div>
    );
}
