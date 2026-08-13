interface DevLoopDesktopApi {
  platform: string;
  getServiceUrl(): Promise<string>;
  isFullScreen(): Promise<boolean>;
  onFullScreenChange(listener: (isFullScreen: boolean) => void): void;
}

interface Window {
  devloopDesktop?: DevLoopDesktopApi;
}
