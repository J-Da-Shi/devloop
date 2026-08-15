interface DevLoopDesktopApi {
  platform: string;
  selectDirectory(): Promise<string | null>;
  getServiceUrl(): Promise<string>;
  isFullScreen(): Promise<boolean>;
  onFullScreenChange(listener: (isFullScreen: boolean) => void): void;
}

interface Window {
  devloopDesktop?: DevLoopDesktopApi;
}
