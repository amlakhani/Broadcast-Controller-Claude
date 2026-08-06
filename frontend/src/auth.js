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

// Like authUrl, but for plain <img>/Image() requests, which can't carry the
// x-bc-remote-token header authFetch uses. Those normally authenticate via the
// bc_remote_token session cookie set at pairing, but if that cookie is ever lost
// while localStorage (and the socket connection) survive, every preview would
// otherwise 403 silently while navigation kept working. Appending the token as a
// query param — only when there's no desktop auth token — closes that gap. Scoped
// to this helper rather than folded into authUrl, since a token in every URL is
// worth avoiding when a cookie/header already covers it.
export function authImageUrl(path, params = {}) {
    const token = getAuthToken();
    const remoteToken = getRemoteToken();
    return authUrl(path, {
        ...params,
        ...(!token && remoteToken ? { remoteToken } : {})
    });
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
