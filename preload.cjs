const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('broadcastAPI', {
    selectLocalVideo: () => ipcRenderer.invoke('select-local-video'),
    selectLocalPhoto: () => ipcRenderer.invoke('select-local-photo'),
    selectWhisperExecutable: () => ipcRenderer.invoke('select-whisper-executable'),
    selectWhisperModel: () => ipcRenderer.invoke('select-whisper-model'),
    getPathForFile: (file) => {
        if (webUtils?.getPathForFile) return webUtils.getPathForFile(file);
        return file?.path || '';
    }
});
