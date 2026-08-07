import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Activity, AlertTriangle, BookOpen, CheckCircle, Play, RefreshCw, Save, Square, Settings, HelpCircle, Info, Globe, Sliders, Trash2, Mic, Volume2, X } from 'lucide-react';
import { deferUntilIdle, readLocalStorageObjectSafe, useDebouncedLocalStorageEffect } from '../utils/performance';


// Note there is no *_KEY_STORAGE key here any more. The Azure and Soniox credentials used to
// live in localStorage in plaintext and be re-written on every keystroke; they are now held by
// the main process under OS encryption (translation_secrets.js) and resolved server-side when
// translation starts, so the key value never enters this renderer at all. All this component
// tracks is whether a key has been set.
const AZURE_REGION_STORAGE = 'bc_azure_speech_region';
const SONIOX_MODEL_STORAGE = 'bc_soniox_model';
const LEGACY_KEY_STORAGE = ['bc_azure_speech_key', 'bc_soniox_api_key'];
const TRANSLATION_TARGET_STORAGE = 'bc_azure_target_lang';
const TRANSLATION_ENGINE_STORAGE = 'bc_translation_engine_v1';
const TRANSLATION_STYLE_STORAGE = 'bc_translation_style_v1';
const TRANSLATION_LAYOUT_STORAGE = 'bc_translation_layout_v1';
const EMPTY_GLOSSARY_FORM = { en: '', gu: '', hi: '', notes: '' };
const DEFAULT_LOCAL_AI_SETTINGS = {
    ollamaBaseUrl: 'http://localhost:11434',
    ollamaModel: '',
    whisperExecutablePath: '',
    whisperModelPath: '',
    chunkSeconds: 5
};

const LANGUAGE_LABELS = {
    en: 'English',
    gu: 'Gujarati',
    hi: 'Hindi'
};

const STATUS_LABELS = {
    idle: 'Idle',
    starting: 'Starting',
    listening: 'Listening',
    stopping: 'Stopping',
    error: 'Error'
};

