// Static Blackmagic ATEM model matrix — for OFFLINE design only.
//
// When a switcher is actually connected, live capabilities from atem_service
// always win (see readDeviceState in atem_service.js): this list only exists so
// a show can be designed on a laptop before the hardware is on the network, or
// when planning for a model that isn't in the room yet.
//
// boxCount/superSourceCount here are best-effort from public Blackmagic specs,
// not queried from a device — do not treat them as authoritative once connected.

export const ATEM_MODEL_PROFILES = [
    { id: 'constellation-8k', label: 'ATEM Constellation 8K', superSourceCount: 2, boxCount: 4 },
    { id: 'constellation-4k-1me', label: 'ATEM Constellation 4K 1 M/E', superSourceCount: 1, boxCount: 4 },
    { id: 'constellation-4k-2me', label: 'ATEM Constellation 4K 2 M/E', superSourceCount: 1, boxCount: 4 },
    { id: 'constellation-4k-4me', label: 'ATEM Constellation 4K 4 M/E', superSourceCount: 2, boxCount: 4 },
    { id: 'constellation-hd-1me', label: 'ATEM Constellation HD 1 M/E', superSourceCount: 1, boxCount: 4 },
    { id: 'constellation-hd-2me', label: 'ATEM Constellation HD 2 M/E', superSourceCount: 1, boxCount: 4 },
    { id: 'constellation-hd-4me', label: 'ATEM Constellation HD 4 M/E', superSourceCount: 2, boxCount: 4 },
    { id: 'production-studio-2me-4k', label: 'ATEM 2 M/E Production Studio 4K', superSourceCount: 1, boxCount: 4 },
    { id: 'production-studio-4me-4k', label: 'ATEM 4 M/E Production Studio 4K', superSourceCount: 1, boxCount: 4 },
    { id: 'mini-extreme', label: 'ATEM Mini Extreme', superSourceCount: 1, boxCount: 4 },
    { id: 'mini-extreme-iso', label: 'ATEM Mini Extreme ISO', superSourceCount: 1, boxCount: 4 },
    { id: 'tvs-pro-4k', label: 'ATEM Television Studio Pro 4K', superSourceCount: 1, boxCount: 4 },
    { id: 'generic-4box', label: 'Generic — 1 SuperSource, 4 boxes', superSourceCount: 1, boxCount: 4 },
];

export const getModelProfile = (id) => ATEM_MODEL_PROFILES.find(p => p.id === id) || ATEM_MODEL_PROFILES.at(-1);
