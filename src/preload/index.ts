import { contextBridge, ipcRenderer } from 'electron';
import type { IpcResult, RlBridge } from '../shared/api.ts';

const bridge: RlBridge = {
  invoke: (channel, req) => ipcRenderer.invoke(channel, req) as Promise<IpcResult<unknown>>,
  onLocked: (cb) => {
    const h = (): void => cb();
    ipcRenderer.on('locked', h);
    return () => ipcRenderer.removeListener('locked', h);
  },
};
contextBridge.exposeInMainWorld('rl', bridge);
