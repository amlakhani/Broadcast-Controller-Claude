import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { AlertCircle, Library, Loader2, Music, PauseCircle, Play, RotateCcw, Save, Search, SkipBack, SkipForward, Trash2, XCircle } from 'lucide-react';
import { authUrl } from '../auth';
import { deferUntilIdle, readLocalStorageArraySafe, readLocalStorageObjectSafe, useDebouncedLocalStorageEffect } from '../utils/performance';
import { DEFAULT_GUJ_FONT, GUJ_FONT_OPTIONS } from '../utils/lyricsFonts';
import { parseAnirdeshText } from '../utils/anirdesh';
import { groupVersesIntoSlides, normalizeLinesPerSlide, remapSlideIndex, slideLabel } from '../utils/lyricsSlides';

const LIBRARY_KEY = 'bc_song_library_v1';
const CUE_MODE_KEY = 'bc_lyrics_cue_mode_v1';
const LYRICS_STYLE_KEY = 'bc_lyrics_style_v1';
const LINES_PER_SLIDE_KEY = 'bc_lyrics_lines_per_slide_v1';
const CUE_MODES = {
    FAST_TAKE: 'fastTake',
    SAFE_ARM: 'safeArm'
};

export default function LyricsPanel({ socket }) {
    // State
    const [anirdeshUrl, setAnirdeshUrl] = useState('');
    const [lyricEn, setLyricEn] = useState('');
    const [lyricGu, setLyricGu] = useState('');
    const [parsedVerses, setParsedVerses] = useState([]);
    const [songTitle, setSongTitle] = useState('');
    
    const [animStyle, setAnimStyle] = useState('fade');
    const [bgStyle, setBgStyle] = useState('default');
    const [langOpt, setLangOpt] = useState('both');
    const [autoClear, setAutoClear] = useState('');
    
    // Typography State
    const [fontFamily, setFontFamily] = useState("'Outfit', sans-serif");
    const [gujFontFamily, setGujFontFamily] = useState(DEFAULT_GUJ_FONT);
    const [fontWeight, setFontWeight] = useState('400');
    const [fontColor, setFontColor] = useState('#ffffff');
    const [fontSize, setFontSize] = useState('64');
    const [letterSpacing, setLetterSpacing] = useState('0');
    const [isBold, setIsBold] = useState(false);
    const [isItalic, setIsItalic] = useState(false);
    const [isUnderline, setIsUnderline] = useState(false);

    // Library State
    const [library, setLibrary] = useState([]);
    const [isEditMode, setIsEditMode] = useState(false);
    const [isSavedFlash, setIsSavedFlash] = useState(false);
    const [isFetching, setIsFetching] = useState(false);
    const [armedVerseIndex, setArmedVerseIndex] = useState(null);
    const [liveVerseIndex, setLiveVerseIndex] = useState(null);
    const [cueMode, setCueMode] = useState(() => localStorage.getItem(CUE_MODE_KEY) || CUE_MODES.FAST_TAKE);
    const [linesPerSlide, setLinesPerSlide] = useState(() => normalizeLinesPerSlide(localStorage.getItem(LINES_PER_SLIDE_KEY)));
    const [errorMessage, setErrorMessage] = useState('');

    // Search State
    const [searchQuery, setSearchQuery] = useState('');
    const [searchResults, setSearchResults] = useState([]);
    const [isSearching, setIsSearching] = useState(false);
    const [showDropdown, setShowDropdown] = useState(false);
    const panelRootRef = useRef(null);
    const searchRef = useRef(null);
    const debounceRef = useRef(null);
    const errorTimerRef = useRef(null);

    const isVerseBlank = (verse) => !verse || (!verse.eng?.trim() && !verse.guj?.trim());

    // What the operator actually arms and takes. Derived, never stored: `parsedVerses` stays
    // one-line-per-entry because the song library persists it verbatim.
    const slides = useMemo(() => groupVersesIntoSlides(parsedVerses, linesPerSlide), [parsedVerses, linesPerSlide]);

    const canShowArmed = armedVerseIndex !== null && !isVerseBlank(slides[armedVerseIndex]);

    const setTemporaryError = (message) => {
        setErrorMessage(message);
        window.clearTimeout(errorTimerRef.current);
        errorTimerRef.current = window.setTimeout(() => setErrorMessage(''), 3600);
    };

    // Takes the freshly parsed LINE array and arms the first usable SLIDE, since the
    // armed/live indices address slides rather than lines.
    const resetCueState = (verses) => {
        const nextSlides = groupVersesIntoSlides(verses, linesPerSlide);
        const nextIndex = nextSlides.findIndex(v => !isVerseBlank(v));
        setArmedVerseIndex(nextIndex >= 0 ? nextIndex : null);
        setLiveVerseIndex(null);
    };

    const handleCueModeChange = (mode) => {
        setCueMode(mode);
        localStorage.setItem(CUE_MODE_KEY, mode);
    };

    const handleLinesPerSlideChange = (value) => {
        setLinesPerSlide(normalizeLinesPerSlide(value));
        localStorage.setItem(LINES_PER_SLIDE_KEY, String(normalizeLinesPerSlide(value)));
    };

    // Toggling the setting reshapes the slide array, so armed/live indices would otherwise
    // dangle past its end. Remap them so the operator keeps their place mid-song.
    const prevLinesPerSlideRef = useRef(linesPerSlide);
    useEffect(() => {
        const previous = prevLinesPerSlideRef.current;
        if (previous === linesPerSlide) return;
        prevLinesPerSlideRef.current = linesPerSlide;
        const count = groupVersesIntoSlides(parsedVerses, linesPerSlide).length;
        setArmedVerseIndex(prev => remapSlideIndex(prev, previous, linesPerSlide, count));
        setLiveVerseIndex(prev => remapSlideIndex(prev, previous, linesPerSlide, count));
    }, [linesPerSlide, parsedVerses]);

    const doSearch = useCallback(async (q) => {
        if (!q || q.length < 2) { setSearchResults([]); return; }
        setIsSearching(true);
        setErrorMessage('');
        try {
            const r = await fetch(authUrl('/search-anirdesh', { q, what: 'title', type: 'keyword' }));
            const data = await r.json();
            if (data.error) {
                setSearchResults([]);
                setTemporaryError('Anirdesh search returned an error.');
                return;
            }
            setSearchResults(Array.isArray(data) ? data.slice(0, 15) : []);
            setShowDropdown(true);
        } catch {
            setSearchResults([]);
            setTemporaryError('Could not search Anirdesh right now.');
        }
        finally { setIsSearching(false); }
    }, []);

    const handleSearchInput = (val) => {
        setSearchQuery(val);
        if (debounceRef.current) clearTimeout(debounceRef.current);
        if (val.length < 2) { setSearchResults([]); setShowDropdown(false); return; }
        debounceRef.current = setTimeout(() => doSearch(val), 350);
    };

    const handleSelectResult = (item) => {
        const url = `https://www.anirdesh.com/kirtan/index.php?lang=${item.lang}&part=${item.part}&no=${item.no}`;
        setAnirdeshUrl(url);
        setSearchQuery('');
        setSearchResults([]);
        setShowDropdown(false);
        // Auto-fetch the selected kirtan
        fetchFromUrl(url);
    };

    // Close dropdown on outside click
    useEffect(() => {
        const handler = (e) => { if (searchRef.current && !searchRef.current.contains(e.target)) setShowDropdown(false); };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, []);

    useEffect(() => deferUntilIdle(() => {
        setLibrary(readLocalStorageArraySafe(LIBRARY_KEY));
    }), []);

    useDebouncedLocalStorageEffect(LIBRARY_KEY, library);

    const saveLibrary = (newLib) => {
        setLibrary(newLib);
    };

    const getStyle = useCallback(() => ({
        fontFamily, gujFontFamily, fontWeight, fontSize, color: fontColor,
        letterSpacing, bold: isBold, italic: isItalic, underline: isUnderline
    }), [fontFamily, gujFontFamily, fontWeight, fontSize, fontColor, letterSpacing, isBold, isItalic, isUnderline]);

    // Restore saved typography (lyrics styling was previously not persisted at all).
    useEffect(() => deferUntilIdle(() => {
        const saved = readLocalStorageObjectSafe(LYRICS_STYLE_KEY);
        if (saved.fontFamily) setFontFamily(saved.fontFamily);
        if (saved.gujFontFamily) setGujFontFamily(saved.gujFontFamily);
        if (saved.fontWeight) setFontWeight(saved.fontWeight);
        if (saved.fontSize) setFontSize(saved.fontSize);
        if (saved.color) setFontColor(saved.color);
        if (saved.letterSpacing !== undefined) setLetterSpacing(saved.letterSpacing);
        if (saved.bold !== undefined) setIsBold(Boolean(saved.bold));
        if (saved.italic !== undefined) setIsItalic(Boolean(saved.italic));
        if (saved.underline !== undefined) setIsUnderline(Boolean(saved.underline));
    }), []);

    const styleSnapshot = getStyle();
    useDebouncedLocalStorageEffect(LYRICS_STYLE_KEY, styleSnapshot);

    // Push typography to the output as it changes. The relay (server.js) and the
    // graphic's listener already existed but nothing ever emitted on this channel,
    // so font changes used to land only on the next verse take.
    useEffect(() => {
        if (!socket) return;
        socket.emit('update_lyrics_style', getStyle());
    }, [socket, getStyle]);

    // Preview the chosen face using the operator's own lyric where available.
    const gujSampleText = (lyricGu.trim() || parsedVerses[0]?.guj || '').trim();
    const previewGujText = (gujSampleText.split('\n')[0] || 'જય સ્વામિનારાયણ').slice(0, 22);

    // Parsing Logic
    const parseTextBlocks = (text) => {
        if (!text) return [];
        return text.split('\n').map(v => v.trim()).filter(v => v);
    };

    const handleParse = () => {
        const arrEn = parseTextBlocks(lyricEn);
        const arrGu = parseTextBlocks(lyricGu);
        const maxLen = Math.max(arrEn.length, arrGu.length);
        const newVerses = [];
        for (let i = 0; i < maxLen; i++) {
            newVerses.push({ eng: arrEn[i] || '', guj: arrGu[i] || '' });
        }
        setParsedVerses(newVerses);
        resetCueState(newVerses);

        if (newVerses.length > 0) {
            const firstEn = (newVerses[0].eng || '').trim();
            const firstGu = (newVerses[0].guj || '').trim();
            setSongTitle([firstGu, firstEn].filter(Boolean).join(' — '));
        } else {
            setTemporaryError('No verses found to parse.');
        }
    };

    const parseAnirdeshLyrics = (html) => {
        const clean = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<audio[\s\S]*?<\/audio>/gi, '');
        const doc = new DOMParser().parseFromString(clean, 'text/html');
        const body = doc.body ? (doc.body.innerText || doc.body.textContent || '') : '';
        return parseAnirdeshText(body);
    };

    const fetchFromUrl = async (url) => {
        setIsFetching(true);
        setErrorMessage('');
        try {
            const r = await fetch(authUrl('/fetch-anirdesh', { url }));
            if (!r.ok) throw new Error(await r.text());
            const html = await r.text();
            const result = parseAnirdeshLyrics(html);
            setLyricEn(result.EN.join('\n'));
            setLyricGu(result.GU.join('\n'));
            
            // Auto parse
            const maxLen = Math.max(result.EN.length, result.GU.length);
            const newVerses = [];
            for (let i = 0; i < maxLen; i++) {
                newVerses.push({ eng: result.EN[i] || '', guj: result.GU[i] || '' });
            }
            setParsedVerses(newVerses);
            resetCueState(newVerses);
            if (newVerses.length > 0) {
                const firstEn = (newVerses[0].eng || '').trim();
                const firstGu = (newVerses[0].guj || '').trim();
                setSongTitle([firstGu, firstEn].filter(Boolean).join(' — '));
            } else {
                setTemporaryError('Fetched the page, but no verses were found.');
            }
        } catch (err) {
            console.error(err);
            setTemporaryError('Error fetching lyrics. Check the URL or server connection.');
        } finally {
            setIsFetching(false);
        }
    };

    const handleFetch = () => {
        const url = anirdeshUrl.trim();
        if (!url) {
            setTemporaryError('Please paste an Anirdesh URL first.');
            return;
        }
        fetchFromUrl(url);
    };

    const handleSaveCurrent = () => {
        if (parsedVerses.length === 0) return;
        const title = songTitle.trim() || 'Untitled Song';
        const entry = { title, verses: parsedVerses.slice(), savedAt: Date.now() };
        
        const existingIndex = library.findIndex(s => s.title.toLowerCase() === title.toLowerCase());
        const newLib = [...library];
        if (existingIndex >= 0) newLib[existingIndex] = entry;
        else newLib.unshift(entry);
        
        saveLibrary(newLib);
        setIsSavedFlash(true);
        setTimeout(() => setIsSavedFlash(false), 1500);
    };

    const loadSong = (song) => {
        if (isEditMode) return;
        const verses = song.verses || [];
        setParsedVerses(verses);
        setLyricEn(verses.map(v => v.eng).join('\n'));
        setLyricGu(verses.map(v => v.guj).join('\n'));
        setSongTitle(song.title || '');
        resetCueState(verses);
    };

    const deleteSong = (index) => {
        const newLib = [...library];
        newLib.splice(index, 1);
        saveLibrary(newLib);
    };

    // Positioning State
    const [posX, setPosX] = useState(50);
    const [posY, setPosY] = useState(80);

    const resetPosition = () => {
        setPosX(50);
        setPosY(80);
    };

    // Cinematic Gradient State
    const [bgIntensity, setBgIntensity] = useState(95);
    const [bgHeight, setBgHeight] = useState(100);
    const [bgSoftness, setBgSoftness] = useState(75);
    const [isGradEnabled, setIsGradEnabled] = useState(true);

    // Live Layout Update
    useEffect(() => {
        if (!socket) return;
        socket.emit('update_lyrics_layout', {
            posX,
            posY,
            bgStyle,
            langOpt,
            animStyle,
            autoClear: autoClear ? Number(autoClear) : 0,
            cinematicGrad: {
                enabled: isGradEnabled && bgStyle === 'cinematic-gradient',
                bgHeight,
                bgIntensity,
                bgSoftness
            }
        });
    }, [posX, posY, bgStyle, bgIntensity, bgHeight, bgSoftness, isGradEnabled, langOpt, animStyle, autoClear, socket]);

    const armVerse = (index) => {
        if (slides.length === 0) return;
        const clamped = Math.max(0, Math.min(index, slides.length - 1));
        setArmedVerseIndex(clamped);
    };

    const moveArmedVerse = (direction) => {
        if (slides.length === 0) return;
        const startIndex = armedVerseIndex === null ? (direction > 0 ? -1 : slides.length) : armedVerseIndex;
        for (let step = 1; step <= slides.length; step++) {
            const nextIndex = startIndex + direction * step;
            if (nextIndex < 0 || nextIndex >= slides.length) break;
            if (!isVerseBlank(slides[nextIndex])) {
                setArmedVerseIndex(nextIndex);
                return;
            }
        }
    };

    const showVerseAt = (index) => {
        const verse = slides[index];
        if (!socket || !verse) return;
        if (isVerseBlank(verse)) {
            setTemporaryError(`${slideLabel(verse, index)} is blank.`);
            return;
        }
        if (!socket) return;
        socket.emit('show_lyrics', {
            engText: verse.eng,
            gujText: verse.guj,
            animation: animStyle,
            langOpt,
            autoClear: autoClear ? Number(autoClear) : 0,
            style: getStyle(),
            bgStyle,
            posX,
            posY,
            cinematicGrad: {
                enabled: isGradEnabled && bgStyle === 'cinematic-gradient',
                bgHeight,
                bgIntensity,
                bgSoftness
            }
        });
        setArmedVerseIndex(index);
        setLiveVerseIndex(index);
    };

    const handleShowArmed = () => {
        if (armedVerseIndex === null) {
            setTemporaryError('No verse is armed.');
            return;
        }
        showVerseAt(armedVerseIndex);
    };

    const handleResendLive = () => {
        if (liveVerseIndex === null) {
            handleShowArmed();
            return;
        }
        showVerseAt(liveVerseIndex);
    };

    const handleVerseTileClick = (index) => {
        if (cueMode === CUE_MODES.FAST_TAKE) {
            showVerseAt(index);
            return;
        }
        armVerse(index);
    };

    const handleHide = () => {
        if (!socket) return;
        socket.emit('hide_lyrics');
        setLiveVerseIndex(null);
    };

    const handleClearLiveCue = () => {
        setParsedVerses([]);
        setLiveVerseIndex(null);
        setArmedVerseIndex(null);
    };

    useEffect(() => {
        const handleKeyDown = (e) => {
            if (!panelRootRef.current || panelRootRef.current.getClientRects().length === 0) return;
            const active = document.activeElement;
            const tagName = active?.tagName?.toLowerCase();
            const isTyping = tagName === 'input' || tagName === 'textarea' || tagName === 'select' || active?.isContentEditable;
            if (isTyping || slides.length === 0) return;

            if (['ArrowRight', 'ArrowDown'].includes(e.key)) {
                e.preventDefault();
                moveArmedVerse(1);
            } else if (['ArrowLeft', 'ArrowUp'].includes(e.key)) {
                e.preventDefault();
                moveArmedVerse(-1);
            } else if (e.key === 'Enter') {
                e.preventDefault();
                handleShowArmed();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                handleHide();
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [slides, armedVerseIndex, liveVerseIndex, socket, animStyle, langOpt, autoClear, fontFamily, gujFontFamily, fontWeight, fontSize, fontColor, letterSpacing, isBold, isItalic, isUnderline, bgStyle, posX, posY, isGradEnabled, bgHeight, bgIntensity, bgSoftness]);

    const getVerseTileClass = (verse, index) => {
        const isArmed = index === armedVerseIndex;
        const isLive = index === liveVerseIndex;
        const isBlank = isVerseBlank(verse);
        if (isLive) return 'bg-emerald-500/15 border-emerald-500 text-slate-900 dark:text-white shadow-lg shadow-emerald-900/10';
        if (isArmed) return 'bg-indigo-500/15 border-indigo-500 text-slate-900 dark:text-white shadow-lg shadow-indigo-900/10';
        if (isBlank) return 'surface-muted border-dashed text-slate-400 cursor-not-allowed';
        return 'surface text-slate-800 dark:text-slate-200 hover:border-indigo-400 hover:bg-indigo-500/5';
    };

    const armedVerse = armedVerseIndex !== null ? slides[armedVerseIndex] : null;
    const liveVerse = liveVerseIndex !== null ? slides[liveVerseIndex] : null;
    const showGujarati = langOpt === 'both' || langOpt === 'guj';
    const showEnglish = langOpt === 'both' || langOpt === 'eng';
    const currentTitle = songTitle.trim() || 'Untitled Kirtan';

    return (
        <div ref={panelRootRef} className="grid grid-cols-1 2xl:grid-cols-[minmax(420px,0.85fr)_minmax(560px,1.15fr)] gap-3">
            <div className="space-y-3">
                <div className="surface rounded-lg p-3 space-y-3">
                    <div className="flex items-center justify-between gap-3">
                        <h3 className="text-[10px] font-bold text-slate-600 dark:text-slate-400 uppercase tracking-[0.2em] flex items-center gap-2">
                            <Library className="w-3.5 h-3.5 text-indigo-400" /> Library / Import
                        </h3>
                        <div className="flex items-center gap-3">
                            <span className="text-[10px] text-slate-500 font-medium">{library.length} saved</span>
                            <button onClick={() => setIsEditMode(!isEditMode)} className={`text-[9px] uppercase font-bold tracking-wider transition ${isEditMode ? 'text-emerald-500' : 'text-slate-500 hover:text-slate-900 dark:hover:text-white'}`}>
                                {isEditMode ? 'Done' : 'Edit'}
                            </button>
                        </div>
                    </div>

                    <div className="grid grid-cols-2 md:grid-cols-3 2xl:grid-cols-2 gap-2 max-h-40 overflow-y-auto pr-0.5">
                        {library.length === 0 ? (
                            <span className="text-xs text-slate-500 italic col-span-full text-center py-3">No songs saved yet. Parse and save a song below.</span>
                        ) : (
                            library.map((song, idx) => (
                                <div key={idx} className="relative flex group">
                                    <button onClick={() => loadSong(song)} className={`flex-1 text-left px-3 py-2 rounded-lg text-xs font-semibold border transition min-h-[54px] ${song.title === songTitle ? 'bg-indigo-500/15 border-indigo-500 text-slate-900 dark:text-white' : 'surface-muted hover:border-indigo-500/50 text-slate-700 dark:text-slate-300'}`}>
                                        <div className="font-guj font-bold text-[11px] leading-tight line-clamp-2 break-words">{song.title.split(' — ')[0]}</div>
                                        {song.title.includes(' — ') && <div className="opacity-60 font-normal text-[9px] italic leading-tight line-clamp-1 break-words">{song.title.split(' — ')[1]}</div>}
                                    </button>
                                    {isEditMode && (
                                        <button onClick={() => deleteSong(idx)} className="absolute right-0 top-0 bottom-0 px-3 bg-red-900/80 hover:bg-red-600 text-white rounded-r-lg border border-red-500/50 flex items-center justify-center transition" aria-label={`Delete ${song.title}`}>
                                            <Trash2 className="w-3.5 h-3.5" />
                                        </button>
                                    )}
                                </div>
                            ))
                        )}
                    </div>

                    <div className="space-y-1.5 relative" ref={searchRef}>
                        <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-wider">Search Anirdesh Kirtan</label>
                        <div className="relative">
                            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                                {isSearching ? <Loader2 className="h-4 w-4 text-indigo-500 animate-spin" /> : <Search className="h-4 w-4 text-slate-400" />}
                            </div>
                            <input type="text" value={searchQuery} onChange={e => handleSearchInput(e.target.value)} onFocus={() => { if (searchResults.length > 0) setShowDropdown(true); }} placeholder="Type to search..." className="control-field pl-10 pr-4 py-2 text-sm" />
                        </div>
                        {showDropdown && searchResults.length > 0 && (
                            <div className="surface-raised absolute z-50 w-full mt-1 rounded-xl max-h-60 overflow-y-auto">
                                {searchResults.map((item, idx) => (
                                    <button key={idx} onClick={() => handleSelectResult(item)} className="w-full text-left px-4 py-3 hover:bg-slate-50 dark:hover:bg-slate-700/50 border-b section-rule last:border-0 transition flex flex-col group">
                                        <div className="flex items-center gap-2">
                                            <span className="text-sm font-semibold text-slate-900 dark:text-white font-guj">{item.title}</span>
                                            {item.video === 1 && <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 font-bold tracking-wider">VIDEO</span>}
                                            {item.audio === 1 && <span className="text-[10px] px-1.5 py-0.5 rounded bg-orange-100 dark:bg-orange-900/30 text-orange-600 dark:text-orange-400 font-bold tracking-wider"><Music className="w-3 h-3 inline-block -mt-0.5" /></span>}
                                        </div>
                                        {item.snippet && <div className="text-xs text-slate-500 dark:text-slate-400 mt-1 line-clamp-1 italic">{item.snippet.replace(/<[^>]*>/g, '')}</div>}
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>

                    <div className="space-y-1.5">
                        <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-wider">Or Paste Anirdesh URL</label>
                        <div className="flex gap-2">
                            <input type="text" value={anirdeshUrl} onChange={e => setAnirdeshUrl(e.target.value)} placeholder="https://www.anirdesh.com/kirtan/..." className="control-field flex-1 px-4 py-1.5 text-xs" />
                            <button onClick={handleFetch} disabled={isFetching || !anirdeshUrl} className="bg-slate-700 hover:bg-slate-600 disabled:opacity-50 text-white px-4 py-1.5 rounded-lg text-xs font-bold transition active:scale-95">
                                {isFetching ? 'Fetching' : 'Fetch'}
                            </button>
                        </div>
                    </div>

                    <div className="grid grid-cols-1 xl:grid-cols-2 2xl:grid-cols-1 gap-3">
                        <div className="space-y-1.5">
                            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300">English Lyrics</label>
                            <textarea value={lyricEn} onChange={e => setLyricEn(e.target.value)} rows="4" className="control-field px-4 py-2" placeholder="Paste English verses here..."></textarea>
                        </div>
                        <div className="space-y-1.5">
                            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300">Gujarati Lyrics</label>
                            <textarea value={lyricGu} onChange={e => setLyricGu(e.target.value)} rows="4" className="control-field px-4 py-2" placeholder="અહીં પેસ્ટ કરો..." dir="auto"></textarea>
                        </div>
                    </div>
                    <button onClick={handleParse} className="w-full bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded-lg font-bold transition active:scale-95">Parse Verses</button>
                </div>
            </div>

            <div className="space-y-3">
                {errorMessage && (
                    <div className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs font-semibold text-red-600 dark:text-red-400">
                        <AlertCircle className="w-4 h-4 flex-none" />
                        <span>{errorMessage}</span>
                    </div>
                )}

                <div className="surface rounded-lg p-3 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="min-w-0">
                            <h3 className="text-[10px] font-bold text-slate-500 uppercase tracking-[0.2em]">Live Cueing</h3>
                            <div className="text-lg font-bold text-slate-900 dark:text-white truncate">{currentTitle}</div>
                        </div>
                        <div className="flex flex-wrap items-center justify-end gap-2">
                            <div className="surface-muted inline-flex rounded-lg p-0.5">
                                {[
                                    { id: CUE_MODES.FAST_TAKE, label: 'Fast Take' },
                                    { id: CUE_MODES.SAFE_ARM, label: 'Safe Arm' }
                                ].map(mode => (
                                    <button
                                        key={mode.id}
                                        onClick={() => handleCueModeChange(mode.id)}
                                        className={`px-3 py-1.5 rounded-md text-[10px] font-bold uppercase tracking-wider transition active:scale-95 ${cueMode === mode.id ? 'bg-emerald-600 text-white shadow-sm' : 'text-slate-500 hover:text-slate-900 dark:hover:text-white'}`}
                                    >
                                        {mode.label}
                                    </button>
                                ))}
                            </div>
                            <span className="rounded-full bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border border-indigo-500/20 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider">
                                Armed {armedVerseIndex !== null ? armedVerseIndex + 1 : '--'}
                            </span>
                            <span className="rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider">
                                Live {liveVerseIndex !== null ? liveVerseIndex + 1 : '--'}
                            </span>
                        </div>
                    </div>

                    <div className="surface-muted flex items-center gap-2 rounded-lg px-3 py-2">
                        <Save className="w-4 h-4 text-indigo-400 flex-none" />
                        <input type="text" value={songTitle} onChange={e => setSongTitle(e.target.value)} placeholder="Song / Kirtan name..." className="flex-1 bg-transparent text-sm text-slate-900 dark:text-white placeholder-slate-500 outline-none min-w-0" />
                        <button onClick={handleSaveCurrent} disabled={parsedVerses.length === 0} className={`flex-none text-white text-xs font-semibold px-3 py-1.5 rounded-lg transition whitespace-nowrap disabled:opacity-40 ${isSavedFlash ? 'bg-emerald-600' : 'bg-indigo-600 hover:bg-indigo-500'}`}>
                            {isSavedFlash ? 'Saved' : 'Save'}
                        </button>
                    </div>

                    {parsedVerses.length === 0 ? (
                        <div className="surface-muted min-h-[190px] rounded-lg border-dashed flex items-center justify-center text-center px-6">
                            <div>
                                <PauseCircle className="w-8 h-8 text-slate-400 mx-auto mb-2" />
                                <div className="text-sm font-bold text-slate-700 dark:text-slate-300">No verses loaded</div>
                                <div className="text-xs text-slate-500 mt-1">Search, fetch, paste, or load a saved song to start cueing.</div>
                            </div>
                        </div>
                    ) : (
                        <>
                            <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
                                <button onClick={() => moveArmedVerse(-1)} className="control-button-muted h-12 text-slate-800 dark:text-slate-100 font-bold text-xs flex items-center justify-center gap-2 active:scale-95">
                                    <SkipBack className="w-4 h-4" /> Previous
                                </button>
                                <button onClick={handleShowArmed} disabled={!canShowArmed} className="h-12 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-300 dark:disabled:bg-slate-800 disabled:text-slate-500 text-white font-bold text-xs flex items-center justify-center gap-2 transition active:scale-95">
                                    <Play className="w-4 h-4" /> Show Armed
                                </button>
                                <button onClick={handleResendLive} disabled={!canShowArmed && liveVerseIndex === null} className="h-12 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-300 dark:disabled:bg-slate-800 disabled:text-slate-500 text-white font-bold text-xs flex items-center justify-center gap-2 transition active:scale-95">
                                    <RotateCcw className="w-4 h-4" /> Resend
                                </button>
                                <button onClick={() => moveArmedVerse(1)} className="control-button-muted h-12 text-slate-800 dark:text-slate-100 font-bold text-xs flex items-center justify-center gap-2 active:scale-95">
                                    Next <SkipForward className="w-4 h-4" />
                                </button>
                            </div>

                            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2 max-h-[420px] overflow-y-auto pr-1">
                                {slides.map((verse, i) => {
                                    const isBlank = isVerseBlank(verse);
                                    // Static class strings: Tailwind cannot see interpolated names.
                                    const tileMinHeight = linesPerSlide > 1 ? 'min-h-[136px]' : 'min-h-[104px]';
                                    const clamp = linesPerSlide > 1 ? 'line-clamp-4' : 'line-clamp-2';
                                    return (
                                        <button key={i} onClick={() => !isBlank && handleVerseTileClick(i)} onDoubleClick={() => cueMode === CUE_MODES.SAFE_ARM && showVerseAt(i)} disabled={isBlank} className={`${tileMinHeight} rounded-lg border p-3 text-left transition active:scale-[0.99] overflow-hidden ${getVerseTileClass(verse, i)}`}>
                                            <div className="flex items-center justify-between gap-2 mb-2">
                                                <span className="text-[10px] uppercase tracking-widest font-bold">{slideLabel(verse, i)}</span>
                                                <span className="text-[9px] font-bold uppercase tracking-wider">
                                                    {i === liveVerseIndex ? 'Live' : i === armedVerseIndex ? 'Armed' : isBlank ? 'Blank' : 'Ready'}
                                                </span>
                                            </div>
                                            {showGujarati && <div className={`font-guj font-bold text-sm leading-snug whitespace-pre-line ${clamp} ${verse.guj ? '' : 'text-slate-400 italic'}`}>{verse.guj || 'No Gujarati line'}</div>}
                                            {showEnglish && <div className={`text-xs leading-snug whitespace-pre-line mt-1 ${clamp} ${verse.eng ? 'text-slate-500 dark:text-slate-400 italic' : 'text-slate-400 italic'}`}>{verse.eng || 'No English line'}</div>}
                                            <div className="mt-2 text-[9px] font-bold uppercase tracking-wider text-slate-400">
                                                {isBlank ? 'Cannot send blank' : cueMode === CUE_MODES.FAST_TAKE ? 'Click to take live' : 'Click to arm'}
                                            </div>
                                        </button>
                                    );
                                })}
                            </div>

                            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                                <div className="rounded-lg bg-indigo-500/10 border border-indigo-500/20 px-3 py-2 min-h-[72px]">
                                    <div className="text-[10px] font-bold uppercase tracking-wider text-indigo-600 dark:text-indigo-400 mb-1">Armed Preview</div>
                                    <div className="text-xs text-slate-700 dark:text-slate-300 line-clamp-2 font-guj">{armedVerse?.guj || armedVerse?.eng || 'No verse armed'}</div>
                                </div>
                                <div className="rounded-lg bg-emerald-500/10 border border-emerald-500/20 px-3 py-2 min-h-[72px]">
                                    <div className="text-[10px] font-bold uppercase tracking-wider text-emerald-600 dark:text-emerald-400 mb-1">On Air</div>
                                    <div className="text-xs text-slate-700 dark:text-slate-300 line-clamp-2 font-guj">{liveVerse?.guj || liveVerse?.eng || 'Nothing live'}</div>
                                </div>
                            </div>
                        </>
                    )}

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        <button onClick={handleClearLiveCue} disabled={parsedVerses.length === 0} className="w-full bg-emerald-600/10 hover:bg-emerald-600 disabled:bg-slate-200/60 dark:disabled:bg-slate-800 disabled:text-slate-400 text-emerald-600 hover:text-white border border-emerald-600/20 disabled:border-transparent px-4 py-3 rounded-xl font-bold uppercase tracking-widest text-[10px] transition active:scale-95 flex items-center justify-center gap-2">
                            <XCircle className="w-4 h-4" /> Clear Live Cue
                        </button>
                        <button onClick={handleHide} className="w-full bg-red-600/10 hover:bg-red-600 text-red-600 hover:text-white border border-red-600/20 px-4 py-3 rounded-xl font-bold uppercase tracking-widest text-[10px] transition active:scale-95 flex items-center justify-center gap-2">
                            <XCircle className="w-4 h-4" /> Clear Display
                        </button>
                    </div>
                </div>

                <div className="surface rounded-lg p-3">
                    <h3 className="text-[10px] font-bold text-slate-500 uppercase tracking-[0.2em] mb-3">Look / Timing</h3>
                <div className="grid grid-cols-2 gap-3 mb-3">
                    <div className="space-y-1.5">
                        <label className="block text-sm font-medium text-slate-700 dark:text-slate-300">Show Languages</label>
                        <select value={langOpt} onChange={e=>setLangOpt(e.target.value)} className="control-field px-4 py-2">
                            <option value="both">Both English & Gujarati</option>
                            <option value="eng">English Only</option>
                            <option value="guj">Gujarati Only</option>
                        </select>
                    </div>
                    <div className="space-y-1.5">
                        <label className="block text-sm font-medium text-slate-700 dark:text-slate-300">Auto Clear (s)</label>
                        <input type="number" value={autoClear} onChange={e=>setAutoClear(e.target.value)} placeholder="0 = Manual" min="0"
                               className="control-field px-4 py-2" />
                    </div>
                    <div className="space-y-1.5">
                        <label className="block text-sm font-medium text-slate-700 dark:text-slate-300">Lines per Slide</label>
                        <select value={linesPerSlide} onChange={e=>handleLinesPerSlideChange(e.target.value)} className="control-field px-4 py-2">
                            <option value="1">1 line at a time</option>
                            <option value="2">2 lines at a time</option>
                        </select>
                    </div>
                </div>

                <div className="grid grid-cols-2 gap-3 mb-3">
                    {/* Lyrics Background Style */}
                    <div className="space-y-1.5">
                        <label className="block text-sm font-medium text-slate-700 dark:text-slate-300">Background Style</label>
                        <select value={bgStyle} onChange={e=>setBgStyle(e.target.value)} className="control-field px-4 py-2">
                            <option value="default">Dark Glass</option>
                            <option value="midnight">Midnight Blue</option>
                            <option value="charcoal">Charcoal Matte</option>
                            <option value="deep-purple">Deep Purple</option>
                            <option value="ocean">Ocean Teal</option>
                            <option value="burgundy">Burgundy Red</option>
                            <option value="forest">Forest Green</option>
                            <option value="warm-gold">Warm Gold</option>
                            <option value="frosted">Frosted Glass</option>
                            <option value="gradient-sunset">Sunset</option>
                            <option value="gradient-aurora">Aurora</option>
                            <option value="cinematic-gradient">Cinematic</option>
                        </select>
                    </div>

                    {/* Lyrics Animation Style */}
                    <div className="space-y-1.5">
                        <label className="block text-sm font-medium text-slate-700 dark:text-slate-300">Animation Style</label>
                        <select value={animStyle} onChange={e=>setAnimStyle(e.target.value)} className="control-field px-4 py-2">
                            <option value="none">None (Instant)</option>
                            <option value="fade">Fade</option>
                            <option value="elastic">Fluid</option>
                            <option value="elasticDrop">Drop</option>
                            <option value="slideRight">Right</option>
                            <option value="slideLeft">Left</option>
                            <option value="slideUp">Up</option>
                            <option value="zoom">Zoom</option>
                            <option value="blur">Blur</option>
                            <option value="flip">Flip</option>
                            <option value="spin">Spin</option>
                            <option value="bounce">Bounce</option>
                        </select>
                    </div>
                </div>

                <div className="grid grid-cols-1 xl:grid-cols-2 gap-3 mb-3">
                    {/* Left Column: Positioning or Gradient */}
                    {bgStyle !== 'cinematic-gradient' ? (
                        <div className="surface rounded-lg p-3 space-y-3">
                            <div className="flex items-center justify-between">
                                <h3 className="text-[10px] font-bold text-slate-500 dark:text-slate-500 uppercase tracking-[0.2em]">Lyric Positioning</h3>
                                <button onClick={resetPosition} className="text-[10px] font-bold text-indigo-400 hover:text-indigo-300 uppercase tracking-widest transition">Reset</button>
                            </div>
                            <div className="space-y-4">
                                <div className="space-y-2">
                                    <div className="flex justify-between items-center">
                                        <label className="text-xs font-medium text-slate-600 dark:text-slate-400">Horizontal Pos (X)</label>
                                        <span className="text-[10px] font-bold text-indigo-400">{posX}%</span>
                                    </div>
                                    <input type="range" min="0" max="100" value={posX} onChange={e=>setPosX(Number(e.target.value))} 
                                           className="w-full h-1.5 bg-slate-200 dark:bg-slate-700 rounded-lg appearance-none cursor-pointer accent-indigo-500" />
                                </div>
                                <div className="space-y-2">
                                    <div className="flex justify-between items-center">
                                        <label className="text-xs font-medium text-slate-600 dark:text-slate-400">Vertical Pos (Y)</label>
                                        <span className="text-[10px] font-bold text-indigo-400">{posY}%</span>
                                    </div>
                                    <input type="range" min="0" max="100" value={posY} onChange={e=>setPosY(Number(e.target.value))} 
                                           className="w-full h-1.5 bg-slate-200 dark:bg-slate-700 rounded-lg appearance-none cursor-pointer accent-indigo-500" />
                                </div>
                            </div>
                        </div>
                    ) : (
                        <div className="surface rounded-lg p-3 space-y-3">
                            <div className="flex items-center justify-between">
                                <h3 className="text-[10px] font-bold text-slate-500 dark:text-slate-500 uppercase tracking-[0.2em]">Cinematic Gradient Controls</h3>
                                <label className="relative inline-flex items-center cursor-pointer scale-75 origin-right">
                                    <input type="checkbox" className="sr-only peer" checked={isGradEnabled} onChange={e=>setIsGradEnabled(e.target.checked)} />
                                    <div className="w-11 h-6 bg-slate-200 dark:bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-indigo-500"></div>
                                </label>
                            </div>

                            {!isGradEnabled && (
                                <div className="surface-muted text-[10px] text-slate-500 italic text-center py-2 rounded-lg border-dashed">
                                    Disabled
                                </div>
                            )}

                            <div className={`${isGradEnabled ? 'opacity-100' : 'opacity-40 pointer-events-none transition-opacity duration-300'} space-y-3`}>
                                <div className="space-y-1.5">
                                    <div className="flex items-center justify-between">
                                        <label className="text-[11px] font-medium text-slate-600 dark:text-slate-400">Intensity</label>
                                        <span className="text-[10px] font-bold text-indigo-500 bg-indigo-500/10 px-1.5 py-0.5 rounded">{bgIntensity}%</span>
                                    </div>
                                    <input type="range" min="0" max="100" value={bgIntensity} onChange={e=>setBgIntensity(Number(e.target.value))}
                                           className="w-full h-1.5 bg-slate-200 dark:bg-slate-700 rounded-lg appearance-none cursor-pointer accent-indigo-500" />
                                </div>
                                <div className="space-y-1.5">
                                    <div className="flex items-center justify-between">
                                        <label className="text-[11px] font-medium text-slate-600 dark:text-slate-400">Height</label>
                                        <span className="text-[10px] font-bold text-indigo-500 bg-indigo-500/10 px-1.5 py-0.5 rounded">{bgHeight}%</span>
                                    </div>
                                    <input type="range" min="0" max="100" value={bgHeight} onChange={e=>setBgHeight(Number(e.target.value))}
                                           className="w-full h-1.5 bg-slate-200 dark:bg-slate-700 rounded-lg appearance-none cursor-pointer accent-indigo-500" />
                                </div>
                                <div className="space-y-1.5">
                                    <div className="flex items-center justify-between">
                                        <label className="text-[11px] font-medium text-slate-600 dark:text-slate-400">Softness</label>
                                        <span className="text-[10px] font-bold text-indigo-500 bg-indigo-500/10 px-1.5 py-0.5 rounded">{bgSoftness}%</span>
                                    </div>
                                    <input type="range" min="0" max="100" value={bgSoftness} onChange={e=>setBgSoftness(Number(e.target.value))}
                                           className="w-full h-1.5 bg-slate-200 dark:bg-slate-700 rounded-lg appearance-none cursor-pointer accent-indigo-500" />
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Right Column: Lyrics Typography */}
                    <div className="surface rounded-lg p-3 space-y-3">
                        <h3 className="text-[10px] font-bold text-slate-500 dark:text-slate-500 uppercase tracking-[0.2em]">Lyric Typography</h3>
                        <div className="grid grid-cols-2 gap-3">
                            <div className="space-y-1">
                                <label className="block text-[10px] font-medium text-slate-500 uppercase">Weight</label>
                                <select value={fontWeight} onChange={e=>setFontWeight(e.target.value)} className="w-full bg-slate-950 border border-slate-700 rounded-lg px-2 py-1 text-[10px] text-white outline-none">
                                    <option value="300">Light</option>
                                    <option value="400">Regular</option>
                                    <option value="600">Semi-Bold</option>
                                    <option value="700">Bold</option>
                                </select>
                            </div>
                            <div className="space-y-1">
                                <label className="block text-[10px] font-medium text-slate-500 uppercase">Color</label>
                                <input type="color" value={fontColor} onChange={e=>setFontColor(e.target.value)} className="w-full h-6 bg-slate-950 border border-slate-700 rounded-lg px-1 py-1 cursor-pointer" />
                            </div>
                        </div>

                        <div className="grid grid-cols-2 gap-3">
                            <div className="space-y-1">
                                <label className="block text-[10px] font-medium text-slate-500 uppercase">Size (px)</label>
                                <div className="flex items-center space-x-1">
                                    <button onClick={() => setFontSize(prev => String(Math.max(10, parseInt(prev) - 5)))} className="bg-slate-800 hover:bg-slate-700 text-white w-5 h-5 rounded flex items-center justify-center text-[10px] font-bold">-</button>
                                    <input type="number" value={fontSize} onChange={e=>setFontSize(e.target.value)} className="w-10 bg-slate-950 border border-slate-700 rounded px-0.5 py-1 text-[10px] text-white outline-none text-center" />
                                    <button onClick={() => setFontSize(prev => String(parseInt(prev) + 5))} className="bg-slate-800 hover:bg-slate-700 text-white w-5 h-5 rounded flex items-center justify-center text-[10px] font-bold">+</button>
                                </div>
                            </div>
                            <div className="space-y-1">
                                <label className="block text-[10px] font-medium text-slate-500 uppercase">Emphasis</label>
                                <div className="flex space-x-1">
                                    <button onClick={() => setIsBold(!isBold)} className={`flex-1 border border-slate-700 rounded p-1 text-[10px] font-bold transition ${isBold ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-400'}`}>B</button>
                                    <button onClick={() => setIsItalic(!isItalic)} className={`flex-1 border border-slate-700 rounded p-1 text-[10px] italic transition ${isItalic ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-400'}`}>I</button>
                                </div>
                            </div>
                        </div>

                        <div className="space-y-1">
                            <label className="block text-[10px] font-medium text-slate-500 uppercase">English Font</label>
                            <select value={fontFamily} onChange={e=>setFontFamily(e.target.value)} className="w-full bg-slate-950 border border-slate-700 rounded-lg px-2 py-1 text-[10px] text-white outline-none">
                                <option value="'Outfit', sans-serif">Outfit (Default)</option>
                                <option value="'Inter', sans-serif">Inter</option>
                                <option value="'Poppins', sans-serif">Poppins</option>
                            </select>
                        </div>

                        <div className="space-y-1">
                            <label className="block text-[10px] font-medium text-slate-500 uppercase">Gujarati Font</label>
                            <select value={gujFontFamily} onChange={e=>setGujFontFamily(e.target.value)} className="w-full bg-slate-950 border border-slate-700 rounded-lg px-2 py-1 text-[10px] text-white outline-none">
                                {GUJ_FONT_OPTIONS.map(font => (
                                    <option key={font.value} value={font.value}>{font.label}</option>
                                ))}
                            </select>
                            <div className="rounded bg-slate-950 px-2 py-1.5 text-center text-lg text-white" style={{ fontFamily: gujFontFamily }}>
                                {previewGujText}
                            </div>
                        </div>
                    </div>
                </div>

                </div>
            </div>
        </div>
    );
}
