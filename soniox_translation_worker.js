import WebSocket from 'ws';

const SONIOX_WEBSOCKET_URL = 'wss://stt-rt.soniox.com/transcribe-websocket';
const SOURCE_LANGUAGE_MAP = {
    'en-US': 'en',
    'gu-IN': 'gu',
    'hi-IN': 'hi'
};

let socket = null;
let stopped = false;
let config = null;
let state = createSonioxTokenState();

function send(message) {
    if (process.send) {
        process.send(message);
    }
}

function unique(values) {
    return [...new Set(values.filter(Boolean))];
}

export function mapSourceLanguages(sourceLanguages = []) {
    return unique(sourceLanguages.map(lang => SOURCE_LANGUAGE_MAP[lang] || lang));
}

export function createSonioxConfig(input = {}) {
    const languageHints = mapSourceLanguages(input.sourceLanguages || []);
    const request = {
        api_key: input.key,
        model: input.sonioxModel || 'stt-rt-v4',
        audio_format: 'pcm_s16le',
        sample_rate: 16000,
        num_channels: 1,
        enable_endpoint_detection: true,
        max_endpoint_delay_ms: 500,
        enable_language_identification: true,
        translation: {
            type: 'one_way',
            target_language: input.targetLang || 'en'
        }
    };

    if (languageHints.length > 0) {
        request.language_hints = languageHints;
    }

    if (Array.isArray(input.sonioxTranslationTerms) && input.sonioxTranslationTerms.length > 0) {
        request.context = {
            translation_terms: input.sonioxTranslationTerms
                .filter(term => term?.source && term?.target)
                .map(term => ({ source: term.source, target: term.target }))
        };
    }

    return request;
}

export function createSonioxTokenState() {
    return {
        lastInterimTranslation: '',
        lastInterimSource: ''
    };
}

function joinTokenText(tokens) {
    return tokens.map(token => token.text || '').join('').trim();
}

export function parseSonioxResponse(response = {}, tokenState = createSonioxTokenState()) {
    const tokens = Array.isArray(response.tokens) ? response.tokens : [];
    const finalTranslations = [];
    const interimTranslations = [];
    const finalSources = [];
    const interimSources = [];

    for (const token of tokens) {
        if (!token?.text) continue;
        const status = token.translation_status || 'none';
        const isTranslation = status === 'translation';
        const target = isTranslation
            ? (token.is_final ? finalTranslations : interimTranslations)
            : (token.is_final ? finalSources : interimSources);
        target.push(token);
    }

    const updates = [];
    const finalText = joinTokenText(finalTranslations);
    const finalSourceText = joinTokenText(finalSources);

    if (finalText) {
        tokenState.lastInterimTranslation = '';
        tokenState.lastInterimSource = '';
        updates.push({
            text: finalText,
            sourceText: finalSourceText,
            isFinal: true,
            lang: finalTranslations.at(-1)?.language || config?.targetLang || 'Soniox'
        });
    } else {
        const interimText = joinTokenText(interimTranslations);
        if (interimText && interimText !== tokenState.lastInterimTranslation) {
            tokenState.lastInterimTranslation = interimText;
            tokenState.lastInterimSource = joinTokenText(interimSources);
            updates.push({
                text: interimText,
                sourceText: tokenState.lastInterimSource,
                isFinal: false,
                lang: interimTranslations.at(-1)?.language || config?.targetLang || 'Soniox'
            });
        }
    }

    return {
        updates,
        finished: Boolean(response.finished),
        error: response.error_code ? {
            code: response.error_code,
            message: response.error_message || response.error_code
        } : null
    };
}

function stopSonioxTranslation({ notify = true } = {}) {
    stopped = true;
    if (socket) {
        try {
            if (socket.readyState === WebSocket.OPEN) {
                socket.send('');
            }
            socket.close();
        } catch (err) {
            console.error('Soniox worker error closing socket:', err);
        }
        socket = null;
    }
    if (notify) {
        send({ type: 'translation_stopped' });
    }
}

function startSonioxTranslation(nextConfig = {}) {
    config = nextConfig;
    stopped = false;
    state = createSonioxTokenState();

    try {
        socket = new WebSocket(SONIOX_WEBSOCKET_URL);

        socket.on('open', () => {
            try {
                socket.send(JSON.stringify(createSonioxConfig(config)));
                send({ type: 'translation_started' });
            } catch (err) {
                send({ type: 'translation_failed', error: err.message || String(err) });
                stopSonioxTranslation({ notify: false });
            }
        });

        socket.on('message', data => {
            try {
                const parsed = JSON.parse(data.toString());
                const result = parseSonioxResponse(parsed, state);

                if (result.error) {
                    send({ type: 'translation_failed', error: `${result.error.code}: ${result.error.message}` });
                    stopSonioxTranslation({ notify: false });
                    return;
                }

                for (const update of result.updates) {
                    send({ type: 'translation_update', data: update });
                }

                if (result.finished) {
                    stopSonioxTranslation();
                }
            } catch (err) {
                send({ type: 'translation_failed', error: err.message || String(err) });
                stopSonioxTranslation({ notify: false });
            }
        });

        socket.on('error', err => {
            if (stopped) return;
            send({ type: 'translation_failed', error: err.message || String(err) });
            stopSonioxTranslation({ notify: false });
        });

        socket.on('close', () => {
            if (!stopped) {
                stopped = true;
                send({ type: 'translation_stopped' });
            }
            socket = null;
        });
    } catch (err) {
        send({ type: 'translation_failed', error: err.message || String(err) });
        stopSonioxTranslation({ notify: false });
    }
}

process.on('message', (msg) => {
    if (msg.type === 'start') {
        startSonioxTranslation(msg.config || {});
    } else if (msg.type === 'stop') {
        stopSonioxTranslation();
    } else if (msg.type === 'audio_chunk' && socket?.readyState === WebSocket.OPEN) {
        const chunk = Buffer.from(msg.chunk?.data || msg.chunk || []);
        if (chunk.length > 0) {
            socket.send(chunk);
        }
    }
});
