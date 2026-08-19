import { create } from "zustand";
import type { RealtimeStatus } from "../types/index.js";

interface UiState {
  realtimeEnabled: boolean;
  realtimeStatus: RealtimeStatus;
  setRealtimeEnabled(enabled: boolean): void;
  setRealtimeStatus(status: RealtimeStatus): void;
}

export const useUiStore = create<UiState>((set) => ({
  realtimeEnabled: true,
  realtimeStatus: "connecting",
  setRealtimeEnabled: (enabled) =>
    set({ realtimeEnabled: enabled, realtimeStatus: enabled ? "connecting" : "disabled" }),
  setRealtimeStatus: (status) => set({ realtimeStatus: status }),
}));
