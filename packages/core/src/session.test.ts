import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createSession, appendChunk, updateSession, getSession, listSessions } from "./session.ts";

const STORAGE_DIR = join(homedir(), ".ralphbox", "sessions");
const BACKUP_DIR = join(homedir(), ".ralphbox-sessions-backup");

describe("session", () => {
  beforeEach(async () => {
    // Backup existing directory if it exists
    try {
      await Bun.$`mv ${STORAGE_DIR} ${BACKUP_DIR}`.quiet();
    } catch {
      // Directory doesn't exist
    }
  });

  afterEach(async () => {
    // Remove test directory
    await rm(STORAGE_DIR, { recursive: true, force: true });

    // Restore backup if it exists
    try {
      await Bun.$`mv ${BACKUP_DIR} ${STORAGE_DIR}`.quiet();
    } catch {
      // Backup doesn't exist
    }
  });

  test("createSession creates a new session file", async () => {
    const session = await createSession("claude");

    expect(session.id).toMatch(/^[0-9a-zA-Z]{8}$/);
    expect(session.status).toBe("created");
    expect(session.agent).toBe("claude");
    expect(session.messages).toEqual([]);
    expect(session.createdAt).toBeGreaterThan(0);

    // Verify file exists
    const file = Bun.file(join(STORAGE_DIR, `${session.id}.json`));
    expect(await file.exists()).toBe(true);
  });

  test("appendChunk accumulates text into messages", async () => {
    const session = await createSession("codex");

    await appendChunk(session.id, { type: "start", messageId: "msg-1" });
    await appendChunk(session.id, { type: "text-start", id: "t1" });
    await appendChunk(session.id, { type: "text-delta", id: "t1", delta: "Hello " });
    await appendChunk(session.id, { type: "text-delta", id: "t1", delta: "world!" });
    await appendChunk(session.id, { type: "text-end", id: "t1" });
    await appendChunk(session.id, { type: "finish" });

    const updated = await getSession(session.id);
    expect(updated?.messages).toHaveLength(1);
    expect(updated!.messages[0]!.id).toBe("msg-1");
    expect(updated!.messages[0]!.role).toBe("assistant");

    const part = updated!.messages[0]!.parts[0]!;
    expect(part.type).toBe("text");
    expect(part.messageId).toBe("msg-1");
    expect(part.id).toMatch(/^[0-9a-zA-Z]{8}$/);
    if (part.type === "text") {
      expect(part.text).toBe("Hello world!");
    }
  });

  test("updateSession updates session fields", async () => {
    const session = await createSession("claude");

    await updateSession(session.id, { status: "running" });
    let updated = await getSession(session.id);
    expect(updated?.status).toBe("running");

    await updateSession(session.id, { status: "completed", sandboxId: "sb-123" });
    updated = await getSession(session.id);
    expect(updated?.status).toBe("completed");
    expect(updated?.sandboxId).toBe("sb-123");
  });

  test("getSession returns null for non-existent session", async () => {
    await mkdir(STORAGE_DIR, { recursive: true });
    const session = await getSession("non-existent-id");
    expect(session).toBeNull();
  });

  test("listSessions returns sessions sorted by createdAt desc", async () => {
    const s1 = await createSession("claude");
    await Bun.sleep(10);
    const s2 = await createSession("codex");
    await Bun.sleep(10);
    const s3 = await createSession("claude");

    const sessions = await listSessions();

    expect(sessions).toHaveLength(3);
    expect(sessions[0]!.id).toBe(s3.id);
    expect(sessions[1]!.id).toBe(s2.id);
    expect(sessions[2]!.id).toBe(s1.id);
  });

  test("appendChunk handles Claude Code tool chunks", async () => {
    const session = await createSession("claude");

    // Simulate Claude Code agent tool chunks
    await appendChunk(session.id, { type: "start", messageId: "msg-1" });
    await appendChunk(session.id, { type: "text-start", id: "t1" });
    await appendChunk(session.id, { type: "text-delta", id: "t1", delta: "Let me check. " });
    await appendChunk(session.id, { type: "text-end", id: "t1" });

    // Tool call using Claude Code chunk types
    await appendChunk(session.id, {
      type: "tool-input-available",
      toolCallId: "tool-1",
      toolName: "Bash",
      input: { command: "ls" },
    });
    await appendChunk(session.id, {
      type: "tool-output-available",
      toolCallId: "tool-1",
      output: "file1.txt\nfile2.txt",
    });

    await appendChunk(session.id, { type: "finish" });

    const result = await getSession(session.id);
    expect(result?.messages).toHaveLength(1);
    expect(result!.messages[0]!.parts).toHaveLength(2); // text + tool

    const textPart = result!.messages[0]!.parts.find((p) => p.type === "text");
    expect(textPart?.type).toBe("text");
    if (textPart?.type === "text") {
      expect(textPart.text).toBe("Let me check. ");
    }

    const toolPart = result!.messages[0]!.parts.find((p) => p.type === "tool");
    expect(toolPart?.type).toBe("tool");
    if (toolPart?.type === "tool") {
      expect(toolPart.toolName).toBe("Bash");
      expect(toolPart.state.status).toBe("completed");
      expect(toolPart.state.input).toEqual({ command: "ls" });
      expect(toolPart.state.output).toBe("file1.txt\nfile2.txt");
    }
  });
});
