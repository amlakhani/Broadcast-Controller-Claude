import { useState } from 'react';
import { Save, Trash2 } from 'lucide-react';

const compactInputClass = 'control-field px-2.5 py-1.5 text-xs';

// Quick-switch list of named address/port profiles for a hardware connection
// card (ATEM). Visually modeled on the "Layout Presets" rail in
// SuperSourcePanel.jsx — a row of chips with delete-on-hover, plus a
// "save current as…" input. Selecting a chip is the caller's job to wire up
// to "load these fields and connect" — that's the point of "quick switch".
export default function SavedConnections({ connections = [], activeConnectionId, onSelect, onSave, onDelete }) {
    const [nameInput, setNameInput] = useState('');

    const handleSave = () => {
        const name = nameInput.trim();
        if (!name) return;
        onSave(name);
        setNameInput('');
    };

    return (
        <div className="space-y-2">
            {connections.length > 0 && (
                <div className="flex flex-wrap gap-2">
                    {connections.map(conn => (
                        <div
                            key={conn.id}
                            className={`relative group rounded-lg border px-2.5 py-1.5 pr-6 transition cursor-pointer ${
                                conn.id === activeConnectionId
                                    ? 'border-blue-500 bg-blue-500/10'
                                    : 'border-slate-200 dark:border-slate-700 hover:border-blue-400'
                            }`}
                            onClick={() => onSelect(conn)}
                        >
                            <div className="text-[11px] font-bold text-slate-700 dark:text-slate-200 truncate max-w-[140px]">{conn.name}</div>
                            <div className="text-[10px] text-slate-500 truncate max-w-[140px]">{conn.address}:{conn.port}</div>
                            <button
                                onClick={e => { e.stopPropagation(); onDelete(conn.id); }}
                                title={`Delete "${conn.name}"`}
                                className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 transition rounded p-0.5 text-slate-400 hover:text-red-500 hover:bg-red-500/10"
                            >
                                <Trash2 className="w-3 h-3" />
                            </button>
                        </div>
                    ))}
                </div>
            )}
            <div className="flex items-center gap-2">
                <input
                    value={nameInput}
                    onChange={e => setNameInput(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') handleSave(); }}
                    placeholder="Save current connection as…"
                    className={`${compactInputClass} flex-1`}
                />
                <button
                    onClick={handleSave}
                    disabled={!nameInput.trim()}
                    className="control-button px-2.5 py-1.5 text-[11px] font-bold flex items-center gap-1.5 disabled:opacity-40"
                >
                    <Save className="w-3 h-3" /> Save
                </button>
            </div>
        </div>
    );
}
