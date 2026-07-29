// Gujarati typography catalogue.
//
// All faces are modern OpenType with real Gujarati coverage (U+0A80–U+0AFF) and
// GSUB/GPOS shaping, self-hosted from /fonts/unicode so they work with no internet.

export const GUJ_FONT_OPTIONS = [
    { value: "'Noto Sans Gujarati', sans-serif", label: 'Noto Sans Gujarati' },
    { value: "'Mukta Vaani', sans-serif",        label: 'Mukta Vaani' },
    { value: "'Hind Vadodara', sans-serif",      label: 'Hind Vadodara' },
    { value: "'Anek Gujarati', sans-serif",      label: 'Anek Gujarati' },
    { value: "'Baloo Bhai 2', system-ui",        label: 'Baloo Bhai 2' },
    { value: "'Rasa', serif",                    label: 'Rasa' },
];

export const DEFAULT_GUJ_FONT = "'Noto Sans Gujarati', sans-serif";
