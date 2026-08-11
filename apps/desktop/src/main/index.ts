import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from "electron";
import { fileURLToPath } from "node:url";

const serviceUrl = process.env.DEVLOOP_SERVICE_URL ?? "http://127.0.0.1:4317";
const rendererUrl =
  process.env.DEVLOOP_WEB_URL ?? (app.isPackaged ? serviceUrl : "http://127.0.0.1:5173");
const trustedOrigins = new Set([new URL(serviceUrl).origin, new URL(rendererUrl).origin]);

let mainWindow: BrowserWindow | null = null;

function isTrustedRendererUrl(value: string): boolean {
  try {
    return trustedOrigins.has(new URL(value).origin);
  } catch {
    return false;
  }
}

function assertTrustedSender(value: string): void {
  if (!isTrustedRendererUrl(value)) {
    throw new Error("拒绝来自未知页面的桌面操作请求");
  }
}

function registerDesktopBridge(): void {
  ipcMain.handle("desktop:select-directory", async (event) => {
    assertTrustedSender(event.senderFrame?.url ?? event.sender.getURL());
    const parentWindow = BrowserWindow.fromWebContents(event.sender);
    const options: Electron.OpenDialogOptions = {
      title: "选择 Git 项目目录",
      properties: ["openDirectory", "createDirectory"],
    };
    const result = parentWindow
      ? await dialog.showOpenDialog(parentWindow, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  ipcMain.handle("desktop:get-service-url", (event) => {
    assertTrustedSender(event.senderFrame?.url ?? event.sender.getURL());
    return serviceUrl;
  });

  ipcMain.handle("desktop:is-full-screen", (event) => {
    assertTrustedSender(event.senderFrame?.url ?? event.sender.getURL());
    return BrowserWindow.fromWebContents(event.sender)?.isFullScreen() ?? false;
  });
}

function installApplicationMenu(): void {
  const isMac = process.platform === "darwin";
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" as const },
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "hideOthers" as const },
              { role: "unhide" as const },
              { type: "separator" as const },
              { role: "quit" as const },
            ],
          },
        ]
      : []),
    {
      label: "编辑",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "视图",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        ...(!app.isPackaged ? [{ role: "toggleDevTools" as const }] : []),
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "窗口",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        ...(isMac
          ? [
              { type: "separator" as const },
              { role: "front" as const },
              { type: "separator" as const },
              { role: "window" as const },
            ]
          : [{ role: "close" as const }]),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function createWindow(): Promise<void> {
  const preloadPath = fileURLToPath(new URL("../preload/index.cjs", import.meta.url));
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    title: "DevLoop",
    backgroundColor: "#000000",
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 16, y: 18 } }
      : { titleBarStyle: "default" as const }),
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow = window;
  window.once("ready-to-show", () => window.show());
  const publishFullScreenState = (): void => {
    window.webContents.send("desktop:full-screen-changed", window.isFullScreen());
  };
  window.on("enter-full-screen", publishFullScreenState);
  window.on("leave-full-screen", publishFullScreenState);
  window.on("closed", () => {
    if (mainWindow === window) {
      mainWindow = null;
    }
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("http://")) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });

  window.webContents.on("will-navigate", (event, url) => {
    if (isTrustedRendererUrl(url)) {
      return;
    }
    event.preventDefault();
    if (url.startsWith("https://") || url.startsWith("http://")) {
      void shell.openExternal(url);
    }
  });

  await window.loadURL(new URL("/status", rendererUrl).toString());
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) {
      void createWindow();
      return;
    }
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.show();
    mainWindow.focus();
  });

  void app.whenReady().then(async () => {
    registerDesktopBridge();
    installApplicationMenu();
    await createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        void createWindow();
      }
    });
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
