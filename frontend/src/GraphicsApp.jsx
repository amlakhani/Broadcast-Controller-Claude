import { useState, useEffect } from 'react';
import { io } from 'socket.io-client';
import { socketOptions } from './auth';
import LowerThirdsGraphic from './graphics/LowerThirdsGraphic';
import LyricsGraphic from './graphics/LyricsGraphic';
import StageDisplayGraphic from './graphics/StageDisplayGraphic';
import MediaGraphic from './graphics/MediaGraphic';
import PresentationGraphic from './graphics/PresentationGraphic';
import SabhaTimerGraphic from './graphics/SabhaTimerGraphic';
import ParticlesGraphic from './graphics/ParticlesGraphic';
import TranslationGraphic from './graphics/TranslationGraphic';
import MediaMessageOverlayGraphic from './graphics/MediaMessageOverlayGraphic';
import StageCanvas from './graphics/StageCanvas';

const socket = io(socketOptions()); // Connects to the host automatically

const DEFAULT_LAYER_VISIBILITY = {
    presentation: true,
    media: true,
    lowerThirds: true,
    lyrics: true,
    translation: true,
    sabhaTimer: true,
    particles: true,
    mediaMessage: true,
};

const NDI_LAYER_SOURCES = new Set(['presentation', 'media', 'lowerThirds', 'lyrics', 'translation', 'sabhaTimer', 'particles', 'mediaMessage']);

export default function GraphicsApp() {
    const [mode, setMode] = useState('graphics'); // 'graphics' or 'stage'
    const [ndiSource, setNdiSource] = useState('graphics');
    const [activeKeyColor, setActiveKeyColor] = useState('#00FF00');
    const [backgroundMode, setBackgroundMode] = useState(() => {
        const params = new URLSearchParams(window.location.search);
        return params.get('backgroundMode') || 'green';
    });
    const [fitMode, setFitMode] = useState(() => {
        const params = new URLSearchParams(window.location.search);
        return params.get('fitMode') === 'fill' ? 'fill' : 'fit';
    });
    const [layerVisibility, setLayerVisibility] = useState(DEFAULT_LAYER_VISIBILITY);
    // Set once at mount, same as backgroundMode above -- only the control window's
    // in-app "Live Preview" iframe sends this, so this never changes for a window's lifetime.
    const [isPreview] = useState(() => new URLSearchParams(window.location.search).get('preview') === 'true');

    // Force CSS reset on mount to eliminate any white border
    useEffect(() => {
        const html = document.documentElement;
        const body = document.body;
        [html, body].forEach(el => {
            el.style.margin = '0';
            el.style.padding = '0';
            el.style.overflow = 'hidden';
            el.style.width = '100%';
            el.style.height = '100%';
        });
    }, []);

    useEffect(() => {
        // Parse URL params
        const urlParams = new URLSearchParams(window.location.search);
        const urlMode = urlParams.get('mode') || 'graphics';
        const urlNdiSource = urlParams.get('ndiSource') || 'graphics';
        setMode(urlMode);
        setNdiSource(urlNdiSource);

        // Socket Listeners
        const handleBgColorUpdate = (color) => {
            if (urlMode === 'stage') return;
            setActiveKeyColor(color);
        };

        const handleCloseCommand = () => {
            window.close();
        };
        const handleOutputModeUpdate = (data) => {
            if (data?.backgroundMode) setBackgroundMode(data.backgroundMode);
            if (data?.fitMode) setFitMode(data.fitMode);
        };
        const handleLayerVisibilityUpdate = (data) => {
            if (data) setLayerVisibility(prev => ({ ...prev, ...data }));
        };

        socket.on('bg_color_update', handleBgColorUpdate);
        socket.on('close_window_command', handleCloseCommand);
        socket.on('output_mode_update', handleOutputModeUpdate);
        socket.on('layer_visibility_update', handleLayerVisibilityUpdate);

        return () => {
            socket.off('bg_color_update', handleBgColorUpdate);
            socket.off('close_window_command', handleCloseCommand);
            socket.off('output_mode_update', handleOutputModeUpdate);
            socket.off('layer_visibility_update', handleLayerVisibilityUpdate);
        };
    }, []);

    useEffect(() => {
        // Apply background color to body
        if (mode === 'stage') {
            document.body.style.backgroundColor = '#000000';
            document.documentElement.style.backgroundColor = '#000000';
        } else if (backgroundMode === 'transparent') {
            document.body.style.backgroundColor = 'transparent';
            document.documentElement.style.backgroundColor = 'transparent';
        } else if (backgroundMode === 'black') {
            document.body.style.backgroundColor = '#000000';
            document.documentElement.style.backgroundColor = '#000000';
        } else {
            document.body.style.backgroundColor = activeKeyColor;
            document.documentElement.style.backgroundColor = activeKeyColor;
        }
    }, [mode, activeKeyColor, backgroundMode]);

    const layerStyle = (layer) => {
        const layerIsSelected = ndiSource === 'graphics' || !NDI_LAYER_SOURCES.has(ndiSource) || ndiSource === layer;
        return {
            display: layerVisibility[layer] && layerIsSelected ? 'contents' : 'none'
        };
    };

    return (
        <div className="fixed inset-0 overflow-hidden">
            {mode === 'stage' ? (
                <StageDisplayGraphic socket={socket} windowMode={mode} />
            ) : (
                <StageCanvas fitMode={fitMode}>
                    <div style={layerStyle('presentation')}><PresentationGraphic socket={socket} windowMode={mode} isPreview={isPreview} /></div>
                    <div style={layerStyle('translation')}><TranslationGraphic socket={socket} windowMode={mode} /></div>
                    <div style={layerStyle('lowerThirds')}><LowerThirdsGraphic socket={socket} windowMode={mode} /></div>
                    <div style={layerStyle('lyrics')}><LyricsGraphic socket={socket} windowMode={mode} /></div>
                    <div style={layerStyle('media')}><MediaGraphic socket={socket} windowMode={mode} /></div>
                    <div style={layerStyle('sabhaTimer')}><SabhaTimerGraphic socket={socket} windowMode={mode} /></div>
                    <div style={layerStyle('particles')}><ParticlesGraphic socket={socket} windowMode={mode} /></div>
                    <div style={layerStyle('mediaMessage')}><MediaMessageOverlayGraphic socket={socket} windowMode={mode} /></div>
                </StageCanvas>
            )}
        </div>
    );
}
