import { describe, test, expect, afterEach } from "bun:test";
import { Bus, publish, subscribe, type BusEvent } from "./bus.ts";

describe("bus", () => {
  // Clean up listeners after each test
  afterEach(() => {
    Bus.removeAllListeners();
  });

  test("subscribe receives published events", () => {
    const received: BusEvent[] = [];
    subscribe((event) => received.push(event));

    publish({ type: "session.created", properties: { sessionId: "test-123" } });

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({
      type: "session.created",
      properties: { sessionId: "test-123" },
    });
  });

  test("multiple subscribers receive same event", () => {
    const received1: BusEvent[] = [];
    const received2: BusEvent[] = [];

    subscribe((event) => received1.push(event));
    subscribe((event) => received2.push(event));

    publish({ type: "session.updated", properties: { sessionId: "test-456" } });

    expect(received1).toHaveLength(1);
    expect(received2).toHaveLength(1);
    expect(received1[0]).toEqual(received2[0]);
  });

  test("unsubscribe stops receiving events", () => {
    const received: BusEvent[] = [];
    const unsubscribe = subscribe((event) => received.push(event));

    publish({ type: "session.created", properties: { sessionId: "test-1" } });
    expect(received).toHaveLength(1);

    unsubscribe();

    publish({ type: "session.created", properties: { sessionId: "test-2" } });
    expect(received).toHaveLength(1); // Still 1, didn't receive second event
  });

  test("publishes server.connected event", () => {
    const received: BusEvent[] = [];
    subscribe((event) => received.push(event));

    publish({ type: "server.connected", properties: {} });

    expect(received[0]).toEqual({
      type: "server.connected",
      properties: {},
    });
  });

  test("publishes server.heartbeat event", () => {
    const received: BusEvent[] = [];
    subscribe((event) => received.push(event));

    publish({ type: "server.heartbeat", properties: {} });

    expect(received[0]).toEqual({
      type: "server.heartbeat",
      properties: {},
    });
  });

  test("publishes session.chunk event with chunk data", () => {
    const received: BusEvent[] = [];
    subscribe((event) => received.push(event));

    const chunk = { type: "text-delta" as const, id: "t1", delta: "hello" };
    publish({
      type: "session.chunk",
      properties: { sessionId: "test-session", chunk },
    });

    expect(received[0]).toEqual({
      type: "session.chunk",
      properties: { sessionId: "test-session", chunk },
    });
  });

  test("events are received in order", () => {
    const received: BusEvent[] = [];
    subscribe((event) => received.push(event));

    publish({ type: "session.created", properties: { sessionId: "s1" } });
    publish({ type: "session.updated", properties: { sessionId: "s1" } });
    publish({ type: "session.updated", properties: { sessionId: "s1" } });

    expect(received).toHaveLength(3);
    expect(received[0]!.type).toBe("session.created");
    expect(received[1]!.type).toBe("session.updated");
    expect(received[2]!.type).toBe("session.updated");
  });
});
