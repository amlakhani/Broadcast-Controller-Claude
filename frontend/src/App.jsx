import { useState, useEffect, useRef, useMemo, useReducer, useCallback } from 'react';
import { io } from 'socket.io-client';
import { ChevronLeft, ChevronRight, ClipboardList, Command, ExternalLink, Film, Grid3x3, Languages, LayoutGrid, ListVideo, Monitor, MonitorCheck, Moon, Music, PanelLeftClose, PanelLeftOpen, Pause, Play, Presentation, Radio, RotateCcw, Search, Settings, Sun, Timer, Trash2, Type, X, Zap } from 'lucide-react';
import { authUrl, getAuthToken, getRemoteToken, isRemoteEntry, socketOptions } from './auth';
import { useThrottledCallback } from './utils/performance';

import RunOfShowPanel from './components/RunOfShowPanel';
import PadLayoutPanel from './components/PadLayoutPanel';
import LowerThirdsPanel from './components/LowerThirdsPanel';
import LyricsPanel from './components/LyricsPanel';
import SabhaPanel from './components/SabhaPanel';
import PresentationPanel from './components/PresentationPanel';
import MediaPanel from './components/MediaPanel';
import StageDisplayPanel from './components/StageDisplayPanel';
import TranslationPanel from './components/TranslationPanel';
import BackstageCueSheetPanel from './components/BackstageCueSheetPanel';
import SuperSourcePanel from './components/SuperSourcePanel';
import RemotePairing from './components/RemotePairing';
import RemoteQr from './components/RemoteQr';

const DEFAULT_LAYER_VISIBILITY = {
  presentation: true,
  media: true,
  lowerThirds: true,
  lyrics: true,
  translation: true,
  sabhaTimer: true,
  particles: true,
  mediaMessage: true,
};

const SHOW_PARTICLE_OVERLAY_CONTROLS_KEY = 'bc-show-particle-overlay-controls';

const LAYER_LABELS = {
  presentation: 'Presentation',
  media: 'Media / Photos',
  lowerThirds: 'Lower Thirds',
  lyrics: 'Lyrics',
  translation: 'Translation',
  sabhaTimer: 'Sabha Timer',
  particles: 'Particles',
  mediaMessage: 'Media Message',
};

const NDI_SOURCE_OPTIONS = [
  { id: 'graphics', label: 'Graphics Output', defaultName: 'Broadcast Controller Graphics' },
  { id: 'stage', label: 'Stage Display', defaultName: 'Broadcast Controller Stage' },
  { id: 'lyrics', label: 'Lyrics Only', defaultName: 'Broadcast Controller Lyrics' },
  { id: 'lowerThirds', label: 'Lower Thirds Only', defaultName: 'Broadcast Controller Lower Thirds' },
  { id: 'sabhaTimer', label: 'Timer Only', defaultName: 'Broadcast Controller Timer' },
  { id: 'translation', label: 'Translation Only', defaultName: 'Broadcast Controller Translation' },
];

const TAB_GROUPS = [
  {
    label: 'Control',
    tabs: [
      { id: 'runshow', label: 'Run of Show', cue: 'Timeline', icon: ListVideo },
    ],
  },
  {
    label: 'Live',
    tabs: [
      { id: 'sabha', label: 'Pre-Show', cue: 'Timer', icon: Timer },
      { id: 'pres', label: 'Slides', cue: 'Presentation', icon: Presentation },
      { id: 'media', label: 'Media', cue: 'Video / Photos', icon: Film },
    ],
  },
  {
    label: 'Graphics',
    tabs: [
      { id: 'lyrics', label: 'Lyrics', cue: 'Verses', icon: Music },
      { id: 'lt', label: 'Lower Thirds', cue: 'Names', icon: Type },
      { id: 'translation', label: 'Translation', cue: 'Captions', icon: Languages },
    ],
  },
  {
    label: 'Production Monitor',
    tabs: [
      { id: 'stage', label: 'Confidence Monitor', cue: 'Stage', icon: MonitorCheck },
      { id: 'backstage', label: 'Backstage Monitor', cue: 'Rundown', icon: ClipboardList },
    ],
  },
  {
    // localOnly: these pages drive physical hardware, so a remote-paired phone
    // never sees them. The filter lives in visibleTabGroups below.
    label: 'Device Controls',
    localOnly: true,
    tabs: [
      { id: 'supersource', label: 'SuperSource Designer', cue: 'ATEM PiP', icon: LayoutGrid },
    ],
  },
  {
    // Also localOnly: the server only accepts a pad layout from the main
    // controller, so showing a remote operator an editor whose saves get
    // rejected would just be confusing.
    label: 'Remote Pad',
    localOnly: true,
    tabs: [
      { id: 'pad', label: 'Pad Layout', cue: 'Button Grid', icon: Grid3x3 },
    ],
  },
];

const getStoredRemoteSession = () => {
  try {
    return JSON.parse(localStorage.getItem('bc-remote-session')) || null;
  } catch {
    return null;
  }
};

const parseJsonSetting = (key, fallback) => {
  try {
    return JSON.parse(localStorage.getItem(key)) || fallback;
  } catch {
    return fallback;
  }
};

function liveStateReducer(state, action) {
  switch (action.type) {
    case 'patch':
      return { ...state, ...action.patch };
    case 'clear':
      return {
        ...state,
        media: false,
        photo: false,
        lowerThird: false,
        sabha: false,
        translation: false,
      };
    default:
      return state;
  }
}

// Reusable hook for responsive design
function useMediaQuery(query) {
  const [matches, setMatches] = useState(window.matchMedia(query).matches);

  useEffect(() => {
    const media = window.matchMedia(query);
    if (media.matches !== matches) {
      setMatches(media.matches);
    }
    const listener = () => setMatches(media.matches);
    media.addEventListener('change', listener);
    return () => media.removeEventListener('change', listener);
  }, [matches, query]);

  return matches;
}

// Preview Iframe component - DEFINED OUTSIDE to prevent unmount/remount loops
const PreviewIframe = ({ isSidebar = false, activeTab }) => {
  const wrapperRef = useRef(null);
  const [iframesReady, setIframesReady] = useState(false);
  const [previewMode, setPreviewMode] = useState(() => ['stage', 'backstage'].includes(activeTab) ? activeTab : 'graphics');
  const [isPaused, setIsPaused] = useState(false);

  const isStage = previewMode === 'stage';
  const isBackstage = previewMode === 'backstage';
  const previewPath = isBackstage ? '/backstage' : '/graphics';
  const previewParams = isBackstage ? { preview: 'true' } : { mode: previewMode, preview: 'true' };
  const previewLabel = isBackstage ? 'Backstage' : isStage ? 'Stage' : 'Graphics';

  // Defer iframe loading to speed up initial app startup
  useEffect(() => {
    const timer = setTimeout(() => setIframesReady(true), 2500);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (activeTab === 'stage') setPreviewMode('stage');
    if (activeTab === 'backstage') setPreviewMode('backstage');
  }, [activeTab]);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    const updateScale = () => {
      const rect = wrapper.getBoundingClientRect();
      if (rect.width > 0) {
        const scale = rect.width / 1920;
        const iframes = wrapper.querySelectorAll('iframe');
        iframes.forEach(iframe => {
          iframe.style.transform = `scale(${scale})`;
        });
      }
    };

    // Initial scale
    requestAnimationFrame(() => {
      requestAnimationFrame(updateScale);
    });

    const ro = new ResizeObserver(() => {
      requestAnimationFrame(updateScale);
    });
    ro.observe(wrapper);
    return () => ro.disconnect();
  }, [isSidebar, iframesReady, isPaused, previewMode]); 

  const popOutPreview = () => {
    window.open(authUrl(previewPath, previewParams), `bc-preview-${previewMode}`, 'width=960,height=540');
  };

  return (
    <div className="surface rounded-lg p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-xs font-bold text-slate-500 uppercase tracking-widest">Live Preview</h3>
        <div className="flex items-center gap-1.5">
          <button onClick={() => setPreviewMode('graphics')} className={`rounded-md px-2 py-1 text-[9px] font-bold uppercase tracking-wider ${previewMode === 'graphics' ? 'bg-blue-600 text-white' : 'control-button-muted'}`}>Graphics</button>
          <button onClick={() => setPreviewMode('stage')} className={`rounded-md px-2 py-1 text-[9px] font-bold uppercase tracking-wider ${previewMode === 'stage' ? 'bg-indigo-600 text-white' : 'control-button-muted'}`}>Stage</button>
          <button onClick={() => setPreviewMode('backstage')} className={`rounded-md px-2 py-1 text-[9px] font-bold uppercase tracking-wider ${previewMode === 'backstage' ? 'bg-cyan-600 text-white' : 'control-button-muted'}`}>Backstage</button>
          <button onClick={() => setIsPaused(prev => !prev)} className="control-button-muted flex h-7 w-7 items-center justify-center text-slate-500 transition hover:text-slate-900 dark:hover:text-white" title={isPaused ? 'Resume Preview' : 'Pause Preview'}>
            {isPaused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
          </button>
          <button onClick={popOutPreview} className="control-button-muted flex h-7 w-7 items-center justify-center text-slate-500 transition hover:text-slate-900 dark:hover:text-white" title="Pop Out Preview">
            <ExternalLink className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <div ref={wrapperRef} className="relative w-full aspect-video bg-black rounded-lg border border-slate-700 overflow-hidden shadow-inner">
        {iframesReady && !isPaused ? (
            <iframe 
              key={previewMode}
              src={authUrl(previewPath, previewParams)}
              style={{ 
                position: 'absolute', top: 0, left: 0, width: '1920px', height: '1080px', transformOrigin: 'top left', pointerEvents: 'none'
              }}
              className="border-0"
              tabIndex={-1}
              title={`${previewLabel} Preview`}
            ></iframe>
        ) : (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="text-xs text-slate-500 font-medium animate-pulse">{isPaused ? 'Preview paused' : 'Loading preview...'}</div>
          </div>
        )}
      </div>
    </div>
  );
};

