import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    ArrowDown,
    ArrowUp,
    Check,
    ChevronLeft,
    ChevronRight,
    ChevronsLeft,
    ChevronsRight,
    GripVertical,
    Pencil,
    Play,
    Search,
    Square,
    Trash2,
    Upload,
    X
} from 'lucide-react';
import { deferUntilIdle, readLocalStorageArraySafe, useDebouncedLocalStorageEffect } from '../utils/performance';
import { EMPTY_PRESENTATION, getDeckType, normalizeCanvaUrl, parseSourceUrl, slideImageUrl } from '../utils/presentation';
import { deleteDeckImages, getDeckImages, putDeckImages } from '../utils/deckStore';

const LIBRARY_KEY = 'bc_pres_library_v1';

export default function PresentationPanel({ socket, isActive }) {
    const [urlInput, setUrlInput] = useState('');
    const [totalInput, setTotalInput] = useState('20');
    const [status, setStatus] = useState('No presentation loaded');
    const [isProcessing, setIsProcessing] = useState(false);
    const [stagingImages, setStagingImages] = useState([]);
    const [isStaging, setIsStaging] = useState(false);
    const [selectedStagedIdx, setSelectedStagedIdx] = useState(0);
    const [library, setLibrary] = useState([]);
    const [libraryQuery, setLibraryQuery] = useState('');
    const [newName, setNewName] = useState('');
    const [isSaving, setIsSaving] = useState(false);
    const [saveSource, setSaveSource] = useState('url');
    const [saveWarning, setSaveWarning] = useState('');
    const [renamingId, setRenamingId] = useState(null);
    const [renameValue, setRenameValue] = useState('');
    const [jumpInput, setJumpInput] = useState('');
    const [presState, setPresState] = useState(EMPTY_PRESENTATION);

    const fileInputRef = useRef(null);

    // Slide images live in IndexedDB (see utils/deckStore); localStorage holds metadata only.
    // Any library saved by an older build still has its images inline, so move them across on
    // load and drop them from the localStorage copy.
    useEffect(() => deferUntilIdle(() => {
        const saved = readLocalStorageArraySafe(LIBRARY_KEY);
        setLibrary(saved);

        const inline = saved.filter(item => Array.isArray(item.images) && item.images.length);
        if (inline.length === 0) return;

        Promise.all(inline.map(item =>
            putDeckImages(item.id, { images: item.images, thumbs: item.thumbs || [] })
        ))
            .then(() => {
                setLibrary(current => current.map(({ images: _i, thumbs: _t, ...rest }) => rest));
            })
            .catch(err => console.error('Could not migrate saved decks to the deck store:', err));
    }), []);

    useDebouncedLocalStorageEffect(LIBRARY_KEY, library);

    // Publish the saved-deck library so remotes (e.g. the slides remote) can list it.
    // Image decks carry their full slide images locally/in localStorage, but those are
    // stripped here — broadcasting them to every connected phone on each save/reconnect
    // would ship megabytes of base64 over the socket just to render a library row.
    useEffect(() => {
        if (!socket) return;
        const publish = () => {
            const lightweight = library.map(({ images: _images, ...rest }) => rest);
            socket.emit('pres_library_update', lightweight);
        };
        publish();
        socket.on('connect', publish);
        return () => socket.off('connect', publish);
    }, [socket, library]);

    const saveLibrary = (newLib) => {
        setLibrary(newLib);
    };

    const persistLibrarySafe = (newLib) => {
        try {
            localStorage.setItem(LIBRARY_KEY, JSON.stringify(newLib));
            return true;
        } catch (err) {
            console.error('Failed to persist presentation library:', err);
            return false;
        }
    };

    // Emits a *deck change* (new source, cleared, staged deck committed). Navigation
    // and show/hide go through pres_goto/pres_set_showing instead — see `navigate`,
    // `jumpToSlide`, `handleGoLive`/`handleTakeDown` below — so `pres_update` only
    // fires when the deck itself changes. That distinction is what lets the server
    // hand out a stable deck id and strip images from the payload sent to remotes.
    const emitState = useCallback((newState) => {
        if (!socket) return;
        socket.emit('pres_update', newState);
    }, [socket]);

    const handleLoadUrlWithData = useCallback((url, total) => {
        const parsed = parseSourceUrl(url, total);
        if (!parsed) return;
        if (parsed.error) {
            setStatus(parsed.error);
            alert(parsed.error);
            return;
        }
        setIsStaging(false);
        setStagingImages([]);
        setSelectedStagedIdx(0);
        setJumpInput('1');
        setStatus(parsed.status);
        setPresState(parsed.state);
        emitState(parsed.state);
    }, [emitState]);

    const handleLoadUrl = () => handleLoadUrlWithData(urlInput, totalInput);

    const addToLibrary = () => {
        const url = urlInput.trim();
        if (!url) {
            alert('Please paste a URL first.');
            return;
        }
        setSaveWarning('');
        setSaveSource('url');
        setIsSaving(true);
        setNewName('');
    };

    const addStagedToLibrary = () => {
        if (!stagingImages.length) return;
        setSaveWarning('');
        setSaveSource('images');
        setIsSaving(true);
        setNewName('');
    };

    const confirmSave = async () => {
        const name = newName.trim();
        if (!name) return;

        if (saveSource === 'images') {
            if (!stagingImages.length) return;
            const duplicate = library.find(item => item.name?.trim().toLowerCase() === name.toLowerCase());
            if (duplicate) {
                setSaveWarning(`Already saved as "${duplicate.name}".`);
                return;
            }

            const id = Math.random().toString(36).slice(2, 11);
            // Images go to IndexedDB; only metadata is kept in localStorage, which is what
            // keeps a large deck from blowing the ~5MB quota and silently disappearing.
            try {
                await putDeckImages(id, {
                    images: stagingImages.map(img => img.src),
                    thumbs: stagingImages.map(img => img.thumb || img.src)
                });
            } catch (err) {
                console.error('Failed to store deck slides:', err);
                setSaveWarning('Could not save the slides for this deck. Try again, or save fewer slides.');
                return;
            }

            const newItem = {
                id,
                name,
                type: 'Image Deck',
                mode: 'images',
                totalSlides: stagingImages.length
            };
            const newLib = [...library, newItem];
            if (!persistLibrarySafe(newLib)) {
                await deleteDeckImages(id);
                setSaveWarning('Storage is full — delete an old saved presentation or save fewer slides.');
                return;
            }
            saveLibrary(newLib);
            setIsSaving(false);
            setNewName('');
            setSaveWarning('');
            return;
        }

        const url = urlInput.trim();
        if (!url) return;

        const normalizedUrl = url.includes('canva.com') ? normalizeCanvaUrl(url) : url;
        const duplicate = library.find(item => (
            item.name?.trim().toLowerCase() === name.toLowerCase() ||
            item.url?.trim() === normalizedUrl ||
            item.url?.trim() === url
        ));

        if (duplicate) {
            setSaveWarning(`Already saved as "${duplicate.name}".`);
            return;
        }

        const newItem = {
            id: Math.random().toString(36).slice(2, 11),
            name,
            url: normalizedUrl,
            totalSlides: totalInput,
            type: getDeckType(normalizedUrl)
        };
        const newLib = [...library, newItem];
        if (!persistLibrarySafe(newLib)) {
            setSaveWarning('Storage is full — delete an old saved presentation and try again.');
            return;
        }
        saveLibrary(newLib);
        setIsSaving(false);
        setNewName('');
        setSaveWarning('');
    };

    const cancelSave = () => {
        setIsSaving(false);
        setNewName('');
        setSaveWarning('');
    };

    const removeFromLibrary = (id) => {
        if (!confirm('Are you sure you want to delete this presentation?')) return;
        saveLibrary(library.filter(item => item.id !== id));
        // Drop the slides too, or they stay in IndexedDB forever with nothing referencing them.
        deleteDeckImages(id);
    };

    const renameLibraryItem = (id) => {
        const item = library.find(i => i.id === id);
        if (!item) return;
        setRenamingId(id);
        setRenameValue(item.name);
    };

    const confirmRename = () => {
        const nextName = renameValue.trim();
        if (!nextName) return;
        saveLibrary(library.map(i => i.id === renamingId ? { ...i, name: nextName } : i));
        setRenamingId(null);
        setRenameValue('');
    };

    const cancelRename = () => {
        setRenamingId(null);
        setRenameValue('');
    };

    const loadFromLibrary = async (item) => {
        if (item.mode === 'images' || item.type === 'Image Deck') {
            setIsStaging(false);
            setStagingImages([]);
            setSelectedStagedIdx(0);
            setJumpInput('1');
            setStatus('Loading deck…');

            // `item.images` is only present for a deck that hasn't been migrated out of
            // localStorage yet; otherwise the slides come from the deck store.
            const stored = item.images?.length
                ? { images: item.images, thumbs: item.thumbs || [] }
                : await getDeckImages(item.id);

            if (!stored.images.length) {
                setStatus('That deck has no saved slides. Re-import the PDF or images.');
                return;
            }

            const nextState = {
                ...EMPTY_PRESENTATION,
                images: stored.images,
                // Decks saved before thumbnails existed have no `thumbs` — the slide
                // endpoint already falls back to the full image when one is missing.
                thumbs: stored.thumbs,
                mode: 'images',
                currentIdx: 0,
                totalSlides: stored.images.length
            };
            setStatus(`Image deck loaded (${nextState.totalSlides} slides) from library. Preview is ready.`);
            setPresState(nextState);
            emitState(nextState);
            return;
        }

        const url = item.url?.includes('canva.com') ? normalizeCanvaUrl(item.url) : item.url;
        setUrlInput(url || '');
        setTotalInput(String(item.totalSlides || '20'));
        handleLoadUrlWithData(url || '', item.totalSlides);
    };

    const filteredLibrary = useMemo(() => {
        const query = libraryQuery.trim().toLowerCase();
        if (!query) return library;
        return library.filter(item => (
            item.name?.toLowerCase().includes(query) ||
            item.url?.toLowerCase().includes(query) ||
            getDeckType(item).toLowerCase().includes(query)
        ));
    }, [library, libraryQuery]);

    // pdf.js is bundled, not fetched from a CDN at runtime. The old loader injected a <script>
    // from cdnjs with no integrity check, which is arbitrary code execution in an Electron
    // renderer if that CDN is ever compromised — and it made PDF import fail outright on a
    // venue rig with no internet, which is the normal state for an isolated broadcast LAN.
    // Loaded lazily so the ~1MB renderer stays out of the initial control-window bundle.
    const pdfjsPromiseRef = useRef(null);
    const loadPdfJs = () => {
        if (!pdfjsPromiseRef.current) {
            pdfjsPromiseRef.current = import('pdfjs-dist').then((pdfjsLib) => {
                pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
                    'pdfjs-dist/build/pdf.worker.min.mjs',
                    import.meta.url
                ).toString();
                return pdfjsLib;
            }).catch((err) => {
                pdfjsPromiseRef.current = null;
                throw err;
            });
        }
        return pdfjsPromiseRef.current;
    };

    const resetFileInput = () => {
        if (fileInputRef.current) fileInputRef.current.value = '';
    };

    const THUMB_MAX_WIDTH = 320;

    // Downscaled JPEG for the "All Slides" grid on the remote, generated once at
    // ingest so a 40-slide deck doesn't mean pulling ~12MB of full-resolution
    // slides just to render ~120px tiles. Reuses the canvas already produced by
    // PDF rendering below; sharp/jimp aren't dependencies of this project and
    // pulling one in for a background-thumbnail pass isn't worth the native-module
    // build story it drags along (see rebuild:ndi:* in package.json).
    const canvasThumbnail = (sourceCanvas, maxWidth = THUMB_MAX_WIDTH) => {
        if (sourceCanvas.width <= maxWidth) return sourceCanvas.toDataURL('image/jpeg', 0.7);
        const scale = maxWidth / sourceCanvas.width;
        const thumbCanvas = document.createElement('canvas');
        thumbCanvas.width = maxWidth;
        thumbCanvas.height = Math.round(sourceCanvas.height * scale);
        thumbCanvas.getContext('2d').drawImage(sourceCanvas, 0, 0, thumbCanvas.width, thumbCanvas.height);
        return thumbCanvas.toDataURL('image/jpeg', 0.6);
    };

    // Same idea for uploaded images, which only exist as a data URL (no canvas yet)
    // until this decodes one to draw the scaled-down version.
    const imageThumbnail = (dataUrl, maxWidth = THUMB_MAX_WIDTH) => new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            try {
                resolve(canvasThumbnail(imageToCanvas(img), maxWidth));
            } catch {
                resolve(dataUrl); // last resort: never smaller a fallback than the source itself
            }
        };
        img.onerror = () => resolve(dataUrl);
        img.src = dataUrl;
    });

    const imageToCanvas = (img) => {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth || img.width;
        canvas.height = img.naturalHeight || img.height;
        canvas.getContext('2d').drawImage(img, 0, 0);
        return canvas;
    };

    const handleFileUpload = async (e) => {
        const files = Array.from(e.target.files || []);
        if (!files.length) return;

        setStatus('Processing local slides...');
        setIsProcessing(true);
        setIsStaging(false);
        setStagingImages([]);
        setSelectedStagedIdx(0);

        const file = files[0];
        const ext = file.name.split('.').pop().toLowerCase();

        if (ext === 'pdf') {
            try {
                setStatus('Loading PDF renderer...');
                const pdfjsLib = await loadPdfJs();

                const buffer = await file.arrayBuffer();
                const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise;
                const newStaging = [];

                for (let i = 1; i <= pdf.numPages; i++) {
                    const page = await pdf.getPage(i);
                    const viewport = page.getViewport({ scale: 1.5 });
                    const canvas = document.createElement('canvas');
                    const context = canvas.getContext('2d');
                    canvas.height = viewport.height;
                    canvas.width = viewport.width;
                    await page.render({ canvasContext: context, viewport }).promise;
                    newStaging.push({
                        id: Math.random().toString(36).slice(2),
                        src: canvas.toDataURL('image/jpeg', 0.82),
                        thumb: canvasThumbnail(canvas),
                        name: `${file.name} page ${i}`
                    });
                    setStatus(`Rendering PDF page ${i}/${pdf.numPages}...`);
                }

                if (!newStaging.length) {
                    setStatus('PDF did not contain renderable pages.');
                    return;
                }

                setStatus(`PDF staged (${pdf.numPages} pages). Arrange, then preview loaded.`);
                setStagingImages(newStaging);
                setIsStaging(true);
            } catch (err) {
                console.error(err);
                setStatus('Error parsing PDF. Check the file and try again.');
                alert('Error parsing PDF. Check the file and try again.');
                resetFileInput();
            } finally {
                setIsProcessing(false);
            }
            return;
        }

        try {
            const imageFiles = files.filter(f => f.type.startsWith('image/'));
            if (!imageFiles.length) {
                setStatus('Unsupported file type. Upload a PDF or images.');
                alert('Unsupported file type. Upload a PDF or images.');
                resetFileInput();
                return;
            }

            const loaded = await Promise.all(imageFiles.map(fileToRead => new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = async (evt) => {
                    const src = evt.target.result;
                    resolve({
                        id: Math.random().toString(36).slice(2),
                        src,
                        thumb: await imageThumbnail(src),
                        name: fileToRead.name
                    });
                };
                reader.onerror = reject;
                reader.readAsDataURL(fileToRead);
            })));

            loaded.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
            setStatus(`Images staged (${loaded.length}). Arrange, then preview loaded.`);
            setStagingImages(loaded);
            setIsStaging(true);
        } catch (err) {
            console.error(err);
            setStatus('Error loading images. Check the files and try again.');
            alert('Error loading images. Check the files and try again.');
            resetFileInput();
        } finally {
            setIsProcessing(false);
        }
    };

    const commitStagedImages = () => {
        if (!stagingImages.length) {
            setStatus('No staged slides to preview.');
            return;
        }

        const srcs = stagingImages.map(img => img.src);
        const nextState = {
            ...EMPTY_PRESENTATION,
            images: srcs,
            thumbs: stagingImages.map(img => img.thumb || img.src),
            mode: 'images',
            currentIdx: 0,
            totalSlides: srcs.length
        };
        setPresState(nextState);
        emitState(nextState);
        setJumpInput('1');
        setIsStaging(false);
        setStagingImages([]);
        setSelectedStagedIdx(0);
        setStatus(`Image deck loaded (${srcs.length} slides). Preview is ready.`);
    };

    const moveStagedImage = (idx, direction) => {
        const targetIdx = idx + direction;
        if (targetIdx < 0 || targetIdx >= stagingImages.length) return;
        const newImages = [...stagingImages];
        const [item] = newImages.splice(idx, 1);
        newImages.splice(targetIdx, 0, item);
        setStagingImages(newImages);
        setSelectedStagedIdx(targetIdx);
    };

    const removeStagedImage = (idx) => {
        const newImages = stagingImages.filter((_, itemIdx) => itemIdx !== idx);
        setStagingImages(newImages);
        setSelectedStagedIdx(Math.max(0, Math.min(idx, newImages.length - 1)));
        if (!newImages.length) setStatus('All staged slides removed.');
    };

    const handleDragStart = (e, idx) => {
        e.dataTransfer.setData('text/plain', String(idx));
        e.dataTransfer.effectAllowed = 'move';
    };

    const handleDrop = (e, targetIdx) => {
        e.preventDefault();
        const sourceIdx = parseInt(e.dataTransfer.getData('text/plain'), 10);
        if (Number.isNaN(sourceIdx) || sourceIdx === targetIdx) return;

        const newImages = [...stagingImages];
        const [draggedItem] = newImages.splice(sourceIdx, 1);
        newImages.splice(targetIdx, 0, draggedItem);
        setStagingImages(newImages);
        setSelectedStagedIdx(targetIdx);
    };

    const handleDragOver = (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
    };

    const cancelStaging = () => {
        setIsStaging(false);
        setStagingImages([]);
        setSelectedStagedIdx(0);
        setStatus('Cancelled staging.');
        resetFileInput();
    };

    // Navigation is server-authoritative: emit an absolute index via pres_goto and
    // let the pres_update echo (below) reconcile state, same as the slides remote.
    // The local setPresState here is purely optimistic, for zero-latency button feel.
    const navigate = useCallback((direction) => {
        if (!socket) return;
        setPresState(prev => {
            if (prev.totalSlides === 0) return prev;
            let newIdx = prev.currentIdx;

            if (direction === 'next') newIdx += 1;
            else if (direction === 'prev') newIdx -= 1;
            else if (direction === 'first') newIdx = 0;
            else if (direction === 'last') newIdx = prev.totalSlides - 1;
            else return prev;

            newIdx = Math.max(0, Math.min(newIdx, prev.totalSlides - 1));
            if (newIdx === prev.currentIdx) return prev;

            socket.emit('pres_goto', { index: newIdx });
            setJumpInput(String(newIdx + 1));
            return { ...prev, currentIdx: newIdx };
        });
    }, [socket]);

    const jumpToSlide = () => {
        if (!socket) return;
        const target = parseInt(jumpInput, 10);
        if (!Number.isFinite(target) || !presState.totalSlides) return;
        const targetIdx = Math.max(0, Math.min(target - 1, presState.totalSlides - 1));
        setPresState(prev => ({ ...prev, currentIdx: targetIdx }));
        socket.emit('pres_goto', { index: targetIdx });
        setJumpInput(String(targetIdx + 1));
    };

    // pres_nav (from the graphics window's own keyboard handler) is now applied
    // server-side and comes back through the pres_update listener below, same as
    // any other client's navigation — no local listener needed.

    useEffect(() => {
        if (!socket) return;

        const handlePresentationUpdate = (state) => {
            if (!state) return;
            setPresState({ ...EMPTY_PRESENTATION, ...state });
            setJumpInput(state.mode !== 'none' && state.totalSlides > 0 ? String((state.currentIdx || 0) + 1) : '');
            if (state.mode === 'none') {
                setStatus('Presentation stopped and cleared.');
            } else if (state.showing) {
                setStatus('Presentation is live on graphics output.');
            }
        };

        socket.on('pres_update', handlePresentationUpdate);
        return () => socket.off('pres_update', handlePresentationUpdate);
    }, [socket]);

    useEffect(() => {
        const handleKeyDown = (e) => {
            if (!isActive) return;
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

            if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.code === 'Space') {
                e.preventDefault();
                navigate('next');
            } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
                e.preventDefault();
                navigate('prev');
            } else if (e.key === 'Home') {
                e.preventDefault();
                navigate('first');
            } else if (e.key === 'End') {
                e.preventDefault();
                navigate('last');
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isActive, navigate]);

    const handleGoLive = () => {
        if (!presState.totalSlides || !socket) return;
        setPresState(prev => ({ ...prev, showing: true }));
        socket.emit('pres_set_showing', true);
        setStatus('Presentation is live on graphics output.');
    };

    const handleTakeDown = () => {
        if (!socket) return;
        setPresState(prev => ({ ...prev, showing: false }));
        socket.emit('pres_set_showing', false);
        setStatus('Presentation taken down. Deck remains loaded.');
    };

    const handleStop = () => {
        setPresState(EMPTY_PRESENTATION);
        emitState(EMPTY_PRESENTATION);
        setJumpInput('');
        setStatus('Presentation stopped and cleared.');
        resetFileInput();
    };

    const hasSlides = presState.mode !== 'none' && presState.totalSlides > 0;
    const isLive = hasSlides && presState.showing;
    const deckType = presState.mode === 'images' ? 'Image Deck' : presState.isCanva ? 'Canva' : presState.mode === 'url' ? 'Google Slides' : 'None';

    const getIframeSrc = (offset) => {
        if (presState.mode !== 'url' || !hasSlides) return '';
        if (presState.isCanva) return offset === 0 ? presState.baseUrl : '';
        const targetIdx = presState.currentIdx + offset;
        if (targetIdx < 0 || targetIdx >= presState.totalSlides) return '';
        return presState.baseUrl + (targetIdx + 1);
    };

    // Prefers the cacheable HTTP endpoint over the inline images array. This is
    // required, not just a nicety: this panel also renders on /remote, where the
    // server now sends a stripped `images: []` (see the room split in server.js),
    // so falling back to `presState.images` there would leave every preview
    // blank. On the desktop it's a bonus — one fewer multi-MB base64 decode.
    const getImageSrc = (offset) => {
        if (presState.mode !== 'images' || !hasSlides) return '';
        const targetIdx = presState.currentIdx + offset;
        if (targetIdx < 0 || targetIdx >= presState.totalSlides) return '';
        if (presState.deckId) return slideImageUrl(targetIdx, presState.deckId);
        return presState.images[targetIdx] || '';
    };

    const renderPreview = (offset, label, isPrimary = false) => {
        const imageSrc = getImageSrc(offset);
        const iframeSrc = getIframeSrc(offset);
        const unavailable = !hasSlides || (offset !== 0 && presState.isCanva) || (presState.currentIdx + offset < 0) || (presState.currentIdx + offset >= presState.totalSlides);

        return (
            <div className="space-y-2">
                <span className="text-[10px] font-bold text-slate-500 dark:text-slate-500 uppercase tracking-widest">{label}</span>
                <div className={`aspect-video bg-black rounded-lg overflow-hidden relative ${isPrimary ? 'border-2 border-emerald-500' : 'border border-slate-300 dark:border-slate-700'}`}>
                    {presState.mode === 'images' && imageSrc && <img src={imageSrc} alt={label} decoding="async" className="w-full h-full object-contain" />}
                    {presState.mode === 'url' && iframeSrc && <iframe src={iframeSrc} className="absolute top-0 left-0 w-[1000%] h-[1000%] origin-top-left scale-[0.1] pointer-events-none border-none" title={label}></iframe>}
                    {unavailable && (
                        <div className="absolute inset-0 flex items-center justify-center text-slate-700 dark:text-slate-600 text-[10px] uppercase font-bold tracking-widest">
                            {hasSlides ? 'End' : 'No Signal'}
                        </div>
                    )}
                </div>
            </div>
        );
    };

    return (
        <div className="space-y-4 block">
            <div className="grid grid-cols-1 2xl:grid-cols-[minmax(320px,0.95fr)_minmax(420px,1.35fr)_minmax(280px,0.8fr)] gap-4 items-start">
                <section className="space-y-4">
                    <h4 className="text-md font-medium text-slate-800 dark:text-slate-200">Source</h4>
                    <div className="surface space-y-3 rounded-lg p-3">
                        <div className="space-y-1.5">
                            <div className="flex justify-between items-end gap-3">
                                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300">Google Slides / Canva URL</label>
                                <span className="text-[10px] text-slate-400 italic text-right">Canva links must be viewable by anyone with the link</span>
                            </div>
                            <div className="flex flex-col sm:flex-row gap-2">
                                <input
                                    type="text"
                                    value={urlInput}
                                    onChange={e => setUrlInput(e.target.value)}
                                    placeholder="Paste URL or iframe code..."
                                    className="control-field flex-1 px-4 py-2"
                                />
                                <button onClick={handleLoadUrl} disabled={isProcessing} className="bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded-lg font-medium transition active:scale-95 disabled:opacity-40">
                                    Preview Loaded
                                </button>
                                <button onClick={addToLibrary} disabled={isProcessing} className="control-button-muted px-4 py-2 font-medium active:scale-95 disabled:opacity-40" title="Save to Library">
                                    Save
                                </button>
                            </div>
                        </div>

                        {isSaving && saveSource === 'url' && (
                            <div className="space-y-2 border-b section-rule pb-3 pt-2">
                                <label className="block text-[10px] font-bold text-indigo-400 uppercase tracking-widest">Name your presentation</label>
                                <div className="flex gap-2">
                                    <input
                                        type="text"
                                        autoFocus
                                        value={newName}
                                        onChange={e => {
                                            setNewName(e.target.value);
                                            setSaveWarning('');
                                        }}
                                        placeholder="e.g. Morning Service Deck"
                                        className="control-field flex-1 border-indigo-500/50 px-3 py-1.5 text-sm focus:ring-1 focus:ring-indigo-500"
                                        onKeyDown={e => {
                                            if (e.key === 'Enter') confirmSave();
                                            if (e.key === 'Escape') cancelSave();
                                        }}
                                    />
                                    <button onClick={confirmSave} className="bg-indigo-600 hover:bg-indigo-500 text-white px-3 py-1.5 rounded-lg text-xs font-bold transition" title="Confirm save">
                                        <Check size={15} />
                                    </button>
                                    <button onClick={cancelSave} className="text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 px-2 transition" title="Cancel save">
                                        <X size={15} />
                                    </button>
                                </div>
                                {saveWarning && <div className="text-[10px] text-amber-500 font-medium">{saveWarning}</div>}
                            </div>
                        )}

                        <div className="pt-2 space-y-2">
                            <div className="flex items-center justify-between gap-2">
                                <h5 className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Presentation Library</h5>
                                <div className="relative w-36">
                                    <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" />
                                    <input
                                        type="search"
                                        value={libraryQuery}
                                        onChange={e => setLibraryQuery(e.target.value)}
                                        placeholder="Search"
                                        className="control-field w-full rounded-md py-1 pl-7 pr-2 text-[11px] focus:ring-1 focus:ring-indigo-500"
                                    />
                                </div>
                            </div>
                            {library.length > 0 ? (
                                <div className="grid grid-cols-1 gap-2 max-h-52 overflow-y-auto pr-1">
                                    {filteredLibrary.map((item) => (
                                        <div key={item.id} className="surface-muted group flex items-center justify-between gap-2 rounded-lg p-2 transition hover:border-indigo-500/50">
                                            {renamingId === item.id ? (
                                                <div className="flex-1 flex items-center gap-2">
                                                    <input
                                                        type="text"
                                                        autoFocus
                                                        value={renameValue}
                                                        onChange={e => setRenameValue(e.target.value)}
                                                        className="control-field flex-1 border-indigo-500 px-2 py-1 text-xs"
                                                        onKeyDown={e => {
                                                            if (e.key === 'Enter') confirmRename();
                                                            if (e.key === 'Escape') cancelRename();
                                                        }}
                                                    />
                                                    <button onClick={confirmRename} className="p-1 text-indigo-500 hover:bg-indigo-500/10 rounded" title="Done"><Check size={14} /></button>
                                                    <button onClick={cancelRename} className="p-1 text-slate-500 hover:bg-slate-500/10 rounded" title="Cancel"><X size={14} /></button>
                                                </div>
                                            ) : (
                                                <>
                                                    <button className="flex-1 min-w-0 text-left" onClick={() => loadFromLibrary(item)} title="Load presentation">
                                                        <div className="text-xs font-semibold text-slate-800 dark:text-slate-200 truncate">{item.name}</div>
                                                        <div className="text-[10px] text-slate-500 truncate">{getDeckType(item)} · {item.totalSlides || 1} slide{Number(item.totalSlides) === 1 ? '' : 's'}</div>
                                                    </button>
                                                    <div className="flex items-center gap-1 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition">
                                                        <button onClick={() => renameLibraryItem(item.id)} className="p-1 hover:bg-slate-200 dark:hover:bg-slate-700 rounded text-slate-500 dark:text-slate-300" title="Rename">
                                                            <Pencil size={14} />
                                                        </button>
                                                        <button onClick={() => removeFromLibrary(item.id)} className="p-1 hover:bg-red-500/20 rounded text-red-500" title="Delete">
                                                            <Trash2 size={14} />
                                                        </button>
                                                    </div>
                                                </>
                                            )}
                                        </div>
                                    ))}
                                    {filteredLibrary.length === 0 && <div className="text-[10px] text-slate-400 italic py-2 px-1">No saved presentations match the search.</div>}
                                </div>
                            ) : (
                                <div className="text-[10px] text-slate-400 italic py-2 px-1">No saved presentations. Paste a URL and save it here.</div>
                            )}
                        </div>

                        <div className="flex items-center justify-center py-1">
                            <span className="text-slate-600 text-[10px] font-bold uppercase tracking-[0.2em]">OR</span>
                        </div>

                        <div className="space-y-1.5">
                            <div className="flex justify-between items-center gap-3">
                                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300">Local PDF / Images</label>
                                <span className="text-[9px] text-slate-500 uppercase font-bold tracking-widest text-right">PDF pages or multiple images</span>
                            </div>
                            <input
                                type="file"
                                ref={fileInputRef}
                                accept=".pdf,image/*"
                                multiple
                                onChange={handleFileUpload}
                                disabled={isProcessing}
                                className="control-field block w-full cursor-pointer p-1 text-sm file:mr-4 file:rounded-lg file:border-0 file:bg-blue-600 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-white hover:file:bg-blue-700 disabled:opacity-50"
                            />
                        </div>

                        <div className="pt-2 flex items-center justify-between gap-3">
                            <div className="space-y-1">
                                <label className="block text-[10px] font-bold text-slate-500 uppercase">URL Slide Count</label>
                                <input
                                    type="number"
                                    min="1"
                                    value={totalInput}
                                    onChange={e => setTotalInput(e.target.value)}
                                    className="control-field w-24 rounded px-2 py-1 text-xs"
                                />
                            </div>
                            <div className="text-xs text-slate-500 dark:text-slate-500 italic text-right">{status}</div>
                        </div>
                    </div>
                </section>

                <section className="space-y-4">
                    <div className="flex items-center justify-between">
                        <h4 className="text-md font-medium text-slate-800 dark:text-slate-200">Preview</h4>
                        <div className={`px-2 py-1 rounded-md text-[10px] font-bold uppercase tracking-widest ${isLive ? 'bg-emerald-500/15 text-emerald-500' : hasSlides ? 'bg-amber-500/15 text-amber-500' : 'bg-slate-500/15 text-slate-500'}`}>
                            {isLive ? 'On Air' : hasSlides ? 'Loaded' : 'Empty'}
                        </div>
                    </div>
                    <div className="surface space-y-3 rounded-lg p-3">
                        <div className="flex items-start justify-between gap-3">
                            <div>
                                <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">{deckType}</div>
                                <div className="text-2xl font-bold text-slate-900 dark:text-white">
                                    {hasSlides ? `Slide ${presState.currentIdx + 1}` : 'No Deck'}
                                    <span className="text-slate-400 dark:text-slate-600"> / {presState.totalSlides}</span>
                                </div>
                            </div>
                            <div className="flex items-center gap-2">
                                <input
                                    type="number"
                                    min="1"
                                    max={presState.totalSlides || 1}
                                    value={jumpInput}
                                    onChange={e => setJumpInput(e.target.value)}
                                    onKeyDown={e => e.key === 'Enter' && jumpToSlide()}
                                    disabled={!hasSlides}
                                    className="control-field w-20 px-3 py-2 text-sm disabled:opacity-40"
                                    title="Jump to slide"
                                />
                                <button onClick={jumpToSlide} disabled={!hasSlides} className="control-button-muted px-3 py-2 text-xs font-bold disabled:opacity-30">
                                    Jump
                                </button>
                            </div>
                        </div>
                        {renderPreview(0, isLive ? 'Live Slide' : 'Loaded Preview', true)}
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            {renderPreview(-1, 'Previous')}
                            {renderPreview(1, 'Next')}
                        </div>
                    </div>
                </section>

                <section className="space-y-4">
                    <h4 className="text-md font-medium text-slate-800 dark:text-slate-200">Live Controls</h4>
                    <div className="surface space-y-3 rounded-lg p-3">
                        <div className="grid grid-cols-2 gap-2">
                            <button onClick={handleGoLive} disabled={!hasSlides || isLive} className="bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-3 rounded-lg font-bold transition active:scale-95 disabled:opacity-30 flex items-center justify-center gap-2">
                                <Play size={16} /> Go Live
                            </button>
                            <button onClick={handleTakeDown} disabled={!hasSlides || !isLive} className="control-button-muted flex items-center justify-center gap-2 px-4 py-3 font-bold active:scale-95 disabled:opacity-30">
                                <Square size={15} /> Take Down
                            </button>
                        </div>

                        <div className="grid grid-cols-4 gap-2">
                            <button onClick={() => navigate('first')} disabled={!hasSlides || presState.currentIdx === 0} className="control-button-muted p-3 active:scale-95 disabled:opacity-30" title="First slide">
                                <ChevronsLeft size={18} className="mx-auto" />
                            </button>
                            <button onClick={() => navigate('prev')} disabled={!hasSlides || presState.currentIdx === 0} className="control-button-muted p-3 active:scale-95 disabled:opacity-30" title="Previous slide">
                                <ChevronLeft size={18} className="mx-auto" />
                            </button>
                            <button onClick={() => navigate('next')} disabled={!hasSlides || presState.currentIdx >= presState.totalSlides - 1} className="bg-indigo-600 hover:bg-indigo-500 text-white p-3 rounded-lg transition disabled:opacity-30 shadow-lg shadow-indigo-600/20 active:scale-95" title="Next slide">
                                <ChevronRight size={18} className="mx-auto" />
                            </button>
                            <button onClick={() => navigate('last')} disabled={!hasSlides || presState.currentIdx >= presState.totalSlides - 1} className="control-button-muted p-3 active:scale-95 disabled:opacity-30" title="Last slide">
                                <ChevronsRight size={18} className="mx-auto" />
                            </button>
                        </div>

                        {presState.isCanva && (
                            <div className="p-3 bg-purple-500/10 border border-purple-500/20 rounded-lg">
                                <p className="text-[10px] text-purple-400 font-medium leading-relaxed">
                                    Canva is embedded as a single external viewer. For controller-driven slide navigation, export the Canva deck as images and upload them here.
                                </p>
                            </div>
                        )}

                        <button onClick={handleStop} disabled={!hasSlides && !isLive} className="w-full bg-red-600/10 hover:bg-red-600 text-red-600 hover:text-white border border-red-600/20 py-3 rounded-xl font-bold uppercase tracking-widest text-[10px] transition active:scale-95 disabled:opacity-30">
                            Stop Presentation
                        </button>
                    </div>
                </section>
            </div>

            {isStaging && (
                <section className="space-y-3 border-t section-rule pt-4">
                    <div className="flex flex-col sm:flex-row sm:justify-between sm:items-end gap-3">
                        <div>
                            <h4 className="text-md font-medium text-emerald-500">Arrange Slides</h4>
                            <p className="text-xs text-slate-500">Drag, reorder, remove, then load the arranged deck into preview.</p>
                        </div>
                        <div className="flex items-center gap-3">
                            <button onClick={cancelStaging} className="text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white text-sm font-medium transition">Cancel</button>
                            <button onClick={addStagedToLibrary} disabled={!stagingImages.length || isProcessing} className="control-button-muted px-4 py-2 font-medium active:scale-95 disabled:opacity-40" title="Save to Library">
                                Save
                            </button>
                            <button onClick={commitStagedImages} disabled={!stagingImages.length || isProcessing} className="bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-2 rounded-lg font-bold transition shadow-lg shadow-emerald-600/20 disabled:opacity-40 flex items-center gap-2">
                                <Upload size={16} /> Preview Loaded ({stagingImages.length})
                            </button>
                        </div>
                    </div>

                    {isSaving && saveSource === 'images' && (
                        <div className="surface space-y-2 rounded-lg p-3">
                            <label className="block text-[10px] font-bold text-indigo-400 uppercase tracking-widest">Name your presentation</label>
                            <div className="flex gap-2">
                                <input
                                    type="text"
                                    autoFocus
                                    value={newName}
                                    onChange={e => {
                                        setNewName(e.target.value);
                                        setSaveWarning('');
                                    }}
                                    placeholder="e.g. Morning Service Deck"
                                    className="control-field flex-1 border-indigo-500/50 px-3 py-1.5 text-sm focus:ring-1 focus:ring-indigo-500"
                                    onKeyDown={e => {
                                        if (e.key === 'Enter') confirmSave();
                                        if (e.key === 'Escape') cancelSave();
                                    }}
                                />
                                <button onClick={confirmSave} className="bg-indigo-600 hover:bg-indigo-500 text-white px-3 py-1.5 rounded-lg text-xs font-bold transition" title="Confirm save">
                                    <Check size={15} />
                                </button>
                                <button onClick={cancelSave} className="text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 px-2 transition" title="Cancel save">
                                    <X size={15} />
                                </button>
                            </div>
                            {saveWarning && <div className="text-[10px] text-amber-500 font-medium">{saveWarning}</div>}
                        </div>
                    )}

                    <div className="grid grid-cols-1 xl:grid-cols-[minmax(280px,0.85fr)_minmax(420px,1.4fr)] gap-4">
                        <div className="surface rounded-lg p-3">
                            <div className="aspect-video bg-black rounded-lg border-2 border-emerald-500 overflow-hidden relative">
                                {stagingImages[selectedStagedIdx]?.src ? (
                                    <img src={stagingImages[selectedStagedIdx].src} alt="Selected staged slide" className="w-full h-full object-contain" />
                                ) : (
                                    <div className="absolute inset-0 flex items-center justify-center text-slate-700 text-[10px] uppercase font-bold tracking-widest">No Slide</div>
                                )}
                            </div>
                            <div className="mt-2 text-xs text-slate-500 truncate">
                                Selected: slide {stagingImages.length ? selectedStagedIdx + 1 : 0} · {stagingImages[selectedStagedIdx]?.name || 'None'}
                            </div>
                        </div>

                        <div className="surface flex snap-x gap-3 overflow-x-auto rounded-lg p-3 pb-3">
                            {stagingImages.map((img, idx) => (
                                <div
                                    key={img.id}
                                    className="flex-none w-40 space-y-2 snap-center cursor-grab active:cursor-grabbing"
                                    draggable
                                    onClick={() => setSelectedStagedIdx(idx)}
                                    onDragStart={(e) => handleDragStart(e, idx)}
                                    onDrop={(e) => handleDrop(e, idx)}
                                    onDragOver={handleDragOver}
                                >
                                    <div className="text-[10px] font-bold text-slate-500 text-center flex items-center justify-center gap-1">
                                        <GripVertical size={12} className="text-slate-400" />
                                        <span>Slide {idx + 1}</span>
                                    </div>
                                    <div className={`aspect-video bg-black rounded-lg overflow-hidden relative group ${idx === selectedStagedIdx ? 'border-2 border-emerald-500' : 'border border-slate-300 dark:border-slate-700'}`}>
                                        <img src={img.src} alt={`Staged slide ${idx + 1}`} className="w-full h-full object-cover pointer-events-none" />
                                        <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition flex items-center justify-center gap-2">
                                            <button onClick={(e) => { e.stopPropagation(); moveStagedImage(idx, -1); }} disabled={idx === 0} className="bg-slate-700 hover:bg-slate-600 text-white p-2 rounded-full disabled:opacity-40" title="Move left">
                                                <ArrowUp size={14} />
                                            </button>
                                            <button onClick={(e) => { e.stopPropagation(); moveStagedImage(idx, 1); }} disabled={idx === stagingImages.length - 1} className="bg-slate-700 hover:bg-slate-600 text-white p-2 rounded-full disabled:opacity-40" title="Move right">
                                                <ArrowDown size={14} />
                                            </button>
                                            <button onClick={(e) => { e.stopPropagation(); removeStagedImage(idx); }} className="bg-red-600 hover:bg-red-500 text-white p-2 rounded-full" title="Remove slide">
                                                <Trash2 size={14} />
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                </section>
            )}
        </div>
    );
}
