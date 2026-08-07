// Override experimental Node.js 21+ global WebSocket with the standard 'ws' package
// before the Azure Speech SDK is imported.
import WebSocket from 'ws';
globalThis.WebSocket = WebSocket;
global.WebSocket = WebSocket;

// Dynamically import Speech SDK to bypass ES Module hoisting and guarantee the WebSocket override is active first
const SpeechSDK = await import('microsoft-cognitiveservices-speech-sdk');

let activeRecognizer = null;
let activePushStream = null;

const stopActiveTranslation = () => {
    if (activeRecognizer) {
        try {
            activeRecognizer.stopContinuousRecognitionAsync(() => {
                if (activeRecognizer) {
                    activeRecognizer.close();
                    activeRecognizer = null;
                }
                console.log("Worker recognizer closed.");
                if (process.send) {
                    process.send({ type: 'translation_stopped' });
                }
            });
        } catch (e) {
            console.error("Worker error stopping recognizer:", e);
        }
        activeRecognizer = null;
    }
    if (activePushStream) {
        try {
            activePushStream.close();
        } catch (e) {
            console.error("Worker error closing push stream:", e);
        }
        activePushStream = null;
    }
};

process.on('message', (msg) => {
    if (msg.type === 'start') {
        const { key, region, targetLang, sourceLanguages } = msg.config;
        console.log(`Worker starting Azure Translation: Target=${targetLang}, Sources=${sourceLanguages}`);
        
        try {
            const format = SpeechSDK.AudioStreamFormat.getWaveFormatPCM(16000, 16, 1);
            activePushStream = SpeechSDK.AudioInputStream.createPushStream(format);
            const audioConfig = SpeechSDK.AudioConfig.fromStreamInput(activePushStream);

            const translationConfig = SpeechSDK.SpeechTranslationConfig.fromSubscription(key.trim(), region);
            translationConfig.addTargetLanguage(targetLang);

            if (sourceLanguages && sourceLanguages.length > 0) {
                translationConfig.speechRecognitionLanguage = sourceLanguages[0];
            }

            if (sourceLanguages.length === 1) {
                activeRecognizer = new SpeechSDK.TranslationRecognizer(translationConfig, audioConfig);
            } else {
                const autoDetectConfig = SpeechSDK.AutoDetectSourceLanguageConfig.fromLanguages(sourceLanguages);
                activeRecognizer = SpeechSDK.TranslationRecognizer.FromConfig(translationConfig, autoDetectConfig, audioConfig);
            }

            activeRecognizer.recognizing = (s, e) => {
                const text = e.result.translations.get(targetLang);
                if (text && text.trim() !== '') {
                    if (process.send) {
                        process.send({
                            type: 'translation_update',
                            data: {
                                text,
                                sourceText: e.result.text || '',
                                isFinal: false,
                                lang: e.result.language || 'Detected'
                            }
                        });
                    }
                }
            };

            activeRecognizer.recognized = (s, e) => {
                if (e.result.reason === SpeechSDK.ResultReason.TranslatedSpeech) {
                    const text = e.result.translations.get(targetLang);
                    if (text && text.trim() !== '') {
                        if (process.send) {
                            process.send({
                                type: 'translation_update',
                            data: {
                                text,
                                sourceText: e.result.text || '',
                                isFinal: true,
                                lang: e.result.language || 'Detected'
                            }
                            });
                        }
                    }
                }
            };

            activeRecognizer.canceled = (s, e) => {
                console.log("Worker translation canceled:", e.errorDetails);
                if (process.send) {
                    process.send({
                        type: 'translation_canceled',
                        error: e.errorDetails || 'Unknown error / invalid credentials.'
                    });
                }
                stopActiveTranslation();
            };

            activeRecognizer.sessionStopped = (s, e) => {
                console.log("Worker translation session stopped.");
                stopActiveTranslation();
            };

            activeRecognizer.startContinuousRecognitionAsync(
                () => {
                    if (process.send) {
                        process.send({ type: 'translation_started' });
                    }
                },
                (err) => {
                    console.error("Worker failed to start continuous recognition:", err);
                    if (process.send) {
                        process.send({ type: 'translation_failed', error: err.toString() });
                    }
                    stopActiveTranslation();
                }
            );

        } catch (err) {
            console.error("Worker initialization failed:", err);
            if (process.send) {
                process.send({ type: 'translation_failed', error: err.toString() });
            }
            stopActiveTranslation();
        }
    } else if (msg.type === 'stop') {
        stopActiveTranslation();
    } else if (msg.type === 'audio_chunk') {
        if (activePushStream && msg.chunk) {
            // A write to a stream that has already been closed throws, and this is inside the
            // IPC message handler — an unguarded throw here takes the whole worker down
            // mid-service. Audio chunks arrive continuously, so losing one is survivable;
            // losing the recognizer is not.
            try {
                activePushStream.write(Buffer.from(msg.chunk.data || msg.chunk));
            } catch (err) {
                console.error('Dropped an audio chunk:', err?.message || err);
            }
        }
    }
});
