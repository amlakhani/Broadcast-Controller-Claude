const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('broadcastAPI', {
    selectLocalVideo: () => ipcRenderer.invoke('select-local-video'),
    selectLocalPhoto: () => ipcRenderer.invoke('select-local-photo'),
    selectWhisperExecutable: () => ipcRenderer.invoke('select-whisper-executable'),
    selectWhisperModel: () => ipcRenderer.invoke('select-whisper-model'),
    getPathForFile: (file) => {
        if (webUtils?.getPathForFile) return webUtils.getPathForFile(file);
        return file?.path || '';
    },
    onBeforeReload: (callback) => {
        const listener = () => callback();
        ipcRenderer.on('before-reload', listener);
        return () => ipcRenderer.removeListener('before-reload', listener);
    },
    onPresentationClickerNav: (callback) => {
        const listener = (event, direction) => callback(direction);
        ipcRenderer.on('presentation-clicker-nav', listener);
        return () => ipcRenderer.removeListener('presentation-clicker-nav', listener);
    }
});
