export const TEMPLATE_SHEET_URL = 'https://docs.google.com/spreadsheets/d/1P8nfL1iNhSvK8ar2ZjWbhxjRxHuIAfEYZ94whgXs2iE/edit?usp=sharing';

export const BACKSTAGE_DISPLAY_MODES = [
    { id: 'currentNext', label: 'Current / Next' },
    { id: 'full', label: 'Full Rundown' }
];

const KEY_BY_HEADER = new Map([
    ['cue no.', 'cueNo'],
    ['cue no', 'cueNo'],
    ['cue #', 'cueNo'],
    ['start', 'start'],
    ['end', 'end'],
    ['duration', 'duration'],
    ['segment', 'segment'],
    ['description', 'description'],
    ['presenter', 'presenter'],
    ['audio board', 'audioBoard'],
    ['audio pb', 'audioPb'],
    ['side screen', 'sideScreen'],
    ['center screen', 'centerScreen'],
    ['gfx', 'gfx'],
    ['stage', 'stage'],
    ['house', 'house']
]);

const FALLBACK_KEYS = ['cueNo', 'start', 'end', 'duration', 'segment', 'description', 'presenter', 'audioBoard', 'audioPb', 'sideScreen', 'centerScreen', 'gfx', 'stage', 'house'];

export function parseCsv(text = '') {
    const rows = [];
    let row = [];
    let cell = '';
    let inQuotes = false;

    for (let i = 0; i < text.length; i += 1) {
        const char = text[i];
        const next = text[i + 1];
        if (char === '"') {
            if (inQuotes && next === '"') {
                cell += '"';
                i += 1;
            } else {
                inQuotes = !inQuotes;
            }
        } else if (char === ',' && !inQuotes) {
            row.push(cell);
            cell = '';
        } else if ((char === '\n' || char === '\r') && !inQuotes) {
            if (char === '\r' && next === '\n') i += 1;
            row.push(cell);
            rows.push(row);
            row = [];
            cell = '';
        } else {
            cell += char;
        }
    }

    row.push(cell);
    rows.push(row);
    return rows.filter(item => item.some(value => value.trim()));
}

const normalizeHeader = (value = '') => value.trim().replace(/\s+/g, ' ').toLowerCase();

function findHeaderRows(rows) {
    for (let i = 0; i < rows.length; i += 1) {
        const current = rows[i].map(normalizeHeader);
        const next = rows[i + 1]?.map(normalizeHeader) || [];
        const combined = current.map((value, index) => next[index] || value);
        const rawCurrent = rows[i].map(value => value.trim());
        const rawNext = rows[i + 1]?.map(value => value.trim()) || [];
        const rawCombined = rawCurrent.map((value, index) => rawNext[index] || value);
        const text = [...current, ...next].join(' ');
        if (text.includes('cue') && text.includes('start') && text.includes('duration') && combined.some(value => value.includes('segment'))) {
            const currentHasLabels = current.some(value => value.includes('segment')) && current.some(value => value === 'start') && current.some(value => value === 'duration');
            return {
                groupRowIndex: i,
                labelRowIndex: currentHasLabels ? i : i + 1,
                headerRow: currentHasLabels ? current : combined,
                rawHeaderRow: currentHasLabels ? rawCurrent : rawCombined
            };
        }
    }
    return {
        groupRowIndex: 0,
        labelRowIndex: 0,
        headerRow: rows[0]?.map(normalizeHeader) || [],
        rawHeaderRow: rows[0]?.map(value => value.trim()) || []
    };
}

function buildColumnMap(headerRow) {
    const map = {};
    headerRow.forEach((header, index) => {
        const normalized = normalizeHeader(header);
        const key = KEY_BY_HEADER.get(normalized) || [...KEY_BY_HEADER.entries()].find(([label]) => normalized.endsWith(label))?.[1];
        if (key && map[key] === undefined) map[key] = index;
    });

    FALLBACK_KEYS.forEach((key, index) => {
        if (map[key] === undefined) map[key] = index;
    });
    return map;
}

const valueAt = (row, map, key) => (row[map[key]] || '').trim();

function customFieldsForRow(row, rawHeaderRow, columnMap) {
    const knownIndexes = new Set(Object.values(columnMap));
    return rawHeaderRow
        .map((label, index) => ({
            label: label || `Column ${index + 1}`,
            value: (row[index] || '').trim(),
            index
        }))
        .filter(field => !knownIndexes.has(field.index) && field.label && field.value);
}

