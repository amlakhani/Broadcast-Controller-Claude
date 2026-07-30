// Pure logic for the ATEM Switcher page (currently just the built-in router) —
// no DOM, unit-testable under `node --test`, same split from
// AtemSwitcherPanel.jsx that superSourceModel.js keeps from SuperSourcePanel.jsx.

export const auxLabel = (index) => `AUX ${index + 1}`;
