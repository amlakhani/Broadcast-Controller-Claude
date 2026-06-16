import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';

let config = null;
let pcmBuffers = [];
let bufferedBytes = 0;
let chunkTimer = null;
let processing = false;
let stopped = false;

const SAMPLE_RATE = 16000;
const CHANNELS = 1;
const BYTES_PER_SAMPLE = 2;

function send(message) {
    if (process.send) {
        process.send(message);
    }
}

function stopLocalTranslation() {
    stopped = true;
    if (chunkTimer) {
        clearInterval(chunkTimer);
        chunkTimer = null;
    }
    pcmBuffers = [];
    bufferedBytes = 0;
    send({ type: 'translation_stopped' });
}

function wavFromPcm(pcm) {
    const header = Buffer.alloc(44);
    const byteRate = SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE;
    const blockAlign = CHANNELS * BYTES_PER_SAMPLE;

    header.write('RIFF', 0);
    header.writeUInt32LE(36 + pcm.length, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(CHANNELS, 22);
    header.writeUInt32LE(SAMPLE_RATE, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(pcm.length, 40);

    return Buffer.concat([header, pcm]);
}

function runCommand(command, args, { timeoutMs = 60000 } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { windowsHide: true });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
            child.kill();
            reject(new Error(`Timed out running ${path.basename(command)}`));
        }, timeoutMs);

        child.stdout.on('data', chunk => {
            stdout += chunk.toString();
        });
        child.stderr.on('data', chunk => {
            stderr += chunk.toString();
        });
        child.on('error', err => {
            clearTimeout(timer);
            reject(err);
        });
        child.on('close', code => {
            clearTimeout(timer);
            if (code === 0) {
                resolve({ stdout, stderr });
            } else {
                reject(new Error(stderr || stdout || `${path.basename(command)} exited with code ${code}`));
            }
        });
    });
}

async function transcribeWithWhisper(wavPath, outputBase) {
    const args = [
        '-m', config.whisperModelPath,
        '-f', wavPath,
        '-otxt',
        '-of', outputBase,
        '-np'
    ];
    const result = await runCommand(config.whisperExecutablePath, args, { timeoutMs: Math.max(30000, config.chunkSeconds * 20000) });
    const txtPath = `${outputBase}.txt`;
    if (fs.existsSync(txtPath)) {
        return fs.readFileSync(txtPath, 'utf8').trim();
    }
    return result.stdout
        .split('\n')
        .map(line => line.replace(/^\[[^\]]+\]\s*/, '').trim())
        .filter(Boolean)
        .join(' ')
        .trim();
}

function getTargetLanguageName(targetLang) {
    return { en: 'English', gu: 'Gujarati', hi: 'Hindi' }[targetLang] || 'English';
}

async function translateWithOllama(sourceText) {
    const prompt = [
        `Translate the following speech transcript into ${getTargetLanguageName(config.targetLang)}.`,
        'Return only the translated sentence. Do not add explanations, labels, quotes, or alternatives.',
        'If the transcript is already in the target language, return it unchanged.',
        '',
        `Transcript: ${sourceText}`
    ].join('\n');

    const response = await fetch(`${config.ollamaBaseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: config.ollamaModel,
            prompt,
            stream: false,
            options: { temperature: 0.1 }
        }),
        signal: AbortSignal.timeout(Math.max(30000, config.chunkSeconds * 20000))
    });

    if (!response.ok) {
        throw new Error(`Ollama returned HTTP ${response.status}`);
    }

    const data = await response.json();
    return String(data?.response || '').trim().replace(/^["']|["']$/g, '');
}

async function processBufferedAudio() {
    if (processing || stopped || bufferedBytes === 0) return;

    processing = true;
    const pcm = Buffer.concat(pcmBuffers, bufferedBytes);
    pcmBuffers = [];
    bufferedBytes = 0;

    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-local-ai-'));
    const wavPath = path.join(workDir, 'audio.wav');
    const outputBase = path.join(workDir, 'transcript');

    try {
        fs.writeFileSync(wavPath, wavFromPcm(pcm));
        const sourceText = await transcribeWithWhisper(wavPath, outputBase);
        if (!sourceText) return;

        const translatedText = await translateWithOllama(sourceText);
        if (!translatedText) return;

        send({
            type: 'translation_update',
            data: {
                text: translatedText,
                sourceText,
                isFinal: true,
                lang: 'Local AI'
            }
        });
    } catch (err) {
        send({ type: 'translation_failed', error: err.message || String(err) });
        stopLocalTranslation();
    } finally {
        processing = false;
        try {
            fs.rmSync(workDir, { recursive: true, force: true });
        } catch {}
    }
}

process.on('message', (msg) => {
    if (msg.type === 'start') {
        config = msg.config?.localAiSettings || {};
        config.targetLang = msg.config?.targetLang || 'en';
        config.chunkSeconds = Number(config.chunkSeconds) || 5;
        stopped = false;
        chunkTimer = setInterval(processBufferedAudio, config.chunkSeconds * 1000);
        send({ type: 'translation_started' });
    } else if (msg.type === 'stop') {
        stopLocalTranslation();
    } else if (msg.type === 'audio_chunk' && !stopped) {
        const chunk = Buffer.from(msg.chunk?.data || msg.chunk || []);
        if (chunk.length > 0) {
            pcmBuffers.push(chunk);
            bufferedBytes += chunk.length;
        }
    }
});