export function parseDurationToSeconds(value = '') {
    const text = String(value).trim();
    if (!text) return 0;
    const parts = text.split(':').map(part => Number(part.trim()));
    if (parts.some(Number.isNaN)) return 0;
    if (parts.length === 3) return (parts[0] * 3600) + (parts[1] * 60) + parts[2];
    if (parts.length === 2) return (parts[0] * 60) + parts[1];
    if (parts.length === 1) return parts[0] * 60;
    return 0;
}

export function formatDuration(seconds = 0, { showSign = false } = {}) {
    const rounded = Math.round(Number(seconds) || 0);
    const sign = rounded < 0 ? '-' : showSign && rounded > 0 ? '+' : '';
    const abs = Math.abs(rounded);
    const h = Math.floor(abs / 3600);
    const m = Math.floor((abs % 3600) / 60);
    const s = abs % 60;
    if (h > 0) return `${sign}${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${sign}${m}:${String(s).padStart(2, '0')}`;
}

export function driftLabel(seconds = 0) {
    const value = Math.round(Number(seconds) || 0);
    if (Math.abs(value) <= 10) return { label: 'On Time', tone: 'green', detail: formatDuration(value) };
    if (value > 0) return { label: `Behind ${formatDuration(value)}`, tone: 'red', detail: formatDuration(value) };
    return { label: `Ahead ${formatDuration(Math.abs(value))}`, tone: 'blue', detail: formatDuration(value) };
}

export function normalizeCueSheet(csvText = '') {
    const rows = parseCsv(csvText);
    if (rows.length === 0) return { title: 'Backstage Cue Sheet', rows: [], columnMap: {} };

    const { labelRowIndex, headerRow, rawHeaderRow } = findHeaderRows(rows);
    const firstCell = rows[0]?.find(cell => cell.trim())?.trim() || '';
    const title = firstCell.replace(/\s*Cue No\.?\s*$/i, '').trim() || 'Backstage Cue Sheet';
    const columnMap = buildColumnMap(headerRow);
    const dataRows = rows.slice(labelRowIndex + 1);

    const normalizedRows = dataRows
        .map((row, index) => {
            const cueNo = valueAt(row, columnMap, 'cueNo') || String(index + 1).padStart(2, '0');
            const item = {
                id: `cue-${index}-${cueNo}`,
                index,
                cueNo,
                start: valueAt(row, columnMap, 'start'),
                end: valueAt(row, columnMap, 'end'),
                duration: valueAt(row, columnMap, 'duration'),
                durationSeconds: parseDurationToSeconds(valueAt(row, columnMap, 'duration')),
                segment: valueAt(row, columnMap, 'segment'),
                description: valueAt(row, columnMap, 'description'),
                presenter: valueAt(row, columnMap, 'presenter'),
                audioBoard: valueAt(row, columnMap, 'audioBoard'),
                audioPb: valueAt(row, columnMap, 'audioPb'),
                sideScreen: valueAt(row, columnMap, 'sideScreen'),
                centerScreen: valueAt(row, columnMap, 'centerScreen'),
                gfx: valueAt(row, columnMap, 'gfx'),
                stage: valueAt(row, columnMap, 'stage'),
                house: valueAt(row, columnMap, 'house'),
                customFields: customFieldsForRow(row, rawHeaderRow, columnMap)
            };
            return item;
        })
        .filter(row => row.cueNo || row.segment || row.description || row.presenter);

    return { title, rows: normalizedRows, columnMap };
}

export function getSegmentTitle(row) {
    return row?.segment || row?.description || `Cue ${row?.cueNo || ''}`.trim() || 'Untitled Segment';
}

export function elapsedForTiming(timing, now = Date.now()) {
    if (!timing?.startedAt) return 0;
    const pausedMs = timing.pausedAccumulatedMs || 0;
    const activeEnd = timing.status === 'paused' ? timing.pausedAt || now : now;
    return Math.max(0, Math.round((activeEnd - timing.startedAt - pausedMs) / 1000));
}

export function remainingForTiming(timing, now = Date.now()) {
    return Math.max(0, (timing?.durationSeconds || 0) - elapsedForTiming(timing, now));
}
