interface DevLoopDesktopApi {
  platform: string;
  selectDirectory(): Promise<string | null>;
  getServiceUrl(): Promise<string>;
  isFullScreen(): Promise<boolean>;
  onFullScreenChange(listener: (isFullScreen: boolean) => void): void;
  openPreview(input: {
    previewId: string;
    runId: string;
    url: string;
    title: string;
  }): Promise<void>;
  closePreview(previewId: string): Promise<void>;
  onPreviewClosed(listener: (previewId: string) => void): () => void;
}

interface Window {
  devloopDesktop?: DevLoopDesktopApi;
}