export default function TranslationPanel({ socket }) {
    // Azure Configuration State
    // Holds only what the operator is currently typing. Cleared once saved — the stored value
    // is never read back.
    const [azureKey, setAzureKey] = useState('');
    const [sonioxKey, setSonioxKey] = useState('');
    const [secretStatus, setSecretStatus] = useState({ azure: false, soniox: false });
    const [secretNotice, setSecretNotice] = useState('');
    const [azureRegion, setAzureRegion] = useState(() => localStorage.getItem(AZURE_REGION_STORAGE) || 'eastus');
    const [sonioxModel, setSonioxModel] = useState(() => localStorage.getItem(SONIOX_MODEL_STORAGE) || 'stt-rt-v4');
    const [targetLang, setTargetLang] = useState(() => localStorage.getItem(TRANSLATION_TARGET_STORAGE) || 'en');
    const [translationEngine, setTranslationEngine] = useState(() => localStorage.getItem(TRANSLATION_ENGINE_STORAGE) || 'azure');
    
    // Translation Runtime State
    const [translationStatus, setTranslationStatus] = useState('idle');
    const [lastError, setLastError] = useState('');
    const [lastEventAt, setLastEventAt] = useState('');
    const [audioPermission, setAudioPermission] = useState('checking');
    const [audioHealth, setAudioHealth] = useState('idle');
    const [pendingRestart, setPendingRestart] = useState(false);
    const [audioDevices, setAudioDevices] = useState([]);
    const [selectedDevice, setSelectedDevice] = useState('');
    const [transcript, setTranscript] = useState([]);
    const [currentPhrase, setCurrentPhrase] = useState('');
    
    // UI Panels & Modals
    const [showHelpModal, setShowHelpModal] = useState(false);
    const [showAzureConfig, setShowAzureConfig] = useState(false);
    const [showSonioxConfig, setShowSonioxConfig] = useState(false);
    const [showLocalConfig, setShowLocalConfig] = useState(false);
    const [localAiSettings, setLocalAiSettings] = useState(DEFAULT_LOCAL_AI_SETTINGS);
    const [localAiStatus, setLocalAiStatus] = useState(null);
    const [localAiBusy, setLocalAiBusy] = useState(false);
    const [glossaryEntries, setGlossaryEntries] = useState([]);
    const [glossaryForm, setGlossaryForm] = useState(EMPTY_GLOSSARY_FORM);
    const [editingGlossaryId, setEditingGlossaryId] = useState(null);
    const [glossaryError, setGlossaryError] = useState('');
    
    // Language Settings
    const [detectEnglish, setDetectEnglish] = useState(true);
    const [detectGujarati, setDetectGujarati] = useState(true);
    const [detectHindi, setDetectHindi] = useState(true);

    // Styling State (matching lyrics panel structure)
    const [fontFamily, setFontFamily] = useState("'Outfit', sans-serif");
    const [fontWeight, setFontWeight] = useState('600');
    const [fontColor, setFontColor] = useState('#ffffff');
    const [fontSize, setFontSize] = useState('56');
    const [letterSpacing, setLetterSpacing] = useState('0');
    const [isBold, setIsBold] = useState(false);
    const [isItalic, setIsItalic] = useState(false);
    const [isUnderline, setIsUnderline] = useState(false);

    // Layout Positioning State
    const [autoClear, setAutoClear] = useState('');

    // Audio Visualizer Refs
    const visualizerCanvasRef = useRef(null);
    const animationFrameRef = useRef(null);
    const audioContextRef = useRef(null);
    const audioStreamRef = useRef(null);
    const lastAudioAtRef = useRef(null);
    const noAudioTimerRef = useRef(null);
    
    // Azure SDK Refs
    const audioInputRef = useRef(null);
    const processorNodeRef = useRef(null);
    const startTranslationRef = useRef(null);

    const isTranslating = translationStatus === 'starting' || translationStatus === 'listening';
    const isBusy = translationStatus === 'starting' || translationStatus === 'stopping';
    const glossaryPhraseCount = ['en', 'gu', 'hi'].filter(lang => glossaryForm[lang].trim()).length;
    const isLocalEngine = translationEngine === 'local';
    const isSonioxEngine = translationEngine === 'soniox';
    const showLocalFallback = translationEngine === 'azure' && translationStatus === 'error';

    const refreshSecretStatus = useCallback(async () => {
        if (!window.broadcastAPI?.getTranslationSecretStatus) return;
        try {
            setSecretStatus(await window.broadcastAPI.getTranslationSecretStatus() || {});
        } catch (err) {
            console.error('Could not read credential status:', err);
        }
    }, []);

    // One-time migration: move any key left in localStorage by an older build into the
    // encrypted store, then delete the plaintext copy.
    useEffect(() => {
        const api = window.broadcastAPI;
        if (!api?.setTranslationSecret) return;

        (async () => {
            for (const [storageKey, name] of [[LEGACY_KEY_STORAGE[0], 'azure'], [LEGACY_KEY_STORAGE[1], 'soniox']]) {
                const legacy = localStorage.getItem(storageKey);
                if (legacy) {
                    try {
                        await api.setTranslationSecret(name, legacy);
                    } catch (err) {
                        console.error(`Could not migrate the stored ${name} key:`, err);
                    }
                }
                localStorage.removeItem(storageKey);
            }
            refreshSecretStatus();
        })();
    }, [refreshSecretStatus]);

    const saveSecret = useCallback(async (name, value, clearInput) => {
        const api = window.broadcastAPI;
        if (!api?.setTranslationSecret) {
            setSecretNotice('Credentials can only be saved from the desktop app.');
            return;
        }
        try {
            const result = await api.setTranslationSecret(name, value);
            if (!result?.ok) {
                setSecretNotice(result?.error || 'Could not save that key.');
                return;
            }
            clearInput('');
            setSecretNotice(result.warning || (result.stored ? 'Key saved.' : 'Key removed.'));
            refreshSecretStatus();
        } catch (err) {
            console.error('Could not save credential:', err);
            setSecretNotice('Could not save that key.');
        }
    }, [refreshSecretStatus]);

    useEffect(() => {
        localStorage.setItem(AZURE_REGION_STORAGE, azureRegion);
    }, [azureRegion]);

    useEffect(() => {
        localStorage.setItem(SONIOX_MODEL_STORAGE, sonioxModel);
    }, [sonioxModel]);

    useEffect(() => {
        localStorage.setItem(TRANSLATION_TARGET_STORAGE, targetLang);
    }, [targetLang]);

    useEffect(() => {
        localStorage.setItem(TRANSLATION_ENGINE_STORAGE, translationEngine);
    }, [translationEngine]);

    // Helpers to get styles and layouts matching existing modules
    const getStyle = useCallback(() => ({
        fontFamily, fontWeight, fontSize: Number(fontSize), color: fontColor,
        letterSpacing, bold: isBold, italic: isItalic, underline: isUnderline
    }), [fontFamily, fontWeight, fontSize, fontColor, letterSpacing, isBold, isItalic, isUnderline]);

    const getLayout = useCallback(() => ({
        posX: 50,
        posY: 88,
        bgStyle: 'charcoal',
        animStyle: 'fade',
        autoClear: autoClear ? Number(autoClear) : 0,
        cinematicGrad: {
            enabled: false
        }
    }), [autoClear]);
    const styleSnapshot = useMemo(() => getStyle(), [getStyle]);
    const layoutSnapshot = useMemo(() => getLayout(), [getLayout]);

    useEffect(() => deferUntilIdle(() => {
        const storedStyle = readLocalStorageObjectSafe(TRANSLATION_STYLE_STORAGE);
        setFontFamily(storedStyle.fontFamily || "'Outfit', sans-serif");
        setFontWeight(storedStyle.fontWeight || '600');
        setFontColor(storedStyle.color || '#ffffff');
        setFontSize(String(storedStyle.fontSize || '56'));
        setLetterSpacing(String(storedStyle.letterSpacing || '0'));
        setIsBold(Boolean(storedStyle.bold));
        setIsItalic(Boolean(storedStyle.italic));
        setIsUnderline(Boolean(storedStyle.underline));

        const storedLayout = readLocalStorageObjectSafe(TRANSLATION_LAYOUT_STORAGE);
        setAutoClear(storedLayout.autoClear ? String(storedLayout.autoClear) : '');
    }), []);

    // Save styling parameters
    useDebouncedLocalStorageEffect(TRANSLATION_STYLE_STORAGE, styleSnapshot);
    useDebouncedLocalStorageEffect(TRANSLATION_LAYOUT_STORAGE, layoutSnapshot);

    // Broadcast styling updates in real time to graphics
    useEffect(() => {
        if (!socket) return;
        socket.emit('update_translation_style', getStyle());
    }, [fontFamily, fontWeight, fontSize, fontColor, letterSpacing, isBold, isItalic, isUnderline, socket, getStyle]);

    useEffect(() => {
        if (!socket) return;
        socket.emit('update_translation_layout', getLayout());
    }, [socket, getLayout]);

    // Enumerate audio input devices
    useEffect(() => {
        const getDevices = async () => {
            try {
                // Request permissions first to get device names
                const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                stream.getTracks().forEach(track => track.stop());
                const devices = await navigator.mediaDevices.enumerateDevices();
                const inputs = devices.filter(d => d.kind === 'audioinput');
                setAudioDevices(inputs);
                setAudioPermission('granted');
                if (inputs.length > 0) {
                    setSelectedDevice(inputs[0].deviceId);
                }
            } catch (err) {
                console.error("Error fetching audio devices:", err);
                setAudioPermission('blocked');
                setAudioHealth('permission-error');
            }
        };
        getDevices();
    }, []);

    const markEvent = useCallback(() => {
        setLastEventAt(new Date().toLocaleTimeString());
    }, []);

    const stopVisualizer = useCallback(() => {
        if (animationFrameRef.current) {
            cancelAnimationFrame(animationFrameRef.current);
            animationFrameRef.current = null;
        }
        const canvas = visualizerCanvasRef.current;
        if (canvas) {
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#0f172a';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
        }
    }, []);

    const cleanupLocalAudio = useCallback(() => {
        if (noAudioTimerRef.current) {
            clearTimeout(noAudioTimerRef.current);
            noAudioTimerRef.current = null;
        }
        if (processorNodeRef.current) {
            try { processorNodeRef.current.disconnect(); } catch (e) {}
            processorNodeRef.current = null;
        }
        if (audioInputRef.current) {
            try { audioInputRef.current.disconnect(); } catch (e) {}
            audioInputRef.current = null;
        }
        if (audioContextRef.current) {
            try {
                if (audioContextRef.current.state !== 'closed') {
                    audioContextRef.current.close();
                }
            } catch (e) {}
            audioContextRef.current = null;
        }
        if (audioStreamRef.current) {
            try {
                audioStreamRef.current.getTracks().forEach(track => track.stop());
            } catch (e) {}
            audioStreamRef.current = null;
        }
        lastAudioAtRef.current = null;
        setAudioHealth('idle');
        stopVisualizer();
    }, [stopVisualizer]);

    // Socket listeners for backend speech translation events
    useEffect(() => {
        if (!socket) return;

        const handleStarted = () => {
            setTranslationStatus('listening');
            setLastError('');
            const label = translationEngine === 'local' ? 'Local AI' : translationEngine === 'soniox' ? 'Soniox' : 'Azure';
            setCurrentPhrase(`${label} listening (recording at 16kHz)...`);
            markEvent();
        };

        const handleFailed = (d) => {
            console.error("Backend translation start failed:", d.error);
            setTranslationStatus('error');
            setLastError(d.error || 'Failed to start translation session.');
            setCurrentPhrase('');
            cleanupLocalAudio();
            markEvent();
        };

        const handleCanceled = (d) => {
            console.log("Backend Azure canceled session:", d.error);
            setTranslationStatus('error');
            setLastError(d.error || 'Azure Speech session was canceled.');
            setCurrentPhrase('');
            cleanupLocalAudio();
            markEvent();
        };

        const handleStopped = () => {
            console.log("Backend Azure stopped session.");
            setTranslationStatus('idle');
            setCurrentPhrase('');
            cleanupLocalAudio();
            markEvent();
        };

        const handleStatus = (status) => {
            if (!status?.state) return;
            setTranslationStatus(status.state);
            setLastError(status.error || '');
            if (status.engine && status.state !== 'idle') {
                setTranslationEngine(status.engine);
            }
            if (status.updatedAt) {
                setLastEventAt(new Date(status.updatedAt).toLocaleTimeString());
            }
        };

        const handleTranslationUpdate = (d) => {
            setTranslationStatus('listening');
            setAudioHealth('receiving');
            markEvent();
            if (d.isFinal) {
                setCurrentPhrase('');
                setTranscript(prev => [...prev, {
                    text: d.text,
                    lang: d.engine === 'local' ? 'Local AI' : d.lang || 'Detected',
                    timestamp: new Date().toLocaleTimeString()
                }]);
            } else {
                setCurrentPhrase(d.text);
            }
        };

        socket.on('translation_started', handleStarted);
        socket.on('translation_failed', handleFailed);
        socket.on('translation_canceled', handleCanceled);
        socket.on('translation_stopped', handleStopped);
        socket.on('translation_status', handleStatus);
        socket.on('translation_update', handleTranslationUpdate);

        return () => {
            socket.off('translation_started', handleStarted);
            socket.off('translation_failed', handleFailed);
            socket.off('translation_canceled', handleCanceled);
            socket.off('translation_stopped', handleStopped);
            socket.off('translation_status', handleStatus);
            socket.off('translation_update', handleTranslationUpdate);
        };
    }, [socket, cleanupLocalAudio, markEvent, translationEngine]);

    useEffect(() => {
        if (!socket) return;

        const handleGlossaryUpdate = (entries) => {
            setGlossaryEntries(Array.isArray(entries) ? entries : []);
        };

        socket.on('translation_glossary_update', handleGlossaryUpdate);
        socket.emit('translation_glossary_request');

        return () => {
            socket.off('translation_glossary_update', handleGlossaryUpdate);
        };
    }, [socket]);

    useEffect(() => {
        if (!socket) return;

        const handleLocalSettingsUpdate = (settings) => {
            setLocalAiSettings({ ...DEFAULT_LOCAL_AI_SETTINGS, ...(settings || {}) });
        };

        socket.on('local_ai_settings_update', handleLocalSettingsUpdate);
        socket.emit('local_ai_settings_request');

        return () => {
            socket.off('local_ai_settings_update', handleLocalSettingsUpdate);
        };
    }, [socket]);

    // Set up real-time audio monitor visualizer tapping into our 16kHz context
    const startVisualizerFromStream = (stream, audioCtx, source) => {
        try {
            if (animationFrameRef.current) {
                cancelAnimationFrame(animationFrameRef.current);
            }

            const analyser = audioCtx.createAnalyser();
            analyser.fftSize = 64;
            source.connect(analyser);

            const bufferLength = analyser.frequencyBinCount;
            const dataArray = new Uint8Array(bufferLength);
            const canvas = visualizerCanvasRef.current;
            if (!canvas) return;
            const canvasCtx = canvas.getContext('2d');

            const draw = () => {
                if (!visualizerCanvasRef.current) return;
                animationFrameRef.current = requestAnimationFrame(draw);
                analyser.getByteFrequencyData(dataArray);

                canvasCtx.fillStyle = 'rgba(15, 23, 42, 0.2)'; // Dark tail fade
                canvasCtx.fillRect(0, 0, canvas.width, canvas.height);

                const barWidth = (canvas.width / bufferLength) * 1.5;
                let barHeight;
                let x = 0;

                for (let i = 0; i < bufferLength; i++) {
                    barHeight = (dataArray[i] / 255) * canvas.height * 0.8;
                    const r = 50 + (i * 2);
                    const g = 180 - i;
                    const b = 250;
                    canvasCtx.fillStyle = `rgb(${r},${g},${b})`;
                    canvasCtx.fillRect(x, canvas.height - barHeight, barWidth - 2, barHeight);
                    x += barWidth;
                }
            };
            draw();
        } catch (err) {
            console.error("Failed to start audio visualizer:", err);
        }
    };

    const handleHide = () => {
        if (socket) socket.emit('clear_translation_display');
        setCurrentPhrase('');
    };

    const clearLogs = () => {
        setTranscript([]);
    };

    const resetGlossaryForm = () => {
        setGlossaryForm(EMPTY_GLOSSARY_FORM);
        setEditingGlossaryId(null);
        setGlossaryError('');
    };

    const updateGlossaryField = (field, value) => {
        setGlossaryForm(prev => ({ ...prev, [field]: value }));
        if (glossaryError) setGlossaryError('');
    };

    const submitGlossaryEntry = () => {
        if (!socket) return;
        if (glossaryPhraseCount < 2) {
            setGlossaryError('Enter at least two matching language phrases.');
            return;
        }

        const payload = {
            ...glossaryForm,
            id: editingGlossaryId || undefined
        };
        const eventName = editingGlossaryId ? 'translation_glossary_update_entry' : 'translation_glossary_add';

        socket.emit(eventName, payload, (result) => {
            if (!result?.ok) {
                setGlossaryError(result?.error || 'Could not save glossary entry.');
                return;
            }
            resetGlossaryForm();
        });
    };

    const editGlossaryEntry = (entry) => {
        setEditingGlossaryId(entry.id);
        setGlossaryForm({
            en: entry.en || '',
            gu: entry.gu || '',
            hi: entry.hi || '',
            notes: entry.notes || ''
        });
        setGlossaryError('');
    };

    const deleteGlossaryEntry = (entryId) => {
        if (!socket) return;
        socket.emit('translation_glossary_delete', entryId, (result) => {
            if (!result?.ok) {
                setGlossaryError(result?.error || 'Could not delete glossary entry.');
            }
            if (editingGlossaryId === entryId) {
                resetGlossaryForm();
            }
        });
    };

    const updateLocalAiField = (field, value) => {
        setLocalAiSettings(prev => ({ ...prev, [field]: value }));
        setLocalAiStatus(null);
    };

    const saveLocalAiSettings = (settings = localAiSettings) => {
        if (!socket) return Promise.resolve({ ok: false, error: 'Socket is not connected.' });
        return new Promise(resolve => {
            socket.emit('local_ai_settings_save', settings, (result) => {
                if (result?.settings) {
                    setLocalAiSettings({ ...DEFAULT_LOCAL_AI_SETTINGS, ...result.settings });
                }
                if (!result?.ok) {
                    setLocalAiStatus({ ok: false, errors: [result?.error || 'Could not save Local AI settings.'] });
                }
                resolve(result || { ok: false });
            });
        });
    };

    const testLocalAi = async () => {
        if (!socket || localAiBusy) return;
        setLocalAiBusy(true);
        setLocalAiStatus(null);
        socket.emit('local_ai_test', localAiSettings, (result) => {
            setLocalAiBusy(false);
            setLocalAiStatus(result || { ok: false, errors: ['Local AI test did not return a result.'] });
            if (result?.settings) {
                setLocalAiSettings({ ...DEFAULT_LOCAL_AI_SETTINGS, ...result.settings });
            }
        });
    };

    const pickWhisperExecutable = async () => {
        const selected = await window.broadcastAPI?.selectWhisperExecutable?.();
        if (selected) updateLocalAiField('whisperExecutablePath', selected);
    };

    const pickWhisperModel = async () => {
        const selected = await window.broadcastAPI?.selectWhisperModel?.();
        if (selected) updateLocalAiField('whisperModelPath', selected);
    };

    const switchToLocalFallback = () => {
        setTranslationEngine('local');
        setShowLocalConfig(true);
        setLastError('');
        setTranslationStatus('idle');
    };

    // Toggle start/stop of translation session
    const toggleTranslation = async () => {
        if (isBusy) return;
        if (isTranslating) {
            stopTranslation();
        } else {
            await startTranslation();
        }
    };

    const startTranslation = async ({ force = false } = {}) => {
        if (!force && (isBusy || isTranslating)) return;

        // Gate on whether a key is *stored*, not on the input box — the box is only ever
        // populated while the operator is typing a new one.
        if (translationEngine === 'azure' && !secretStatus.azure) {
            setShowAzureConfig(true);
            setTranslationStatus('error');
            setLastError('Save a valid Azure Speech key in the settings first.');
            return;
        }

        if (translationEngine === 'soniox' && !secretStatus.soniox) {
            setShowSonioxConfig(true);
            setTranslationStatus('error');
            setLastError('Save a valid Soniox API key in the settings first.');
            return;
        }

        const sourceLanguages = [];
        if (detectEnglish) sourceLanguages.push('en-US');
        if (detectGujarati) sourceLanguages.push('gu-IN');
        if (detectHindi) sourceLanguages.push('hi-IN');
        
        if (sourceLanguages.length === 0) {
            setTranslationStatus('error');
            setLastError('Please select at least one language to recognize.');
            return;
        }

        try {
            setTranslationStatus('starting');
            setLastError('');
            setPendingRestart(false);
            setAudioHealth('starting');
            setCurrentPhrase('Connecting to server...');
            markEvent();

            // 1. Tell backend to start Azure Speech session
            if (translationEngine === 'local') {
                await saveLocalAiSettings();
            }

            // No `key` field: the server resolves the credential from the encrypted store in
            // the main process, so it never crosses this boundary (or the LAN).
            socket.emit('start_translation', {
                engine: translationEngine,
                region: azureRegion,
                targetLang,
                sourceLanguages,
                sonioxModel,
                localAiSettings
            });

            // 2. Capture microphone stream at 16kHz
            const constraints = {
                audio: selectedDevice ? { deviceId: { exact: selectedDevice } } : true
            };
            const stream = await navigator.mediaDevices.getUserMedia(constraints);
            audioStreamRef.current = stream;
            setAudioPermission('granted');
            setAudioHealth('waiting-for-signal');
            lastAudioAtRef.current = null;

            if (noAudioTimerRef.current) clearTimeout(noAudioTimerRef.current);
            noAudioTimerRef.current = setTimeout(() => {
                if (!lastAudioAtRef.current) {
                    setAudioHealth('silent');
                }
            }, 3500);

            // Initialize AudioContext downsampled to 16kHz
            const AudioContextClass = window.AudioContext || window.webkitAudioContext;
            const audioCtx = new AudioContextClass({ sampleRate: 16000 });
            audioContextRef.current = audioCtx;

            const source = audioCtx.createMediaStreamSource(stream);
            audioInputRef.current = source;

            // ScriptProcessorNode to read PCM chunks
            const processor = audioCtx.createScriptProcessor(4096, 1, 1);
            processorNodeRef.current = processor;

            source.connect(processor);
            processor.connect(audioCtx.destination);

            processor.onaudioprocess = (e) => {
                const inputData = e.inputBuffer.getChannelData(0);
                
                // Convert Float32 samples [-1.0, 1.0] to Int16 PCM
                const l = inputData.length;
                const pcm16 = new Int16Array(l);
                let peak = 0;
                for (let i = 0; i < l; i++) {
                    let s = Math.max(-1, Math.min(1, inputData[i]));
                    peak = Math.max(peak, Math.abs(s));
                    pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
                }

                if (peak > 0.015) {
                    lastAudioAtRef.current = Date.now();
                    setAudioHealth('receiving');
                } else if (lastAudioAtRef.current && Date.now() - lastAudioAtRef.current > 5000) {
                    setAudioHealth('silent');
                }
                
                // Emit raw PCM 16-bit array buffer
                socket.emit('audio_chunk', pcm16.buffer);
            };

            // Start waveform visualizer for monitoring
            startVisualizerFromStream(stream, audioCtx, source);

        } catch (err) {
            console.error("Failed to capture audio:", err);
            setTranslationStatus('error');
            setLastError('Failed to start audio recording. Check microphone permissions.');
            setAudioPermission('blocked');
            cleanupLocalAudio();
            if (socket) socket.emit('stop_translation');
        }
    };

    startTranslationRef.current = startTranslation;

    const stopTranslation = () => {
        if (translationStatus === 'idle' || translationStatus === 'stopping') return;
        setTranslationStatus('stopping');
        setCurrentPhrase('');
        markEvent();
        
        // 1. Tell backend to stop Azure session
        socket.emit('stop_translation');

        cleanupLocalAudio();
    };

    const restartTranslation = async () => {
        if (isBusy) return;
        if (isTranslating) {
            stopTranslation();
            setTimeout(() => startTranslation({ force: true }), 500);
        } else {
            await startTranslation();
        }
    };

    useEffect(() => {
        const handleRunShowStart = () => {
            startTranslationRef.current?.();
        };
        window.addEventListener('bc_runshow_start_translation', handleRunShowStart);
        return () => window.removeEventListener('bc_runshow_start_translation', handleRunShowStart);
    }, []);

    const testMic = async () => {
        try {
            setAudioHealth('checking');
            const constraints = {
                audio: selectedDevice ? { deviceId: { exact: selectedDevice } } : true
            };
            const stream = await navigator.mediaDevices.getUserMedia(constraints);
            stream.getTracks().forEach(track => track.stop());
            setAudioPermission('granted');
            setAudioHealth('ready');
            setLastError('');
            markEvent();
        } catch (err) {
            console.error("Mic test failed:", err);
            setAudioPermission('blocked');
            setAudioHealth('permission-error');
            setLastError('Microphone test failed. Check device selection and macOS/browser microphone permissions.');
            setTranslationStatus('error');
        }
    };

    // Clean up on unmount
    useEffect(() => {
        return () => {
            cleanupLocalAudio();
        };
    }, [cleanupLocalAudio]);

    const statusTone = {
        idle: 'bg-slate-500',
        starting: 'bg-amber-500',
        listening: 'bg-emerald-500',
        stopping: 'bg-amber-500',
        error: 'bg-red-500'
    }[translationStatus] || 'bg-slate-500';

    const audioHealthLabel = {
        idle: 'Mic idle',
        checking: 'Checking mic',
        starting: 'Opening mic',
        ready: 'Mic ready',
        'waiting-for-signal': 'Waiting for signal',
        receiving: 'Signal live',
        silent: 'No audio signal',
        'permission-error': 'Mic blocked'
    }[audioHealth] || 'Mic idle';

    const selectedDeviceLabel = audioDevices.find(d => d.deviceId === selectedDevice)?.label || 'Default input';


    return (
        <div className="space-y-4">
            
            {/* Top Control Bar */}
            <div className="surface rounded-lg p-4 flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center space-x-3 min-w-0">
                    <button 
                        onClick={toggleTranslation}
                        disabled={isBusy}
                        className={`w-12 h-12 rounded-xl flex items-center justify-center transition-all duration-300 active:scale-95 shadow-lg ${
                            isTranslating 
                                ? 'bg-red-600 hover:bg-red-500 shadow-red-600/30 text-white' 
                                : 'bg-blue-600 hover:bg-blue-500 shadow-blue-600/30 text-white'
                        } ${isBusy ? 'opacity-60 cursor-not-allowed' : ''}`}
                        title={isTranslating ? 'Stop Translation' : 'Start Translation'}
                    >
                        {isTranslating ? <Square className="w-6 h-6 fill-white" /> : <Play className="w-6 h-6 fill-white ml-0.5" />}
                    </button>
                    <div>
                        <div className="flex items-center space-x-2">
                            <span className="font-bold text-base tracking-wide">Live Audio Translation</span>
                            <span className={`flex h-2.5 w-2.5 relative`}>
                                <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${statusTone}`}></span>
                                <span className={`relative inline-flex rounded-full h-2.5 w-2.5 ${statusTone}`}></span>
                            </span>
                        </div>
                        <p className="text-xs text-slate-500 font-medium mt-0.5">
                            {translationStatus === 'listening' ? `${isLocalEngine ? 'Local AI backup' : isSonioxEngine ? 'Soniox Real-Time Translation' : 'Azure Speech Translation'} is active` : translationStatus === 'error' ? 'Resolve the error below, then retry' : 'Click Play to stream program audio'}
                        </p>
                    </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                    <div className="surface-muted flex items-center gap-2 rounded-lg px-3 py-2 text-[10px] font-bold uppercase tracking-wider" title={selectedDeviceLabel}>
                        <Activity className="w-3.5 h-3.5 text-slate-400" />
                        <span className="text-slate-500">Service</span>
                        <span className={`${translationStatus === 'error' ? 'text-red-400' : translationStatus === 'listening' ? 'text-emerald-400' : 'text-slate-300'}`}>{STATUS_LABELS[translationStatus]}</span>
                    </div>
                    <div className="surface-muted flex items-center rounded-lg px-3 py-2 text-xs">
                        <Activity className="w-4 h-4 text-slate-400 mr-2 shrink-0" />
                        <select
                            value={translationEngine}
                            onChange={e => {
                                setTranslationEngine(e.target.value);
                                if (isTranslating) setPendingRestart(true);
                            }}
                            disabled={isBusy}
                            className="bg-transparent border-0 outline-none text-slate-700 dark:text-slate-200 font-bold"
                        >
                            <option value="azure">Azure</option>
                            <option value="soniox">Soniox</option>
                            <option value="local">Local AI</option>
                        </select>
                    </div>
                    <div className="surface-muted flex items-center gap-2 rounded-lg px-3 py-2 text-[10px] font-bold uppercase tracking-wider">
                        {audioHealth === 'receiving' || audioHealth === 'ready' ? <CheckCircle className="w-3.5 h-3.5 text-emerald-400" /> : <AlertTriangle className={`w-3.5 h-3.5 ${audioHealth === 'silent' || audioPermission === 'blocked' ? 'text-amber-400' : 'text-slate-400'}`} />}
                        <span className={audioHealth === 'silent' || audioPermission === 'blocked' ? 'text-amber-400' : 'text-slate-400'}>{audioHealthLabel}</span>
                    </div>
                    <div className="surface-muted hidden 2xl:flex items-center gap-2 rounded-lg px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-slate-500">
                        <span>To</span>
                        <span className="text-slate-300">{LANGUAGE_LABELS[targetLang]}</span>
                        <span className="text-slate-700">/</span>
                        <span>{lastEventAt || 'No events'}</span>
                    </div>
                    {/* Audio input selector */}
                    <div className="surface-muted flex items-center rounded-lg px-3 py-2 text-xs">
                        <Mic className="w-4 h-4 text-slate-400 mr-2 shrink-0" />
                        <select 
                            value={selectedDevice} 
                            onChange={e => {
                                setSelectedDevice(e.target.value);
                                if (isTranslating) {
                                    setPendingRestart(true);
                                }
                            }}
                            disabled={isBusy}
                            className="bg-transparent border-0 outline-none text-slate-700 dark:text-slate-200 font-medium max-w-[200px]"
                        >
                            <option value="">Default Microphone...</option>
                            {audioDevices.map(d => (
                                <option key={d.deviceId} value={d.deviceId}>{d.label || `Audio Input ${d.deviceId.slice(0, 5)}`}</option>
                            ))}
                        </select>
                    </div>

                    {/* Target Language Select */}
                    <div className="surface-muted flex items-center rounded-lg px-3 py-2 text-xs">
                        <Globe className="w-4 h-4 text-slate-400 mr-2 shrink-0" />
                        <span className="text-slate-500 mr-1.5 font-medium">Translate to:</span>
                        <select 
                            value={targetLang} 
                            onChange={e => {
                                setTargetLang(e.target.value);
                                if (isTranslating) {
                                    setPendingRestart(true);
                                }
                            }}
                            disabled={isBusy}
                            className="bg-transparent border-0 outline-none text-slate-700 dark:text-slate-200 font-bold"
                        >
                            <option value="en">English (en)</option>
                            <option value="gu">Gujarati (gu)</option>
                            <option value="hi">Hindi (hi)</option>
                        </select>
                    </div>

                    <button 
                        onClick={restartTranslation}
                        disabled={isBusy || (!isTranslating && !pendingRestart)}
                        className={`px-3 py-2.5 rounded-xl border text-[10px] font-bold uppercase tracking-wider flex items-center gap-1.5 transition active:scale-95 ${
                            pendingRestart 
                                ? 'bg-amber-500/10 border-amber-500/40 text-amber-400 hover:bg-amber-500 hover:text-white'
                                : 'control-button-muted text-slate-500 hover:text-slate-300'
                        } ${(isBusy || (!isTranslating && !pendingRestart)) ? 'opacity-50 cursor-not-allowed' : ''}`}
                        title="Restart translation with the current settings"
                    >
                        <RefreshCw className="w-3.5 h-3.5" /> Restart
                    </button>

                    <button 
                        onClick={testMic}
                        disabled={isBusy || isTranslating}
                        className={`control-button-muted px-3 py-2.5 text-[10px] font-bold uppercase tracking-wider flex items-center gap-1.5 active:scale-95 text-slate-500 hover:text-slate-300 ${(isBusy || isTranslating) ? 'opacity-50 cursor-not-allowed' : ''}`}
                        title="Check microphone permission and selected input"
                    >
                        <Mic className="w-3.5 h-3.5" /> Test Mic
                    </button>

                    <button 
                        onClick={() => setShowAzureConfig(!showAzureConfig)} 
                        className={`p-2.5 rounded-xl border transition active:scale-95 ${
                            showAzureConfig 
                                ? 'bg-blue-600/10 border-blue-500 text-blue-500' 
                                : 'control-button-muted text-slate-500 hover:text-slate-300'
                        }`}
                        title="Azure Setup"
                    >
                        <Settings className="w-4 h-4" />
                    </button>
                    <button 
                        onClick={() => setShowSonioxConfig(!showSonioxConfig)} 
                        className={`px-3 py-2.5 rounded-xl border text-[10px] font-bold uppercase tracking-wider flex items-center gap-1.5 transition active:scale-95 ${
                            showSonioxConfig 
                                ? 'bg-cyan-600/10 border-cyan-500 text-cyan-500' 
                                : 'control-button-muted text-slate-500 hover:text-slate-300'
                        }`}
                        title="Soniox Setup"
                    >
                        <Globe className="w-3.5 h-3.5" /> Soniox
                    </button>
                    <button 
                        onClick={() => setShowLocalConfig(!showLocalConfig)} 
                        className={`px-3 py-2.5 rounded-xl border text-[10px] font-bold uppercase tracking-wider flex items-center gap-1.5 transition active:scale-95 ${
                            showLocalConfig 
                                ? 'bg-emerald-600/10 border-emerald-500 text-emerald-500' 
                                : 'control-button-muted text-slate-500 hover:text-slate-300'
                        }`}
                        title="Local AI Setup"
                    >
                        <Sliders className="w-3.5 h-3.5" /> Local AI
                    </button>
                </div>
            </div>

            {lastError && (
                <div className="bg-red-500/10 border border-red-500/30 rounded-2xl p-4 flex items-start gap-3 text-sm text-red-100">
                    <AlertTriangle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
                    <div className="min-w-0">
                        <div className="font-bold text-red-300 uppercase tracking-wider text-[10px]">Translation needs attention</div>
                        <p className="text-xs text-red-100/90 mt-1">{lastError}</p>
                        <p className="text-[10px] text-red-200/70 mt-1">Check credentials, region, microphone access, then start or restart the session.</p>
                    </div>
                </div>
            )}

            {showLocalFallback && (
                <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-2xl p-3 text-xs text-emerald-100 flex items-center justify-between gap-3">
                    <span>Azure stopped. You can switch to Local AI backup if Ollama and Whisper are configured on this machine.</span>
                    <button onClick={switchToLocalFallback} className="bg-emerald-500 hover:bg-emerald-400 text-slate-950 px-3 py-1.5 rounded-lg font-bold uppercase tracking-wider text-[10px]">
                        Use Local AI
                    </button>
                </div>
            )}

            {pendingRestart && isTranslating && (
                <div className="bg-amber-500/10 border border-amber-500/30 rounded-2xl p-3 text-xs text-amber-100 flex items-center justify-between gap-3">
                    <span>Settings changed. Restart the session to apply the new input or language.</span>
                    <button onClick={restartTranslation} disabled={isBusy} className="bg-amber-500 hover:bg-amber-400 text-slate-950 px-3 py-1.5 rounded-lg font-bold uppercase tracking-wider text-[10px] disabled:opacity-60">
                        Restart Now
                    </button>
                </div>
            )}

            {/* Azure Configuration Drawer */}
            {showAzureConfig && (
                <div className="surface space-y-3 rounded-lg p-4">
                    <div className="flex items-center justify-between">
                        <h4 className="text-xs font-bold text-blue-500 uppercase tracking-widest flex items-center gap-2">
                            <Sliders className="w-4 h-4" /> Azure Service Credentials
                        </h4>
                        <button 
                            onClick={() => setShowHelpModal(true)}
                            className="text-[10px] font-bold text-blue-400 hover:text-blue-300 uppercase tracking-wider flex items-center gap-1 transition"
                        >
                            <HelpCircle className="w-3.5 h-3.5" /> Setup Help
                        </button>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="space-y-1.5">
                            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                                Speech Subscription Key (Key 1 / Key 2)
                                {secretStatus.azure && <span className="ml-2 text-emerald-500">saved</span>}
                            </label>
                            <div className="flex gap-2">
                                <input
                                    type="password"
                                    value={azureKey}
                                    onChange={e => setAzureKey(e.target.value)}
                                    placeholder={secretStatus.azure ? 'A key is saved. Paste a new one to replace it.' : 'Paste your Azure Speech API key...'}
                                    className="control-field px-4 py-2.5 text-xs flex-1"
                                />
                                <button
                                    type="button"
                                    onClick={() => saveSecret('azure', azureKey, setAzureKey)}
                                    disabled={!azureKey.trim()}
                                    className="control-button px-3 py-2.5 text-xs disabled:opacity-40"
                                >
                                    Save
                                </button>
                                {secretStatus.azure && (
                                    <button
                                        type="button"
                                        onClick={() => saveSecret('azure', '', setAzureKey)}
                                        className="control-button px-3 py-2.5 text-xs"
                                    >
                                        Clear
                                    </button>
                                )}
                            </div>
                            {secretNotice && <p className="text-[10px] text-slate-500 dark:text-slate-400">{secretNotice}</p>}
                        </div>
                        <div className="space-y-1.5">
                            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">Service Location/Region</label>
                            <select 
                                value={azureRegion} 
                                onChange={e => setAzureRegion(e.target.value)}
                                className="control-field px-4 py-2.5 text-xs"
                            >
                                <option value="eastus">East US (eastus)</option>
                                <option value="eastus2">East US 2 (eastus2)</option>
                                <option value="westus2">West US 2 (westus2)</option>
                                <option value="centralus">Central US (centralus)</option>
                                <option value="northcentralus">North Central US (northcentralus)</option>
                                <option value="southcentralus">South Central US (southcentralus)</option>
                                <option value="centralindia">Central India (centralindia)</option>
                                <option value="westeurope">West Europe (westeurope)</option>
                                <option value="southeastasia">Southeast Asia (southeastasia)</option>
                            </select>
                        </div>
                    </div>
                </div>
            )}

            {showSonioxConfig && (
                <div className="surface space-y-3 rounded-lg p-4">
                    <div className="flex items-center justify-between">
                        <h4 className="text-xs font-bold text-cyan-500 uppercase tracking-widest flex items-center gap-2">
                            <Globe className="w-4 h-4" /> Soniox Real-Time Translation
                        </h4>
                        <a
                            href="https://console.soniox.com"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[10px] font-bold text-cyan-400 hover:text-cyan-300 uppercase tracking-wider transition"
                        >
                            Soniox Console
                        </a>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="space-y-1.5">
                            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                                Soniox API Key
                                {secretStatus.soniox && <span className="ml-2 text-emerald-500">saved</span>}
                            </label>
                            <div className="flex gap-2">
                                <input
                                    type="password"
                                    value={sonioxKey}
                                    onChange={e => setSonioxKey(e.target.value)}
                                    placeholder={secretStatus.soniox ? 'A key is saved. Paste a new one to replace it.' : 'Paste your Soniox API key...'}
                                    className="control-field px-4 py-2.5 text-xs flex-1"
                                />
                                <button
                                    type="button"
                                    onClick={() => saveSecret('soniox', sonioxKey, setSonioxKey)}
                                    disabled={!sonioxKey.trim()}
                                    className="control-button px-3 py-2.5 text-xs disabled:opacity-40"
                                >
                                    Save
                                </button>
                                {secretStatus.soniox && (
                                    <button
                                        type="button"
                                        onClick={() => saveSecret('soniox', '', setSonioxKey)}
                                        className="control-button px-3 py-2.5 text-xs"
                                    >
                                        Clear
                                    </button>
                                )}
                            </div>
                            {secretNotice && <p className="text-[10px] text-slate-500 dark:text-slate-400">{secretNotice}</p>}
                        </div>
                        <div className="space-y-1.5">
                            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">Real-Time Model</label>
                            <input
                                value={sonioxModel}
                                onChange={e => setSonioxModel(e.target.value)}
                                placeholder="stt-rt-v4"
                                className="control-field px-4 py-2.5 text-xs"
                            />
                        </div>
                    </div>
                    <p className="text-[10px] text-slate-500">
                        Soniox streams translated caption tokens mid-sentence using the same microphone feed and overlay.
                    </p>
                </div>
            )}

            {showLocalConfig && (
                <div className="surface space-y-4 rounded-lg p-4">
                    <div className="flex items-center justify-between gap-3">
                        <h4 className="text-xs font-bold text-emerald-500 uppercase tracking-widest flex items-center gap-2">
                            <Sliders className="w-4 h-4" /> Local AI Backup Setup
                        </h4>
                        <button
                            onClick={testLocalAi}
                            disabled={localAiBusy}
                            className="px-3 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 text-white text-[10px] font-bold uppercase tracking-wider transition"
                        >
                            {localAiBusy ? 'Testing...' : 'Test Local AI'}
                        </button>
                    </div>

                    <div className="grid grid-cols-1 xl:grid-cols-3 gap-3 text-[11px] text-slate-500">
                        <div className="surface-muted rounded-lg p-3">
                            <div className="font-bold uppercase tracking-wider text-slate-600 dark:text-slate-300">1. Install Ollama</div>
                            <p className="mt-1">Download from <a href="https://ollama.com" target="_blank" rel="noopener noreferrer" className="text-emerald-500 underline font-semibold">ollama.com</a>, then pull a model.</p>
                            <code className="surface-raised mt-2 block rounded p-2 text-[10px] text-slate-700 dark:text-slate-300">ollama run gemma3:4b</code>
                        </div>
                        <div className="surface-muted rounded-lg p-3">
                            <div className="font-bold uppercase tracking-wider text-slate-600 dark:text-slate-300">2. Install Whisper</div>
                            <p className="mt-1">Install a Whisper-compatible local executable, such as whisper.cpp, and download a Whisper model file.</p>
                            <code className="surface-raised mt-2 block rounded p-2 text-[10px] text-slate-700 dark:text-slate-300">whisper-cli -m model.bin -f audio.wav</code>
                        </div>
                        <div className="surface-muted rounded-lg p-3">
                            <div className="font-bold uppercase tracking-wider text-slate-600 dark:text-slate-300">3. Expect Latency</div>
                            <p className="mt-1">Local AI runs on this computer. Smaller models respond faster; larger models may translate better but lag more.</p>
                        </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="space-y-1.5">
                            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">Ollama URL</label>
                            <input
                                value={localAiSettings.ollamaBaseUrl}
                                onChange={e => updateLocalAiField('ollamaBaseUrl', e.target.value)}
                                placeholder="http://localhost:11434"
                                className="control-field w-full px-4 py-2.5 text-xs focus:ring-emerald-500"
                            />
                        </div>
                        <div className="space-y-1.5">
                            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">Ollama Model Name</label>
                            <input
                                value={localAiSettings.ollamaModel}
                                onChange={e => updateLocalAiField('ollamaModel', e.target.value)}
                                placeholder="gemma3:4b"
                                className="control-field w-full px-4 py-2.5 text-xs focus:ring-emerald-500"
                            />
                        </div>
                        <div className="space-y-1.5">
                            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">Whisper Executable</label>
                            <div className="flex gap-2">
                                <input
                                    value={localAiSettings.whisperExecutablePath}
                                    onChange={e => updateLocalAiField('whisperExecutablePath', e.target.value)}
                                    placeholder="/path/to/whisper-cli"
                                    className="control-field min-w-0 flex-1 px-4 py-2.5 text-xs focus:ring-emerald-500"
                                />
                                <button onClick={pickWhisperExecutable} className="control-button-muted px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-slate-500">Browse</button>
                            </div>
                        </div>
                        <div className="space-y-1.5">
                            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">Whisper Model File</label>
                            <div className="flex gap-2">
                                <input
                                    value={localAiSettings.whisperModelPath}
                                    onChange={e => updateLocalAiField('whisperModelPath', e.target.value)}
                                    placeholder="/path/to/ggml-model.bin"
                                    className="control-field min-w-0 flex-1 px-4 py-2.5 text-xs focus:ring-emerald-500"
                                />
                                <button onClick={pickWhisperModel} className="control-button-muted px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-slate-500">Browse</button>
                            </div>
                        </div>
                        <div className="space-y-1.5">
                            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">Audio Chunk Seconds</label>
                            <input
                                type="number"
                                min="2"
                                max="15"
                                value={localAiSettings.chunkSeconds}
                                onChange={e => updateLocalAiField('chunkSeconds', e.target.value)}
                                className="control-field w-full px-4 py-2.5 text-xs focus:ring-emerald-500"
                            />
                        </div>
                        <div className="flex items-end">
                            <button
                                onClick={() => saveLocalAiSettings()}
                                className="w-full px-3 py-2.5 rounded-xl border border-emerald-500/40 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500 hover:text-white text-[10px] font-bold uppercase tracking-wider transition"
                            >
                                Save Local AI Settings
                            </button>
                        </div>
                    </div>

                    {localAiStatus && (
                        <div className={`rounded-xl border p-3 text-xs ${localAiStatus.ok ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-100' : 'border-red-500/30 bg-red-500/10 text-red-100'}`}>
                            <div className="font-bold uppercase tracking-wider text-[10px] mb-1">{localAiStatus.ok ? 'Local AI Ready' : 'Local AI Needs Attention'}</div>
                            {localAiStatus.errors?.length > 0 ? (
                                <ul className="list-disc pl-4 space-y-1">
                                    {localAiStatus.errors.map((error, idx) => <li key={idx}>{error}</li>)}
                                </ul>
                            ) : (
                                <p>Ollama responded and the Whisper paths look valid.</p>
                            )}
                        </div>
                    )}
                </div>
            )}

            {/* Middle Main Section: Left Controls, Right Logs */}
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                
                {/* Left Column: Subtitle Formatting & Layout Settings */}
                <div className="space-y-4">
                    
                    {/* Source Languages card */}
                    <div className="surface space-y-3 rounded-lg p-4">
                        <h4 className="text-[10px] font-bold text-slate-500 uppercase tracking-widest flex items-center gap-1.5">
                            <Globe className="w-3.5 h-3.5 text-blue-500" /> Multi-Language Auto Detection
                        </h4>
                        <p className="text-[10px] text-slate-500">Check all languages the speakers might use. Cloud engines use these as detection hints:</p>
                        <div className="flex space-x-6 pt-1">
                            <label className="flex items-center text-xs font-semibold cursor-pointer select-none">
                                <input type="checkbox" checked={detectEnglish} onChange={e=>{ setDetectEnglish(e.target.checked); if (isTranslating) setPendingRestart(true); }} disabled={isBusy} className="rounded border-slate-300 text-blue-600 focus:ring-blue-500 mr-2 h-4 w-4 disabled:opacity-60" />
                                English (en-US)
                            </label>
                            <label className="flex items-center text-xs font-semibold cursor-pointer select-none">
                                <input type="checkbox" checked={detectGujarati} onChange={e=>{ setDetectGujarati(e.target.checked); if (isTranslating) setPendingRestart(true); }} disabled={isBusy} className="rounded border-slate-300 text-blue-600 focus:ring-blue-500 mr-2 h-4 w-4 disabled:opacity-60" />
                                Gujarati (gu-IN)
                            </label>
                            <label className="flex items-center text-xs font-semibold cursor-pointer select-none">
                                <input type="checkbox" checked={detectHindi} onChange={e=>{ setDetectHindi(e.target.checked); if (isTranslating) setPendingRestart(true); }} disabled={isBusy} className="rounded border-slate-300 text-blue-600 focus:ring-blue-500 mr-2 h-4 w-4 disabled:opacity-60" />
                                Hindi (hi-IN)
                            </label>
                        </div>
                    </div>

                    {/* Translation correction glossary */}
                    <div className="surface space-y-3 rounded-lg p-4">
                        <div className="flex items-center justify-between gap-3">
                            <h4 className="text-[10px] font-bold text-slate-500 uppercase tracking-widest flex items-center gap-1.5">
                                <BookOpen className="w-3.5 h-3.5 text-emerald-500" /> Correction Glossary
                            </h4>
                            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{glossaryEntries.length} saved</span>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                            <input
                                value={glossaryForm.en}
                                onChange={e => updateGlossaryField('en', e.target.value)}
                                placeholder="English phrase"
                                className="control-field w-full px-3 py-2 text-xs focus:ring-emerald-500"
                            />
                            <input
                                value={glossaryForm.gu}
                                onChange={e => updateGlossaryField('gu', e.target.value)}
                                placeholder="Gujarati phrase"
                                className="control-field w-full px-3 py-2 text-xs focus:ring-emerald-500"
                            />
                            <input
                                value={glossaryForm.hi}
                                onChange={e => updateGlossaryField('hi', e.target.value)}
                                placeholder="Hindi phrase"
                                className="control-field w-full px-3 py-2 text-xs focus:ring-emerald-500"
                            />
                        </div>

                        <div className="flex flex-col sm:flex-row gap-2">
                            <input
                                value={glossaryForm.notes}
                                onChange={e => updateGlossaryField('notes', e.target.value)}
                                placeholder="Optional note or context"
                                className="control-field flex-1 px-3 py-2 text-xs focus:ring-emerald-500"
                            />
                            <div className="flex gap-2">
                                {editingGlossaryId && (
                                    <button
                                        onClick={resetGlossaryForm}
                                        className="control-button-muted px-3 py-2 text-slate-500 transition"
                                        title="Cancel edit"
                                    >
                                        <X className="w-4 h-4" />
                                    </button>
                                )}
                                <button
                                    onClick={submitGlossaryEntry}
                                    disabled={glossaryPhraseCount < 2}
                                    className="px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-400 disabled:cursor-not-allowed text-white text-[10px] font-bold uppercase tracking-wider flex items-center gap-1.5 transition"
                                    title={editingGlossaryId ? 'Update glossary entry' : 'Save glossary entry'}
                                >
                                    <Save className="w-3.5 h-3.5" /> {editingGlossaryId ? 'Update' : 'Save'}
                                </button>
                            </div>
                        </div>

                        {glossaryError && (
                            <p className="text-[10px] font-semibold text-red-400">{glossaryError}</p>
                        )}

                        <div className="max-h-44 overflow-y-auto space-y-2 pr-1">
                            {glossaryEntries.length === 0 ? (
                                <div className="surface-muted rounded-lg border-dashed p-3 text-center text-[10px] text-slate-500">
                                    Saved corrections will apply automatically to live translation output.
                                </div>
                            ) : glossaryEntries.map(entry => (
                                <div key={entry.id} className="surface-muted rounded-lg p-3">
                                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
                                        <div className="min-w-0">
                                            <span className="block text-[9px] font-bold uppercase tracking-wider text-slate-500">English</span>
                                            <span className="block truncate font-semibold">{entry.en || '-'}</span>
                                        </div>
                                        <div className="min-w-0">
                                            <span className="block text-[9px] font-bold uppercase tracking-wider text-slate-500">Gujarati</span>
                                            <span className="block truncate font-semibold">{entry.gu || '-'}</span>
                                        </div>
                                        <div className="min-w-0">
                                            <span className="block text-[9px] font-bold uppercase tracking-wider text-slate-500">Hindi</span>
                                            <span className="block truncate font-semibold">{entry.hi || '-'}</span>
                                        </div>
                                    </div>
                                    <div className="flex items-center justify-between gap-2 mt-2">
                                        <span className="text-[10px] text-slate-500 truncate">{entry.notes || 'No note'}</span>
                                        <div className="flex gap-2 shrink-0">
                                            <button onClick={() => editGlossaryEntry(entry)} className="text-[10px] font-bold uppercase tracking-wider text-blue-400 hover:text-blue-300 transition">Edit</button>
                                            <button onClick={() => deleteGlossaryEntry(entry.id)} className="text-[10px] font-bold uppercase tracking-wider text-red-400 hover:text-red-300 transition">Delete</button>
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                    {/* Subtitle Typography Card */}
                    <div className="surface space-y-3 rounded-lg p-4">
                        <h3 className="text-[10px] font-bold text-slate-500 dark:text-slate-500 uppercase tracking-[0.2em]">Subtitle Typography</h3>
                        
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                            <div className="space-y-1.5">
                                <label className="block text-xs font-semibold text-slate-600 dark:text-slate-400">Font Family</label>
                                <select value={fontFamily} onChange={e=>setFontFamily(e.target.value)} className="control-field w-full px-3 py-2 text-xs">
                                    <option value="'Outfit', sans-serif">Outfit (Default)</option>
                                    <option value="'Inter', sans-serif">Inter</option>
                                    <option value="'Poppins', sans-serif">Poppins</option>
                                    <option value="'Roboto', sans-serif">Roboto</option>
                                </select>
                            </div>

                            <div className="space-y-1.5">
                                <label className="block text-xs font-semibold text-slate-600 dark:text-slate-400">Weight</label>
                                <select value={fontWeight} onChange={e=>setFontWeight(e.target.value)} className="control-field w-full px-3 py-2 text-xs">
                                    <option value="300">Light</option>
                                    <option value="400">Regular</option>
                                    <option value="600">Semi-Bold</option>
                                    <option value="700">Bold</option>
                                </select>
                            </div>

                            <div className="space-y-1.5">
                                <label className="block text-xs font-semibold text-slate-600 dark:text-slate-400">Font Color</label>
                                <div className="flex items-center space-x-2">
                                    <input type="color" value={fontColor} onChange={e=>setFontColor(e.target.value)} className="w-10 h-8 p-0 bg-transparent border-0 cursor-pointer" />
                                    <span className="text-xs font-mono uppercase text-slate-500">{fontColor}</span>
                                </div>
                            </div>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2">
                            <div className="space-y-1.5">
                                <label className="block text-xs font-semibold text-slate-600 dark:text-slate-400">Size (px)</label>
                                <div className="flex items-center space-x-2">
                                    <button onClick={() => setFontSize(prev => String(Math.max(10, parseInt(prev) - 2)))} className="control-button-muted flex h-8 w-8 items-center justify-center text-sm font-bold">-</button>
                                    <input type="number" value={fontSize} onChange={e=>setFontSize(e.target.value)} className="control-field w-16 py-1.5 text-center text-xs font-medium" />
                                    <button onClick={() => setFontSize(prev => String(parseInt(prev) + 2))} className="control-button-muted flex h-8 w-8 items-center justify-center text-sm font-bold">+</button>
                                </div>
                            </div>

                            <div className="space-y-1.5">
                                <label className="block text-xs font-semibold text-slate-600 dark:text-slate-400">Emphasis</label>
                                <div className="flex space-x-2">
                                    <button onClick={() => setIsBold(!isBold)} className={`flex-1 rounded-lg border py-1.5 text-xs font-bold transition ${isBold ? 'border-blue-600 bg-blue-600 text-white' : 'control-button-muted text-slate-500'}`}>Bold</button>
                                    <button onClick={() => setIsItalic(!isItalic)} className={`flex-1 rounded-lg border py-1.5 text-xs font-bold italic transition ${isItalic ? 'border-blue-600 bg-blue-600 text-white' : 'control-button-muted text-slate-500'}`}>Italic</button>
                                </div>
                            </div>
                        </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-1.5 col-span-2">
                            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 font-bold uppercase tracking-wider text-[10px]">Auto Hide Graphics (seconds of silence)</label>
                            <input 
                                type="number" 
                                value={autoClear} 
                                onChange={e=>setAutoClear(e.target.value)} 
                                placeholder="0 = Never auto-hide (manual clear only)" 
                                min="0" 
                                className="control-field w-full px-4 py-2 focus:ring-blue-500" 
                            />
                        </div>
                    </div>

                    <button 
                        onClick={handleHide} 
                        className="w-full bg-red-600/10 hover:bg-red-600 text-red-500 hover:text-white border border-red-500/25 px-4 py-3 rounded-2xl font-bold uppercase tracking-widest text-xs transition active:scale-95"
                    >
                        Clear Translation Display Only
                    </button>

                </div>

                {/* Right Column: Live Transcript & Signal Waveform */}
                <div className="surface flex h-[460px] flex-col overflow-hidden rounded-lg">
                    <div className="surface-muted flex shrink-0 items-center justify-between border-b section-rule p-4">
                        <h4 className="text-xs font-bold text-slate-600 dark:text-slate-300 uppercase tracking-widest flex items-center gap-1.5">
                            <Volume2 className="w-4 h-4 text-emerald-400" /> Live Transcript Log
                        </h4>
                        <div className="flex items-center space-x-2">
                            <button 
                                onClick={clearLogs} 
                                className="text-[10px] font-bold text-slate-400 hover:text-red-400 transition flex items-center gap-1 uppercase tracking-wider"
                                title="Clear log"
                            >
                                <Trash2 className="w-3.5 h-3.5" /> Clear Log
                            </button>
                        </div>
                    </div>

                    {/* Audio monitor waveform visualizer */}
                    <div className="relative flex h-12 shrink-0 items-center border-b section-rule bg-slate-950 p-2">
                        <canvas ref={visualizerCanvasRef} width="600" height="40" className="w-full h-full rounded bg-slate-950" />
                        <span className="absolute left-4 text-[9px] uppercase font-bold tracking-widest text-slate-500 pointer-events-none flex items-center gap-1">
                            <Mic className="w-3 h-3 text-blue-500" /> Signal Meter
                        </span>
                    </div>

                    {/* Transcript logger container */}
                    <div className="surface-muted no-scrollbar flex-1 space-y-3 overflow-y-auto p-4">
                        {transcript.length === 0 && !currentPhrase && (
                            <div className="h-full flex flex-col items-center justify-center text-center text-slate-500 p-6">
                                <Mic className="w-10 h-10 text-slate-700 animate-pulse mb-3" />
                                <p className="text-xs font-medium">No live speech captured yet.</p>
                                <p className="text-[10px] opacity-75 mt-1">Make sure you have selected the correct audio input device above and clicked the Play button.</p>
                            </div>
                        )}
                        {transcript.map((line, idx) => (
                            <div key={idx} className="surface-raised flex flex-col space-y-1 rounded-lg p-3.5 transition hover:border-slate-500/20">
                                <div className="flex items-center justify-between text-[9px] text-slate-500 font-medium">
                                    <span className="bg-blue-600/10 text-blue-400 px-1.5 py-0.5 rounded font-bold uppercase tracking-wider">{line.lang}</span>
                                    <span>{line.timestamp}</span>
                                </div>
                                <p className="text-xs text-slate-800 dark:text-slate-100 font-semibold leading-relaxed font-eng">
                                    {line.text}
                                </p>
                            </div>
                        ))}
                        {currentPhrase && (
                            <div className="flex flex-col space-y-1 bg-blue-600/5 dark:bg-blue-500/5 border border-blue-500/20 p-3.5 rounded-xl animate-pulse">
                                <div className="flex items-center justify-between text-[9px] text-blue-500 font-bold">
                                    <span>{isLocalEngine ? 'Local AI Processing...' : isSonioxEngine ? 'Soniox Translating...' : 'Azure Recognizing...'}</span>
                                </div>
                                <p className="text-xs text-slate-600 dark:text-blue-200 font-medium italic leading-relaxed">
                                    {currentPhrase}
                                </p>
                            </div>
                        )}
                    </div>
                </div>

            </div>

            {/* Azure Instructions Modal */}
            {showHelpModal && (
                <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[9999] flex items-center justify-center p-4">
                    <div className="bg-slate-900 border border-slate-800 rounded-3xl w-full max-w-xl max-h-[85vh] flex flex-col shadow-2xl overflow-hidden scale-100 animate-in fade-in duration-300">
                        {/* Modal Header */}
                        <div className="p-6 bg-slate-800/50 border-b border-slate-800 flex items-center justify-between shrink-0">
                            <h3 className="text-base font-bold text-white uppercase tracking-wider flex items-center gap-2">
                                <Info className="w-5 h-5 text-blue-500" /> Azure Speech Setup Instructions
                            </h3>
                            <button 
                                onClick={() => setShowHelpModal(false)}
                                className="text-slate-400 hover:text-white font-bold text-sm bg-slate-800 hover:bg-slate-700 w-8 h-8 rounded-full flex items-center justify-center transition"
                            >
                                ✕
                            </button>
                        </div>

                        {/* Modal Body */}
                        <div className="p-6 overflow-y-auto space-y-5 text-sm text-slate-300 leading-relaxed no-scrollbar">
                            
                            <div className="space-y-2">
                                <h4 className="font-bold text-white flex items-center gap-2 text-xs uppercase tracking-wider text-blue-400">
                                    Step 1: Sign up for Azure
                                </h4>
                                <p>If you don't have an Azure subscription yet, sign up first at <a href="https://azure.microsoft.com/free/" target="_blank" rel="noopener noreferrer" className="text-blue-500 underline font-semibold">Azure Free Account (azure.microsoft.com/free)</a> to activate your subscription and default directory.</p>
                                <p className="mt-1">If you already have an account, go directly to the <a href="https://portal.azure.com" target="_blank" rel="noopener noreferrer" className="text-blue-500 underline font-semibold">Azure Portal (portal.azure.com)</a>.</p>
                                
                                <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-3.5 text-[11px] text-amber-200 mt-3 space-y-1">
                                    <p className="font-bold flex items-center gap-1">⚠️ "Account does not exist in tenant 'Microsoft Services'"?</p>
                                    <p>If you see this error when logging in, it means your browser session is trying to access a corporate/external Microsoft directory instead of your own. To fix this:</p>
                                    <ul className="list-disc pl-4 space-y-1 mt-1">
                                        <li>Make sure you signed up for a subscription first at <a href="https://azure.microsoft.com/free/" target="_blank" rel="noopener noreferrer" className="underline font-semibold text-blue-400">azure.microsoft.com/free</a>.</li>
                                        <li>Open an <strong>Incognito/Private Browser Tab</strong> and log in to <a href="https://portal.azure.com" target="_blank" rel="noopener noreferrer" className="underline font-semibold text-blue-400">portal.azure.com</a>.</li>
                                        <li>Or force logging into your personal directory using this link: <a href="https://portal.azure.com/?whr=default" target="_blank" rel="noopener noreferrer" className="underline font-semibold text-blue-400">portal.azure.com/?whr=default</a>.</li>
                                    </ul>
                                </div>
                            </div>

                            <hr className="border-slate-800" />

                            <div className="space-y-2">
                                <h4 className="font-bold text-white flex items-center gap-2 text-xs uppercase tracking-wider text-blue-400">
                                    Step 2: Create a Speech Resource
                                </h4>
                                <ul className="list-disc pl-5 space-y-1.5">
                                    <li>In the top search bar, type <strong>Speech Services</strong> (or <strong>Cognitive Services Speech</strong>) and select it.</li>
                                    <li>Click the <strong>+ Create</strong> button.</li>
                                    <li>Select your Subscription and create a new Resource Group (e.g. <code>broadcasthub-rg</code>).</li>
                                    <li>Choose a Region close to you (e.g. <code>East US</code> or <code>Central India</code>).</li>
                                    <li>Give it a unique Name (e.g. <code>church-speech-service</code>).</li>
                                    <li>For Pricing Tier, select <strong>Free (F0)</strong> to get your **5 free audio hours** every month. *(If F0 is not visible, choose Standard S0)*.</li>
                                    <li>Click <strong>Review + Create</strong>, and then <strong>Create</strong>.</li>
                                </ul>
                            </div>

                            <hr className="border-slate-800" />

                            <div className="space-y-2">
                                <h4 className="font-bold text-white flex items-center gap-2 text-xs uppercase tracking-wider text-blue-400">
                                    Step 3: Retrieve Keys and Location
                                </h4>
                                <ul className="list-disc pl-5 space-y-1.5">
                                    <li>Once deployment is complete, click <strong>Go to resource</strong>.</li>
                                    <li>In the left sidebar menu, look under <em>Resource Management</em> and click <strong>Keys and Endpoint</strong>.</li>
                                    <li>Copy the value of <strong>KEY 1</strong>. This is your Speech Subscription API Key.</li>
                                    <li>Copy the value of <strong>Location/Region</strong> (e.g., <code>eastus</code>). This must match the region selected in the app dropdown.</li>
                                </ul>
                            </div>

                            <hr className="border-slate-800" />

                            <div className="space-y-2">
                                <h4 className="font-bold text-white flex items-center gap-2 text-xs uppercase tracking-wider text-blue-400">
                                    Step 4: Configure the App
                                </h4>
                                <p>Click the <strong>Gear Icon</strong> in the Live Translation panel to open settings. Paste your Key 1 into the <strong>Key</strong> field and select your matching <strong>Region</strong>. The credentials will be saved in your browser locally.</p>
                            </div>
                        </div>

                        {/* Modal Footer */}
                        <div className="p-4 bg-slate-950/40 border-t border-slate-800 text-center shrink-0">
                            <button 
                                onClick={() => setShowHelpModal(false)}
                                className="bg-blue-600 hover:bg-blue-500 text-white font-semibold px-6 py-2 rounded-xl text-xs transition active:scale-95"
                            >
                                Got It!
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
