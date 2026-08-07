const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('broadcastAPI', {
    selectLocalVideo: () => ipcRenderer.invoke('select-local-video'),
    selectLocalPhoto: () => ipcRenderer.invoke('select-local-photo'),
    // Deliberately write-only. There is no getTranslationSecret: the renderer can store a key
    // and ask whether one is set, but can never read the value back out. server.js resolves the
    // real key in the main process when translation starts.
    setTranslationSecret: (name, value) => ipcRenderer.invoke('set-translation-secret', name, value),
    getTranslationSecretStatus: () => ipcRenderer.invoke('get-translation-secret-status'),
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
