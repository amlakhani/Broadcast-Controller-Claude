// Pairing-code helpers, kept out of the component files so those export components only
// (which is what React Fast Refresh requires to hot-reload them properly).

// Non-destructive check: is a scanned pairing code sitting in the fragment?
// Lets a host decide to re-pair before RemotePairing mounts and consumes it.
export function peekFragmentPairingCode() {
    try {
        return /(?:^|[#&])c=(\d{6})(?:&|$)/.exec(window.location.hash || '')?.[1] || '';
    } catch {
        return '';
    }
}

// The pairing code rides in the URL *fragment*: fragments are never sent to the server,
// so the credential stays out of request logs. RemotePairing strips it after use.
export function buildRemoteQrValue(url, code) {
    if (!url) return '';
    return code ? `${url}#c=${code}` : url;
}
