import type { RunEvent } from "@devloop/shared";
import { useLayoutEffect, useRef } from "react";
import { formatDateTime } from "../../../core/index.js";

interface RunEventListProps {
  events: RunEvent[];
  streamKey: string;
  compact?: boolean;
  label?: string;
  title?: string;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const formatPayload = (payload: unknown): string | null => {
  if (payload === null || payload === undefined) return null;
  const record = asRecord(payload);
  if (record && Object.keys(record).length === 0) return null;
  return JSON.stringify(payload, null, 2) ?? null;
};

const payloadLabel = (event: RunEvent): string => {
  if (event.type === "run.rejected") return "驳回详情";
  const payload = asRecord(event.payload);
  const rawEvent = asRecord(payload?.event);
  const item = asRecord(rawEvent?.item);
  if (item?.type === "command_execution") return "命令详情";
  if (typeof payload?.validationError === "string") return "校验详情";
  if (typeof payload?.raw === "string") return "原始输出";
  return "事件详情";
};

export function RunEventList({
  events,
  streamKey,
  compact = false,
  label = "执行日志",
  title,
}: RunEventListProps) {
  const listRef = useRef<HTMLOListElement>(null);
  const streamKeyRef = useRef(streamKey);
  const followLatestRef = useRef(true);
  const latestEventId = events.at(-1)?.id ?? null;

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) {
      return;
    }
    if (streamKeyRef.current !== streamKey) {
      streamKeyRef.current = streamKey;
      followLatestRef.current = true;
    }
    if (followLatestRef.current) {
      list.scrollTop = list.scrollHeight;
    }
  }, [latestEventId, streamKey]);

  const eventList = (
    <ol
      ref={listRef}
      className={`event-list event-log-scroll${compact ? " compact" : ""}`}
      role="log"
      aria-label={label}
      aria-live="polite"
      aria-relevant="additions text"
      tabIndex={0}
      onScroll={(event) => {
        const list = event.currentTarget;
        followLatestRef.current = list.scrollHeight - list.scrollTop - list.clientHeight <= 32;
      }}
    >
      {events.map((event, index) => {
        const payload = formatPayload(event.payload);
        const details = payload ? (
          <details className="event-payload">
            <summary>{payloadLabel(event)}</summary>
            <pre>{payload}</pre>
          </details>
        ) : null;
        return (
          <li key={event.id} className={!compact && index === events.length - 1 ? "active" : ""}>
            {compact ? (
              <>
                <span>{event.message}</span>
                <time>{formatDateTime(event.createdAt)}</time>
                {details}
              </>
            ) : (
              <>
                <span className="event-marker" aria-hidden="true" />
                <div>
                  <strong>{event.message}</strong>
                  <time>{formatDateTime(event.createdAt)}</time>
                  {details}
                </div>
              </>
            )}
          </li>
        );
      })}
    </ol>
  );

  if (!title) {
    return eventList;
  }

  return (
    <section className={`event-log-panel${compact ? " compact" : ""}`} aria-label={title}>
      <header className="event-log-heading">
        <h4>{title}</h4>
        <span>{events.length} 条</span>
      </header>
      {eventList}
    </section>
  );
}
