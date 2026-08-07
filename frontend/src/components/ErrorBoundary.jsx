import { Component } from 'react';

// Keeps one failing subtree from taking down a whole window.
//
// This matters most on the graphics output: React unmounts the entire tree on an uncaught
// render error, so before this existed a single bad payload — a malformed gradient string, an
// unexpected media shape — put a black frame on air and took every other layer with it. Wrapping
// each layer individually means a broken layer renders nothing while the rest keep going.
//
// `silent` (the default for output layers) renders nothing at all on failure, because anything
// drawn here would be drawn on the live output. Operator-facing surfaces pass silent={false} to
// get a visible message instead of a mysteriously empty panel.
export default class ErrorBoundary extends Component {
    constructor(props) {
        super(props);
        this.state = { failed: false };
    }

    static getDerivedStateFromError() {
        return { failed: true };
    }

    componentDidCatch(error, info) {
        const label = this.props.label || 'component';
        console.error(`[${label}] render failed:`, error, info?.componentStack);
        // Best-effort report so the operator can see *which* layer died rather than just
        // noticing something is missing. Never let reporting itself throw.
        try {
            this.props.socket?.emit('client_error', {
                label,
                message: error?.message || String(error),
                stack: error?.stack || ''
            });
        } catch {
            // Reporting is a nicety; a dead socket must not turn into a second failure.
        }
    }

    render() {
        if (!this.state.failed) return this.props.children;
        if (this.props.silent !== false) return null;

        return (
            <div className="p-4 text-xs text-red-500">
                {this.props.label || 'This section'} stopped responding. Reload the window to retry.
            </div>
        );
    }
}
