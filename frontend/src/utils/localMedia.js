// The server serves local media only by opaque mediaId — it does not accept raw filesystem
// paths, because doing so was an arbitrary-file-read over the whole disk. Registering a path
// returns an id scoped to this app run, so ids are not durable and must be re-obtained for any
// item restored from localStorage.

import { authFetch } from '../auth';

export async function registerLocalMedia(filePath, type = 'local') {
    const response = await authFetch('/api/local-media/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: filePath, type })
    });
    if (!response.ok) {
        throw new Error('Could not register local media file.');
    }
    const result = await response.json();
    return result.media;
}

// Re-registers any local/photo item that has a path but no usable mediaId. Playlists saved
// before mediaId existed, and every playlist restored after a restart, land here. Items whose
// file has since moved or been deleted keep their missing id and simply won't play, which is
// the same outcome as before and better than dropping the operator's playlist entry.
export async function ensureMediaIds(items) {
    if (!Array.isArray(items) || items.length === 0) return items;

    let changed = false;
    const resolved = await Promise.all(items.map(async (item) => {
        if (!item || item.mediaId || !item.path) return item;
        if (item.type !== 'local' && item.type !== 'photo') return item;
        try {
            const media = await registerLocalMedia(item.path, item.type);
            changed = true;
            return { ...item, mediaId: media.mediaId, path: media.path || item.path };
        } catch {
            return item;
        }
    }));

    return changed ? resolved : items;
}
