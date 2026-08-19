const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");

const desktopApi = Object.freeze({
  platform: process.platform,
  selectDirectory: (): Promise<string | null> => ipcRenderer.invoke("desktop:select-directory"),
  getServiceUrl: (): Promise<string> => ipcRenderer.invoke("desktop:get-service-url"),
  isFullScreen: (): Promise<boolean> => ipcRenderer.invoke("desktop:is-full-screen"),
  onFullScreenChange: (listener: (isFullScreen: boolean) => void): void => {
    ipcRenderer.on("desktop:full-screen-changed", (_event, isFullScreen: boolean) => {
      listener(isFullScreen);
    });
  },
  openPreview: (input: {
    previewId: string;
    runId: string;
    url: string;
    title: string;
  }): Promise<void> => ipcRenderer.invoke("desktop:open-preview", input),
  closePreview: (previewId: string): Promise<void> =>
    ipcRenderer.invoke("desktop:close-preview", previewId),
  onPreviewClosed: (listener: (previewId: string) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, previewId: string): void => {
      listener(previewId);
    };
    ipcRenderer.on("desktop:preview-closed", handler);
    return () => ipcRenderer.removeListener("desktop:preview-closed", handler);
  },
});

contextBridge.exposeInMainWorld("devloopDesktop", desktopApi);
