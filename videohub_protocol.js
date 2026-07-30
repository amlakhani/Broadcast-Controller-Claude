// Pure parsing/encoding for the Blackmagic Videohub Ethernet Protocol
// (plain-text, newline-delimited blocks separated by a blank line, TCP port
// 9990). No I/O here — videohub_service.js owns the socket and buffering
// glue; this module is the part that's actually worth unit-testing without
// a real hub, same split as superSourceModel.js vs atem_service.js.

export const DEFAULT_VIDEOHUB_PORT = 9990;

// Splits an accumulating text buffer into complete blocks (header line plus
// zero or more body lines, terminated by a blank line) and whatever
// incomplete trailing text should be kept for the next chunk. Protocol line
// endings are bare LF.
export function splitBlocks(buffer) {
    const blocks = [];
    // The spec uses bare LF, but strip any \r defensively — some firmware/OS
    // TCP stacks are known to send CRLF, and a literal "\r\n\r\n" blank-line
    // separator would otherwise never match the "\n\n" scan below, silently
    // stalling every block (and therefore the connection) forever.
    let text = buffer.replace(/\r/g, '');
    for (;;) {
        const blankAt = text.indexOf('\n\n');
        if (blankAt === -1) break;
        const raw = text.slice(0, blankAt);
        text = text.slice(blankAt + 2);
        const lines = raw.split('\n').filter(line => line.length > 0);
        if (lines.length === 0) continue;
        blocks.push({ header: lines[0].trim(), lines: lines.slice(1) });
    }
    return { blocks, remainder: text };
}

// One line of a labels/routing/locks block is "<index> <rest>".
function parseIndexedLines(lines) {
    return lines
        .map(line => {
            const spaceAt = line.indexOf(' ');
            if (spaceAt === -1) return { index: Number(line.trim()), value: '' };
            return { index: Number(line.slice(0, spaceAt)), value: line.slice(spaceAt + 1) };
        })
        .filter(entry => Number.isInteger(entry.index));
}

function parseColonFields(lines) {
    const fields = {};
    for (const line of lines) {
        const colonAt = line.indexOf(':');
        if (colonAt === -1) continue;
        fields[line.slice(0, colonAt).trim()] = line.slice(colonAt + 1).trim();
    }
    return fields;
}

// Turns one parsed block into a { type, patch } the service merges into its
// status. `patch` shape depends on `type` — see the switch below.
export function parseBlock({ header, lines }) {
    const headerKey = header.replace(/:$/, '').trim().toUpperCase();

    switch (headerKey) {
        case 'VIDEOHUB DEVICE': {
            const fields = parseColonFields(lines);
            return {
                type: 'device',
                patch: {
                    modelName: fields['Model name'] || null,
                    friendlyName: fields['Friendly name'] || null,
                    videoInputs: Number(fields['Video inputs']) || 0,
                    videoOutputs: Number(fields['Video outputs']) || 0,
                },
            };
        }
        case 'INPUT LABELS':
            return {
                type: 'inputLabels',
                patch: parseIndexedLines(lines).map(({ index, value }) => ({ index, label: value })),
            };
        case 'OUTPUT LABELS':
            return {
                type: 'outputLabels',
                patch: parseIndexedLines(lines).map(({ index, value }) => ({ index, label: value })),
            };
        case 'VIDEO OUTPUT LOCKS':
            return {
                type: 'locks',
                patch: parseIndexedLines(lines).map(({ index, value }) => ({
                    index,
                    // O = owned by us, F = force-locked by another client — both read as "locked".
                    locked: value.trim() === 'O' || value.trim() === 'F',
                })),
            };
        case 'VIDEO OUTPUT ROUTING':
            return {
                type: 'routing',
                patch: parseIndexedLines(lines).map(({ index, value }) => ({ index, source: Number(value.trim()) })),
            };
        case 'PROTOCOL PREAMBLE':
            return { type: 'preamble', patch: parseColonFields(lines) };
        // Real firmware terminates the initial dump with "END PRELUDE:" —
        // inconsistent with the opening "PROTOCOL PREAMBLE:" block, but
        // confirmed against an actual Blackmagic Smart Videohub 20 x 20.
        // "END PREAMBLE" is kept too in case other firmware uses that spelling.
        case 'END PRELUDE':
        case 'END PREAMBLE':
            return { type: 'end', patch: null };
        case 'ACK':
            return { type: 'ack', patch: null };
        case 'NAK':
            return { type: 'nak', patch: null };
        default:
            return { type: 'unknown', patch: null };
    }
}

// --- Command builders ----------------------------------------------------
// Every command is a self-contained block: header line, one line per
// change, terminated by a blank line. The protocol allows multiple index
// lines per block, so a multi-destination TAKE is a single message/ACK.

export function buildRoutingCommand(pairs) {
    const body = pairs.map(({ destIndex, srcIndex }) => `${destIndex} ${srcIndex}`).join('\n');
    return `VIDEO OUTPUT ROUTING:\n${body}\n\n`;
}

export function buildLockCommand(destIndex, locked) {
    return `VIDEO OUTPUT LOCKS:\n${destIndex} ${locked ? 'O' : 'U'}\n\n`;
}

export function buildInputLabelCommand(index, label) {
    return `INPUT LABELS:\n${index} ${label}\n\n`;
}

export function buildOutputLabelCommand(index, label) {
    return `OUTPUT LABELS:\n${index} ${label}\n\n`;
}
