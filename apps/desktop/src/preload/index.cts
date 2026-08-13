const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");

const desktopApi = Object.freeze({
  platform: process.platform,
  getServiceUrl: (): Promise<string> => ipcRenderer.invoke("desktop:get-service-url"),
  isFullScreen: (): Promise<boolean> => ipcRenderer.invoke("desktop:is-full-screen"),
  onFullScreenChange: (listener: (isFullScreen: boolean) => void): void => {
    ipcRenderer.on("desktop:full-screen-changed", (_event, isFullScreen: boolean) => {
      listener(isFullScreen);
    });
  },
});

contextBridge.exposeInMainWorld("devloopDesktop", desktopApi);
