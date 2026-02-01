import { Bus } from "@ralphbox/core/bus";
import { createSession, getSession } from "@ralphbox/core/session";
import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { rm, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { app } from "./server.ts";

const STORAGE_DIR = join(homedir(), ".ralphbox");
const BACKUP_DIR = join(homedir(), ".ralphbox-backup");

describe("server API", () => {
  beforeEach(async () => {
    // Backup existing directory if it exists
    try {
      await Bun.$`mv ${STORAGE_DIR} ${BACKUP_DIR}`.quiet();
    } catch {
      // Directory doesn't exist
    }
  });

  afterEach(async () => {
    Bus.removeAllListeners();
    // Remove test directory
    await rm(STORAGE_DIR, { recursive: true, force: true });
    // Restore backup if it exists
    try {
      await Bun.$`mv ${BACKUP_DIR} ${STORAGE_DIR}`.quiet();
    } catch {
      // Backup doesn't exist
    }
  });

  describe("GET /api/sessions", () => {
    test("returns empty array when no sessions exist", async () => {
      await mkdir(STORAGE_DIR, { recursive: true });

      const res = await app.fetch(new Request("http://localhost/api/sessions"));

      expect(res.status).toBe(200);
      const sessions = await res.json();
      expect(sessions).toEqual([]);
    });

    test("returns list of sessions", async () => {
      await createSession("claude");
      await createSession("codex");

      const res = await app.fetch(new Request("http://localhost/api/sessions"));

      expect(res.status).toBe(200);
      const sessions = await res.json();
      expect(sessions).toHaveLength(2);
    });
  });

  describe("GET /api/sessions/:id", () => {
    test("returns session by id", async () => {
      const session = await createSession("claude");

      const res = await app.fetch(new Request(`http://localhost/api/sessions/${session.id}`));

      expect(res.status).toBe(200);
      const data = (await res.json()) as { id: string; agent: string };
      expect(data.id).toBe(session.id);
      expect(data.agent).toBe("claude");
    });

    test("returns 404 for non-existent session", async () => {
      await mkdir(STORAGE_DIR, { recursive: true });

      const res = await app.fetch(new Request("http://localhost/api/sessions/non-existent"));

      expect(res.status).toBe(404);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe("Not found");
    });
  });

  describe("POST /api/sessions", () => {
    test("creates a new session with claude agent", async () => {
      const res = await app.fetch(
        new Request("http://localhost/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agent: "claude" }),
        }),
      );

      expect(res.status).toBe(200);
      const session = (await res.json()) as { id: string; agent: string; status: string };
      expect(session.id).toMatch(/^session-/);
      expect(session.agent).toBe("claude");
      expect(session.status).toBe("created");
    });

    test("creates a new session with codex agent", async () => {
      const res = await app.fetch(
        new Request("http://localhost/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agent: "codex" }),
        }),
      );

      expect(res.status).toBe(200);
      const session = (await res.json()) as { agent: string };
      expect(session.agent).toBe("codex");
    });
  });

  describe("POST /api/sessions/:id/run", () => {
    test("returns 404 for non-existent session", async () => {
      await mkdir(STORAGE_DIR, { recursive: true });

      const res = await app.fetch(
        new Request("http://localhost/api/sessions/non-existent/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agent: "claude",
            messages: [{ role: "user", content: "test" }],
          }),
        }),
      );

      expect(res.status).toBe(404);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe("Session not found");
    });
  });

  describe("GET /events (SSE)", () => {
    test("returns SSE content type", async () => {
      const controller = new AbortController();

      const res = await app.fetch(new Request("http://localhost/events"), {
        signal: controller.signal,
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");

      // Abort to clean up
      controller.abort();
    });

    test("sends server.connected event on connection", async () => {
      const controller = new AbortController();

      const res = await app.fetch(new Request("http://localhost/events"), {
        signal: controller.signal,
      });

      const reader = res.body?.getReader();
      expect(reader).toBeDefined();

      const { value } = await reader!.read();
      const text = new TextDecoder().decode(value);

      expect(text).toContain("server.connected");

      controller.abort();
    });
  });

  describe("CORS headers", () => {
    test("allows localhost origins", async () => {
      const res = await app.fetch(
        new Request("http://localhost/api/sessions", {
          headers: { Origin: "http://localhost:8643" },
        }),
      );

      expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:8643");
    });

    test("allows 127.0.0.1 origins", async () => {
      const res = await app.fetch(
        new Request("http://localhost/api/sessions", {
          headers: { Origin: "http://127.0.0.1:3000" },
        }),
      );

      expect(res.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:3000");
    });

    test("rejects other origins", async () => {
      const res = await app.fetch(
        new Request("http://localhost/api/sessions", {
          headers: { Origin: "http://example.com" },
        }),
      );

      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    });
  });
});
