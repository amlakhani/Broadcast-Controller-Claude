// Pure logic for the Videohub router UI — no DOM, unit-testable under
// `node --test`, same split VideohubPanel.jsx keeps from its stateful glue
// as superSourceModel.js does for SuperSourcePanel.jsx.

export const MAX_LABEL_LENGTH = 20;

// `staged` is a plain object { [destIndex]: srcIndex } of not-yet-committed
// picks; `outputs` is the device's last-known routing (VideohubService's
// status.outputs). Returns only the destinations that would actually change,
// which is both the TAKE payload and what drives the button's enabled state.
export function computeStagedDiff(outputs = [], staged = {}) {
    const pairs = [];
    for (const key of Object.keys(staged)) {
        const destIndex = Number(key);
        const srcIndex = staged[key];
        if (outputs[destIndex]?.source !== srcIndex) pairs.push({ destIndex, srcIndex });
    }
    return pairs;
}

// Videohub firmware UIs generally cap labels around 20 characters; the
// Ethernet protocol itself doesn't enforce a limit, but sending something
// longer just gets silently truncated on-device, so match it client-side.
export function normalizeLabel(label) {
    return (typeof label === 'string' ? label : '').trim().slice(0, MAX_LABEL_LENGTH);
}

export function labelFor(list = [], index, fallbackPrefix = 'Input') {
    if (index == null || index < 0) return '—';
    return list[index]?.label || `${fallbackPrefix} ${index + 1}`;
}
