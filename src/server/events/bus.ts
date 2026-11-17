/**
 * Tells live listeners (the event streams) about every event stored. Each app
 * has its own bus (see buildApp), so apps in one process don't see each
 * other's events, and closing one app doesn't affect another.
 */
import type { StoredEvent } from "./store.js";

export type EventListener = (event: StoredEvent) => void;

export class EventBus {
  private readonly listeners = new Set<EventListener>();

  /** Listen for newly stored events; returns an unsubscribe function. */
  on(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  publish(event: StoredEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // A broken listener must not stop the others, nor the caller that stored the event.
      }
    }
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}
