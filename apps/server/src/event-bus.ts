import { EventEmitter } from "node:events";
import type { DomainEvent } from "@devloop/shared";

export type DomainEventListener = (event: DomainEvent) => void;

export class DomainEventBus {
  private readonly emitter = new EventEmitter();

  publish(events: readonly DomainEvent[]): void {
    for (const event of events) {
      this.emitter.emit("domain-event", event);
    }
  }

  subscribe(listener: DomainEventListener): () => void {
    this.emitter.on("domain-event", listener);
    return () => this.emitter.off("domain-event", listener);
  }
}
