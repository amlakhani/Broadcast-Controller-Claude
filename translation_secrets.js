// Encrypted-at-rest store for the operator's paid transcription API keys (Azure Speech,
// Soniox).
//
// These used to live in the renderer's localStorage in plaintext, rewritten on every keystroke,
// and were sent over the socket on every start_translation. Now the value never enters the
// renderer at all: the panel writes a key once, reads back only whether one is set, and
// server.js resolves the actual secret at start time (see setTranslationSecretResolver).
//
// safeStorage is backed by the OS keychain (DPAPI on Windows, Keychain on macOS). When it is
// unavailable — some Linux setups without a keyring — we refuse to persist rather than silently
// writing plaintext, and the operator is told the key will only last for this session.

import fs from 'fs';
import path from 'path';
import { safeStorage } from 'electron';

const SUPPORTED_KEYS = new Set(['azure', 'soniox']);

let storePath = null;
let cache = null;
// Falls back to memory when the OS has no usable keychain, so translation still works for the
// current run without ever writing an unencrypted key to disk.
const sessionOnly = new Map();

export function setTranslationSecretsDir(dir) {
    storePath = path.join(dir, 'translation-secrets.json');
    cache = null;
}

function readStore() {
    if (cache) return cache;
    cache = {};
    if (!storePath) return cache;
    try {
        if (fs.existsSync(storePath)) {
            const parsed = JSON.parse(fs.readFileSync(storePath, 'utf8'));
            if (parsed && typeof parsed === 'object' && parsed.secrets && typeof parsed.secrets === 'object') {
                cache = parsed.secrets;
            }
        }
    } catch (err) {
        console.error('Failed to read translation secrets; starting empty:', err);
        cache = {};
    }
    return cache;
}

function writeStore(secrets) {
    cache = secrets;
    if (!storePath) return false;
    try {
        fs.mkdirSync(path.dirname(storePath), { recursive: true });
        const tmp = `${storePath}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({ version: 1, secrets }, null, 2), 'utf8');
        fs.renameSync(tmp, storePath);
        return true;
    } catch (err) {
        console.error('Failed to write translation secrets:', err);
        return false;
    }
}

function encryptionAvailable() {
    try {
        return safeStorage.isEncryptionAvailable();
    } catch {
        return false;
    }
}

export function setTranslationSecret(name, value) {
    if (!SUPPORTED_KEYS.has(name)) return { ok: false, error: 'Unknown credential.' };
    const secret = typeof value === 'string' ? value.trim() : '';

    if (!secret) {
        sessionOnly.delete(name);
        const secrets = { ...readStore() };
        delete secrets[name];
        writeStore(secrets);
        return { ok: true, stored: false, persisted: false };
    }

    if (!encryptionAvailable()) {
        sessionOnly.set(name, secret);
        return {
            ok: true,
            stored: true,
            persisted: false,
            warning: 'No OS keychain is available, so this key is kept for this session only.'
        };
    }

    sessionOnly.delete(name);
    const encrypted = safeStorage.encryptString(secret).toString('base64');
    const persisted = writeStore({ ...readStore(), [name]: encrypted });
    return { ok: true, stored: true, persisted };
}

// Main-process only. Never expose this over IPC — the renderer must not be able to read a key
// back out, which is the whole point of moving them here.
export function getTranslationSecret(name) {
    if (!SUPPORTED_KEYS.has(name)) return '';
    if (sessionOnly.has(name)) return sessionOnly.get(name);

    const encrypted = readStore()[name];
    if (!encrypted) return '';
    try {
        return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
    } catch (err) {
        console.error(`Failed to decrypt ${name} key:`, err);
        return '';
    }
}

// The only shape the renderer is allowed to see: which keys exist, not what they are.
export function getTranslationSecretStatus() {
    const store = readStore();
    const status = {};
    for (const name of SUPPORTED_KEYS) {
        status[name] = Boolean(sessionOnly.get(name) || store[name]);
    }
    return status;
}
