import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  shell,
  utilityProcess,
  type UtilityProcess,
} from "electron";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

const serviceUrl = process.env.DEVLOOP_SERVICE_URL ?? "http://127.0.0.1:4317";
const rendererUrl =
  process.env.DEVLOOP_WEB_URL ?? (app.isPackaged ? serviceUrl : "http://127.0.0.1:5173");
const trustedOrigins = new Set([new URL(serviceUrl).origin, new URL(rendererUrl).origin]);
const bundledRuntimeDirectoryName = "runtime-bundle";
const maxServiceLogLength = 12_000;

let mainWindow: BrowserWindow | null = null;
let bundledService: UtilityProcess | null = null;
let bundledServiceExitCode: number | null = null;
let bundledServiceLog = "";
let isQuitting = false;

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function appendServiceLog(source: string, value: unknown): void {
  bundledServiceLog = `${bundledServiceLog}${source}: ${String(value)}`.slice(-maxServiceLogLength);
}

function buildBundledServiceEnvironment(runtimeRoot: string): NodeJS.ProcessEnv {
  const executablePaths = [
    join(homedir(), "Library", "pnpm"),
    join(homedir(), ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/Homebrew/bin",
    "/usr/local/bin",
    process.env.PATH,
  ].filter((value): value is string => Boolean(value));
  const url = new URL(serviceUrl);
  return {
    ...process.env,
    PATH: Array.from(new Set(executablePaths)).join(delimiter),
    DEVLOOP_REPOSITORY_ROOT: runtimeRoot,
    DEVLOOP_DATA_DIR: join(app.getPath("userData"), "data"),
    DEVLOOP_HOST: url.hostname,
    DEVLOOP_PORT: url.port || "4317",
  };
}

async function waitForBundledService(timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "服务尚未响应";
  while (Date.now() < deadline) {
    if (bundledServiceExitCode !== null) {
      throw new Error(
        `内置服务已退出，退出码 ${bundledServiceExitCode}.${bundledServiceLog ? `\n${bundledServiceLog}` : ""}`,
      );
    }
    try {
      const response = await fetch(new URL("/api/health", serviceUrl), {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) {
        return;
      }
      lastError = `健康检查返回 HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(200);
  }
  throw new Error(
    `等待内置服务启动超时：${lastError}.${bundledServiceLog ? `\n${bundledServiceLog}` : ""}`,
  );
}

async function startBundledService(): Promise<void> {
  if (!app.isPackaged || process.env.DEVLOOP_SERVICE_URL) {
    return;
  }
  const runtimeRoot = join(process.resourcesPath, bundledRuntimeDirectoryName);
  const serverEntry = join(runtimeRoot, "apps", "server", "dist", "index.js");
  bundledServiceExitCode = null;
  bundledServiceLog = "";
  const child = utilityProcess.fork(serverEntry, [], {
    cwd: runtimeRoot,
    env: buildBundledServiceEnvironment(runtimeRoot),
    stdio: ["ignore", "pipe", "pipe"],
    serviceName: "DevLoop Service",
  });
  bundledService = child;
  child.stdout?.on("data", (chunk) => appendServiceLog("stdout", chunk));
  child.stderr?.on("data", (chunk) => appendServiceLog("stderr", chunk));
  child.once("exit", (code) => {
    bundledServiceExitCode = code;
    if (bundledService === child) {
      bundledService = null;
    }
    if (!isQuitting && mainWindow) {
      dialog.showErrorBox(
        "DevLoop 服务已停止",
        `内置服务意外退出，退出码 ${code}.${bundledServiceLog ? `\n\n${bundledServiceLog}` : ""}`,
      );
    }
  });
  await waitForBundledService();
}

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
      title: "选择本地 Git 项目",
      properties: ["openDirectory"],
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
    try {
      registerDesktopBridge();
      installApplicationMenu();
      await startBundledService();
      await createWindow();
    } catch (error) {
      dialog.showErrorBox(
        "DevLoop 启动失败",
        error instanceof Error ? (error.stack ?? error.message) : String(error),
      );
      app.quit();
      return;
    }

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        void createWindow();
      }
    });
  });
}

app.on("before-quit", () => {
  isQuitting = true;
  bundledService?.kill();
  bundledService = null;
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
