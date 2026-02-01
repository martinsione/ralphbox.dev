import { EventEmitter } from "events";
import type { BusEvent } from "./types.ts";

export type { BusEvent };

export const Bus = new EventEmitter<{ event: [BusEvent] }>();

export function publish(event: BusEvent): void {
  Bus.emit("event", event);
}

export function subscribe(callback: (event: BusEvent) => void): () => void {
  Bus.on("event", callback);
  return () => Bus.off("event", callback);
}
