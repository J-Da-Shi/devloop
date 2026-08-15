import type { RunEvent } from "@devloop/shared";
import { useLayoutEffect, useRef } from "react";
import { formatDateTime } from "../utils.js";

interface RunEventListProps {
  events: RunEvent[];
  streamKey: string;
  compact?: boolean;
  label?: string;
}

export function RunEventList({
  events,
  streamKey,
  compact = false,
  label = "执行日志",
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

  return (
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
      {events.map((event, index) => (
        <li key={event.id} className={!compact && index === events.length - 1 ? "active" : ""}>
          {compact ? (
            <>
              <span>{event.message}</span>
              <time>{formatDateTime(event.createdAt)}</time>
            </>
          ) : (
            <>
              <span className="event-marker" aria-hidden="true" />
              <div>
                <strong>{event.message}</strong>
                <time>{formatDateTime(event.createdAt)}</time>
              </div>
            </>
          )}
        </li>
      ))}
    </ol>
  );
}
