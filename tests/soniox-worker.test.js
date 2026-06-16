import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    createSonioxConfig,
    createSonioxTokenState,
    mapSourceLanguages,
    parseSonioxResponse
} from '../soniox_translation_worker.js';

test('builds Soniox realtime config from app translation settings', () => {
    const config = createSonioxConfig({
        key: 'soniox-key',
        targetLang: 'gu',
        sourceLanguages: ['en-US', 'hi-IN', 'en-US'],
        sonioxModel: 'stt-rt-v4',
        sonioxTranslationTerms: [
            { source: 'Akshardham', target: 'અક્ષરધામ' },
            { source: '', target: 'ignored' }
        ]
    });

    assert.equal(config.api_key, 'soniox-key');
    assert.equal(config.model, 'stt-rt-v4');
    assert.equal(config.audio_format, 'pcm_s16le');
    assert.equal(config.sample_rate, 16000);
    assert.equal(config.num_channels, 1);
    assert.equal(config.translation.type, 'one_way');
    assert.equal(config.translation.target_language, 'gu');
    assert.deepEqual(config.language_hints, ['en', 'hi']);
    assert.deepEqual(config.context.translation_terms, [
        { source: 'Akshardham', target: 'અક્ષરધામ' }
    ]);
});

test('maps Broadcast Controller source locales to Soniox language hints', () => {
    assert.deepEqual(mapSourceLanguages(['en-US', 'gu-IN', 'hi-IN']), ['en', 'gu', 'hi']);
});

test('parses Soniox translation tokens without duplicating repeated interim text', () => {
    const state = createSonioxTokenState();
    const interim = {
        tokens: [
            { text: 'Wel', translation_status: 'translation', language: 'en', is_final: false },
            { text: 'come', translation_status: 'translation', language: 'en', is_final: false }
        ]
    };

    const first = parseSonioxResponse(interim, state);
    assert.deepEqual(first.updates, [
        { text: 'Welcome', sourceText: '', isFinal: false, lang: 'en' }
    ]);

    const duplicate = parseSonioxResponse(interim, state);
    assert.deepEqual(duplicate.updates, []);
});

test('parses final Soniox original and translation tokens as caption updates', () => {
    const state = createSonioxTokenState();
    const result = parseSonioxResponse({
        tokens: [
            { text: 'જય', translation_status: 'original', language: 'gu', is_final: true },
            { text: ' સ્વામિનારાયણ', translation_status: 'original', language: 'gu', is_final: true },
            { text: 'Jai', translation_status: 'translation', language: 'en', is_final: true },
            { text: ' Swaminarayan', translation_status: 'translation', language: 'en', is_final: true }
        ],
        finished: true
    }, state);

    assert.deepEqual(result.updates, [
        {
            text: 'Jai Swaminarayan',
            sourceText: 'જય સ્વામિનારાયણ',
            isFinal: true,
            lang: 'en'
        }
    ]);
    assert.equal(result.finished, true);
});
