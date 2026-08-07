// IndexedDB store for saved image-deck slides.
//
// These used to live in localStorage alongside the deck metadata. A 30-slide 1080p PDF is well
// past Chromium's ~5MB per-origin localStorage quota, and the debounced re-persist swallowed the
// resulting QuotaExceededError — so the operator saved a deck, saw it in the library, restarted,
// and found it gone, with nothing but a console line to explain it. IndexedDB has no practical
// size limit for this, and reports failure properly.
//
// Only the images live here; the library metadata (id, name, slide count) stays in localStorage
// so the library list renders without an async read.

const DB_NAME = 'bc-decks';
const DB_VERSION = 1;
const STORE = 'deckImages';

let dbPromise = null;

function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
        if (!window.indexedDB) {
            reject(new Error('IndexedDB is unavailable.'));
            return;
        }
        const request = window.indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORE)) {
                db.createObjectStore(STORE, { keyPath: 'id' });
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('Could not open the deck store.'));
    }).catch((err) => {
        // Don't cache a rejected promise: a later attempt should be able to retry.
        dbPromise = null;
        throw err;
    });
    return dbPromise;
}

function runTransaction(mode, work) {
    return openDb().then(db => new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const store = tx.objectStore(STORE);
        let result;
        try {
            result = work(store);
        } catch (err) {
            reject(err);
            return;
        }
        tx.oncomplete = () => resolve(result?.result !== undefined ? result.result : result);
        tx.onerror = () => reject(tx.error || new Error('Deck store transaction failed.'));
        tx.onabort = () => reject(tx.error || new Error('Deck store transaction aborted.'));
    }));
}

export function putDeckImages(id, { images = [], thumbs = [] } = {}) {
    return runTransaction('readwrite', store => store.put({ id, images, thumbs }));
}

export async function getDeckImages(id) {
    try {
        const record = await runTransaction('readonly', store => store.get(id));
        return { images: record?.images || [], thumbs: record?.thumbs || [] };
    } catch (err) {
        console.error(`Could not read deck ${id} from the deck store:`, err);
        return { images: [], thumbs: [] };
    }
}

export async function deleteDeckImages(id) {
    try {
        await runTransaction('readwrite', store => store.delete(id));
    } catch (err) {
        console.error(`Could not delete deck ${id} from the deck store:`, err);
    }
}