function App() {
  const isRemoteClient = isRemoteEntry() && !getAuthToken();
  const [remoteToken, setRemoteToken] = useState(() => isRemoteClient ? getRemoteToken() : '');
  const [remoteSession, setRemoteSession] = useState(() => isRemoteClient ? getStoredRemoteSession() : null);
  const [remoteAccessStatus, setRemoteAccessStatus] = useState(null);
  const [remoteAccessPending, setRemoteAccessPending] = useState(false);
  const [socket, setSocket] = useState(null);
  const [activeTab, setActiveTab] = useState('runshow');
  const [navCollapsed, setNavCollapsed] = useState(() => {
    return localStorage.getItem('bc-nav-collapsed') === 'true';
  });
  const [theme, setTheme] = useState(() => {
    return localStorage.getItem('bc-theme') || 'dark';
  });
  const [showParticleOverlayControls, setShowParticleOverlayControls] = useState(() => {
    return localStorage.getItem(SHOW_PARTICLE_OVERLAY_CONTROLS_KEY) === 'true';
  });

  const isDesktop = useMediaQuery('(min-width: 1280px)'); // 1280px is 'xl' in Tailwind

  // Settings state
  const [displays, setDisplays] = useState([]);
  const [graphicsDisplay, setGraphicsDisplay] = useState(() => {
    return localStorage.getItem('bc-graphics-display') || '';
  });
  const [stageDisplay, setStageDisplay] = useState(() => {
    return localStorage.getItem('bc-stage-display') || '';
  });
  const [backstageDisplay, setBackstageDisplay] = useState(() => {
    return localStorage.getItem('bc-backstage-display') || '';
  });
  const [outputMode, setOutputMode] = useState(() => {
    return localStorage.getItem('bc-output-background-mode') || 'green';
  });
  const [fitMode, setFitMode] = useState(() => {
    return localStorage.getItem('bc-output-fit-mode') === 'fill' ? 'fill' : 'fit';
  });
  const [layerVisibility, setLayerVisibility] = useState(() => ({
    ...DEFAULT_LAYER_VISIBILITY,
    ...parseJsonSetting('bc-layer-visibility', {})
  }));
  const initialLayerVisibilityRef = useRef(layerVisibility);
  const [ndiSourceName, setNdiSourceName] = useState(() => {
    return localStorage.getItem('bc-ndi-source-name') || 'Broadcast Controller Graphics';
  });
  const [ndiSourceType, setNdiSourceType] = useState(() => {
    return localStorage.getItem('bc-ndi-source-type') || 'graphics';
  });
  const [ndiStatus, setNdiStatus] = useState({
    enabled: false,
    sourceName: 'Broadcast Controller Graphics',
    sourceType: 'graphics',
    receivers: 0,
    fps: 0,
    lastFrameAt: null,
    error: null
  });
  const [operatorState, setOperatorState] = useState(null);
  const [socketConnected, setSocketConnected] = useState(false);

  const [isGraphicsOpen, setIsGraphicsOpen] = useState(false);
  const [isStageOpen, setIsStageOpen] = useState(false);
  const [isBackstageOpen, setIsBackstageOpen] = useState(false);
  const [isCommandOpen, setIsCommandOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState('');
  const [clearUndo, setClearUndo] = useState(null);
  const [isPreviewCollapsed, setIsPreviewCollapsed] = useState(false);
  const clearUndoTimerRef = useRef(null);
  const commandInputRef = useRef(null);
  const [liveState, dispatchLiveState] = useReducer(liveStateReducer, {
    media: false,
    photo: false,
    lowerThird: false,
    sabha: false,
    translation: false,
    presentation: false,
  });
  const throttledSetOperatorState = useThrottledCallback(setOperatorState, 200);
  const throttledSetNdiStatus = useThrottledCallback(setNdiStatus, 200);

  const clearRemoteSession = useCallback(() => {
    localStorage.removeItem('bc-remote-token');
    localStorage.removeItem('bc-remote-session');
    setRemoteToken('');
    setRemoteSession(null);
    setSocketConnected(false);
  }, []);

  useEffect(() => {
    if (isRemoteClient && !remoteToken) return undefined;
    const nextSocket = io(socketOptions(remoteToken));
    const handleConnectError = () => {
      if (isRemoteClient) {
        localStorage.removeItem('bc-remote-token');
        localStorage.removeItem('bc-remote-session');
        setRemoteToken('');
        setRemoteSession(null);
      }
    };
    nextSocket.on('connect_error', handleConnectError);
    setSocket(nextSocket);
    return () => {
      nextSocket.off('connect_error', handleConnectError);
      nextSocket.disconnect();
      setSocket(null);
    };
  }, [isRemoteClient, remoteToken]);

  useEffect(() => {
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
    localStorage.setItem('bc-theme', theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem('bc-nav-collapsed', navCollapsed ? 'true' : 'false');
  }, [navCollapsed]);

  useEffect(() => {
    if (!socket) return undefined;
    const handleDisplays = (data) => setDisplays(data);
    socket.on('available_displays', handleDisplays);
    return () => socket.off('available_displays', handleDisplays);
  }, [socket]);

  useEffect(() => {
    if (!socket) return undefined;
    const handleConnect = () => {
      setSocketConnected(true);
      if (!isRemoteClient) socket.emit('remote_access_status_request');
    };
    const handleDisconnect = (reason) => {
      setSocketConnected(false);
      if (!isRemoteClient && reason === 'io server disconnect') {
        setTimeout(() => socket.connect(), 250);
      }
    };
    const handleOperatorState = (state) => throttledSetOperatorState(state);
    const handleRemoteRevoked = () => {
      clearRemoteSession();
    };
    socket.on('connect', handleConnect);
    socket.on('disconnect', handleDisconnect);
    socket.on('operator_state_update', handleOperatorState);
    socket.on('remote_session_revoked', handleRemoteRevoked);
    return () => {
      socket.off('connect', handleConnect);
      socket.off('disconnect', handleDisconnect);
      socket.off('operator_state_update', handleOperatorState);
      socket.off('remote_session_revoked', handleRemoteRevoked);
    };
  }, [socket, throttledSetOperatorState, isRemoteClient, clearRemoteSession]);

  // Forwards a clicker keypress captured globally in the main process (registered once at
  // startup — see main.js's registerClickerShortcuts) to the same server-authoritative
  // pres_nav path every other slide-navigation source already uses. `window.broadcastAPI`
  // only exists inside the Electron control window (see preload.cjs) — a /remote session
  // opened in a plain phone browser has no such bridge.
  useEffect(() => {
    if (!socket || !window.broadcastAPI?.onPresentationClickerNav) return undefined;
    return window.broadcastAPI.onPresentationClickerNav((direction) => {
      socket.emit('pres_nav', direction);
    });
  }, [socket]);

  useEffect(() => {
    if (!socket) return undefined;
    const handleNdiStatus = (status) => throttledSetNdiStatus(status);
    socket.on('ndi_status_update', handleNdiStatus);
    socket.emit('ndi_status_request');
    return () => socket.off('ndi_status_update', handleNdiStatus);
  }, [socket, throttledSetNdiStatus]);

  useEffect(() => {
    if (!socket || isRemoteClient) return undefined;
    const handleRemoteStatus = (status) => {
      setRemoteAccessPending(false);
      setRemoteAccessStatus(status);
    };
    socket.on('remote_access_status_update', handleRemoteStatus);
    socket.emit('remote_access_status_request');
    return () => socket.off('remote_access_status_update', handleRemoteStatus);
  }, [socket, isRemoteClient]);

  useEffect(() => {
    if (!socket) return undefined;
    const handleMediaPlay = () => dispatchLiveState({ type: 'patch', patch: { media: true } });
    const handleMediaStop = () => dispatchLiveState({ type: 'patch', patch: { media: false } });
    const handlePhotoPlay = () => dispatchLiveState({ type: 'patch', patch: { photo: true } });
    const handlePhotoStop = () => dispatchLiveState({ type: 'patch', patch: { photo: false } });
    const handleLowerThirdPlay = () => dispatchLiveState({ type: 'patch', patch: { lowerThird: true } });
    const handleLowerThirdStop = () => dispatchLiveState({ type: 'patch', patch: { lowerThird: false } });
    const handleSabha = (data) => dispatchLiveState({ type: 'patch', patch: { sabha: Boolean(data?.showing) } });
    const handleTranslation = () => dispatchLiveState({ type: 'patch', patch: { translation: true } });
    const handleTranslationHide = () => dispatchLiveState({ type: 'patch', patch: { translation: false } });
    const handlePresentation = (data) => dispatchLiveState({
      type: 'patch',
      patch: { presentation: Boolean(data && data.mode !== 'none' && data.showing) }
    });

    socket.on('media_play', handleMediaPlay);
    socket.on('media_stop', handleMediaStop);
    socket.on('photo_play', handlePhotoPlay);
    socket.on('photo_stop', handlePhotoStop);
    socket.on('play_graphic', handleLowerThirdPlay);
    socket.on('stop_graphic', handleLowerThirdStop);
    socket.on('sabha_timer_state', handleSabha);
    socket.on('translation_update', handleTranslation);
    socket.on('hide_translation', handleTranslationHide);
    socket.on('pres_update', handlePresentation);

    return () => {
      socket.off('media_play', handleMediaPlay);
      socket.off('media_stop', handleMediaStop);
      socket.off('photo_play', handlePhotoPlay);
      socket.off('photo_stop', handlePhotoStop);
      socket.off('play_graphic', handleLowerThirdPlay);
      socket.off('stop_graphic', handleLowerThirdStop);
      socket.off('sabha_timer_state', handleSabha);
      socket.off('translation_update', handleTranslation);
      socket.off('hide_translation', handleTranslationHide);
      socket.off('pres_update', handlePresentation);
    };
  }, [socket]);

  useEffect(() => {
    const handleKeyDown = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setIsCommandOpen(true);
      }
      if (event.key === 'Escape') {
        setIsCommandOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  useEffect(() => {
    if (isCommandOpen) {
      requestAnimationFrame(() => commandInputRef.current?.focus());
    } else {
      setCommandQuery('');
    }
  }, [isCommandOpen]);

  useEffect(() => {
    if (!socket) return undefined;
    const handleOutputMode = (data) => {
      if (data?.backgroundMode) setOutputMode(data.backgroundMode);
      if (data?.fitMode) setFitMode(data.fitMode);
    };
    const handleLayerVisibility = (data) => {
      if (data) setLayerVisibility(prev => ({ ...prev, ...data }));
    };
    socket.on('output_mode_update', handleOutputMode);
    socket.on('layer_visibility_update', handleLayerVisibility);
    return () => {
      socket.off('output_mode_update', handleOutputMode);
      socket.off('layer_visibility_update', handleLayerVisibility);
    };
  }, [socket]);

  // Persist settings
  useEffect(() => {
    localStorage.setItem('bc-graphics-display', graphicsDisplay);
  }, [graphicsDisplay]);

  useEffect(() => {
    localStorage.setItem('bc-stage-display', stageDisplay);
  }, [stageDisplay]);

  useEffect(() => {
    localStorage.setItem('bc-backstage-display', backstageDisplay);
  }, [backstageDisplay]);

  useEffect(() => {
    localStorage.setItem('bc-output-background-mode', outputMode);
    if (socket) {
      socket.emit('output_mode_update', { backgroundMode: outputMode });
    }
  }, [outputMode, socket]);

  useEffect(() => {
    localStorage.setItem('bc-output-fit-mode', fitMode);
    if (socket) {
      socket.emit('output_mode_update', { fitMode });
    }
  }, [fitMode, socket]);

  useEffect(() => {
    localStorage.setItem('bc-layer-visibility', JSON.stringify(layerVisibility));
  }, [layerVisibility]);

  useEffect(() => {
    localStorage.setItem(SHOW_PARTICLE_OVERLAY_CONTROLS_KEY, showParticleOverlayControls ? 'true' : 'false');
  }, [showParticleOverlayControls]);

  useEffect(() => {
    if (socket) {
      socket.emit('layer_visibility_update', initialLayerVisibilityRef.current);
    }
  }, [socket]);

  useEffect(() => {
    localStorage.setItem('bc-ndi-source-name', ndiSourceName);
  }, [ndiSourceName]);

  useEffect(() => {
    localStorage.setItem('bc-ndi-source-type', ndiSourceType);
  }, [ndiSourceType]);

  const toggleTheme = useCallback(() => {
    setTheme(prev => prev === 'dark' ? 'light' : 'dark');
  }, []);

  // Settings handlers
  const handleOpenGraphics = useCallback(() => {
    if (!socket) return;
    if (!graphicsDisplay) {
      setActiveTab('settings');
      return;
    }
    socket.emit('set_output_display', graphicsDisplay);
    setIsGraphicsOpen(true);
  }, [graphicsDisplay, socket]);
  const handleCloseGraphics = useCallback(() => {
    if (!socket) return;
    socket.emit('close_graphics_window');
    setIsGraphicsOpen(false);
  }, [socket]);
  const handleOpenStage = useCallback(() => {
    if (!socket) return;
    if (!stageDisplay) {
      setActiveTab('settings');
      return;
    }
    socket.emit('set_stage_display', stageDisplay);
    setIsStageOpen(true);
  }, [stageDisplay, socket]);
  const handleCloseStage = useCallback(() => {
    if (!socket) return;
    socket.emit('close_stage_window');
    setIsStageOpen(false);
  }, [socket]);
  const handleOpenBackstage = useCallback(() => {
    if (!socket) return;
    if (!backstageDisplay) {
      setActiveTab('settings');
      return;
    }
    socket.emit('set_backstage_display', backstageDisplay);
    setIsBackstageOpen(true);
  }, [backstageDisplay, socket]);
  const handleCloseBackstage = useCallback(() => {
    if (!socket) return;
    socket.emit('close_backstage_window');
    setIsBackstageOpen(false);
  }, [socket]);
  const handleNdiToggle = useCallback(() => {
    if (!socket) return;
    if (ndiStatus.enabled) {
      socket.emit('ndi_stop');
    } else {
      socket.emit('ndi_start', {
        sourceName: ndiSourceName.trim() || 'Broadcast Controller Graphics',
        sourceType: ndiSourceType,
        width: 1920,
        height: 1080,
        fps: 30
      });
    }
  }, [ndiStatus.enabled, ndiSourceName, ndiSourceType, socket]);
  const toggleLayerVisibility = (layer) => {
    if (!socket) return;
    setLayerVisibility(prev => {
      const patch = { [layer]: !prev[layer] };
      socket.emit('layer_visibility_update', patch);
      return { ...prev, ...patch };
    });
  };
  const handleClearAll = useCallback(() => {
    if (!socket) return;
    socket.emit('clear_all');
    setClearUndo({ createdAt: Date.now() });
    if (clearUndoTimerRef.current) clearTimeout(clearUndoTimerRef.current);
    clearUndoTimerRef.current = setTimeout(() => setClearUndo(null), 10000);
    dispatchLiveState({ type: 'clear' });
  }, [socket]);
  const handleBlackout = useCallback(() => {
    if (!socket) return;
    setOutputMode('black');
    socket.emit('output_mode_update', { backgroundMode: 'black' });
    handleClearAll();
  }, [handleClearAll, socket]);
  const handleShowTimer = () => {
    if (!socket) return;
    const timer = operatorState?.current?.sabhaTimer || {};
    socket.emit('sabha_timer_update', {
      timeStr: timer.timeStr || '16:00',
      message: timer.message || 'Sabha Starts In',
      showing: true
    });
  };
  const handleUndoClear = useCallback(() => {
    if (!socket) return;
    socket.emit('restore_recent_clear');
    setClearUndo(null);
    if (clearUndoTimerRef.current) clearTimeout(clearUndoTimerRef.current);
  }, [socket]);

  // Clear all outputs before the main process reloads this window, so
  // Preview and Output don't end up desynced (e.g. preview restarting a
  // clip from 0 while the untouched output window keeps playing it).
  useEffect(() => {
    if (!window.broadcastAPI?.onBeforeReload) return undefined;
    return window.broadcastAPI.onBeforeReload(() => handleClearAll());
  }, [handleClearAll]);

  const handleClearCache = () => {
    if (window.confirm("WARNING: Are you sure you want to clear all saved data (playlists, library, presets, themes)? This cannot be undone.")) {
      localStorage.clear();
      window.location.reload();
    }
  };

  const handleRemoteAccessToggle = () => {
    if (!socket || remoteAccessPending) return;
    const nextEnabled = !remoteAccessStatus?.enabled;
    setRemoteAccessPending(true);
    setRemoteAccessStatus(prev => prev ? { ...prev, enabled: nextEnabled } : { enabled: nextEnabled, lanUrls: [], sessions: [] });
    setTimeout(async () => {
      try {
        const response = await fetch(authUrl('/api/remote/status'));
        if (response.ok) {
          setRemoteAccessStatus(await response.json());
        }
      } finally {
        setRemoteAccessPending(false);
      }
    }, 2500);
    socket.emit('remote_access_set_enabled', nextEnabled, (result) => {
      setRemoteAccessPending(false);
      if (result?.status) setRemoteAccessStatus(result.status);
      if (result && !result.ok) window.alert(result.error || 'Could not update remote access.');
    });
  };

  const handleRemoteCodeRotate = () => {
    if (!socket) return;
    socket.emit('remote_pairing_code_rotate', (result) => {
      if (result?.status) setRemoteAccessStatus(result.status);
      if (result && !result.ok) window.alert(result.error || 'Could not rotate pairing code.');
    });
  };

  const handleRemoteNetworkChange = (selected) => {
    if (!socket) return;
    socket.emit('remote_network_set', selected, (result) => {
      if (result?.status) setRemoteAccessStatus(result.status);
      if (result && !result.ok) window.alert(result.error || 'Could not change the remote network.');
    });
  };

  const handleRemoteSessionRevoke = (sessionId) => {
    if (!socket) return;
    socket.emit('remote_session_revoke', sessionId, (result) => {
      if (result && !result.ok) window.alert(result.error || 'Could not revoke remote session.');
    });
  };

  const handleRemoteLogout = () => {
    if (!socket) {
      clearRemoteSession();
      return;
    }
    socket.emit('remote_logout', () => {
      clearRemoteSession();
    });
    setTimeout(clearRemoteSession, 750);
  };

  const selectedNdiSource = NDI_SOURCE_OPTIONS.find(option => option.id === ndiSourceType) || NDI_SOURCE_OPTIONS[0];
  const runningNdiSource = NDI_SOURCE_OPTIONS.find(option => option.id === ndiStatus.sourceType) || selectedNdiSource;

  const activeLiveCount = useMemo(() => (
    Object.values(liveState).filter(Boolean).length + (isGraphicsOpen ? 1 : 0) + (isStageOpen ? 1 : 0) + (ndiStatus.enabled ? 1 : 0)
  ), [liveState, isGraphicsOpen, isStageOpen, ndiStatus.enabled]);

  const visibleTabGroups = useMemo(() => (
    isRemoteClient ? TAB_GROUPS.filter(group => !group.localOnly) : TAB_GROUPS
  ), [isRemoteClient]);
  const visibleTabs = useMemo(() => (
    visibleTabGroups.flatMap(group => group.tabs.map(tab => ({ ...tab, group: group.label })))
  ), [visibleTabGroups]);

  const tabCommands = useMemo(() => visibleTabs.map(tab => ({
    id: `tab-${tab.id}`,
    label: `Go to ${tab.label}`,
    detail: `${tab.group} / ${tab.cue}`,
    keywords: `${tab.label} ${tab.group} ${tab.cue}`,
    action: () => setActiveTab(tab.id),
  })), [visibleTabs]);

  const commandItems = useMemo(() => [
    ...tabCommands,
    { id: 'settings', label: 'Open Settings', detail: 'System configuration', keywords: 'settings output ndi display', action: () => setActiveTab('settings') },
    { id: 'graphics', label: isGraphicsOpen ? 'Close Graphics Output' : 'Open Graphics Output', detail: 'External graphics display', keywords: 'graphics output monitor display', action: () => (isGraphicsOpen ? handleCloseGraphics() : handleOpenGraphics()) },
    { id: 'stage', label: isStageOpen ? 'Close Confidence Monitor' : 'Open Confidence Monitor', detail: 'Stage confidence display', keywords: 'stage confidence monitor output display', action: () => (isStageOpen ? handleCloseStage() : handleOpenStage()) },
    { id: 'backstage', label: isBackstageOpen ? 'Close Backstage Monitor' : 'Open Backstage Monitor', detail: 'Backstage rundown display', keywords: 'backstage monitor cue sheet rundown output display', action: () => (isBackstageOpen ? handleCloseBackstage() : handleOpenBackstage()) },
    { id: 'ndi', label: ndiStatus.enabled ? 'Stop NDI Output' : 'Start NDI Output', detail: ndiStatus.sourceName || ndiSourceName, keywords: 'ndi output stream', action: handleNdiToggle },
    { id: 'clear', label: 'Clear All Outputs', detail: 'Undo available for 10 seconds', keywords: 'clear stop hide all', action: handleClearAll },
    { id: 'blackout', label: 'Blackout Output', detail: 'Set output black and clear live graphics', keywords: 'blackout black output clear', action: handleBlackout },
    ...(clearUndo ? [{ id: 'undo-clear', label: 'Undo Clear All', detail: 'Restore recently cleared output', keywords: 'undo restore clear', action: handleUndoClear }] : []),
    { id: 'theme', label: `Switch to ${theme === 'dark' ? 'Light' : 'Dark'} Mode`, detail: 'Operator theme', keywords: 'theme light dark', action: toggleTheme },
  ], [tabCommands, isGraphicsOpen, isStageOpen, isBackstageOpen, ndiStatus.enabled, ndiStatus.sourceName, ndiSourceName, clearUndo, theme, handleBlackout, handleClearAll, handleCloseGraphics, handleCloseStage, handleCloseBackstage, handleNdiToggle, handleOpenGraphics, handleOpenStage, handleOpenBackstage, handleUndoClear, toggleTheme]);

  const filteredCommands = useMemo(() => commandItems.filter(item => {
    const q = commandQuery.trim().toLowerCase();
    if (!q) return true;
    return `${item.label} ${item.detail} ${item.keywords}`.toLowerCase().includes(q);
  }), [commandItems, commandQuery]);

  const runCommand = (item) => {
    item.action();
    setIsCommandOpen(false);
  };

  const activeTabIndex = useMemo(() => visibleTabs.findIndex(tab => tab.id === activeTab), [activeTab, visibleTabs]);
  const activeTabInfo = useMemo(() => (
    visibleTabs[activeTabIndex] || { label: activeTab === 'settings' ? 'Settings' : 'Workspace', cue: 'Control' }
  ), [activeTab, activeTabIndex, visibleTabs]);

  if (isRemoteClient && (!remoteToken || !remoteSession)) {
    return <RemotePairing onPaired={(token, session) => {
      setRemoteToken(token);
      setRemoteSession(session);
    }} />;
  }

  if (!socket) {
    return (
      <div className="app-bg min-h-screen flex items-center justify-center p-4">
        <div className="surface-raised rounded-xl px-5 py-4 text-sm font-bold text-slate-600 dark:text-slate-300">
          Connecting to Broadcast Controller...
        </div>
      </div>
    );
  }

  return (
    <div className="app-bg min-h-screen flex items-stretch justify-center p-1 lg:p-2">
      <div className="app-shell w-full rounded-xl overflow-hidden flex flex-col">
        
        {/* Header & Navigation */}
        <div className="surface-muted flex-none border-x-0 border-t-0 rounded-none">
          <div className="px-3 py-2 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <div className="surface-raised p-px rounded-lg flex items-center justify-center shrink-0 overflow-hidden">
                <img src="/logo.png" className="h-8 w-8 object-cover shrink-0 rounded-[7px]" alt="Broadcast Controller logo" />
              </div>
              <div className="flex flex-col justify-center shrink-0">
                <span className="text-slate-900 dark:text-white font-bold text-base leading-none tracking-wide">Broadcast</span>
                <span className="text-blue-600 dark:text-blue-400 font-bold text-[0.6rem] leading-tight tracking-[0.25em] uppercase mt-1">Controller</span>
              </div>
              <div className="hidden xl:flex items-center gap-2 border-l section-rule pl-3">
                <span className={`h-3 w-3 rounded-full ${activeLiveCount > 0 ? 'bg-emerald-500 animate-pulse shadow-[0_0_16px_rgba(16,185,129,0.7)]' : 'bg-slate-400'}`} />
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Operator State</div>
                  <div className="text-xs font-bold text-slate-800 dark:text-slate-100">{activeLiveCount > 0 ? `${activeLiveCount} live signal${activeLiveCount === 1 ? '' : 's'}` : 'Standby'}</div>
                </div>
              </div>
              {isRemoteClient && (
                <div className="flex items-center gap-2 border-l section-rule pl-3">
                  <span className="rounded-full border border-blue-500/30 bg-blue-500/10 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-blue-600 dark:text-blue-400">
                    Remote
                  </span>
                  <button
                    onClick={handleRemoteLogout}
                    className="control-button px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider active:scale-95 dark:text-slate-300"
                    title="Log out of this remote session"
                  >
                    Log Out
                  </button>
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-end gap-1.5 min-w-0">
              <button
                onClick={() => setIsCommandOpen(true)}
                className="control-button h-8 px-2 text-slate-600 dark:text-slate-300 flex items-center gap-2 text-xs font-bold"
                title="Command Palette"
              >
                <Command className="w-4 h-4" />
                <span className="hidden sm:inline">Command</span>
                <span className="hidden lg:inline text-[10px] text-slate-400 border section-rule rounded px-1.5 py-0.5">⌘K</span>
              </button>
              <button 
                onClick={isGraphicsOpen ? handleCloseGraphics : handleOpenGraphics}
                className={`h-8 px-2 rounded-lg font-bold text-[10px] uppercase tracking-wider transition flex items-center gap-2 border ${isGraphicsOpen ? 'bg-emerald-600 text-white border-emerald-600 shadow-lg shadow-emerald-600/20' : 'control-button-muted hover:text-slate-800 dark:hover:text-white'}`}
                title="Graphics Output"
              >
                <Monitor className="w-4 h-4" />
                Graphics
              </button>
              <button 
                onClick={isStageOpen ? handleCloseStage : handleOpenStage}
                className={`h-8 px-2 rounded-lg font-bold text-[10px] uppercase tracking-wider transition flex items-center gap-2 border ${isStageOpen ? 'bg-indigo-600 text-white border-indigo-600 shadow-lg shadow-indigo-600/20' : 'control-button-muted hover:text-slate-800 dark:hover:text-white'}`}
                title="Confidence Monitor"
              >
                <Radio className="w-4 h-4" />
                Confidence
              </button>
              <button
                onClick={isBackstageOpen ? handleCloseBackstage : handleOpenBackstage}
                className={`h-8 px-2 rounded-lg font-bold text-[10px] uppercase tracking-wider transition flex items-center gap-2 border ${isBackstageOpen ? 'bg-cyan-600 text-white border-cyan-600 shadow-lg shadow-cyan-600/20' : 'control-button-muted hover:text-slate-800 dark:hover:text-white'}`}
                title="Backstage Monitor"
              >
                <Monitor className="w-4 h-4" />
                Backstage
              </button>
              <button 
                onClick={handleClearAll} 
                className="h-8 px-2 rounded-lg bg-red-600/10 hover:bg-red-600 text-red-500 hover:text-white border border-red-500/30 hover:border-red-600 transition active:scale-95 flex items-center gap-2 font-bold text-[10px] uppercase tracking-wider"
                title="Clear All Outputs"
              >
                <X className="w-4 h-4" />
                Clear
              </button>
              <button onClick={toggleTheme} className="control-button w-8 h-8 text-slate-700 dark:text-slate-200 active:scale-95 flex items-center justify-center" title="Toggle Theme">
                {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
              </button>
              <button 
                onClick={() => setActiveTab(activeTab === 'settings' ? 'runshow' : 'settings')} 
                className={`w-8 h-8 rounded-lg transition active:scale-95 flex items-center justify-center border ${activeTab === 'settings' ? 'bg-blue-600 text-white border-blue-600' : 'control-button text-slate-700 dark:text-slate-200'}`}
                title="Settings"
              >
                <Settings className="w-4 h-4" />
              </button>
              {!isRemoteClient && <button 
                onClick={handleClearCache} 
                className="control-button w-8 h-8 text-slate-500 dark:text-slate-400 hover:bg-red-600/20 hover:text-red-500 hover:border-red-500/50 flex items-center justify-center active:scale-95"
                title="Clear All Cache / Factory Reset"
              >
                <Trash2 className="w-4 h-4" />
              </button>}
            </div>
          </div>

        </div>

        {isCommandOpen && (
          <div className="fixed inset-0 z-[10000] bg-slate-950/60 backdrop-blur-sm flex items-start justify-center px-4 pt-20" onMouseDown={() => setIsCommandOpen(false)}>
            <div className="surface-raised w-full max-w-2xl rounded-xl overflow-hidden" onMouseDown={e => e.stopPropagation()}>
              <div className="flex items-center gap-3 border-b section-rule px-4 py-3">
                <Search className="w-5 h-5 text-slate-400" />
                <input
                  ref={commandInputRef}
                  value={commandQuery}
                  onChange={e => setCommandQuery(e.target.value)}
                  placeholder="Search commands, tabs, outputs..."
                  className="flex-1 bg-transparent text-slate-900 dark:text-white outline-none text-sm"
                />
                <button onClick={() => setIsCommandOpen(false)} className="control-button-muted w-8 h-8 flex items-center justify-center text-slate-500">
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="max-h-[420px] overflow-y-auto p-2">
                {filteredCommands.length === 0 ? (
                  <div className="px-4 py-8 text-center text-sm text-slate-500">No command found</div>
                ) : (
                  filteredCommands.map(item => (
                    <button
                      key={item.id}
                      onClick={() => runCommand(item)}
                      className="w-full text-left px-3 py-2.5 rounded-lg hover:bg-blue-500/10 dark:hover:bg-blue-500/15 transition flex items-center justify-between gap-3 group"
                    >
                      <div className="min-w-0">
                        <div className="text-sm font-bold text-slate-800 dark:text-slate-100 truncate">{item.label}</div>
                        <div className="text-xs text-slate-500 truncate">{item.detail}</div>
                      </div>
                      <Zap className="w-4 h-4 text-slate-300 group-hover:text-blue-500 shrink-0" />
                    </button>
                  ))
                )}
              </div>
            </div>
          </div>
        )}

        {clearUndo && (
          <div className="surface-raised fixed right-6 bottom-6 z-[10001] rounded-xl p-3 flex items-center gap-3">
            <div>
              <div className="text-sm font-bold text-slate-900 dark:text-white">Outputs cleared</div>
              <div className="text-xs text-slate-500">Undo is available briefly.</div>
            </div>
            <button onClick={handleUndoClear} className="px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold flex items-center gap-2 transition">
              <RotateCcw className="w-3.5 h-3.5" />
              Undo
            </button>
          </div>
        )}


        {/* Content Area */}
        <div className="flex-grow flex overflow-hidden">
          {/* Collapsible page navigation sidebar */}
          <aside className={`flex-none surface-muted border-y-0 border-l-0 border-r section-rule flex flex-col transition-[width] duration-200 ease-out ${navCollapsed ? 'w-14' : 'w-52'}`}>
            <div className="p-2 flex-none">
              <button
                onClick={() => setNavCollapsed(v => !v)}
                className="control-button w-full h-9 flex items-center justify-center gap-2 text-slate-600 dark:text-slate-300 text-[11px] font-bold uppercase tracking-wider active:scale-95"
                title={navCollapsed ? 'Expand navigation' : 'Collapse navigation'}
              >
                {navCollapsed ? <PanelLeftOpen className="w-4 h-4" /> : <><PanelLeftClose className="w-4 h-4" /><span>Collapse</span></>}
              </button>
            </div>
            <nav className="flex-1 overflow-y-auto px-2 pb-2 space-y-3">
              {visibleTabGroups.map(group => (
                <div key={group.label} className="space-y-1">
                  {navCollapsed
                    ? <div className="mx-2 h-px bg-slate-200 dark:bg-slate-700/60" />
                    : <div className="px-1 text-[8px] font-bold uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">{group.label}</div>}
                  <div className="space-y-0.5">
                    {group.tabs.map(tab => {
                      const Icon = tab.icon;
                      const isActive = activeTab === tab.id;
                      return (
                        <button
                          key={tab.id}
                          onClick={() => setActiveTab(tab.id)}
                          className={`w-full flex items-center rounded-md font-bold text-[11px] transition ${navCollapsed ? 'justify-center h-9' : 'gap-2.5 px-2.5 py-1.5'} ${
                            isActive
                              ? 'bg-blue-600 text-white shadow-sm'
                              : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800'
                          }`}
                          title={navCollapsed ? `${tab.label} — ${tab.cue}` : tab.cue}
                        >
                          {Icon && <Icon className="w-4 h-4 shrink-0" />}
                          {!navCollapsed && <span className="truncate">{tab.label}</span>}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </nav>
          </aside>
          <div className="flex-grow p-3 overflow-y-auto">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b section-rule pb-2">
              <div className="min-w-0">
                <div className="text-[9px] font-bold uppercase tracking-[0.2em] text-slate-500">Cue Workspace</div>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="text-lg font-bold text-slate-900 dark:text-white truncate">{activeTabInfo.label}</span>
                  <span className="rounded-full bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider">{activeTabInfo.cue}</span>
                </div>
              </div>
            </div>
            {/* Content Panels */}
            <div style={{ display: activeTab === 'runshow' ? 'block' : 'none' }}>
              <RunOfShowPanel
                socket={socket}
                onNavigate={setActiveTab}
                onBlackout={handleBlackout}
                onShowTimer={handleShowTimer}
                isRemoteClient={isRemoteClient}
              />
            </div>
            <div style={{ display: activeTab === 'settings' ? 'block' : 'none' }}>
              <div className="space-y-4">
                <h2 className="text-xl font-bold text-slate-900 dark:text-white flex items-center">
                  <svg className="w-5 h-5 mr-2 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"></path><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path></svg>
                  System Configuration
                </h2>
                <div className="surface flex flex-wrap gap-2 rounded-lg p-2">
                  {[
                    ['Displays', '#settings-displays'],
                    ['Remote Operators', '#settings-remote'],
                    ['NDI', '#settings-ndi'],
                    ['Layers', '#settings-layers'],
                    ['Media UI', '#settings-media-ui'],
                    ['Translation / AI', '#settings-translation'],
                    ['Cache / Reset', '#settings-cache'],
                  ].map(([label, href]) => (
                    <a key={href} href={href} className="rounded-lg px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 dark:hover:bg-slate-800 dark:hover:text-white">
                      {label}
                    </a>
                  ))}
                </div>

                <section id="settings-displays" className="space-y-3 scroll-mt-4">
                  <div>
                    <h3 className="text-[10px] font-bold uppercase tracking-[0.22em] text-slate-500">Displays</h3>
                    <p className="mt-1 text-xs text-slate-500">Choose the physical outputs used for graphics and confidence display.</p>
                  </div>
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
                  <div className="surface space-y-3 p-3 rounded-lg">
                    <label className="block text-sm font-medium text-slate-700 dark:text-slate-300">Graphics Display</label>
                    <div className="flex space-x-2">
                      <button onClick={handleOpenGraphics} className="flex-1 bg-blue-600 hover:bg-blue-500 text-white px-3 py-2 rounded-lg text-sm font-medium transition active:scale-95">Open</button>
                      <button onClick={handleCloseGraphics} className="flex-1 bg-red-600 hover:bg-red-500 text-white px-3 py-2 rounded-lg text-sm font-medium transition active:scale-95">Close</button>
                    </div>
                    <select value={graphicsDisplay} onChange={e => setGraphicsDisplay(e.target.value)} className="control-field px-3 py-2 text-xs mt-2">
                      <option value="">Graphics Output...</option>
                      {displays.map(d => <option key={d.id} value={d.id}>{d.label}</option>)}
                    </select>
                  </div>

                  <div className="surface space-y-3 p-3 rounded-lg">
                    <label className="block text-sm font-medium text-slate-700 dark:text-slate-300">Confidence Monitor</label>
                    <div className="flex space-x-2">
                      <button onClick={handleOpenStage} className="flex-1 bg-indigo-600 hover:bg-indigo-500 text-white px-3 py-2 rounded-lg text-sm font-medium transition active:scale-95">Open</button>
                      <button onClick={handleCloseStage} className="flex-1 bg-red-600 hover:bg-red-500 text-white px-3 py-2 rounded-lg text-sm font-medium transition active:scale-95">Close</button>
                    </div>
                    <select value={stageDisplay} onChange={e => setStageDisplay(e.target.value)} className="control-field px-3 py-2 text-xs mt-2">
                      <option value="">Confidence Monitor Output...</option>
                      {displays.map(d => <option key={d.id} value={d.id}>{d.label}</option>)}
                    </select>
                  </div>

                  <div className="surface space-y-3 p-3 rounded-lg">
                    <label className="block text-sm font-medium text-slate-700 dark:text-slate-300">Backstage Monitor</label>
                    <div className="flex space-x-2">
                      <button onClick={handleOpenBackstage} className="flex-1 bg-cyan-600 hover:bg-cyan-500 text-white px-3 py-2 rounded-lg text-sm font-medium transition active:scale-95">Open</button>
                      <button onClick={handleCloseBackstage} className="flex-1 bg-red-600 hover:bg-red-500 text-white px-3 py-2 rounded-lg text-sm font-medium transition active:scale-95">Close</button>
                    </div>
                    <select value={backstageDisplay} onChange={e => setBackstageDisplay(e.target.value)} className="control-field px-3 py-2 text-xs mt-2">
                      <option value="">Backstage Monitor Output...</option>
                      {displays.map(d => <option key={d.id} value={d.id}>{d.label}</option>)}
                    </select>
                  </div>
                </div>
                </section>

                <section id="settings-remote" className="surface space-y-3 p-3 rounded-lg scroll-mt-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-bold text-slate-800 dark:text-white uppercase tracking-wider">Remote Operators</h3>
                      <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">Let trusted remote controllers pair from another PC on this local network.</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={handleRemoteCodeRotate}
                        disabled={!remoteAccessStatus?.enabled}
                        className="control-button px-3 py-2 text-xs font-bold uppercase tracking-wider disabled:cursor-not-allowed disabled:opacity-50 dark:text-slate-300"
                      >
                        Rotate Code
                      </button>
                      <button
                        onClick={handleRemoteAccessToggle}
                        disabled={remoteAccessPending}
                        className={`rounded-lg px-4 py-2 text-xs font-bold uppercase tracking-wider transition active:scale-95 ${
                          remoteAccessStatus?.enabled
                            ? 'bg-emerald-600 text-white shadow-lg shadow-emerald-600/20'
                            : 'control-button-muted text-slate-700 dark:text-slate-200'
                        }`}
                      >
                        {remoteAccessPending ? 'Updating...' : remoteAccessStatus?.enabled ? 'Disable' : 'Enable'}
                      </button>
                    </div>
                  </div>

                  {remoteAccessStatus?.enabled && remoteAccessStatus?.networkUnavailable ? (
                    <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs font-semibold text-amber-700 dark:text-amber-300">
                      Selected network “{remoteAccessStatus.selectedNetwork}” is unavailable — remote devices cannot connect. Pick another network below.
                    </div>
                  ) : null}
                  {remoteAccessStatus?.enabled && remoteAccessStatus?.lastBlocked ? (
                    <div className="rounded-lg border border-slate-500/20 bg-slate-500/10 px-3 py-2 text-xs font-semibold text-slate-600 dark:text-slate-300">
                      Blocked a connection from {remoteAccessStatus.lastBlocked.address} — remote access is limited to{' '}
                      {remoteAccessStatus.activeAddress || 'the selected network'}.
                    </div>
                  ) : null}

                  <div className="surface-muted rounded-lg p-3">
                    <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Network</div>
                    <select
                      value={remoteAccessStatus?.selectedNetwork || 'auto'}
                      onChange={event => handleRemoteNetworkChange(event.target.value)}
                      className="control-field mt-2 w-full px-3 py-2 text-sm"
                    >
                      <option value="auto">Auto — prefer a real network adapter</option>
                      {(remoteAccessStatus?.networks || []).map(net => (
                        <option key={net.name} value={net.name}>
                          {net.name} ({net.address}){net.isVirtual ? ' · virtual' : ''}
                        </option>
                      ))}
                    </select>
                    <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                      Remote devices can only connect over this network. The controller itself always works.
                    </p>
                  </div>

                  <div className="grid grid-cols-1 gap-3 lg:grid-cols-[1fr_220px]">
                    <div className="surface-muted rounded-lg p-3">
                      <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">LAN URL</div>
                      {remoteAccessStatus?.enabled && remoteAccessStatus?.lanUrls?.length ? (
                        <div className="mt-2 space-y-1">
                          {remoteAccessStatus.lanUrls.map(url => (
                            <div key={url} className="surface flex items-center gap-3 rounded-md px-3 py-2">
                              <span className="min-w-0 flex-1 break-all text-xs font-bold text-blue-600 dark:text-blue-400">{url}</span>
                              <RemoteQr
                                url={url}
                                code={remoteAccessStatus.pairingCode}
                                expiresAt={remoteAccessStatus.pairingCodeExpiresAt}
                                label="Remote Controller"
                              />
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="mt-2 text-xs font-semibold text-slate-500">Enable Remote Operators to publish a LAN pairing URL.</div>
                      )}
                      {remoteAccessStatus?.enabled && remoteAccessStatus?.slidesUrls?.length ? (
                        <>
                          <div className="mt-3 text-[10px] font-bold uppercase tracking-wider text-slate-500">Slides Remote (phone / iPad)</div>
                          <div className="mt-2 space-y-1">
                            {remoteAccessStatus.slidesUrls.map(url => (
                              <div key={url} className="surface flex items-center gap-3 rounded-md px-3 py-2">
                                <span className="min-w-0 flex-1 break-all text-xs font-bold text-amber-600 dark:text-amber-400">{url}</span>
                                <RemoteQr
                                  url={url}
                                  code={remoteAccessStatus.pairingCode}
                                  expiresAt={remoteAccessStatus.pairingCodeExpiresAt}
                                  label="Slides Remote"
                                />
                              </div>
                            ))}
                          </div>
                        </>
                      ) : null}
                      {remoteAccessStatus?.enabled && remoteAccessStatus?.padUrls?.length ? (
                        <>
                          <div className="mt-3 text-[10px] font-bold uppercase tracking-wider text-slate-500">Control Pad (iPad)</div>
                          <div className="mt-2 space-y-1">
                            {remoteAccessStatus.padUrls.map(url => (
                              <div key={url} className="surface flex items-center gap-3 rounded-md px-3 py-2">
                                <span className="min-w-0 flex-1 break-all text-xs font-bold text-violet-600 dark:text-violet-400">{url}</span>
                                <RemoteQr
                                  url={url}
                                  code={remoteAccessStatus.pairingCode}
                                  expiresAt={remoteAccessStatus.pairingCodeExpiresAt}
                                  label="Control Pad"
                                />
                              </div>
                            ))}
                          </div>
                        </>
                      ) : null}
                      {remoteAccessStatus?.enabled && remoteAccessStatus?.slidesUrls?.length ? (
                        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                          Scanning pairs automatically. The code changes every 30 seconds.
                        </p>
                      ) : null}
                    </div>
                    <div className="surface-muted rounded-lg p-3 text-center">
                      <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Pairing Code</div>
                      <div className="surface mt-2 rounded-md px-3 py-2 text-2xl font-black tracking-[0.25em] text-slate-900 dark:text-white">
                        {remoteAccessStatus?.enabled ? (remoteAccessStatus.pairingCode || '------') : '------'}
                      </div>
                    </div>
                  </div>

                  <div className="surface rounded-lg">
                    <div className="border-b section-rule px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-slate-500">
                      Connected / Paired Controllers
                    </div>
                    <div className="divide-y divide-slate-200 dark:divide-slate-800">
                      {remoteAccessStatus?.sessions?.length ? remoteAccessStatus.sessions.map(session => (
                        <div key={session.id} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2">
                          <div>
                            <div className="text-sm font-bold text-slate-900 dark:text-white">{session.deviceName}</div>
                            <div className="text-xs text-slate-500">{session.connected ? 'Connected' : 'Paired'}</div>
                          </div>
                          <button
                            onClick={() => handleRemoteSessionRevoke(session.id)}
                            className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-red-500 transition hover:bg-red-600 hover:text-white"
                          >
                            Revoke
                          </button>
                        </div>
                      )) : (
                        <div className="px-3 py-6 text-center text-xs font-semibold text-slate-500">No remote controllers paired.</div>
                      )}
                    </div>
                  </div>
                </section>

                <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                  <section id="settings-ndi" className="surface space-y-3 p-3 rounded-lg scroll-mt-4">
                    <div className="flex items-center justify-between gap-4">
                      <div>
                        <h3 className="text-sm font-bold text-slate-800 dark:text-white uppercase tracking-wider">NDI Output</h3>
                        <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">1080p30 video-only {ndiStatus.enabled ? runningNdiSource.label : selectedNdiSource.label}</p>
                      </div>
                      <button
                        onClick={handleNdiToggle}
                        className={`px-4 py-2 rounded-lg text-xs font-bold uppercase tracking-wider transition active:scale-95 ${
                          ndiStatus.enabled
                            ? 'bg-emerald-600 text-white shadow-lg shadow-emerald-600/20'
                            : 'control-button-muted text-slate-600 dark:text-slate-300'
                        }`}
                      >
                        {ndiStatus.enabled ? 'Stop NDI' : 'Start NDI'}
                      </button>
                    </div>

                    <div className="space-y-1.5">
                      <label className="block text-xs font-medium text-slate-600 dark:text-slate-400">NDI Source</label>
                      <select
                        value={ndiSourceType}
                        onChange={e => {
                          const nextType = e.target.value;
                          const selected = NDI_SOURCE_OPTIONS.find(item => item.id === nextType);
                          setNdiSourceType(nextType);
                          if (selected && (!ndiSourceName.trim() || NDI_SOURCE_OPTIONS.some(item => item.defaultName === ndiSourceName.trim()))) {
                            setNdiSourceName(selected.defaultName);
                          }
                        }}
                        disabled={ndiStatus.enabled}
                        className="control-field px-3 py-2 text-sm disabled:opacity-60"
                      >
                        {NDI_SOURCE_OPTIONS.map(option => (
                          <option key={option.id} value={option.id}>{option.label}</option>
                        ))}
                      </select>
                      {ndiStatus.enabled && (
                        <p className="text-[11px] text-slate-500 dark:text-slate-400">Stop NDI to switch sources.</p>
                      )}
                    </div>

                    <div className="space-y-1.5">
                      <label className="block text-xs font-medium text-slate-600 dark:text-slate-400">Source Name</label>
                      <input
                        type="text"
                        value={ndiSourceName}
                        onChange={e => setNdiSourceName(e.target.value)}
                        className="control-field px-3 py-2 text-sm"
                      />
                    </div>

                    <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                      <div className="surface-muted rounded-lg p-3">
                        <div className="text-slate-500 uppercase tracking-wider text-[10px] font-bold">Status</div>
                        <div className={ndiStatus.error ? 'text-red-500 font-bold mt-1' : ndiStatus.enabled ? 'text-emerald-500 font-bold mt-1' : 'text-slate-500 font-bold mt-1'}>
                          {ndiStatus.error ? 'Error' : ndiStatus.enabled ? 'Running' : 'Stopped'}
                        </div>
                      </div>
                      <div className="surface-muted rounded-lg p-3">
                        <div className="text-slate-500 uppercase tracking-wider text-[10px] font-bold">Receivers</div>
                        <div className="text-slate-900 dark:text-white font-bold mt-1">{ndiStatus.receivers || 0}</div>
                      </div>
                      <div className="surface-muted rounded-lg p-3">
                        <div className="text-slate-500 uppercase tracking-wider text-[10px] font-bold">FPS</div>
                        <div className="text-slate-900 dark:text-white font-bold mt-1">{ndiStatus.fps || 0}</div>
                      </div>
                      <div className="surface-muted rounded-lg p-3">
                        <div className="text-slate-500 uppercase tracking-wider text-[10px] font-bold">Source</div>
                        <div className="text-slate-900 dark:text-white font-bold mt-1">
                          {ndiStatus.enabled ? runningNdiSource.label : selectedNdiSource.label}
                        </div>
                      </div>
                    </div>

                    <div className="text-[11px] text-slate-500 dark:text-slate-400">
                      Last frame: {ndiStatus.lastFrameAt ? new Date(ndiStatus.lastFrameAt).toLocaleTimeString() : '--'}
                    </div>

                    {ndiStatus.error && (
                      <div className="text-xs text-red-500 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 break-words">
                        {ndiStatus.error}
                      </div>
                    )}
                  </section>

                  <section id="settings-layers" className="surface space-y-3 p-3 rounded-lg scroll-mt-4">
                    <div>
                      <h3 className="text-sm font-bold text-slate-800 dark:text-white uppercase tracking-wider">Output Mode</h3>
                      <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">Controls graphics background and layer visibility</p>
                    </div>

                    <div className="grid grid-cols-3 gap-2">
                      {[
                        { id: 'green', label: 'Green Screen' },
                        { id: 'black', label: 'Black' },
                        { id: 'transparent', label: 'Transparent' },
                      ].map(mode => (
                        <button
                          key={mode.id}
                          onClick={() => setOutputMode(mode.id)}
                          className={`px-3 py-2 rounded-lg text-xs font-bold transition active:scale-95 ${
                            outputMode === mode.id
                              ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/20'
                              : 'control-button-muted text-slate-600 dark:text-slate-300'
                          }`}
                        >
                          {mode.label}
                        </button>
                      ))}
                    </div>

                    <div>
                      <div className="flex items-center justify-between gap-2">
                        <div>
                          <div className="text-xs font-bold text-slate-700 dark:text-slate-300">Fill Display</div>
                          <p className="text-[11px] text-slate-500 dark:text-slate-400">
                            Crop to fill a non-16:9 or non-1080p display instead of showing key-colour bars.
                            Only use this when there's no downstream switcher/keyer relying on the bars.
                          </p>
                        </div>
                        <button
                          onClick={() => setFitMode(prev => prev === 'fill' ? 'fit' : 'fill')}
                          className={`shrink-0 px-3 py-2 rounded-lg text-xs font-bold transition active:scale-95 ${
                            fitMode === 'fill'
                              ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/20'
                              : 'control-button-muted text-slate-600 dark:text-slate-300'
                          }`}
                        >
                          {fitMode === 'fill' ? 'On' : 'Off'}
                        </button>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                      {Object.entries(LAYER_LABELS).map(([key, label]) => (
                        <button
                          key={key}
                          onClick={() => toggleLayerVisibility(key)}
                          className={`px-3 py-2 rounded-lg text-xs font-bold text-left transition active:scale-95 border ${
                            layerVisibility[key]
                              ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-600 dark:text-emerald-400'
                              : 'control-button-muted text-slate-500'
                          }`}
                        >
                          <span className={`inline-block w-2 h-2 rounded-full mr-2 ${layerVisibility[key] ? 'bg-emerald-500' : 'bg-slate-400'}`}></span>
                          {label}
                        </button>
                      ))}
                    </div>
                  </section>
                </div>

                <section id="settings-media-ui" className="surface space-y-3 p-3 rounded-lg scroll-mt-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-bold text-slate-800 dark:text-white uppercase tracking-wider">Media Page</h3>
                      <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">Show optional media controls for particle overlays.</p>
                    </div>
                    <label className="relative inline-flex items-center cursor-pointer" title="Show particle overlay controls on the Media page">
                      <input
                        type="checkbox"
                        className="sr-only peer"
                        checked={showParticleOverlayControls}
                        onChange={event => setShowParticleOverlayControls(event.target.checked)}
                      />
                      <div className="w-11 h-6 bg-slate-200 dark:bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-indigo-600"></div>
                    </label>
                  </div>
                </section>

                <section id="settings-translation" className="surface space-y-3 p-3 rounded-lg scroll-mt-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-bold text-slate-800 dark:text-white uppercase tracking-wider">Translation / Local AI</h3>
                      <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">Configure live translation, glossary, microphone, Azure, and Local AI from the translation workspace.</p>
                    </div>
                    <button onClick={() => setActiveTab('translation')} className="rounded-lg bg-indigo-600 px-4 py-2 text-xs font-bold uppercase tracking-wider text-white transition hover:bg-indigo-500 active:scale-95">
                      Open Translation Settings
                    </button>
                  </div>
                </section>

                <section id="settings-cache" className="surface space-y-3 p-3 rounded-lg scroll-mt-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-bold text-slate-800 dark:text-white uppercase tracking-wider">Cache / Reset</h3>
                      <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">Factory reset clears saved playlists, libraries, presets, themes, and local UI settings.</p>
                    </div>
                    <button onClick={handleClearCache} className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-2 text-xs font-bold uppercase tracking-wider text-red-500 transition hover:bg-red-600 hover:text-white active:scale-95">
                      Factory Reset
                    </button>
                  </div>
                </section>
              </div>
            </div>

            {/* Mounted even when hidden, like every other panel — that is what keeps
                the layout publishing to paired pads without visiting this tab. */}
            {!isRemoteClient && (
              <div style={{ display: activeTab === 'pad' ? 'block' : 'none' }}>
                <PadLayoutPanel socket={socket} isRemoteClient={isRemoteClient} />
              </div>
            )}
            <div style={{ display: activeTab === 'sabha' ? 'block' : 'none' }}><SabhaPanel socket={socket} /></div>
            <div style={{ display: activeTab === 'pres' ? 'block' : 'none' }}><PresentationPanel socket={socket} isActive={activeTab === 'pres'} /></div>
            <div style={{ display: activeTab === 'lyrics' ? 'block' : 'none' }}><LyricsPanel socket={socket} /></div>
            <div style={{ display: activeTab === 'lt' ? 'block' : 'none' }}><LowerThirdsPanel socket={socket} /></div>
            <div style={{ display: activeTab === 'media' ? 'block' : 'none' }}><MediaPanel socket={socket} showParticleOverlayControls={showParticleOverlayControls} /></div>
            <div style={{ display: activeTab === 'stage' ? 'block' : 'none' }}><StageDisplayPanel socket={socket} /></div>
            <div style={{ display: activeTab === 'backstage' ? 'block' : 'none' }}>
              <BackstageCueSheetPanel
                socket={socket}
                displays={displays}
                backstageDisplay={backstageDisplay}
                setBackstageDisplay={setBackstageDisplay}
                isBackstageOpen={isBackstageOpen}
                onOpenBackstage={handleOpenBackstage}
                onCloseBackstage={handleCloseBackstage}
              />
            </div>
            <div style={{ display: activeTab === 'translation' ? 'block' : 'none' }}><TranslationPanel socket={socket} /></div>
            {!isRemoteClient && (
              <div style={{ display: activeTab === 'supersource' ? 'block' : 'none' }}>
                <SuperSourcePanel socket={socket} isActive={activeTab === 'supersource'} />
              </div>
            )}

            {/* Bottom Preview - ONLY RENDER IF NOT DESKTOP */}
            {!isRemoteClient && !isDesktop && (
              <div className="mt-8 pt-6 border-t section-rule">
                <PreviewIframe isSidebar={false} activeTab={activeTab} />
              </div>
            )}
          </div>

          {/* Sidebar Preview - ONLY RENDER IF DESKTOP */}
          {!isRemoteClient && isDesktop && (
            <div className={`${isPreviewCollapsed ? 'w-12' : 'w-[360px] 2xl:w-[420px]'} surface-muted flex-none border-y-0 border-r-0 transition-all duration-300 overflow-hidden`}>
              <div className="sticky top-0 p-3">
                <button
                  onClick={() => setIsPreviewCollapsed(prev => !prev)}
                  className="control-button w-full mb-3 h-9 text-slate-500 hover:text-slate-900 dark:hover:text-white flex items-center justify-center gap-2 text-[10px] font-bold uppercase tracking-wider"
                  aria-label={isPreviewCollapsed ? 'Show Live Preview' : 'Collapse Preview'}
                  title={isPreviewCollapsed ? 'Show Live Preview' : 'Collapse Preview'}
                >
                  {isPreviewCollapsed ? <ChevronLeft className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                  {!isPreviewCollapsed && 'Collapse Preview'}
                </button>
                {!isPreviewCollapsed && <PreviewIframe isSidebar={true} activeTab={activeTab} />}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default App;
