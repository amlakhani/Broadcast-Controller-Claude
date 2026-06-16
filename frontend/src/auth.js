export function getAuthToken() {
    return window.__BC_AUTH_TOKEN__ || new URLSearchParams(window.location.search).get('auth') || '';
}

export function getRemoteToken() {
    return window.__BC_REMOTE_TOKEN__ || new URLSearchParams(window.location.search).get('remoteToken') || localStorage.getItem('bc-remote-token') || '';
}

export function isRemoteEntry() {
    return Boolean(window.__BC_REMOTE_ENTRY__) || window.location.pathname === '/remote';
}

export function socketOptions(remoteToken = getRemoteToken()) {
    const token = getAuthToken();
    return token
        ? { auth: { token } }
        : { auth: { remoteToken } };
}

export function authUrl(path, params = {}) {
    const url = new URL(path, window.location.origin);
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null) {
            url.searchParams.set(key, String(value));
        }
    }
    return `${url.pathname}${url.search}${url.hash}`;
}

export function authHeaders(headers = {}) {
    const token = getAuthToken();
    const remoteToken = getRemoteToken();
    return {
        ...headers,
        ...(token ? { 'x-bc-auth-token': token } : {}),
        ...(!token && remoteToken ? { 'x-bc-remote-token': remoteToken } : {})
    };
}

export function authFetch(path, options = {}) {
    return fetch(authUrl(path), {
        ...options,
        headers: authHeaders(options.headers || {})
    });
}
