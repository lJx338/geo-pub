import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('workerTabs', {
  selectPlatform: (platform: string) => ipcRenderer.send('worker-tabs-select-platform', platform),
  requestStatus: async () => await ipcRenderer.invoke('worker-tabs-status'),
  onStatus: (listener: (status: unknown) => void) => {
    ipcRenderer.on('worker-tabs-status', (_event, status) => listener(status));
  },
});
