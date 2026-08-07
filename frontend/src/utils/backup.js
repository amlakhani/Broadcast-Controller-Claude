// Export/import of everything the operator has built up in this browser profile: song library,
// deck library (including the slides themselves), media playlists, pad layout, message presets,
// styles and UI preferences.
//
// There was previously no way to back any of this up, and a single Factory Reset click wiped all
// of it irreversibly. It also gives the operator a way to move a library from the machine they
// build shows on to the venue PC.
//
// API keys are deliberately NOT included: they live in the OS keychain via the main process
// (translation_secrets.js), not in this browser profile, and a plaintext key in a file the
// operator emails around is exactly what moving them out of localStorage was meant to prevent.

import { getDeckImages, putDeckImages } from './deckStore';

const BACKUP_VERSION = 1;
const PRES_LIBRARY_KEY = 'bc_pres_library_v1';

// Everything under this prefix is app data. Anything else in localStorage isn't ours.
const KEY_PREFIXES = ['bc_', 'bc-'];

function isAppKey(key) {
    return KEY_PREFIXES.some(prefix => key.startsWith(prefix));
}

function collectLocalStorage() {
    const data = {};
    for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (!key || !isAppKey(key)) continue;
        data[key] = localStorage.getItem(key);
    }
    return data;
}

export async function buildBackup() {
    const settings = collectLocalStorage();

    // Slide images live in IndexedDB, so pull them in explicitly or a restored backup would
    // list every deck and be unable to open any of them.
    let decks = [];
    try {
        const library = JSON.parse(settings[PRES_LIBRARY_KEY] || '[]');
        if (Array.isArray(library)) {
            decks = await Promise.all(
                library
                    .filter(item => item?.id && (item.mode === 'images' || item.type === 'Image Deck'))
                    .map(async item => ({ id: item.id, ...(await getDeckImages(item.id)) }))
            );
            decks = decks.filter(deck => deck.images.length);
        }
    } catch (err) {
        console.error('Could not include saved decks in the backup:', err);
    }

    return {
        format: 'broadcast-controller-backup',
        version: BACKUP_VERSION,
        exportedAt: new Date().toISOString(),
        settings,
        decks
    };
}

export async function downloadBackup() {
    const backup = await buildBackup();
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const stamp = new Date().toISOString().slice(0, 10);
    link.href = url;
    link.download = `broadcast-controller-backup-${stamp}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    return backup;
}

// Merges rather than replaces: restoring a library on a machine that already has one should not
// silently discard what is already there. Existing keys are overwritten by the backup's values.
export async function restoreBackup(file) {
    const text = await file.text();
    let backup;
    try {
        backup = JSON.parse(text);
    } catch {
        throw new Error('That file is not a valid backup.');
    }

    if (backup?.format !== 'broadcast-controller-backup' || !backup.settings) {
        throw new Error('That file is not a Broadcast Controller backup.');
    }
    if (Number(backup.version) > BACKUP_VERSION) {
        throw new Error('That backup was made by a newer version of the app.');
    }

    for (const [key, value] of Object.entries(backup.settings)) {
        if (typeof value === 'string' && isAppKey(key)) {
            localStorage.setItem(key, value);
        }
    }

    for (const deck of backup.decks || []) {
        if (!deck?.id) continue;
        await putDeckImages(deck.id, { images: deck.images || [], thumbs: deck.thumbs || [] });
    }

    return { keys: Object.keys(backup.settings).length, decks: (backup.decks || []).length };
}
