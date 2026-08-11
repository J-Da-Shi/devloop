import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import type { DomainEvent } from "@devloop/shared";
import { eventNames, queryKeys } from "../api.js";
import { useUiStore } from "../store.js";

export function RealtimeSync() {
  const queryClient = useQueryClient();
  const enabled = useUiStore((state) => state.realtimeEnabled);
  const setStatus = useUiStore((state) => state.setRealtimeStatus);

  useEffect(() => {
    if (!enabled) {
      setStatus("disabled");
      return;
    }

    let closed = false;
    let source: EventSource | null = null;
    let reconnectTimer: number | null = null;
    let invalidateTimer: number | null = null;
    let invalidateTasks = false;
    let invalidateRuns = false;
    let invalidateProjects = false;
    let invalidateDevices = false;
    const runIds = new Set<string>();
    const storedEventId = Number.parseInt(
      window.sessionStorage.getItem("devloop:last-event-id") ?? "0",
      10,
    );
    let lastEventId = Number.isSafeInteger(storedEventId) && storedEventId > 0 ? storedEventId : 0;

    const flushInvalidations = () => {
      invalidateTimer = null;
      const requests = [queryClient.invalidateQueries({ queryKey: queryKeys.dashboard })];
      if (invalidateTasks) {
        requests.push(queryClient.invalidateQueries({ queryKey: queryKeys.tasks }));
      }
      if (invalidateRuns) {
        requests.push(queryClient.invalidateQueries({ queryKey: queryKeys.runs }));
      }
      if (invalidateProjects) {
        requests.push(queryClient.invalidateQueries({ queryKey: queryKeys.projects }));
      }
      if (invalidateDevices) {
        requests.push(queryClient.invalidateQueries({ queryKey: queryKeys.devices }));
      }
      for (const runId of runIds) {
        requests.push(queryClient.invalidateQueries({ queryKey: queryKeys.run(runId) }));
      }

      invalidateTasks = false;
      invalidateRuns = false;
      invalidateProjects = false;
      invalidateDevices = false;
      runIds.clear();
      void Promise.all(requests);
    };

    const scheduleInvalidation = (event: DomainEvent) => {
      if (event.aggregateType === "task") {
        invalidateTasks = true;
      }
      if (event.aggregateType === "run") {
        invalidateRuns = true;
        runIds.add(event.aggregateId);
      }
      if (event.aggregateType === "project") {
        invalidateProjects = true;
      }
      if (event.aggregateType === "device") {
        invalidateDevices = true;
      }
      invalidateTimer ??= window.setTimeout(flushInvalidations, 50);
    };

    const handleEvent = (message: MessageEvent<string>) => {
      const event = JSON.parse(message.data) as DomainEvent;
      const eventId = Number.parseInt(message.lastEventId, 10) || event.id;
      if (eventId > lastEventId) {
        lastEventId = eventId;
        window.sessionStorage.setItem("devloop:last-event-id", String(lastEventId));
      }
      scheduleInvalidation(event);
    };

    const connect = () => {
      if (closed) {
        return;
      }
      setStatus("connecting");
      const nextSource = new EventSource(`/api/events?after=${lastEventId}`);
      source = nextSource;
      nextSource.onopen = () => setStatus("connected");
      nextSource.onerror = () => {
        if (closed || source !== nextSource) {
          return;
        }
        setStatus("offline");
        nextSource.close();
        source = null;
        reconnectTimer ??= window.setTimeout(() => {
          reconnectTimer = null;
          connect();
        }, 1_500);
      };
      for (const eventName of eventNames) {
        nextSource.addEventListener(eventName, handleEvent as EventListener);
      }
    };

    connect();
    return () => {
      closed = true;
      source?.close();
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
      }
      if (invalidateTimer !== null) {
        window.clearTimeout(invalidateTimer);
      }
    };
  }, [enabled, queryClient, setStatus]);

  return null;
}
